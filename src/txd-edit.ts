import * as fs from 'fs/promises';
import path from 'node:path';
import {
  CHUNK_TEXTURENATIVE,
  decodeTxdTextureAt,
  decodePng,
  encodePng,
  parseTxd,
  readTxdSections,
  rwVersionString,
  type DecodedTexture,
  type TxdPixelFormat,
  type TxdWriteFormat,
} from './txd.js';
import {
  RW_SA_VERSION,
  TXD_MAX_TEXTURE_SIZE,
  TXD_NAME_LIMIT,
  TXD_TEXTURE_FORMATS,
  buildMipChain,
  buildTxdBuffer,
  textureChunkBytes,
  textureFormatHeader,
  textureUsesAlpha,
  type TxdQuality,
  type TxdWriteEntry,
} from './txd-write.js';
import { findImgEntry, readImgEntry, readImgIndex, writeImgEntry, type ImgWriteResult } from './img.js';

/**
 * Editable texture dictionaries — the Magic.TXD half of samp-mcp: open a .txd
 * (or a dictionary inside a VER2 .img), import PNGs as new/replacement textures,
 * rename/duplicate/remove them, convert between raster formats (with mip chains),
 * export textures as PNG and save the dictionary back to disk or into the .img.
 *
 * Design rules that keep a save safe:
 *  - textures the editor did not touch are written back byte for byte from the
 *    original file, so Direct3D 8 dictionaries, paletted rasters and writer
 *    quirks survive untouched,
 *  - a file save copies the previous file to `<name>.txd.bak` first,
 *  - an .img save only rewrites the one entry's sectors (in place) or appends at
 *    the end of the archive and updates that entry's directory slot — nothing
 *    else in a multi-gigabyte game archive is ever moved.
 *
 * Workspaces live in memory for the lifetime of the MCP server, so an agent can
 * edit a dictionary across several tool calls and only then save it.
 */

/** The name a fresh, empty dictionary is created with. */
const DEFAULT_TXD_NAME = 'samp_mcp_texture';

/** Where decoded textures are written when the caller does not pick a directory. */
const EXPORT_DIR = ['.samp-mcp', 'txd-export'];

export interface TxdTextureInfo {
  name: string;
  mask: string;
  format: TxdPixelFormat;
  width: number;
  height: number;
  levels: number;
  /** Bytes of the raster including the mip levels. */
  bytes: number;
  hasAlpha: boolean;
  platform: number;
  filterMode: number;
  /** True when the editor holds decoded pixels for this texture. */
  editable: boolean;
  /** True when the bytes differ from what is on disk. */
  dirty: boolean;
  /** Block-compression effort used the next time this texture is encoded as DXT. */
  quality: TxdQuality;
  error?: string;
}

export interface TxdWorkspaceInfo {
  id: string;
  /** Path of the .txd (relative to the server root), or the pending save target. */
  file: string;
  /** Set when the dictionary was opened from (and saves back into) a .img. */
  archive?: string;
  dictionary: string;
  deviceId: number;
  version: string;
  textures: TxdTextureInfo[];
  /** Size of the file as it is on disk (0 for a dictionary that was just created). */
  sourceBytes: number;
  /** Size the dictionary would have if it were saved right now. */
  outputBytes: number;
  dirty: boolean;
  notes: string[];
}

export interface TxdImportOptions {
  name: string;
  image: DecodedTexture;
  format?: TxdWriteFormat | 'auto';
  /** Mip levels to generate: a count, 'full' for the whole chain, 'keep' to copy the replaced texture's count. */
  mipmaps?: number | 'full' | 'keep';
  mask?: string;
  filterMode?: number;
  /**
   * Block-compression effort for the DXT formats (default 'high'): 'high' runs the
   * squish-style cluster/least-squares refinement, 'fast' a single range fit.
   */
  quality?: TxdQuality;
}

export interface TxdExportResult {
  dictionary: string;
  files: { name: string; file: string; bytes: number; width: number; height: number; format: TxdPixelFormat; levels: number }[];
  missing: string[];
}

export interface TxdSaveResult {
  id: string;
  file: string;
  bytes: number;
  textures: number;
  target: 'file' | 'img';
  mode?: 'in-place' | 'appended';
  sector?: number;
  sectors?: number;
  backup?: string;
  warnings: string[];
}

interface EditableTexture {
  name: string;
  mask: string;
  /** The raster format the texture is (or will be) stored in. */
  format: TxdWriteFormat | null;
  /**
   * Pixels of the texture: level 0 as decoded from the file, or the full chain
   * after an import/convert. Only written when `reencoded` is set.
   */
  levels: DecodedTexture[] | null;
  /**
   * Original textureNative section — what gets written for a texture whose
   * pixels were not touched, so untouched textures (mip levels, Direct3D 8
   * headers, formats this build cannot encode) survive a save byte for byte.
   */
  section: Buffer | null;
  /** True once the pixels changed (import/replace/convert), which switches the write path to `levels`. */
  reencoded: boolean;
  filterMode: number;
  platform: number;
  formatOnDisk: TxdPixelFormat;
  levelsOnDisk: number;
  /** Effort for the next DXT encode of this texture (see TxdQuality). */
  quality: TxdQuality;
  /** Reported state: true when this texture differs from what is on disk. */
  dirty: boolean;
  error?: string;
}

class TxdWorkspace {
  id: string;
  file: string | null;
  archive: string | null;
  entry: string | null;
  dictionary: string;
  deviceId: number;
  version: number;
  textures: EditableTexture[] = [];
  sourceBytes = 0;
  dirty = false;
  notes: string[] = [];

  constructor(opts: { id: string; file: string | null; dictionary: string; deviceId: number; version: number; archive?: string | null; entry?: string | null }) {
    this.id = opts.id;
    this.file = opts.file;
    this.dictionary = opts.dictionary;
    this.deviceId = opts.deviceId;
    this.version = opts.version;
    this.archive = opts.archive ?? null;
    this.entry = opts.entry ?? null;
  }

  /** The dictionary as it would be written to disk right now. */
  toBuffer(): Buffer {
    return buildTxdBuffer({ textures: this.entries(), deviceId: this.deviceId, version: this.version });
  }

  /** How one texture is written: re-encoded pixels, or its original section. */
  entryFor(texture: EditableTexture): TxdWriteEntry | null {
    if (texture.reencoded && texture.levels && texture.format) {
      return {
        name: texture.name,
        mask: texture.mask,
        format: texture.format,
        levels: texture.levels,
        filterMode: texture.filterMode,
        quality: texture.quality,
        // Re-encoded data always uses the 92-byte Direct3D 9 layout, even when
        // the section it replaces came from a legacy Direct3D 8 dictionary.
        platform: 9,
      };
    }
    return texture.section ? { section: texture.section } : null;
  }

  entries(): TxdWriteEntry[] {
    return this.textures.map((texture) => {
      const entry = this.entryFor(texture);
      if (!entry) throw new Error(`"${texture.name}" has neither pixels nor original bytes to write back`);
      return entry;
    });
  }

  find(name: string): EditableTexture | undefined {
    const wanted = name.trim().toLowerCase();
    return this.textures.find((texture) => texture.name.toLowerCase() === wanted);
  }
}

export class TxdEditorManager {
  private root = '';
  private workspaces = new Map<string, TxdWorkspace>();

  /** Called by set_server_root; every relative path is resolved against this. */
  setRoot(root: string): void {
    const resolved = path.resolve(root);
    if (resolved !== this.root) {
      // Workspaces that were never saved cannot survive a root change.
      for (const [id, workspace] of this.workspaces) {
        if (!workspace.file) this.workspaces.delete(id);
      }
    }
    this.root = resolved;
  }

  private rootOrThrow(): string {
    if (!this.root) throw new Error("No SAMP server root set. Use 'set_server_root' first.");
    return this.root;
  }

  private abs(file: string): string {
    this.rootOrThrow();
    return path.isAbsolute(file) ? path.normalize(file) : path.join(this.root, file);
  }

  /** How a path is shown to the user: relative to the server root when possible. */
  private display(file: string): string {
    const relative = path.relative(this.root, file);
    if (!relative || relative.startsWith('..')) return file.split(path.sep).join('/');
    return relative.split(path.sep).join('/');
  }

  private idFor(file: string, entry?: string | null): string {
    const base = this.display(file);
    return entry ? `${base}#${entry}` : base;
  }

  list(): TxdWorkspaceInfo[] {
    return [...this.workspaces.values()].map((workspace) => this.describe(workspace));
  }

  // -------------------------------------------------------------------------
  // Opening
  // -------------------------------------------------------------------------

  async open(opts: { file?: string; img?: string; entry?: string; create?: boolean }): Promise<TxdWorkspaceInfo> {
    return this.describe(await this.openWorkspace(opts));
  }

  /** Reads a PNG (a design image, or a texture exported earlier) as RGBA pixels. */
  async loadPng(file: string): Promise<{ image: DecodedTexture; file: string }> {
    const target = this.abs(file);
    const buffer = await fs.readFile(target).catch(() => null);
    if (!buffer) throw new Error(`cannot read ${this.display(target)}`);
    const image = decodePng(buffer);
    if (!image) {
      throw new Error(`${this.display(target)} is not a PNG this decoder understands (8/16-bit, non-interlaced, colour type 0/2/3/4/6)`);
    }
    return { image, file: this.display(target) };
  }

  private async openWorkspace(opts: { file?: string; img?: string; entry?: string; create?: boolean }): Promise<TxdWorkspace> {
    if (opts.img) return this.openFromArchive(opts.img, opts.entry);
    if (!opts.file) {
      throw new Error('pass file (a .txd path), img + entry (a dictionary inside an archive), or create=true');
    }
    const file = this.abs(opts.file);
    const existing = this.byId(this.idFor(file));
    if (existing) return existing;

    const buffer = await fs.readFile(file).catch(() => null);
    if (!buffer) {
      if (!opts.create) {
        const stat = await fs.stat(file).catch(() => null);
        if (stat?.isDirectory()) throw new Error(`${this.display(file)} is a directory, not a .txd file`);
        throw new Error(`cannot read ${this.display(file)} (pass create=true to start a new dictionary)`);
      }
      const workspace = new TxdWorkspace({
        id: this.idFor(file),
        file,
        dictionary: path.basename(file).replace(/\.txd$/i, '') || DEFAULT_TXD_NAME,
        deviceId: 2,
        version: RW_SA_VERSION,
      });
      workspace.dirty = true;
      workspace.notes.push('new dictionary — add textures with txd_import_texture, then txd_save');
      this.workspaces.set(workspace.id, workspace);
      return workspace;
    }
    if (!/\.txd$/i.test(file)) {
      const parsed = parseTxd(buffer, file);
      if (parsed.error && parsed.textures.length === 0) {
        throw new Error(`${this.display(file)} is not a RenderWare texture dictionary (${parsed.error})`);
      }
    }
    const workspace = this.loadWorkspace(this.idFor(file), file, buffer);
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  private async openFromArchive(img: string, entry?: string): Promise<TxdWorkspace> {
    if (!entry) throw new Error('pass entry (the .txd name inside the archive, e.g. "vehicle.txd")');
    const archivePath = this.abs(img);
    const id = this.idFor(archivePath, entry);
    const cached = this.byId(id);
    if (cached) return cached;

    const archive = await readImgIndex(archivePath);
    if (archive.error || archive.version !== 2) {
      throw new Error(`cannot read ${this.display(archivePath)} as a VER2 IMG archive${archive.error ? ` (${archive.error})` : ''}`);
    }
    const found = findImgEntry(archive, entry);
    if (!found) throw new Error(`"${entry}" is not inside ${this.display(archivePath)}`);
    const buffer = await readImgEntry(archive.file, found);
    if (!buffer) throw new Error(`could not extract "${entry}" from ${this.display(archivePath)}`);

    const workspace = this.loadWorkspace(id, null, buffer, {
      archive: archivePath,
      entry: found.name,
      displayFile: this.idFor(archivePath, found.name),
    });
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  private loadWorkspace(
    id: string,
    file: string | null,
    buffer: Buffer,
    img?: { archive: string; entry: string; displayFile: string },
  ): TxdWorkspace {
    const dict = parseTxd(buffer, file ?? img?.displayFile ?? id);
    const workspace = new TxdWorkspace({
      id,
      file,
      dictionary: dict.name || DEFAULT_TXD_NAME,
      deviceId: dict.deviceId,
      version: buffer.length >= 12 ? buffer.readUInt32LE(8) : RW_SA_VERSION,
      archive: img?.archive ?? null,
      entry: img?.entry ?? null,
    });
    workspace.sourceBytes = buffer.length;
    if (dict.error && dict.textures.length === 0) workspace.notes.push(dict.error);

    const sections = readTxdSections(buffer).filter((section) => section.type === CHUNK_TEXTURENATIVE);
    workspace.textures = dict.textures.map((meta, index) => {
      const section = sections[index] ? Buffer.from(buffer.subarray(sections[index].start, sections[index].end)) : null;
      const image = meta.decodable ? decodeTxdTextureAt(buffer, index) : null;
      const format = image && meta.format !== 'unknown' && meta.format !== 'PAL8' ? meta.format : null;
      return {
        name: meta.name,
        mask: meta.mask,
        format,
        levels: image && format ? [image] : null,
        section,
        // The decoded pixels are only a reference (for export and convert); the
        // section stays authoritative until an edit changes the pixels.
        reencoded: false,
        filterMode: meta.filterMode,
        platform: meta.platform,
        formatOnDisk: meta.format,
        levelsOnDisk: meta.numLevels,
        quality: 'high',
        dirty: false,
        error: meta.decodeError,
      } satisfies EditableTexture;
    });
    return workspace;
  }

  /** Finds an open workspace by id, by path, or by dictionary/file name. */
  private byId(ref: string): TxdWorkspace | undefined {
    const wanted = ref.trim().toLowerCase().split(path.sep).join('/');
    const direct = this.workspaces.get(ref) ?? this.workspaces.get(wanted);
    if (direct) return direct;
    for (const workspace of this.workspaces.values()) {
      if (workspace.id.toLowerCase() === wanted) return workspace;
      const base = workspace.id.split('#').pop()!.replace(/\.txd$/i, '');
      if (base.toLowerCase() === wanted) return workspace;
      if (this.display(workspace.file ?? '').toLowerCase() === wanted) return workspace;
    }
    return undefined;
  }

  /**
   * Turns a caller's reference into a workspace: an already open one (id, path
   * or name) or a dictionary loaded from disk on the spot.
   */
  async resolve(ref: string): Promise<TxdWorkspace> {
    const open = this.byId(ref);
    if (open) return open;
    if (ref.includes('#')) {
      const [img, entry] = ref.split('#');
      return this.openFromArchive(img, entry);
    }
    return this.openWorkspace({ file: ref });
  }

  // -------------------------------------------------------------------------
  // Describing
  // -------------------------------------------------------------------------

  private describe(workspace: TxdWorkspace): TxdWorkspaceInfo {
    const entries = workspace.textures.map((texture) => workspace.entryFor(texture));
    const info: TxdWorkspaceInfo = {
      id: workspace.id,
      file: workspace.archive ? this.idFor(workspace.archive, workspace.entry) : this.display(workspace.file ?? workspace.id),
      dictionary: workspace.dictionary,
      deviceId: workspace.deviceId,
      version: rwVersionString(workspace.version),
      textures: workspace.textures.map((texture, index) => ({
        name: texture.name,
        mask: texture.mask,
        format: texture.format ?? texture.formatOnDisk,
        width: texture.levels?.[0].width ?? 0,
        height: texture.levels?.[0].height ?? 0,
        levels: texture.format ? (texture.levels?.length ?? texture.levelsOnDisk) : texture.levelsOnDisk,
        bytes: entries[index] ? textureChunkBytes(entries[index]!) : 0,
        hasAlpha: texture.levels && texture.format ? textureUsesAlpha(texture.format, texture.levels[0]) : texture.formatOnDisk === '8888' || texture.formatOnDisk === '4444',
        platform: texture.platform,
        filterMode: texture.filterMode,
        editable: Boolean(texture.levels),
        dirty: texture.dirty,
        quality: texture.quality,
        error: texture.error,
      })),
      sourceBytes: workspace.sourceBytes,
      outputBytes: workspace.toBuffer().length,
      dirty: workspace.dirty,
      notes: workspace.notes,
    };
    if (workspace.archive) info.archive = this.display(workspace.archive);
    return info;
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  async importTexture(ref: string, opts: TxdImportOptions & { replace?: boolean }): Promise<{ workspace: TxdWorkspaceInfo; replaced: boolean }> {
    const workspace = await this.resolve(ref);
    const name = this.normalizeName(opts.name);
    const image = opts.image;
    const { width, height } = image;
    const format = this.pickFormat(opts.format);
    if (textureUsesAlpha('8888', image) && (textureFormatHeader(format, { mipmaps: false, alpha: true }).flags & 0x01) === 0) {
      workspace.notes.push(`${name}: the source PNG has transparency but ${format} stores none — transparent pixels become opaque (use 8888, DXT3 or DXT5)`);
    }
    const existing = workspace.find(name);
    if (existing && opts.replace === false) {
      throw new Error(`"${existing.name}" already exists in ${workspace.id} (pass replace=true to overwrite it)`);
    }
    const mipmaps = opts.mipmaps === 'keep' && existing
      ? Math.max(1, existing.levels?.length ?? 0, existing.levelsOnDisk)
      : opts.mipmaps ?? 1;
    const levels = buildMipChain(image, mipmaps === 'full' ? 'full' : Math.max(1, Number(mipmaps)));

    if (width > TXD_MAX_TEXTURE_SIZE || height > TXD_MAX_TEXTURE_SIZE) {
      workspace.notes.push(`${name}: ${width}x${height} is above ${TXD_MAX_TEXTURE_SIZE}px, which the SA renderer cannot load`);
    }
    if (width !== height && !this.isPowerOfTwo(width) && !this.isPowerOfTwo(height)) {
      workspace.notes.push(`${name}: non power-of-two size (${width}x${height}) — fine for textdraws, may blur on 3D models`);
    }

    const texture: EditableTexture = {
      name,
      mask: opts.mask ?? existing?.mask ?? '',
      format,
      levels,
      section: null,
      reencoded: true,
      filterMode: opts.filterMode ?? (levels.length > 1 ? 0x1106 : 0x1102),
      platform: 9,
      formatOnDisk: format,
      levelsOnDisk: levels.length,
      quality: opts.quality ?? 'high',
      dirty: true,
    };
    if (existing) {
      workspace.textures[workspace.textures.indexOf(existing)] = texture;
    } else {
      workspace.textures.push(texture);
    }
    workspace.dirty = true;
    return { workspace: this.describe(workspace), replaced: Boolean(existing) };
  }

  async editTexture(
    ref: string,
    action: 'rename' | 'duplicate' | 'remove' | 'convert',
    opts: { texture: string; name?: string; format?: TxdWriteFormat; mipmaps?: number | 'full' | 'keep'; filterMode?: number; quality?: TxdQuality },
  ): Promise<{ workspace: TxdWorkspaceInfo; message: string }> {
    const workspace = await this.resolve(ref);
    const texture = workspace.find(opts.texture);
    if (!texture) throw new Error(`"${opts.texture}" is not in ${workspace.id}`);

    if (action === 'remove') {
      workspace.textures.splice(workspace.textures.indexOf(texture), 1);
      workspace.dirty = true;
      return { workspace: this.describe(workspace), message: `removed "${texture.name}"` };
    }

    if (action === 'rename') {
      if (!opts.name) throw new Error('pass name (the new texture name)');
      const name = this.normalizeName(opts.name);
      const clash = workspace.textures.find((other) => other !== texture && other.name.toLowerCase() === name.toLowerCase());
      if (clash) throw new Error(`"${clash.name}" already exists in ${workspace.id}`);
      this.renameInSection(texture, name);
      texture.name = name;
      texture.dirty = true;
      workspace.dirty = true;
      return { workspace: this.describe(workspace), message: `renamed to "${name}"` };
    }

    if (action === 'duplicate') {
      const name = this.normalizeName(opts.name ?? `${texture.name}_copy`);
      if (workspace.textures.some((other) => other.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`"${name}" already exists in ${workspace.id}`);
      }
      const copy: EditableTexture = {
        ...texture,
        name,
        section: texture.section ? Buffer.from(texture.section) : null,
        levels: texture.levels?.map((level) => ({ width: level.width, height: level.height, rgba: Buffer.from(level.rgba) })) ?? null,
        dirty: true,
      };
      this.renameInSection(copy, name);
      workspace.textures.splice(workspace.textures.indexOf(texture) + 1, 0, copy);
      workspace.dirty = true;
      return { workspace: this.describe(workspace), message: `duplicated "${texture.name}" as "${name}"` };
    }

    // convert: re-encode the pixels in another raster format (and mip count)
    if (!texture.levels || !texture.format) {
      throw new Error(`"${texture.name}" is a ${texture.formatOnDisk} texture the decoder cannot read (${texture.error ?? 'unsupported raster'}), so it cannot be converted`);
    }
    const format = opts.format;
    if (!format) throw new Error(`pass format (${TXD_TEXTURE_FORMATS.join(', ')})`);
    const mipmaps = opts.mipmaps ?? 'keep';
    // "keep" means the level count the file already has — the decoded level 0 is
    // all the pixels that survive a decode, so the chain is rebuilt from it.
    const wanted = mipmaps === 'keep'
      ? Math.max(1, texture.levels.length, texture.levelsOnDisk)
      : mipmaps === 'full' ? 'full' : Math.max(1, Number(mipmaps));
    const levels = buildMipChain(texture.levels[0], wanted);
    texture.format = format;
    texture.levels = levels;
    texture.levelsOnDisk = Math.max(texture.levelsOnDisk, levels.length);
    texture.reencoded = true;
    texture.section = null;
    texture.platform = 9;
    texture.filterMode = opts.filterMode ?? (levels.length > 1 ? 0x1106 : 0x1102);
    texture.quality = opts.quality ?? texture.quality;
    texture.dirty = true;
    texture.error = undefined;
    workspace.dirty = true;
    const header = textureFormatHeader(format, { mipmaps: levels.length > 1, alpha: textureUsesAlpha(format, levels[0]) });
    const compressed = format === 'DXT1' || format === 'DXT3' || format === 'DXT5';
    const compression = compressed ? `, DXT quality ${texture.quality}` : '';
    return {
      workspace: this.describe(workspace),
      message: `"${texture.name}" converted to ${format} (rasterFormat 0x${header.rasterFormat.toString(16)}, d3dFormat 0x${(header.d3dFormat >>> 0).toString(16)}) with ${levels.length} level(s)${compression}`,
    };
  }

  /**
   * Renames inside the textureNative section itself (chunk header 12 + struct
   * header 12 + name at +8), which keeps every other byte — mip levels, D3D8
   * headers, rasters this build cannot decode — exactly as they were.
   */
  private renameInSection(texture: EditableTexture, name: string): void {
    if (!texture.section || texture.section.length < 32 + TXD_NAME_LIMIT) return;
    texture.section.fill(0, 32, 32 + 32);
    texture.section.write(name.slice(0, TXD_NAME_LIMIT), 32, TXD_NAME_LIMIT, 'latin1');
  }

  private normalizeName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('the texture name cannot be empty');
    if (trimmed.length > TXD_NAME_LIMIT) {
      throw new Error(`"${trimmed}" is ${trimmed.length} characters — texture names are limited to ${TXD_NAME_LIMIT} (the header field is char[32])`);
    }
    if (!/^[\x20-\x7e]+$/.test(trimmed)) throw new Error('texture names must be printable ASCII (the header field is char[32])');
    return trimmed;
  }

  private pickFormat(format: TxdImportOptions['format']): TxdWriteFormat {
    if (!format || format === 'auto') {
      // Lossless unless the caller asks for compression: an imported UI sprite
      // keeps every pixel, and 8888 is what stock SA dictionaries use most.
      return '8888';
    }
    if (!TXD_TEXTURE_FORMATS.includes(format)) {
      throw new Error(`unsupported format "${format}" (use ${TXD_TEXTURE_FORMATS.join(', ')} or auto)`);
    }
    return format;
  }

  private isPowerOfTwo(value: number): boolean {
    return value > 0 && (value & (value - 1)) === 0;
  }

  // -------------------------------------------------------------------------
  // Exporting
  // -------------------------------------------------------------------------

  async exportTexture(ref: string, opts: { texture?: string; out?: string }): Promise<TxdExportResult> {
    const workspace = await this.resolve(ref);
    const wanted = opts.texture
      ? workspace.textures.filter((texture) => texture.name.toLowerCase() === opts.texture!.trim().toLowerCase())
      : workspace.textures;
    if (!wanted.length) throw new Error(`no texture matching "${opts.texture}" in ${workspace.id}`);

    const dir = opts.out
      ? (path.isAbsolute(opts.out) ? opts.out : path.join(this.rootOrThrow(), opts.out))
      : path.join(this.rootOrThrow(), ...EXPORT_DIR, workspace.dictionary);
    await fs.mkdir(dir, { recursive: true });

    const result: TxdExportResult = { dictionary: workspace.dictionary, files: [], missing: [] };
    for (const texture of wanted) {
      const image = texture.levels?.[0] ?? (texture.section ? this.decodeSection(texture) : null);
      if (!image) {
        result.missing.push(texture.name);
        continue;
      }
      const file = path.join(dir, `${this.safeFileName(texture.name)}.png`);
      await fs.writeFile(file, encodePng(image));
      result.files.push({
        name: texture.name,
        file: this.display(file),
        bytes: image.width * image.height * 4,
        width: image.width,
        height: image.height,
        format: texture.format ?? texture.formatOnDisk,
        levels: texture.levels?.length ?? texture.levelsOnDisk,
      });
    }
    return result;
  }

  /** Decodes a verbatim section by temporarily wrapping it in a dictionary. */
  private decodeSection(texture: EditableTexture): DecodedTexture | null {
    if (!texture.section) return null;
    const wrapper = buildTxdBuffer({ textures: [{ section: texture.section }], deviceId: 0 });
    return decodeTxdTextureAt(wrapper, 0);
  }

  private safeFileName(name: string): string {
    return name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'texture';
  }

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  async save(ref: string, opts: { out?: string; img?: string; entry?: string; backup?: boolean }): Promise<TxdSaveResult> {
    const workspace = await this.resolve(ref);
    if (opts.img) return this.saveToArchive(workspace, opts.img, opts.entry);
    // A dictionary opened from an archive saves back into that archive unless a
    // file target was asked for.
    if (!opts.out && workspace.archive) {
      return this.saveToArchive(workspace, workspace.archive, opts.entry ?? workspace.entry ?? undefined);
    }
    const target = opts.out ? this.abs(opts.out) : workspace.file;
    if (!target) throw new Error('this dictionary is not on disk yet — pass out (the .txd path to create)');
    if (opts.out && opts.out.includes('#')) throw new Error('pass a .txd path in out (use img to write into an archive)');
    const fromArchive = Boolean(workspace.archive);

    const buffer = workspace.toBuffer();
    const warnings: string[] = [];
    await fs.mkdir(path.dirname(target), { recursive: true });
    let backup: string | undefined;
    const previous = await fs.readFile(target).catch(() => null);
    if (previous && opts.backup !== false) {
      backup = `${target}.bak`;
      await fs.writeFile(backup, previous);
    }

    // Verify before touching the disk: the rebuilt dictionary must parse back to
    // the same textures, otherwise a bug could ruin a game asset silently.
    const check = parseTxd(buffer, target);
    if (check.error && workspace.textures.length > 0) warnings.push(`saved file does not parse back cleanly: ${check.error}`);
    if (check.textures.length !== workspace.textures.length) {
      warnings.push(`saved file reports ${check.textures.length} textures but ${workspace.textures.length} were edited`);
    }
    for (const texture of workspace.textures) {
      if (!texture.levels) continue;
      if (!importedNameMatches(check, texture.name)) warnings.push(`texture "${texture.name}" did not survive the rewrite`);
    }
    if (previous && previous.length !== buffer.length) {
      warnings.push(`size changed from ${previous.length} to ${buffer.length} bytes (the game reads the chunk sizes, so this is only a note)`);
    }

    await fs.writeFile(target, buffer);
    if (fromArchive) {
      // An archive workspace keeps pointing at its entry, so writing a standalone
      // copy must not silently drop the pending archive edits.
      warnings.push('the open workspace is still bound to its .img entry — pass img/entry to update the archive itself');
    } else {
      this.workspaces.delete(workspace.id);
      const reopened = this.loadWorkspace(this.idFor(target), target, buffer);
      this.workspaces.set(reopened.id, reopened);
    }

    return {
      id: fromArchive ? workspace.id : this.idFor(target),
      file: this.display(target),
      bytes: buffer.length,
      textures: workspace.textures.length,
      target: 'file',
      backup: backup ? this.display(backup) : undefined,
      warnings,
    };
  }

  /** Replaces (or adds, when the entry is missing but the archive has room? no — replace only) one archive entry. */
  private async saveToArchive(workspace: TxdWorkspace, img: string, entry?: string): Promise<TxdSaveResult> {
    const archivePath = this.abs(img);
    const entryName = entry ?? workspace.entry;
    if (!entryName) throw new Error('pass entry (the .txd name inside the archive) and img (the archive path)');
    const buffer = workspace.toBuffer();
    const archive = await readImgIndex(archivePath);
    if (archive.error || archive.version !== 2) {
      throw new Error(`cannot write into ${this.display(archivePath)}: ${archive.error ?? `unsupported version ${archive.version}`}`);
    }
    const found = findImgEntry(archive, entryName);
    if (!found) {
      throw new Error(`"${entryName}" is not inside ${this.display(archivePath)} — an archive is only ever updated in place, so the entry has to exist`);
    }
    const result: ImgWriteResult = await writeImgEntry(archive.file, found, buffer);
    const warnings: string[] = [];
    if (result.mode === 'appended') {
      warnings.push('the new dictionary needed more sectors than the entry owned, so it was appended at the end of the archive (the old sectors are unused from now on)');
    }
    const verify = await readImgIndex(archivePath);
    const after = findImgEntry(verify, entryName);
    if (!after || after.byteLength < buffer.length) warnings.push('could not verify the written entry size — check the dictionary in game');
    this.workspaces.delete(workspace.id);
    return {
      id: workspace.id,
      file: this.display(archivePath),
      bytes: buffer.length,
      textures: workspace.textures.length,
      target: 'img',
      mode: result.mode,
      sector: result.sector,
      sectors: result.sectors,
      warnings,
    };
  }

  /** Drops an in-memory workspace without writing anything. */
  discard(ref: string): string {
    const workspace = this.byId(ref) ?? [...this.workspaces.values()].find((candidate) => candidate.dictionary.toLowerCase() === ref.trim().toLowerCase());
    if (!workspace) throw new Error(`no open dictionary matches "${ref}"`);
    this.workspaces.delete(workspace.id);
    return `closed ${workspace.id} without saving (${workspace.textures.length} textures)`;
  }
}

/** Name comparison used by the save-time verification pass. */
function importedNameMatches(dict: { textures: { name: string }[] }, name: string): boolean {
  return dict.textures.some((texture) => texture.name.toLowerCase() === name.toLowerCase());
}
