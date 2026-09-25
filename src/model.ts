import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, type Dirent } from 'fs';
import {
  parseDff, flattenDff, renderMesh, exportObj, exportGltf,
  type DffModel, type MeshData, type MeshRenderResult,
} from './dff.js';
import {
  parseTxd, decodeTxdTexture, decodePng, encodePng,
  type DecodedTexture, type TxdTexture,
} from './txd.js';
import { readImgIndex, readImgEntry, findImgEntry, type ImgArchive } from './img.js';

/**
 * 3D model support for the textdraw editor.
 *
 * A font 5 textdraw (`TextDrawSetPreviewModel(td, 411)`) shows a rotating 3D
 * model, and custom UI images in 0.3.DL are AddSimpleModel .dff/.txd pairs.
 * Neither is visible without the game, so this module finds the model files on
 * the machine (loose .dff files, servers' `models/` folder, or inside a VER2
 * .img archive), pairs them with their textures, renders them with the DFF
 * rasteriser and stores the result where the preview page already looks for
 * font 5 art (`.samp-mcp/textdraw-assets/models/<id>.png`).
 *
 * Nothing here writes into the server's model files — only under `.samp-mcp`.
 */

export const MODEL_ASSET_DIR = ['.samp-mcp', 'textdraw-assets', 'models'];
const MODEL_TEXTURE_DIR = ['.samp-mcp', 'textdraw-assets', 'textures'];
/**
 * Design-time sprite art. A font 4 sprite is "txdname:texturename" and normally
 * comes from a compiled .txd; dropping `<txdname>__<texturename>.png` here lets a
 * designer preview the artwork before (or instead of) compiling the dictionary.
 * Model materials fall back to the same files when no .txd can be decoded.
 */
export const SPRITE_ASSET_DIR = ['.samp-mcp', 'textdraw-assets', 'sprites'];
const MODEL_EXPORT_DIR = ['.samp-mcp', 'model-export'];
const MODEL_INDEX_FILE = ['.samp-mcp', 'textdraws', 'model-index.json'];
const TEXTDRAW_DIR = ['.samp-mcp', 'textdraws'];
const DEFAULT_PREVIEW_SIZE = 256;

interface ModelScanRecord {
  name: string;
  file: string;
  bytes: number;
  version: string;
  stats: DffModel['stats'];
  textures: string[];
  texturesFound: string[];
  modelIds: number[];
  txdHint: string;
  warnings: string[];
}

interface ModelArchiveRecord {
  file: string;
  version: number;
  entries: number;
  bytes: number;
  listed: string[];
  error?: string;
}

interface ModelScanResult {
  indexFile: string;
  dffs: ModelScanRecord[];
  archives: ModelArchiveRecord[];
  /** model id → where it resolves (AddSimpleModel entries and loose <id>.dff files). */
  modelIds: Record<string, { dff: string; txd: string; source: string }>;
  usedModelIds: number[];
  unmappedModelIds: number[];
  scannedFiles: number;
  warnings: string[];
}

interface ModelPreviewResult {
  model: string;
  source: string;
  file: string;
  width: number;
  height: number;
  bytes: number;
  render: { rot: [number, number, number]; zoom: number; triangles: number; drawn: number; coverage: number };
  mesh: MeshData['stats'];
  stats: DffModel['stats'];
  textures: { used: string[]; missing: string[] };
  warnings: string[];
}

interface ModelExportResult {
  model: string;
  source: string;
  format: string;
  files: string[];
  mesh: MeshData['stats'];
  textures: { exported: string[]; missing: string[] };
}

interface LocatedModel {
  label: string;
  source: string;
  file: string | null;
  archive: string | null;
  name: string;
  bytes: Buffer;
  txdHint: string;
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'model';
}

/** Asset file name for a model reference — AddSimpleModel ids are often negative. */
function modelKey(value: number | string): string {
  const text = String(value).trim();
  return text.startsWith('-') ? `n${slug(text.slice(1))}` : slug(text);
}

async function walkFiles(dir: string, depth: number, limit: number, wanted: string[]): Promise<string[]> {
  const found: string[] = [];
  const queue: Array<{ dir: string; level: number }> = [{ dir, level: 0 }];
  while (queue.length && found.length < limit) {
    const current = queue.shift() as { dir: string; level: number };
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= limit) break;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.level + 1 <= depth && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          queue.push({ dir: full, level: current.level + 1 });
        }
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (wanted.includes(ext)) found.push(full);
    }
  }
  return found;
}

class ModelManager {
  private root = '';
  private scanResult: ModelScanResult | null = null;
  private archives = new Map<string, ImgArchive>();
  private txdFiles: string[] = [];
  /** txd path → decoded texture index (name → metadata). */
  private txdTextures = new Map<string, Map<string, TxdTexture>>();
  private txdBuffers = new Map<string, Buffer>();
  private textureCache = new Map<string, DecodedTexture | null>();
  private dataUrlCache = new Map<string, string>();

  setRoot(root: string): void {
    if (root === this.root) return;
    this.root = root;
    this.scanResult = null;
    this.archives.clear();
    this.txdFiles = [];
    this.txdTextures.clear();
    this.txdBuffers.clear();
    this.textureCache.clear();
    this.dataUrlCache.clear();
  }

  private abs(...parts: string[]): string {
    return path.join(this.root, ...parts);
  }

  private rel(file: string): string {
    return this.root && path.resolve(file).startsWith(path.resolve(this.root)) ? path.relative(this.root, file) : file;
  }

  /** Absolute path for a scanned entry (scan targets may live outside the root). */
  private resolvePath(ref: string): string {
    return path.isAbsolute(ref) ? ref : this.abs(ref);
  }

  /**
   * Finds model files: loose .dff on disk, .txd dictionaries next to them, IMG
   * archives, and the model ids the textdraw projects reference.
   */
  async scan(opts: { dir?: string; depth?: number; limit?: number; img?: string } = {}): Promise<ModelScanResult> {
    const root = this.root;
    const warnings: string[] = [];
    const depth = Math.max(0, Math.min(6, opts.depth ?? 3));
    const limit = Math.max(1, Math.min(2000, opts.limit ?? 200));
    const startDir = opts.dir ? (path.isAbsolute(opts.dir) ? opts.dir : this.abs(opts.dir)) : root;
    if (!root) throw new Error('No SA-MP server root configured — call set_server_root first.');

    const dffFiles = await walkFiles(startDir, depth, limit, ['.dff']);
    this.txdFiles = await walkFiles(startDir, depth, limit, ['.txd']);
    this.txdTextures.clear();
    this.txdBuffers.clear();
    this.textureCache.clear();
    this.dataUrlCache.clear();

    const archiveFiles = new Set<string>();
    if (opts.img) {
      const candidate = path.isAbsolute(opts.img) ? opts.img : path.join(root, opts.img);
      if (existsSync(candidate)) archiveFiles.add(candidate);
      else warnings.push(`--img ${opts.img} not found on disk`);
    } else {
      for (const file of await walkFiles(startDir, Math.min(depth, 2), 8, ['.img'])) archiveFiles.add(file);
    }
    this.archives.clear();
    const archives: ModelArchiveRecord[] = [];
    for (const file of archiveFiles) {
      const archive = await readImgIndex(file);
      this.archives.set(path.resolve(file), archive);
      const names = archive.entries
        .filter((entry) => entry.name.toLowerCase().endsWith('.dff'))
        .map((entry) => entry.name);
      archives.push({
        file: this.rel(file),
        version: archive.version,
        entries: archive.entries.length,
        bytes: archive.bytes,
        listed: names.slice(0, 500),
        error: archive.error,
      });
      if (archive.error) warnings.push(`${this.rel(file)}: ${archive.error}`);
    }

    const dffs: ModelScanRecord[] = [];
    for (const file of dffFiles) {
      const buffer = await fs.readFile(file).catch(() => null);
      if (!buffer) continue;
      const model = parseDff(buffer, file);
      const mesh = flattenDff(model);
      const found: string[] = [];
      for (const texture of model.textures) {
        if (await this.resolveTexture(texture, { dir: path.dirname(file), archive: null, txdHint: path.basename(file, path.extname(file)) })) {
          found.push(texture);
        }
      }
      dffs.push({
        name: path.basename(file),
        file: this.rel(file),
        bytes: buffer.length,
        version: model.version,
        stats: model.stats,
        textures: model.textures,
        texturesFound: found,
        modelIds: [],
        txdHint: path.basename(file, path.extname(file)),
        warnings: mesh.warnings,
      });
    }

    const modelIds = await this.readProjectModelIds();
    for (const [id, record] of Object.entries(modelIds)) {
      const target = path.resolve(this.resolvePath(record.dff));
      const entry = dffs.find((dff) => path.resolve(this.resolvePath(dff.file)) === target);
      if (entry && !entry.modelIds.includes(Number(id))) entry.modelIds.push(Number(id));
    }
    for (const dff of dffs) {
      const base = path.basename(dff.file, path.extname(dff.file)).toLowerCase();
      const numeric = /^(?:model)?(\d{1,5})$/.exec(base);
      if (numeric) {
        const id = Number(numeric[1]);
        if (!dff.modelIds.includes(id)) dff.modelIds.push(id);
        if (!modelIds[String(id)]) modelIds[String(id)] = { dff: dff.file, txd: dff.txdHint, source: `file ${dff.file}` };
      }
    }

    const used = await this.readUsedModelIds();
    const knownIds = new Set(Object.keys(modelIds));
    const unmapped = used.filter((id) => !knownIds.has(String(id)));
    if (unmapped.length) {
      warnings.push(`model id(s) ${unmapped.join(', ')} are used by textdraws but no .dff was found for them — add a file or an AddSimpleModel entry`);
    }

    const result: ModelScanResult = {
      indexFile: this.abs(...MODEL_INDEX_FILE),
      dffs,
      archives,
      modelIds,
      usedModelIds: used,
      unmappedModelIds: unmapped,
      scannedFiles: dffFiles.length,
      warnings,
    };
    this.scanResult = result;
    await fs.mkdir(path.dirname(result.indexFile), { recursive: true });
    await fs.writeFile(result.indexFile, JSON.stringify({ root, scannedAt: new Date().toISOString(), ...result }, null, 2), 'utf8');
    return result;
  }

  /** model id → {dff, txd} from every project's AddSimpleModel entries. */
  private async readProjectModelIds(): Promise<Record<string, { dff: string; txd: string; source: string }>> {
    const map: Record<string, { dff: string; txd: string; source: string }> = {};
    const dir = this.abs(...TEXTDRAW_DIR);
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'txd-index.json' || file === 'model-index.json') continue;
      const raw = await fs.readFile(path.join(dir, file), 'utf8').catch(() => null);
      if (!raw) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      for (const entry of Array.isArray(parsed?.simpleModels) ? parsed.simpleModels : []) {
        if (entry?.dff === undefined) continue;
        map[String(entry.newid)] = {
          dff: String(entry.dff),
          txd: entry.txd ? String(entry.txd).replace(/\.txd$/i, '') : '',
          source: `AddSimpleModel(${entry.baseid}, ${entry.newid}) in ${file}`,
        };
      }
    }
    return map;
  }

  /** Every previewModel id the textdraw projects use (font 5 slots). */
  private async readUsedModelIds(): Promise<number[]> {
    const ids = new Set<number>();
    const dir = this.abs(...TEXTDRAW_DIR);
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'txd-index.json' || file === 'model-index.json') continue;
      const raw = await fs.readFile(path.join(dir, file), 'utf8').catch(() => null);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        for (const td of Array.isArray(parsed?.textdraws) ? parsed.textdraws : []) {
          if (typeof td?.previewModel === 'number') ids.add(td.previewModel);
        }
      } catch { /* ignore broken project files */ }
    }
    return [...ids].sort((a, b) => a - b);
  }

  /** Resolves an id, file path or bare model name to bytes on disk or in an archive. */
  private async locate(ref: string, hint?: { txd?: string }): Promise<LocatedModel> {
    const trimmed = String(ref ?? '').trim();
    if (!trimmed) throw new Error('A model id, file or name is required.');
    // AddSimpleModel ids are often negative (e.g. -2000), so allow a sign.
    const numeric = /^-?\d{1,5}$/.test(trimmed);

    if (numeric) {
      const index = this.scanResult ?? await this.scanIndex();
      const mapped = index?.modelIds?.[trimmed];
      const candidates: string[] = [];
      if (mapped?.dff) candidates.push(mapped.dff);
      candidates.push(`${trimmed}.dff`, `model${trimmed}.dff`, `models/${trimmed}.dff`);
      for (const candidate of candidates) {
        const file = this.resolvePath(candidate);
        if (existsSync(file)) {
          const bytes = await fs.readFile(file);
          return {
            label: `model ${trimmed} (${path.basename(file)})`,
            source: mapped?.source ?? this.rel(file),
            file,
            archive: null,
            name: path.basename(file, path.extname(file)),
            bytes,
            txdHint: hint?.txd || mapped?.txd || path.basename(file, path.extname(file)),
          };
        }
      }
      throw new Error(
        `model id ${trimmed} has no .dff on this machine — add one under <root>/models as ${trimmed}.dff, declare it via `
        + 'AddSimpleModel, or pass the model file/name directly (a bare name is also searched inside the .img archives).',
      );
    }

    // Only a ref with a directory separator is treated as a path — a bare
    // "infernus.dff" is searched like any other name (on disk, then in archives).
    if (/[\\/]/.test(trimmed)) {
      const file = path.isAbsolute(trimmed) ? trimmed : this.abs(trimmed);
      if (!existsSync(file)) throw new Error(`model file not found: ${this.rel(file)}`);
      const bytes = await fs.readFile(file);
      return {
        label: path.basename(file),
        source: this.rel(file),
        file,
        archive: null,
        name: path.basename(file, path.extname(file)),
        bytes,
        txdHint: hint?.txd || path.basename(file, path.extname(file)),
      };
    }

    // A bare name: whatever the last scan indexed, then the usual folders, then
    // inside the indexed .img archives.
    const want = trimmed.toLowerCase().endsWith('.dff') ? trimmed : `${trimmed}.dff`;
    // GTA model files often use upper-case extensions (wheels.DFF).
    const base = path.basename(want).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    const index = this.scanResult ?? await this.scanIndex();
    const indexed = index?.dffs.find((dff) => path.basename(dff.file).replace(/\.[a-z0-9]+$/i, '').toLowerCase() === base);
    if (indexed) {
      const file = this.resolvePath(indexed.file);
      if (existsSync(file)) {
        const bytes = await fs.readFile(file);
        return {
          label: path.basename(file),
          source: this.rel(file),
          file,
          archive: null,
          name: path.basename(file, path.extname(file)),
          bytes,
          txdHint: hint?.txd || path.basename(file, path.extname(file)),
        };
      }
    }
    for (const dir of [this.root, this.abs('models'), this.abs('models', 'dff'), this.abs(...MODEL_EXPORT_DIR)]) {
      const file = path.join(dir, want);
      if (existsSync(file)) {
        const bytes = await fs.readFile(file);
        return {
          label: path.basename(file),
          source: this.rel(file),
          file,
          archive: null,
          name: path.basename(file, path.extname(file)),
          bytes,
          txdHint: hint?.txd || path.basename(file, path.extname(file)),
        };
      }
    }
    await this.ensureArchives();
    for (const archive of this.archives.values()) {
      const entry = findImgEntry(archive, want);
      if (!entry) continue;
      const bytes = await readImgEntry(archive.file, entry);
      if (!bytes) continue;
      return {
        label: `${entry.name} (${path.basename(archive.file)})`,
        source: `${this.rel(archive.file)} → ${entry.name}`,
        file: null,
        archive: archive.file,
        name: entry.name.replace(/\.[a-z0-9]+$/i, ''),
        bytes,
        txdHint: hint?.txd || entry.name.replace(/\.[a-z0-9]+$/i, ''),
      };
    }
    throw new Error(`model "${trimmed}" was not found on disk or in an .img archive — run model_scan to list what is available`);
  }

  private async scanIndex(): Promise<ModelScanResult | null> {
    const file = this.abs(...MODEL_INDEX_FILE);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as ModelScanResult & { root: string };
      if (parsed.root !== this.root) return null;
      this.scanResult = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  private async ensureArchives(): Promise<void> {
    if (this.archives.size) return;
    const index = this.scanResult ?? await this.scanIndex();
    for (const record of index?.archives ?? []) {
      const archive = await readImgIndex(path.isAbsolute(record.file) ? record.file : this.abs(record.file));
      this.archives.set(path.resolve(archive.file), archive);
    }
  }

  /** Finds a texture for a material name: hint/sibling .txd, scanned .txd files, then PNG overrides. */
  private async resolveTexture(name: string, ctx: { dir: string | null; archive: string | null; txdHint: string }): Promise<DecodedTexture | null> {
    const key = name.toLowerCase();
    if (this.textureCache.has(key)) return this.textureCache.get(key) ?? null;

    const candidates: Array<{ buffer: Buffer; file: string }> = [];
    // "vehicle" and "generic" are the stock dictionaries most SA models use.
    const wanted = [ctx.txdHint, String(name), 'vehicle', 'generic', 'samp'].filter(Boolean);
    const baseDirs = [ctx.dir, this.root, this.abs('models', 'txd'), this.abs('models'), this.abs(...MODEL_TEXTURE_DIR)]
      .filter((dir): dir is string => Boolean(dir));
    // GTA keeps the shared dictionaries a level down (models/generic/vehicle.txd).
    const dirs = [...baseDirs, ...baseDirs.map((dir) => path.join(dir, 'generic'))];
    for (const txdName of wanted) {
      for (const dir of dirs) {
        const file = path.join(dir, `${txdName}.txd`);
        if (!existsSync(file)) continue;
        const buffer = this.txdBuffers.get(file) ?? await fs.readFile(file).catch(() => null);
        if (!buffer) continue;
        this.txdBuffers.set(file, buffer);
        candidates.push({ buffer, file });
      }
    }
    if (ctx.archive) {
      const archive = this.archives.get(path.resolve(ctx.archive)) ?? await readImgIndex(ctx.archive);
      this.archives.set(path.resolve(ctx.archive), archive);
      for (const txdName of wanted) {
        const entry = findImgEntry(archive, `${txdName}.txd`);
        if (!entry) continue;
        const buffer = await readImgEntry(archive.file, entry);
        if (buffer) candidates.push({ buffer, file: `${archive.file}→${entry.name}` });
      }
    }
    for (const file of this.txdFiles) {
      const buffer = this.txdBuffers.get(file) ?? await fs.readFile(file).catch(() => null);
      if (!buffer) continue;
      this.txdBuffers.set(file, buffer);
      candidates.push({ buffer, file });
    }

    for (const candidate of candidates) {
      if (!this.txdHasTexture(candidate.file, candidate.buffer, key)) continue;
      const decoded = decodeTxdTexture(candidate.buffer, key);
      if (decoded) {
        this.textureCache.set(key, decoded);
        return decoded;
      }
    }

    // Design-time PNG: `<txd>__<texture>.png`, `<texture>.png`, or any `*__<texture>.png`.
    const pngDirs = [this.abs(...SPRITE_ASSET_DIR), this.abs(...MODEL_TEXTURE_DIR), ...dirs];
    const pngCandidates: string[] = [];
    for (const dir of pngDirs) {
      pngCandidates.push(path.join(dir, `${key}.png`), path.join(dir, `${key}__${key}.png`));
      const listed = await fs.readdir(dir).catch(() => [] as string[]);
      for (const file of listed) {
        if (/\.png$/i.test(file) && file.toLowerCase().endsWith(`__${key}.png`)) pngCandidates.push(path.join(dir, file));
      }
    }
    for (const file of pngCandidates) {
      if (!existsSync(file)) continue;
      const png = decodePng(await fs.readFile(file).catch(() => Buffer.alloc(0)));
      if (!png) continue;
      this.textureCache.set(key, png);
      return png;
    }

    this.textureCache.set(key, null);
    return null;
  }

  private txdHasTexture(file: string, buffer: Buffer, key: string): boolean {
    let index = this.txdTextures.get(file);
    if (!index) {
      const dictionary = parseTxd(buffer, file);
      index = new Map(dictionary.textures.map((texture) => [texture.name.toLowerCase(), texture]));
      this.txdTextures.set(file, index);
    }
    if (index.has(key)) return true;
    // GTA texture names are often suffixed/augmented (e.g. "wheel_lr" in "wheel_lr_dam").
    for (const name of index.keys()) if (name.startsWith(key)) return true;
    return false;
  }

  /** renderMesh samples synchronously — loadModel pre-decodes every referenced texture. */
  private textureLookup(): (name: string) => DecodedTexture | null {
    return (name: string): DecodedTexture | null => this.textureCache.get(name.toLowerCase()) ?? null;
  }

  /** Parses a model and pre-decodes every texture its materials reference. */
  private async loadModel(ref: string, opts: { txd?: string } = {}): Promise<{ located: LocatedModel; model: DffModel; mesh: MeshData; ctx: { dir: string | null; archive: string | null; txdHint: string }; missing: string[] }> {
    const located = await this.locate(ref, opts);
    const model = parseDff(located.bytes, located.label);
    const mesh = flattenDff(model);
    const ctx = {
      // Archive entries keep their textures next to the archive (models/,
      // models/generic/) or inside the archive itself.
      dir: located.file ? path.dirname(located.file) : located.archive ? path.dirname(located.archive) : null,
      archive: located.archive,
      txdHint: located.txdHint,
    };
    const missing: string[] = [];
    for (const texture of model.textures) {
      const decoded = await this.resolveTexture(texture, ctx);
      if (!decoded) missing.push(texture);
    }
    return { located, model, mesh, ctx, missing };
  }

  /** Renders a model to a PNG and stores it in the textdraw model asset folder. */
  async preview(ref: string, opts: {
    rot?: [number, number, number];
    zoom?: number;
    width?: number;
    height?: number;
    background?: [number, number, number, number] | null;
    vehCol?: [number, number];
    txd?: string;
    saveAs?: string;
    cameraYaw?: number;
    cameraPitch?: number;
    supersample?: number;
  } = {}): Promise<ModelPreviewResult> {
    if (!this.root) throw new Error('No SA-MP server root configured — call set_server_root first.');
    const rot: [number, number, number] = [
      opts.rot?.[0] ?? 0,
      opts.rot?.[1] ?? 0,
      opts.rot?.[2] ?? 0,
    ];
    const zoom = opts.zoom ?? 1;
    const width = Math.max(16, Math.min(1024, Math.round(opts.width ?? DEFAULT_PREVIEW_SIZE)));
    const height = Math.max(16, Math.min(1024, Math.round(opts.height ?? width)));
    const { located, model, mesh, missing } = await this.loadModel(ref, { txd: opts.txd });

    const result: MeshRenderResult = renderMesh(mesh, {
      width,
      height,
      rot,
      zoom,
      background: opts.background ?? null,
      vehCol: opts.vehCol,
      cameraYaw: opts.cameraYaw,
      cameraPitch: opts.cameraPitch,
      supersample: opts.supersample,
      texture: this.textureLookup(),
    });

    const base = opts.saveAs ? modelKey(opts.saveAs) : slug(located.name);
    const variant = this.variantSuffix(rot, zoom, opts);
    const fileName = `${base}${variant}.png`;
    const file = this.abs(...MODEL_ASSET_DIR, fileName);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const png = encodePng(result.image);
    await fs.writeFile(file, png);
    this.dataUrlCache.clear();

    return {
      model: ref,
      source: located.source,
      file: this.rel(file),
      width: result.image.width,
      height: result.image.height,
      bytes: png.length,
      render: { rot, zoom, triangles: result.triangles, drawn: result.drawn, coverage: Number(result.coverage.toFixed(4)) },
      mesh: mesh.stats,
      stats: model.stats,
      textures: { used: result.texturesUsed, missing },
      warnings: [...new Set([...model.warnings, ...mesh.warnings])].slice(0, 12),
    };
  }

  private variantSuffix(rot: [number, number, number], zoom: number, opts: { background?: [number, number, number, number] | null; cameraYaw?: number; cameraPitch?: number }): string {
    const plain = rot.every((value) => Math.abs(value) < 0.001) && Math.abs(zoom - 1) < 0.001
      && !opts.background && opts.cameraYaw === undefined && opts.cameraPitch === undefined;
    if (plain) return '';
    const parts = [
      `r${rot.map((value) => Math.round(value)).join('_')}`,
      `z${Number(zoom.toFixed(2))}`,
    ];
    if (opts.cameraYaw !== undefined || opts.cameraPitch !== undefined) parts.push(`c${Math.round(opts.cameraYaw ?? 40)}_${Math.round(opts.cameraPitch ?? 20)}`);
    if (opts.background) parts.push(`bg${opts.background.join('')}`);
    return `__${parts.join('-')}`;
  }

  /** Renders the model best matching a textdraw's font 5 settings (used by the preview page). */
  async textdrawAsset(modelId: number, opts: { rot?: [number, number, number]; zoom?: number; vehCol?: [number, number]; size?: number; txd?: string; render?: boolean } = {}): Promise<{ file: string; width: number; height: number; source: string } | null> {
    if (!this.root) return null;
    const size = Math.max(32, Math.min(512, Math.round(opts.size ?? DEFAULT_PREVIEW_SIZE)));
    const rot: [number, number, number] = [opts.rot?.[0] ?? 0, opts.rot?.[1] ?? 0, opts.rot?.[2] ?? 0];
    const zoom = opts.zoom ?? 1;
    const fileName = `${modelKey(modelId)}${this.variantSuffix(rot, zoom, {})}.png`;
    const file = this.abs(...MODEL_ASSET_DIR, fileName);
    if (existsSync(file)) {
      return { file, width: size, height: size, source: `models/${fileName} (cached render)` };
    }
    if (opts.render === false) return null;
    let result: ModelPreviewResult;
    try {
      result = await this.preview(String(modelId), { rot, zoom, width: size, height: size, vehCol: opts.vehCol, txd: opts.txd, saveAs: String(modelId) });
    } catch {
      return null;
    }
    return {
      file: this.abs(...MODEL_ASSET_DIR, fileName),
      width: result.width,
      height: result.height,
      source: `${result.source} · ${result.render.triangles} tri · textures ${result.textures.used.length}/${result.textures.used.length + result.textures.missing.length}`,
    };
  }

  /** Inline data URL for the live editor (orbiting a font 5 textdraw re-renders it). */
  async renderDataUrl(ref: string, opts: {
    rot?: [number, number, number];
    zoom?: number;
    size?: number;
    vehCol?: [number, number];
    txd?: string;
  } = {}): Promise<{ url: string; width: number; height: number; cacheKey: string; source: string; missing: string[] }> {
    const size = Math.max(32, Math.min(512, Math.round(opts.size ?? DEFAULT_PREVIEW_SIZE)));
    const rot = opts.rot ?? [0, 0, 0];
    const zoom = opts.zoom ?? 1;
    const cacheKey = `${ref}|${size}|${rot.join(',')}|${zoom}|${opts.vehCol?.join(',') ?? ''}`;
    const cached = this.dataUrlCache.get(cacheKey);
    if (cached) return { url: cached, width: size, height: size, cacheKey, source: 'cache', missing: [] };
    const { located, mesh, missing } = await this.loadModel(ref, { txd: opts.txd });
    const result = renderMesh(mesh, {
      width: size,
      height: size,
      rot: [rot[0], rot[1], rot[2]],
      zoom,
      vehCol: opts.vehCol,
      texture: this.textureLookup(),
    });
    const url = `data:image/png;base64,${encodePng(result.image).toString('base64')}`;
    if (this.dataUrlCache.size > 64) this.dataUrlCache.clear();
    this.dataUrlCache.set(cacheKey, url);
    return { url, width: result.image.width, height: result.image.height, cacheKey, source: located.source, missing };
  }

  /** Exports a model for external tools: OBJ + MTL, or glTF 2.0 (textures as PNG next to it). */
  async exportModel(ref: string, opts: { format?: 'obj' | 'gltf'; out?: string; txd?: string } = {}): Promise<ModelExportResult> {
    if (!this.root) throw new Error('No SA-MP server root configured — call set_server_root first.');
    const format = opts.format ?? 'obj';
    const { located, model, mesh, missing } = await this.loadModel(ref, { txd: opts.txd });
    const name = slug(located.name);
    const outDir = opts.out
      ? (path.isAbsolute(opts.out) ? opts.out : this.abs(opts.out))
      : this.abs(...MODEL_EXPORT_DIR, name);
    await fs.mkdir(outDir, { recursive: true });

    const files: string[] = [];
    const textureFiles: Record<string, string> = {};
    const exported: string[] = [];
    for (const texture of model.textures) {
      const decoded = this.textureCache.get(texture.toLowerCase());
      if (!decoded) continue;
      const fileName = `${slug(texture)}.png`;
      await fs.writeFile(path.join(outDir, fileName), encodePng(decoded));
      textureFiles[texture.toLowerCase()] = fileName;
      files.push(path.join(outDir, fileName));
      exported.push(texture);
    }

    if (format === 'gltf') {
      const file = path.join(outDir, `${name}.gltf`);
      const gltf = exportGltf(mesh, { name, textureFiles });
      // Embed only what the texture files actually contain; the images are external siblings.
      await fs.writeFile(file, gltf, 'utf8');
      files.unshift(file);
    } else {
      const { obj, mtl } = exportObj(mesh, { name, mtlFile: `${name}.mtl`, textureFiles });
      const objFile = path.join(outDir, `${name}.obj`);
      const mtlFile = path.join(outDir, `${name}.mtl`);
      await fs.writeFile(objFile, obj, 'utf8');
      await fs.writeFile(mtlFile, mtl, 'utf8');
      files.unshift(mtlFile);
      files.unshift(objFile);
    }

    return {
      model: ref,
      source: located.source,
      format,
      files: files.map((file) => this.rel(file)),
      mesh: mesh.stats,
      textures: { exported, missing },
    };
  }
}

export const models = new ModelManager();
