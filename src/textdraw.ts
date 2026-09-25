import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';
import { existsSync } from 'fs';
import { parseTxd, decodeTxdTexture, encodePng, shrinkTexture, pngDataUrl, type TxdDictionary, type TxdTexture } from './txd.js';
import { models, MODEL_ASSET_DIR, SPRITE_ASSET_DIR } from './model.js';

/**
 * SA-MP Textdraw Editor subsystem.
 *
 * Textdraws are stored as editable project files under
 * `<server root>/.samp-mcp/textdraws/<project>.json`, so an agent can design a
 * UI, keep it in version control next to the gamemode, import existing
 * TextDrawCreate code, export Pawn again — and look at the result in a browser
 * (static page or live editor server) without starting the game.
 *
 * Conventions used throughout:
 *  - coordinates live on the classic 640x448 textdraw grid (x * W/640, y * H/448 on screen),
 *  - colours are SA-MP ARGB ("0xRRGGBBAA"), the same order Pawn uses,
 *  - font 4 = txd sprite ("txdname:texturename"), font 5 = 3D model preview.
 */

type TextdrawTarget = 'global' | 'player';

interface TextdrawDef {
  id: string;
  name: string;
  target: TextdrawTarget;
  text: string;
  x: number;
  y: number;
  letterWidth: number;
  letterHeight: number;
  textSizeX: number;
  textSizeY: number;
  font: number;
  alignment: number;
  color: string;
  boxColor: string;
  background: string;
  shadow: number;
  outline: number;
  proportional: boolean;
  box: boolean;
  selectable: boolean;
  previewModel?: number;
  previewRot?: [number, number, number];
  previewZoom?: number;
  previewVehCol?: [number, number];
  /** Preview-only bitmap (png/jpg) relative to the server root, or absolute inside it. */
  image?: string;
  group?: string;
  note?: string;
  visible?: boolean;
}

interface SimpleModelEntry {
  baseid: number;
  newid: number;
  dff: string;
  txd: string;
}

interface TextdrawProject {
  name: string;
  baseWidth: number;
  baseHeight: number;
  createdAt: string;
  updatedAt: string;
  simpleModels: SimpleModelEntry[];
  textdraws: TextdrawDef[];
}

interface PreviewAsset {
  url: string;
  width: number;
  height: number;
  source: string;
}

interface PreviewPayload {
  project: string;
  baseWidth: number;
  baseHeight: number;
  generatedAt: string;
  textdraws: TextdrawDef[];
  warnings: string[];
  simpleModels: SimpleModelEntry[];
  /** key = "txdname:spritename" (lower case). */
  assets: Record<string, PreviewAsset>;
  /** key = model id. */
  models: Record<string, PreviewAsset>;
  /** key = textdraw id — the optional design bitmap a textdraw carries (`image`). */
  images: Record<string, PreviewAsset>;
  stats: { global: number; player: number; fonts: Record<string, number>; groups: string[] };
  /** In-game text metrics shipped to the page: font atlases, colour codes, grid. */
  metrics: {
    baseWidth: number;
    baseHeight: number;
    lineHeightUnits: number;
    glyphHeightUnits: number;
    colorCodes: Record<string, string>;
    atlas: Record<string, { prop: number[]; unprop: number }>;
  };
}

interface PreviewBuildResult {
  htmlPath: string;
  dataPath: string;
  assetDir: string;
  url: string | null;
  textdraws: number;
  assets: number;
  /** font 5 textdraws that got a real 3D render (from a .dff) instead of a placeholder */
  models: number;
  missingModels: string[];
  missingTextures: string[];
  /** sprites drawn from a design-time PNG/JPG because no .txd on this machine has them yet */
  designOverrides: string[];
  warnings: string[];
}

interface TxdScanResult {
  scannedFiles: number;
  dictionaries: {
    file: string;
    name: string;
    version: string;
    deviceId: number;
    textureCount: number;
    error?: string;
  }[];
  textures: {
    key: string;
    txd: string;
    name: string;
    width: number;
    height: number;
    format: string;
    decodable: boolean;
    png?: string;
    error?: string;
  }[];
  indexFile: string;
}

interface TxdIndex {
  root: string;
  scannedAt: string;
  assets: Record<string, PreviewAsset>;
  textures: TxdScanResult['textures'];
  dictionaries: TxdScanResult['dictionaries'];
}

const DEFAULT_BASE_WIDTH = 640;
/**
 * SA-MP textdraws live on a 640x448 canvas (the wiki documents the same number
 * for TextDrawCreate, and Leonardo541's editor scales y by height/448 as well),
 * so vertical scaling is H/448 even on 4:3 resolutions.
 */
const DEFAULT_BASE_HEIGHT = 448;
const STORE_DIR = ['.samp-mcp', 'textdraws'];
const PREVIEW_DIR = ['.samp-mcp', 'textdraw-preview'];
const ASSET_DIR = ['.samp-mcp', 'textdraw-preview', 'assets'];
/**
 * Font 5 model preview art lives in MODEL_ASSET_DIR (owned by src/model.ts,
 * which renders it from the server's .dff/.txd files) and sprite overrides in
 * SPRITE_ASSET_DIR — both are shared with the model pipeline.
 */
const TXD_INDEX_FILE = ['.samp-mcp', 'textdraws', 'txd-index.json'];
/** Font 5 previews are rendered at this size and scaled by CSS to the textdraw box. */
const MODEL_PREVIEW_SIZE = 256;
const DEFAULT_PROJECT = 'default';
const MAX_TEXTDRAW_CHARS = 800;
const GLOBAL_TEXTDRAW_LIMIT = 2048;
const PLAYER_TEXTDRAW_LIMIT = 256;

/** Common GTA dictionary names, used to keep sprite warnings useful. */
function slugifyId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'textdraw';
}

/** Accepts Pawn ARGB (0xRRGGBBAA / bare hex) and CSS-style #RRGGBB(AA). */
function normalizeColor(value: unknown, fallback = '0xFFFFFFFF'): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const v = value < 0 ? value >>> 0 : value;
    return `0x${(v >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
  }
  if (typeof value === 'string' && value.trim()) {
    let text = value.trim();
    const cssOrder = text.startsWith('#');
    text = text.replace(/^[#]/, '').replace(/^0x/i, '');
    if (/^[0-9a-f]{6}$/i.test(text)) return `0x${text.toUpperCase()}FF`;
    if (/^[0-9a-f]{8}$/i.test(text)) {
      const normalized = cssOrder ? text.slice(6, 8) + text.slice(0, 6) : text;
      return `0x${normalized.toUpperCase()}`;
    }
  }
  return fallback;
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
  }
  return fallback;
}

function pawnFloat(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : '0.000000';
}

function pawnString(value: string): string {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/**
 * Turns a Pawn string literal back into the text the client actually draws:
 * escape sequences become real characters (newline instead of \n) and an
 * underscore becomes a space, which is the SA-MP convention for blank filler.
 */
function unescapePawnString(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = value[++i];
    switch (next) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case undefined: out += '\\'; break;
      default: out += next; break;
    }
  }
  return out;
}

function isSpriteReference(text: string): boolean {
  return /^[A-Za-z0-9_]{1,32}:[A-Za-z0-9_]{1,32}$/.test(text.trim());
}

function spriteKey(text: string): string {
  return text.trim().toLowerCase();
}

function toCssColor(argb: string): { r: number; g: number; b: number; a: number } {
  const hex = normalizeColor(argb).slice(2);
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: parseInt(hex.slice(6, 8), 16),
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Width/height straight out of a PNG's IHDR chunk (0 when the file is not a PNG). */
function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0 };
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function safeJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-game text metrics
//
// SA-MP draws fonts 0-3 from two bitmap atlases: 32x40 px glyph cells, an advance
// of `prop[glyph]` per character when proportional (or a constant `unprop`), a
// line height of 9 units x letterSizeY and a glyph box of 10 units x letterSizeY.
// The advance tables below come from Leonardo541's TextDrawEditor, which reads
// them out of the game's font atlases — they are what makes a browser preview
// line up with the client.
// ---------------------------------------------------------------------------

const FONT_ATLAS_METRICS: Record<string, { prop: number[]; unprop: number }> = {
  font1: {
    unprop: 27,
    prop: [
      15, 9, 17, 27, 20, 34, 23, 12, 12, 12, 21, 20, 12, 14, 12, 15, 23, 15, 21, 21, 21, 21, 21, 21, 20, 21,
      12, 12, 24, 24, 24, 19, 10, 22, 19, 19, 22, 16, 19, 24, 22, 11, 16, 21, 15, 28, 24, 27, 20, 25, 19, 19, 18,
      23, 23, 31, 23, 19, 21, 21, 13, 35, 11, 21, 10, 19, 20, 14, 20, 19, 13, 20, 19, 9, 9, 19, 9, 29, 19, 21, 19,
      19, 15, 15, 14, 18, 19, 27, 20, 20, 17, 21, 17, 20, 15, 15, 22, 22, 22, 22, 29, 19, 16, 16, 16, 16, 11, 11,
      11, 11, 27, 27, 27, 27, 23, 23, 23, 23, 20, 19, 19, 19, 19, 30, 14, 19, 19, 19, 19, 9, 9, 9, 9, 21, 21, 21,
      21, 18, 18, 18, 18, 24, 19, 19, 20, 18, 19, 19, 21, 19, 19, 19, 19, 19, 16, 19, 19, 19, 20, 19, 16, 19, 19,
      9, 19, 20, 14, 29, 19, 19, 19, 19, 19, 19, 21, 19, 20, 32, 21, 19, 19, 19, 19, 19, 19, 29, 19, 19, 19, 19,
      19, 9, 9, 9, 9, 19, 19, 19, 19, 19, 19, 19, 19, 19, 21, 19, 10, 9,
    ],
  },
  font2: {
    unprop: 20,
    prop: [
      12, 13, 13, 28, 28, 28, 28, 8, 17, 17, 30, 28, 28, 12, 9, 21, 28, 14, 28, 28, 28, 28, 28, 28, 28, 28, 13,
      13, 30, 30, 30, 30, 10, 25, 23, 21, 24, 22, 20, 24, 24, 17, 20, 22, 20, 30, 27, 27, 26, 26, 24, 23, 24, 31,
      23, 31, 24, 23, 21, 28, 33, 33, 14, 28, 10, 11, 12, 9, 11, 10, 10, 12, 12, 7, 7, 13, 5, 18, 12, 10, 12, 11,
      10, 12, 8, 13, 13, 18, 17, 13, 12, 30, 30, 37, 35, 37, 25, 25, 25, 25, 33, 21, 24, 24, 24, 24, 17, 17, 17,
      17, 27, 27, 27, 27, 31, 31, 31, 31, 11, 11, 11, 11, 11, 20, 9, 10, 10, 10, 10, 7, 7, 7, 7, 10, 10, 10, 10,
      13, 13, 13, 13, 27, 12, 30, 27, 16, 27, 27, 27, 27, 27, 27, 27, 27, 18, 29, 26, 25, 28, 26, 25, 27, 28, 12,
      24, 25, 24, 30, 27, 29, 26, 26, 25, 26, 25, 26, 28, 32, 27, 26, 26, 29, 29, 29, 29, 33, 25, 26, 26, 26, 26,
      14, 14, 14, 14, 29, 29, 29, 29, 26, 26, 26, 26, 21, 25, 30, 27, 27,
    ],
  },
};

/** Textdraw colour codes the client understands inside textdraw strings. */
const TEXTDRAW_COLOR_CODES: Record<string, string> = {
  r: '0xB4191DFF',
  g: '0x36682CFF',
  b: '0x323C7FFF',
  w: '0xE1E1E1FF',
  p: '0xA86EFCFF',
};

/** Builds the full definition for a new (or imported) textdraw. */
function hydrateDef(input: Record<string, unknown>, existing: TextdrawDef[]): TextdrawDef {
  const name = String(input.name ?? '').trim() || `td_${existing.length + 1}`;
  const target: TextdrawTarget = input.target === 'player' ? 'player' : 'global';
  const font = Math.round(num(input.font, 1));
  const def: TextdrawDef = {
    id: String(input.id ?? '').trim() || slugifyId(name),
    name,
    target,
    text: input.text === undefined ? '' : String(input.text),
    x: num(input.x, 320),
    y: num(input.y, 240),
    letterWidth: num(input.letterWidth, 0.3),
    letterHeight: num(input.letterHeight, 1.2),
    textSizeX: num(input.textSizeX, 0),
    textSizeY: num(input.textSizeY, 0),
    font,
    alignment: Math.min(3, Math.max(1, Math.round(num(input.alignment, 1)))),
    color: normalizeColor(input.color, '0xFFFFFFFF'),
    boxColor: normalizeColor(input.boxColor, '0x000000AA'),
    // the client's TextDrawCreate default: opaque black (this is also the outline colour)
    background: normalizeColor(input.background, '0x000000FF'),
    shadow: Math.max(0, Math.round(num(input.shadow, 0))),
    outline: Math.max(0, Math.round(num(input.outline, 1))),
    proportional: bool(input.proportional, true),
    box: bool(input.box, false),
    selectable: bool(input.selectable, false),
  };

  if (input.previewModel !== undefined && input.previewModel !== null) {
    def.previewModel = Math.round(num(input.previewModel, -1));
  }
  if (Array.isArray(input.previewRot)) {
    const rot = input.previewRot.map((v) => num(v, 0));
    def.previewRot = [rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0];
  }
  if (input.previewZoom !== undefined && input.previewZoom !== null) {
    def.previewZoom = num(input.previewZoom, 1);
  }
  if (Array.isArray(input.previewVehCol)) {
    const cols = input.previewVehCol.map((v) => Math.round(num(v, 1)));
    def.previewVehCol = [cols[0] ?? 1, cols[1] ?? 1];
  }
  if (font === 5 && def.previewModel === undefined) def.previewModel = 411;
  if (font === 4 && !isSpriteReference(def.text)) {
    def.note = [def.note, 'font 4 needs text in the form "txdname:texturename"'].filter(Boolean).join(' · ');
  }
  if (input.image !== undefined && input.image !== null && String(input.image).trim()) {
    def.image = String(input.image).trim();
  }
  if (input.group) def.group = String(input.group).trim();
  if (input.note) def.note = String(input.note);
  if (input.visible !== undefined) def.visible = bool(input.visible, true);
  return def;
}

interface ParsedSetter {
  setter: string;
  variable: string;
  args: string[];
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inString) {
      current += ch;
      if (ch === '\\') {
        current += value[++i] ?? '';
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapePawnString(trimmed.slice(1, -1));
  }
  return trimmed;
}

function parsePawnNumber(value: string): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Pulls textdraws out of Pawn source: target/variable declarations,
 * TextDrawCreate / CreatePlayerTextDraw calls and the TextDraw* setters that
 * follow them (including AddSimpleModel entries used for custom UI textures).
 */
function parsePawnTextdraws(source: string): {
  textdraws: Record<string, unknown>[];
  simpleModels: SimpleModelEntry[];
  stats: { creates: number; setters: number; ignored: number };
} {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const decls = new Map<string, TextdrawTarget>();
  const setters = new Map<string, ParsedSetter[]>();
  const creates: { name: string; target: TextdrawTarget; args: string[] }[] = [];
  let ignored = 0;
  let setterCount = 0;

  const declRe = /new\s+(Text|PlayerText)\s*:\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = declRe.exec(code)) !== null) {
    decls.set(match[2], match[1] === 'PlayerText' ? 'player' : 'global');
  }

  const createRe = /(?:new\s+(?:Text|PlayerText)\s*:\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*=\s*)?(CreatePlayerTextDraw|TextDrawCreate)\s*\(/g;
  while ((match = createRe.exec(code)) !== null) {
    // Walk to the matching closing parenthesis (strings may contain brackets).
    let depth = 1;
    let i = createRe.lastIndex;
    let inString = false;
    for (; i < code.length && depth > 0; i++) {
      const ch = code[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    const inner = code.slice(createRe.lastIndex, i - 1);
    createRe.lastIndex = i;

    const args = splitTopLevel(inner);
    const isPlayer = match[2] === 'CreatePlayerTextDraw';
    const argOffset = isPlayer ? 1 : 0;
    let name = match[1];
    if (!name) {
      // Assignment to an existing variable: `gLogo = TextDrawCreate(...)`
      const before = code.slice(Math.max(0, match.index - 120), match.index);
      const assign = before.match(/([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?=\s*$/);
      name = assign ? assign[1] : `td_${creates.length + 1}`;
    }
    creates.push({ name, target: isPlayer ? 'player' : (decls.get(name) ?? 'global'), args: [args[argOffset], args[argOffset + 1], args[argOffset + 2]].filter((v): v is string => v !== undefined) });
  }

  const setterRe = /\b(PlayerTextDraw|TextDraw)([A-Za-z]+)\s*\(/g;
  while ((match = setterRe.exec(code)) !== null) {
    const prefix = match[1];
    const setter = match[2];
    if (prefix === 'TextDraw' && setter === 'Create') continue;
    if (prefix === 'PlayerTextDraw' && setter === 'Create') continue;
    let depth = 1;
    let i = setterRe.lastIndex;
    let inString = false;
    for (; i < code.length && depth > 0; i++) {
      const ch = code[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    const inner = code.slice(setterRe.lastIndex, i - 1);
    setterRe.lastIndex = i;
    const args = splitTopLevel(inner);
    const variable = (args.shift() ?? '').replace(/\[[^\]]*\]/g, '').trim();
    if (!variable) {
      ignored++;
      continue;
    }
    setterCount++;
    const list = setters.get(variable) ?? [];
    list.push({ setter, variable, args });
    setters.set(variable, list);
  }

  const applyArg = (def: Record<string, unknown>, setter: string, args: string[]): void => {
    const a0 = args[0] ?? '';
    switch (setter) {
      case 'LetterSize':
        def.letterWidth = parsePawnNumber(a0);
        def.letterHeight = parsePawnNumber(args[1] ?? '');
        break;
      case 'TextSize':
        def.textSizeX = parsePawnNumber(a0);
        def.textSizeY = parsePawnNumber(args[1] ?? '');
        break;
      case 'Color': def.color = normalizeColor(a0, String(def.color ?? '0xFFFFFFFF')); break;
      case 'BoxColor': def.boxColor = normalizeColor(a0, String(def.boxColor ?? '0x000000AA')); break;
      case 'BackgroundColor': case 'BackgroundColour':
        def.background = normalizeColor(a0, String(def.background ?? '0x00000000'));
        break;
      case 'Alignment': def.alignment = Math.round(parsePawnNumber(a0)) || 1; break;
      case 'Font': def.font = Math.round(parsePawnNumber(a0)); break;
      case 'SetOutline': case 'SetOutlineSize': def.outline = Math.round(parsePawnNumber(a0)); break;
      case 'SetShadow': case 'SetShadowSize': def.shadow = Math.round(parsePawnNumber(a0)); break;
      case 'SetProportional': def.proportional = parsePawnNumber(a0) !== 0; break;
      case 'UseBox': def.box = parsePawnNumber(a0) !== 0; break;
      case 'SetSelectable': def.selectable = parsePawnNumber(a0) !== 0; break;
      case 'SetString': def.text = unquote(a0); break;
      case 'SetPreviewModel': def.previewModel = Math.round(parsePawnNumber(a0)); break;
      case 'SetPreviewRot':
        def.previewRot = [
          parsePawnNumber(a0),
          parsePawnNumber(args[1] ?? ''),
          parsePawnNumber(args[2] ?? ''),
        ];
        if (args[3] !== undefined) def.previewZoom = parsePawnNumber(args[3]);
        break;
      case 'SetPreviewVehCol':
      case 'SetPreviewVehicleColours':
        def.previewVehCol = [Math.round(parsePawnNumber(a0)), Math.round(parsePawnNumber(args[1] ?? ''))];
        break;
      default: break;
    }
  };

  const textdraws: Record<string, unknown>[] = [];
  for (const create of creates) {
    const def: Record<string, unknown> = {
      name: create.name,
      target: create.target,
      text: unquote(create.args[2] ?? '""'),
      x: parsePawnNumber(create.args[0] ?? '0'),
      y: parsePawnNumber(create.args[1] ?? '0'),
    };
    for (const setter of setters.get(create.name) ?? []) applyArg(def, setter.setter, setter.args);
    textdraws.push(def);
  }

  const simpleModels: SimpleModelEntry[] = [];
  const modelRe = /AddSimpleModel\s*\(([^;]*)\)\s*;/g;
  while ((match = modelRe.exec(code)) !== null) {
    const args = splitTopLevel(match[1]);
    if (args.length < 5) continue;
    simpleModels.push({
      baseid: Math.round(parsePawnNumber(args[1])),
      newid: Math.round(parsePawnNumber(args[2])),
      dff: unquote(args[3]),
      txd: unquote(args[4]),
    });
  }

  return { textdraws, simpleModels, stats: { creates: creates.length, setters: setterCount, ignored } };
}

export class TextdrawManager {
    private root = '';
    private previewServer: http.Server | null = null;
    private previewServerPort = 0;
    private previewProject = DEFAULT_PROJECT;
    private txdIndex: TxdIndex | null = null;
    private decodedCache = new Map<string, { url: string; width: number; height: number; source: string }>();

    /** Called by set_server_root; all textdraw data lives under this directory. */
    setRoot(root: string): void {
        models.setRoot(root);
        const resolved = path.resolve(root);
        if (resolved !== this.root) {
            this.txdIndex = null;
            this.decodedCache.clear();
        }
        this.root = resolved;
    }

    private rootOrThrow(): string {
        if (!this.root) throw new Error("No SAMP server root set. Use 'set_server_root' first.");
        return this.root;
    }

    private abs(parts: string[], file = ''): string {
        return path.join(this.rootOrThrow(), ...parts, file);
    }

    private projectFile(project: string): string {
        return this.abs(STORE_DIR, `${slugifyId(project || DEFAULT_PROJECT)}.json`);
    }

    private async loadProject(project?: string): Promise<TextdrawProject> {
        const name = slugifyId(project || DEFAULT_PROJECT);
        const file = this.projectFile(name);
        try {
            const raw = await fs.readFile(file, 'utf8');
            const parsed = JSON.parse(raw) as TextdrawProject;
            return {
                name: parsed.name || name,
                baseWidth: parsed.baseWidth || DEFAULT_BASE_WIDTH,
                baseHeight: parsed.baseHeight || DEFAULT_BASE_HEIGHT,
                createdAt: parsed.createdAt || new Date().toISOString(),
                updatedAt: parsed.updatedAt || new Date().toISOString(),
                simpleModels: Array.isArray(parsed.simpleModels) ? parsed.simpleModels : [],
                textdraws: Array.isArray(parsed.textdraws) ? parsed.textdraws.map((td) => hydrateDef(td as unknown as Record<string, unknown>, [])) : [],
            };
        } catch {
            return {
                name,
                baseWidth: DEFAULT_BASE_WIDTH,
                baseHeight: DEFAULT_BASE_HEIGHT,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                simpleModels: [],
                textdraws: [],
            };
        }
    }

    private async saveProject(project: TextdrawProject): Promise<string> {
        const file = this.projectFile(project.name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        project.updatedAt = new Date().toISOString();
        await fs.writeFile(file, JSON.stringify(project, null, 2) + '\n', 'utf8');
        return file;
    }

    private async listProjectFiles(): Promise<{ name: string; file: string; textdraws: number; updatedAt: string }[]> {
        const dir = this.abs(STORE_DIR);
        const entries = await fs.readdir(dir).catch(() => [] as string[]);
        const out: { name: string; file: string; textdraws: number; updatedAt: string }[] = [];
        for (const entry of entries) {
            if (!entry.endsWith('.json') || entry === path.basename(this.abs(TXD_INDEX_FILE))) continue;
            try {
                const raw = await fs.readFile(path.join(dir, entry), 'utf8');
                const parsed = JSON.parse(raw) as TextdrawProject;
                out.push({
                    name: parsed.name || entry.replace(/\.json$/, ''),
                    file: path.join(dir, entry),
                    textdraws: Array.isArray(parsed.textdraws) ? parsed.textdraws.length : 0,
                    updatedAt: parsed.updatedAt || '',
                });
            } catch { /* ignore unreadable project files */ }
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    private findDef(project: TextdrawProject, target: string): TextdrawDef | undefined {
        const needle = target.trim().toLowerCase();
        return project.textdraws.find((td) => td.id.toLowerCase() === needle || td.name.toLowerCase() === needle);
    }

    // -----------------------------------------------------------------------
    // Validation
    // -----------------------------------------------------------------------

    private validate(project: TextdrawProject, index: TxdIndex | null): string[] {
        const warnings: string[] = [];
        const names = new Map<string, number>();
        const globals = project.textdraws.filter((td) => td.target === 'global');
        const players = project.textdraws.filter((td) => td.target === 'player');

        if (globals.length > GLOBAL_TEXTDRAW_LIMIT) {
            warnings.push(`ERROR: ${globals.length} global textdraws exceeds the client limit of ${GLOBAL_TEXTDRAW_LIMIT}`);
        }
        if (players.length > PLAYER_TEXTDRAW_LIMIT) {
            warnings.push(`ERROR: ${players.length} per-player textdraws per player exceeds the limit of ${PLAYER_TEXTDRAW_LIMIT}`);
        }

        for (const td of project.textdraws) {
            names.set(td.name.toLowerCase(), (names.get(td.name.toLowerCase()) ?? 0) + 1);

            if (td.font > 5) {
                warnings.push(`ERROR ${td.name}: font ${td.font} is not a drawable font (4 = txd sprite, 5 = model preview; >16 crashes the client)`);
            }
            if (td.font === 4 && !isSpriteReference(td.text)) {
                warnings.push(`WARN ${td.name}: font 4 sprite textdraws need text "txdname:texturename" (currently "${td.text}")`);
            }
            if (td.font === 4 && isSpriteReference(td.text)) {
                const key = spriteKey(td.text);
                if (!index?.assets[key]) {
                    const override = this.spriteOverrideFile(key);
                    if (override) {
                        warnings.push(`INFO ${td.name}: sprite "${td.text}" is not in a decoded .txd yet — the preview uses the design-time image ${path.relative(this.root, override)} (ship it inside ${key.split(':')[0]}.txd for the game)`);
                    } else {
                        const [txd, tex] = key.split(':');
                        const scanned = index && index.dictionaries.length > 0;
                        const sameTxd = (index?.textures ?? []).some((t) => t.txd.toLowerCase() === txd);
                        warnings.push(sameTxd
                            ? `WARN ${td.name}: texture "${tex}" not found in dictionary "${txd}"${scanned ? '' : ' (no .txd scanned yet — run txd_scan)'}`
                            : `WARN ${td.name}: sprite "${td.text}" not found in the scanned dictionaries (run txd_scan after adding the .txd, or check the spelling)`);
                    }
                }
            }
            if (td.font === 5 && td.previewModel === undefined) {
                warnings.push(`WARN ${td.name}: font 5 model preview without previewModel (TextDrawSetPreviewModel)`);
            }
            if (td.font !== 4 && td.font !== 5) {
                if (td.y < 1) {
                    warnings.push(`WARN ${td.name}: y < 1 — in SA-MP the first text row is invisible (only the shadow shows)`);
                }
                // a textdraw whose text is only whitespace is a deliberate blank (clickable filler), not a mistake
                if (/[^\s]\s$/.test(td.text)) {
                    warnings.push(`WARN ${td.name}: text ends with a space — the whole textdraw renders blank in SA-MP`);
                }
                if (td.text === '') {
                    warnings.push(`INFO ${td.name}: empty text crashes the server in older SA-MP versions — use " " or _ as filler`);
                }
            }
            if (td.text.length > MAX_TEXTDRAW_CHARS) {
                warnings.push(`WARN ${td.name}: text is ${td.text.length} characters, the client truncates beyond ${MAX_TEXTDRAW_CHARS}`);
            }
            if (td.x < -100 || td.x > project.baseWidth + 100 || td.y < -100 || td.y > project.baseHeight + 100) {
                warnings.push(`WARN ${td.name}: position ${td.x}, ${td.y} is far outside the ${project.baseWidth}x${project.baseHeight} grid`);
            }
            if (td.selectable && td.textSizeX === 0 && td.textSizeY === 0) {
                warnings.push(`WARN ${td.name}: selectable without a text size — set textSizeX/textSizeY for the clickable area`);
            }
            if (td.box && toCssColor(td.boxColor).a === 0) {
                warnings.push(`INFO ${td.name}: box is enabled but boxColor has alpha 0 (invisible box)`);
            }

        }

        for (const [name, count] of names) {
            if (count > 1) warnings.push(`ERROR: duplicate variable name "${name}" (${count} textdraws)`);
        }
        return warnings;
    }

    private stats(project: TextdrawProject): PreviewPayload['stats'] {
        const fonts: Record<string, number> = {};
        for (const td of project.textdraws) {
            const key = String(td.font);
            fonts[key] = (fonts[key] ?? 0) + 1;
        }
        return {
            global: project.textdraws.filter((td) => td.target === 'global').length,
            player: project.textdraws.filter((td) => td.target === 'player').length,
            fonts,
            groups: unique(project.textdraws.map((td) => td.group).filter((g): g is string => !!g)).sort(),
        };
    }

    // -----------------------------------------------------------------------
    // Public tools
    // -----------------------------------------------------------------------

    async listProjects(): Promise<{ storeDir: string; projects: { name: string; textdraws: number; updatedAt: string }[] }> {
        const projects = await this.listProjectFiles();
        return {
            storeDir: this.abs(STORE_DIR),
            projects: projects.map(({ name, textdraws, updatedAt }) => ({ name, textdraws, updatedAt })),
        };
    }

    async listTextdraws(project: string, opts: { group?: string; search?: string; target?: string } = {}): Promise<{
        project: TextdrawProject;
        textdraws: TextdrawDef[];
        total: number;
        stats: PreviewPayload['stats'];
        warnings: string[];
    }> {
        const loaded = await this.loadProject(project);
        const index = await this.loadTxdIndex(true);
        let list = loaded.textdraws;
        if (opts.group) list = list.filter((td) => (td.group ?? '').toLowerCase() === opts.group!.toLowerCase());
        if (opts.target === 'global' || opts.target === 'player') list = list.filter((td) => td.target === opts.target);
        if (opts.search) {
            const needle = opts.search.toLowerCase();
            list = list.filter((td) =>
                td.name.toLowerCase().includes(needle)
                || td.text.toLowerCase().includes(needle)
                || (td.id ?? '').toLowerCase().includes(needle)
                || (td.group ?? '').toLowerCase().includes(needle));
        }
        return {
            project: loaded,
            textdraws: list,
            total: loaded.textdraws.length,
            stats: this.stats(loaded),
            warnings: this.validate(loaded, index),
        };
    }

    async createTextdraw(project: string, input: Record<string, unknown>): Promise<{ file: string; textdraw: TextdrawDef; count: number }> {
        const loaded = await this.loadProject(project);
        const requestedName = String(input.name ?? '').trim().toLowerCase();
        const requestedId = input.id ? slugifyId(String(input.id)) : '';
        if (requestedName && loaded.textdraws.some((td) => td.name.toLowerCase() === requestedName)) {
            throw new Error(`A textdraw named "${input.name}" already exists in project "${loaded.name}". Use textdraw_update to change it.`);
        }
        if (requestedId && loaded.textdraws.some((td) => td.id.toLowerCase() === requestedId)) {
            throw new Error(`A textdraw with id "${requestedId}" already exists in project "${loaded.name}".`);
        }
        const def = hydrateDef(input, loaded.textdraws);
        if (loaded.textdraws.some((td) => td.id.toLowerCase() === def.id.toLowerCase())) {
            def.id = `${def.id}_${loaded.textdraws.length + 1}`;
        }
        if (loaded.name !== slugifyId(project || DEFAULT_PROJECT)) loaded.name = slugifyId(project || DEFAULT_PROJECT);
        loaded.textdraws.push(def);
        const file = await this.saveProject(loaded);
        return { file, textdraw: def, count: loaded.textdraws.length };
    }

    async updateTextdraw(project: string, target: string, patch: Record<string, unknown>): Promise<{ file: string; before: TextdrawDef; after: TextdrawDef }> {
        const loaded = await this.loadProject(project);
        const existing = this.findDef(loaded, target);
        if (!existing) throw new Error(`Textdraw "${target}" not found in project "${loaded.name}".`);

        const merged: Record<string, unknown> = { ...existing };
        for (const [key, value] of Object.entries(patch)) {
            if (value !== undefined) merged[key] = value;
        }
        // id/name are identity: keep them unless explicitly renamed, and never duplicate one.
        if (patch.name !== undefined) {
            const nextName = String(patch.name).trim();
            if (nextName && loaded.textdraws.some((td) => td !== existing && td.name.toLowerCase() === nextName.toLowerCase())) {
                throw new Error(`Another textdraw already uses the name "${nextName}".`);
            }
        }
        const updated = hydrateDef(merged, loaded.textdraws);
        const index = loaded.textdraws.indexOf(existing);
        const before = { ...existing };
        loaded.textdraws[index] = updated;
        const file = await this.saveProject(loaded);
        return { file, before, after: updated };
    }

    async deleteTextdraw(project: string, targets: string[]): Promise<{ file: string; removed: string[]; left: number }> {
        const loaded = await this.loadProject(project);
        const removed: string[] = [];
        for (const target of targets) {
            const def = this.findDef(loaded, target);
            if (!def) continue;
            loaded.textdraws = loaded.textdraws.filter((td) => td !== def);
            removed.push(def.name);
        }
        if (removed.length === 0) throw new Error(`Nothing deleted: ${targets.join(', ')} not found in project "${loaded.name}".`);
        const file = await this.saveProject(loaded);
        return { file, removed, left: loaded.textdraws.length };
    }

    async importFromScript(project: string, filePath: string, mode: 'merge' | 'replace'): Promise<{
        file: string;
        source: string;
        formats: string[];
        imported: number;
        updated: number;
        created: string[];
        simpleModels: number;
        skippedGuides: number;
        files: string[];
    }> {
        const root = this.rootOrThrow();
        const abs = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat) throw new Error(`File not found: ${abs}`);
        const files = stat.isDirectory()
            ? (await fs.readdir(abs, { recursive: true }).catch(() => [] as string[]))
                .map((f) => path.join(abs, String(f)))
                .filter((f) => /\.(pwn|inc|json)$/i.test(f))
            : [abs];
        if (files.length === 0) throw new Error(`No .pwn/.inc/.json files found under ${abs}`);

        const loaded = await this.loadProject(project);
        if (loaded.name !== slugifyId(project || DEFAULT_PROJECT)) loaded.name = slugifyId(project || DEFAULT_PROJECT);
        if (mode === 'replace') loaded.textdraws = [];

        let imported = 0;
        let updatedCount = 0;
        let skippedGuides = 0;
        const created: string[] = [];
        const formats = new Set<string>();
        const seenModels = new Set(loaded.simpleModels.map((m) => `${m.newid}`));

        const merge = (def: Record<string, unknown>): void => {
            const name = String(def.name ?? '');
            const existing = loaded.textdraws.find((td) => td.name.toLowerCase() === name.toLowerCase());
            if (existing) {
                loaded.textdraws[loaded.textdraws.indexOf(existing)] = hydrateDef({ ...existing, ...def }, loaded.textdraws);
                updatedCount++;
            } else {
                loaded.textdraws.push(hydrateDef(def, loaded.textdraws));
                created.push(name);
            }
            imported++;
        };

        for (const file of files) {
            const source = await fs.readFile(file, 'utf8').catch(() => '');
            if (/\.json$/i.test(file)) {
                const parsed = source ? safeJson(source) : null;
                if (!parsed) continue;
                // Leonardo541's TextDrawEditor project export
                if (Array.isArray(parsed.textDraws)) {
                    formats.add('textdraw-editor');
                    skippedGuides += (parsed.guideGrids?.length ?? 0) + (parsed.guideLines?.length ?? 0);
                    for (const entry of parsed.textDraws) {
                        const alignment = Math.round(num(entry.alignment, 1));
                        // the editor keeps alignment 2 dimensions swapped relative to the Pawn args
                        const textSizeX = alignment === 2 ? entry.textSizeY : entry.textSizeX;
                        const textSizeY = alignment === 2 ? entry.textSizeX : entry.textSizeY;
                        merge({
                            name: entry.name,
                            text: entry.text,
                            x: entry.x,
                            y: entry.y,
                            letterWidth: entry.letterSizeX,
                            letterHeight: entry.letterSizeY,
                            textSizeX,
                            textSizeY,
                            alignment,
                            color: entry.color,
                            boxColor: entry.boxColor,
                            background: entry.backgroundColor,
                            shadow: entry.setShadow,
                            outline: entry.setOutline,
                            box: entry.useBox,
                            proportional: entry.setProportional,
                            font: entry.font,
                            visible: !entry.hidden,
                        });
                    }
                    continue;
                }
                // a samp-mcp textdraw project file
                if (Array.isArray(parsed.textdraws)) {
                    formats.add('samp-mcp');
                    for (const entry of parsed.textdraws) merge(entry as Record<string, unknown>);
                    for (const model of Array.isArray(parsed.simpleModels) ? parsed.simpleModels : []) {
                        if (seenModels.has(`${model.newid}`)) continue;
                        seenModels.add(`${model.newid}`);
                        loaded.simpleModels.push(model as SimpleModelEntry);
                    }
                }
                continue;
            }
            if (!source.includes('TextDrawCreate') && !source.includes('CreatePlayerTextDraw')) continue;
            formats.add('pawn');
            const parsed = parsePawnTextdraws(source);
            for (const entry of parsed.simpleModels) {
                if (seenModels.has(`${entry.newid}`)) continue;
                seenModels.add(`${entry.newid}`);
                loaded.simpleModels.push(entry);
            }
            for (const def of parsed.textdraws) merge(def);
        }
        const savedFile = await this.saveProject(loaded);
        if (imported === 0) {
            throw new Error(`Nothing imported from ${abs} — no TextDrawCreate calls or textdraw project JSON were found.`);
        }
        return {
            file: savedFile,
            source: abs,
            formats: [...formats],
            imported,
            updated: updatedCount,
            created,
            simpleModels: loaded.simpleModels.length,
            skippedGuides,
            files: files.map((f) => path.relative(root, f)),
        };
    }

    async exportTextdraws(project: string, opts: {
        mode: 'statements' | 'declarations' | 'module' | 'markdown' | 'json';
        target?: 'all' | 'global' | 'player';
        group?: string;
        name?: string;
    }): Promise<{ content: string; count: number; mode: string }> {
        const loaded = await this.loadProject(project);
        let list = loaded.textdraws;
        if (opts.target && opts.target !== 'all') list = list.filter((td) => td.target === opts.target);
        if (opts.group) list = list.filter((td) => (td.group ?? '').toLowerCase() === opts.group!.toLowerCase());
        if (opts.name) {
            const def = this.findDef(loaded, opts.name);
            list = def ? [def] : [];
        }
        const mode = opts.mode ?? 'statements';
        if (mode === 'json') {
            return { content: JSON.stringify({ project: loaded.name, textdraws: list }, null, 2), count: list.length, mode };
        }
        if (mode === 'markdown') {
            return { content: this.renderMarkdown(loaded, list), count: list.length, mode };
        }
        if (mode === 'declarations') {
            return { content: this.renderDeclarations(list), count: list.length, mode };
        }
        if (mode === 'module') {
            return { content: this.renderModule(loaded, list), count: list.length, mode };
        }
        return { content: this.renderStatements(list), count: list.length, mode };
    }

    async buildPreview(project: string, opts: { exportPng: boolean; inlineAssets: boolean; maxTextureSize: number }): Promise<PreviewBuildResult> {
        const projectName = slugifyId(project || DEFAULT_PROJECT);
        const payload = await this.buildPayload(projectName, opts);
        const htmlPath = this.abs(PREVIEW_DIR, 'index.html');
        const dataPath = this.abs(PREVIEW_DIR, 'data.json');
        await fs.mkdir(path.dirname(htmlPath), { recursive: true });
        await fs.writeFile(dataPath, JSON.stringify(payload, null, 2), 'utf8');
        await fs.writeFile(htmlPath, renderPreviewHtml(payload), 'utf8');
        const sprites = payload.textdraws.filter((td) => td.font === 4 && isSpriteReference(td.text)).map((td) => td.text);
        const missingTextures = sprites.filter((text) => !payload.assets[spriteKey(text)]);
        // sprites that only exist as a design-time image, i.e. not in any .txd yet
        const designOverrides = sprites.filter((text) => {
            const asset = payload.assets[spriteKey(text)];
            return asset ? asset.source.includes('design override') : false;
        });
        const modelIds = unique(payload.textdraws.filter((td) => td.font === 5 && td.previewModel !== undefined).map((td) => String(td.previewModel)));
        const missingModels = modelIds.filter((id) => !payload.models[id]);
        if (this.previewServer) this.previewProject = projectName;
        return {
            htmlPath,
            dataPath,
            assetDir: this.abs(ASSET_DIR),
            url: this.previewServer ? `http://127.0.0.1:${this.previewServerPort}/` : null,
            textdraws: payload.textdraws.length,
            assets: Object.keys(payload.assets).length,
            models: modelIds.length - missingModels.length,
            missingModels,
            missingTextures: unique(missingTextures),
            designOverrides: unique(designOverrides),
            warnings: payload.warnings,
        };
    }

    async startPreviewServer(project: string, port?: number): Promise<{ url: string; port: number; htmlPath: string }> {
        const projectName = slugifyId(project || DEFAULT_PROJECT);
        if (this.previewServer) await this.stopPreviewServer();
        this.previewProject = projectName;

        const server = http.createServer((req, res) => {
            void this.handlePreviewRequest(req, res);
        });
        const chosenPort = await listenOnFreePort(server, port ?? 7788);
        server.unref();
        this.previewServer = server;
        this.previewServerPort = chosenPort;
        await this.buildPreview(projectName, { exportPng: true, inlineAssets: false, maxTextureSize: 256 });
        return {
            url: `http://127.0.0.1:${chosenPort}/`,
            port: chosenPort,
            htmlPath: this.abs(PREVIEW_DIR, 'index.html'),
        };
    }

    async stopPreviewServer(): Promise<string> {
        const server = this.previewServer;
        if (!server) return 'No textdraw preview server is running.';
        const port = this.previewServerPort;
        this.previewServer = null;
        this.previewServerPort = 0;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return `Textdraw preview server stopped (was on http://127.0.0.1:${port}/).`;
    }

    previewServerStatus(): string {
        if (!this.previewServer) {
            return 'Textdraw preview server: stopped. Start it with textdraw_preview_server (action=start) or textdraw_preview (serve=true).';
        }
        return `Textdraw preview server: running at http://127.0.0.1:${this.previewServerPort}/ (project: ${this.previewProject}).`;
    }

    async scanTxds(opts: {
        dir?: string;
        depth: number;
        exportPng: boolean;
        maxTextureSize: number;
        limit: number;
    }): Promise<TxdScanResult> {
        const root = this.rootOrThrow();
        const startDir = opts.dir ? (path.isAbsolute(opts.dir) ? opts.dir : path.join(root, opts.dir)) : root;
        const files = await walkForTxds(startDir, Math.max(1, opts.depth), opts.limit);
        const index: TxdIndex = {
            root,
            scannedAt: new Date().toISOString(),
            assets: {},
            textures: [],
            dictionaries: [],
        };

        const assetDir = this.abs(ASSET_DIR);
        if (opts.exportPng) await fs.mkdir(assetDir, { recursive: true });
        this.decodedCache.clear();

        for (const file of files) {
            const buffer = await fs.readFile(file).catch(() => null);
            if (!buffer) continue;
            const dict: TxdDictionary = parseTxd(buffer, file);
            index.dictionaries.push({
                file: path.relative(root, file) || file,
                name: dict.name,
                version: dict.version,
                deviceId: dict.deviceId,
                textureCount: dict.textures.length,
                error: dict.error,
            });
            for (const texture of dict.textures) {
                const record: TxdScanResult['textures'][number] = {
                    key: `${dict.name}:${texture.name}`.toLowerCase(),
                    txd: dict.name,
                    name: texture.name,
                    width: texture.width,
                    height: texture.height,
                    format: texture.format,
                    decodable: texture.decodable,
                    error: texture.decodeError,
                };
                if (texture.decodable && texture.width > 0 && texture.height > 0) {
                    const asset = await this.decodeTextureAsset(file, buffer, texture, dict.name, {
                        exportPng: opts.exportPng,
                        inlineAssets: false,
                        maxTextureSize: opts.maxTextureSize,
                    });
                    if (asset) {
                        record.png = asset.fileName;
                        index.assets[record.key] = asset.asset;
                    } else {
                        record.decodable = false;
                        record.error = 'decoder produced no pixels';
                    }
                }
                index.textures.push(record);
            }
        }

        const indexFile = this.abs(TXD_INDEX_FILE);
        await fs.mkdir(path.dirname(indexFile), { recursive: true });
        await fs.writeFile(indexFile, JSON.stringify(index, null, 2), 'utf8');
        this.txdIndex = index;

        return {
            scannedFiles: files.length,
            dictionaries: index.dictionaries,
            textures: index.textures,
            indexFile,
        };
    }

    // -----------------------------------------------------------------------
    // Internals: texture assets, payload, preview server
    // -----------------------------------------------------------------------

    private async decodeTextureAsset(
        file: string,
        buffer: Buffer,
        texture: TxdTexture,
        txdName: string,
        opts: { exportPng: boolean; inlineAssets: boolean; maxTextureSize: number },
    ): Promise<{ fileName: string; asset: PreviewAsset } | null> {
        const decoded = decodeTxdTexture(buffer, texture.name);
        if (!decoded) return null;
        const shrunk = shrinkTexture(decoded, Math.max(16, opts.maxTextureSize));
        const png = encodePng(shrunk);
        const fileName = `${slugifyId(txdName)}__${slugifyId(texture.name)}.png`;
        if (opts.exportPng) {
            await fs.writeFile(this.abs(ASSET_DIR, fileName), png);
        }
        return {
            fileName,
            asset: {
                url: opts.inlineAssets ? pngDataUrl(png) : `assets/${fileName}`,
                width: shrunk.width,
                height: shrunk.height,
                source: `${path.basename(file)}:${texture.name} (${texture.format})`,
            },
        };
    }

    private async loadTxdIndex(readFromDisk = true): Promise<TxdIndex | null> {
        if (this.txdIndex) return this.txdIndex;
        if (!this.root || !readFromDisk) return null;
        try {
            const raw = await fs.readFile(this.abs(TXD_INDEX_FILE), 'utf8');
            const parsed = JSON.parse(raw) as TxdIndex;
            if (parsed.root === this.root) {
                this.txdIndex = parsed;
                return parsed;
            }
        } catch { /* no index yet */ }
        return null;
    }

    /** Generates the URL for a texture: cached decode, design-time PNG, on-disk index, or a light scan. */
    private async resolveTexture(key: string, opts: { inlineAssets: boolean; maxTextureSize: number }): Promise<PreviewAsset | null> {
        const cached = this.decodedCache.get(key);
        if (cached) return { url: cached.url, width: cached.width, height: cached.height, source: cached.source };

        let index = await this.loadTxdIndex(true);
        if (!index?.assets[key]) {
            const override = await this.resolveSpriteOverride(key, opts.inlineAssets);
            if (override) return override;
        }
        if (!index) {
            // Light first-time scan so sprites work before the agent calls txd_scan.
            await this.scanTxds({ depth: 2, exportPng: true, maxTextureSize: opts.maxTextureSize, limit: 64 });
            index = this.txdIndex;
        }
        if (index?.assets[key]) return index.assets[key];

        const [txd, texture] = key.split(':');
        if (!txd || !texture) return null;
        const dirs = [
            this.abs(ASSET_DIR),
            path.join(this.root, 'models', 'txd'),
            path.join(this.root, 'models'),
            this.root,
        ];
        for (const dir of dirs) {
            const file = path.join(dir, `${txd}.txd`);
            if (!existsSync(file)) continue;
            const buffer = await fs.readFile(file).catch(() => null);
            if (!buffer) continue;
            const decoded = decodeTxdTexture(buffer, texture);
            if (!decoded) continue;
            const shrunk = shrinkTexture(decoded, Math.max(16, opts.maxTextureSize));
            const png = encodePng(shrunk);
            const fileName = `${slugifyId(txd)}__${slugifyId(texture)}.png`;
            await fs.mkdir(this.abs(ASSET_DIR), { recursive: true });
            await fs.writeFile(this.abs(ASSET_DIR, fileName), png).catch(() => {});
            const asset: PreviewAsset = {
                url: opts.inlineAssets ? pngDataUrl(png) : `assets/${fileName}`,
                width: shrunk.width,
                height: shrunk.height,
                source: `${path.basename(file)}:${texture}`,
            };
            this.decodedCache.set(key, { url: asset.url, width: asset.width, height: asset.height, source: asset.source });
            return asset;
        }
        return null;
    }

    /** The design-time PNG/JPG that stands in for `txd:texture` while no .txd decode exists. */
    private spriteOverrideFile(key: string): string | null {
        if (!this.root) return null;
        const [txd, texture] = key.split(':');
        if (!txd || !texture) return null;
        for (const ext of ['png', 'jpg', 'jpeg']) {
            const file = this.abs(SPRITE_ASSET_DIR, `${slugifyId(txd)}__${slugifyId(texture)}.${ext}`);
            if (existsSync(file)) return file;
        }
        return null;
    }

    /** Design-time PNG/JPG sprite for a `txd:texture` key (used only when no .txd decode exists). */
    private async resolveSpriteOverride(key: string, inline: boolean): Promise<PreviewAsset | null> {
        const file = this.spriteOverrideFile(key);
        if (!file) return null;
        const buffer = await fs.readFile(file).catch(() => null);
        if (!buffer) return null;
        const size = pngSize(buffer);
        const mime = path.extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
        const url = inline
            ? `data:${mime};base64,${buffer.toString('base64')}`
            : `assets/${path.basename(file)}`;
        const asset: PreviewAsset = {
            url,
            width: size.width,
            height: size.height,
            source: `${path.relative(this.rootOrThrow(), file)} (design override)`,
        };
        this.decodedCache.set(key, { url, width: asset.width, height: asset.height, source: asset.source });
        return asset;
    }

    private async resolveImage(fileRef: string, inline: boolean): Promise<PreviewAsset | null> {
        const root = this.rootOrThrow();
        const abs = path.isAbsolute(fileRef) ? fileRef : path.join(root, fileRef);
        if (!path.resolve(abs).startsWith(path.resolve(root))) return null;
        const buffer = await fs.readFile(abs).catch(() => null);
        if (!buffer) return null;
        const ext = path.extname(abs).toLowerCase();
        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : 'image/png';
        const url = inline ? `data:${mime};base64,${buffer.toString('base64')}` : path.relative(this.abs(PREVIEW_DIR), abs).replace(/\\/g, '/');
        return { url, width: 0, height: 0, source: path.relative(root, abs) };
    }

    /** Builds everything the preview page needs (also served live by the API). */
    async buildPayload(projectName: string, opts: { exportPng: boolean; inlineAssets: boolean; maxTextureSize: number }): Promise<PreviewPayload> {
        const project = await this.loadProject(projectName);
        const index = await this.loadTxdIndex(true);
        const assets: Record<string, PreviewAsset> = {};
        const modelAssets: Record<string, PreviewAsset> = {};
        const images: Record<string, PreviewAsset> = {};

        for (const td of project.textdraws) {
            if (td.image) {
                const asset = await this.resolveImage(td.image, opts.inlineAssets);
                if (asset) images[td.id] = asset;
            }
            if (td.font === 4 && isSpriteReference(td.text)) {
                const key = spriteKey(td.text);
                if (index?.assets[key]) {
                    const asset = index.assets[key];
                    const known = await this.resolveTextureOnDisk(asset, key, opts);
                    assets[key] = opts.inlineAssets ? known : { ...asset, url: `assets/${asset.url.replace(/^assets\//, '')}` };
                } else {
                    const resolved = await this.resolveTexture(key, opts);
                    if (resolved) assets[key] = resolved;
                }
            }
            if (td.font === 5 && td.previewModel !== undefined) {
                const key = String(td.previewModel);
                if (modelAssets[key]) continue;
                const asset = await this.resolveModelAsset(td, opts);
                if (asset) modelAssets[key] = asset;
            }
        }

        const assetsOut: Record<string, PreviewAsset> = {};
        for (const [key, asset] of Object.entries(assets)) {
            assetsOut[key] = asset;
        }

        return {
            project: project.name,
            baseWidth: project.baseWidth,
            baseHeight: project.baseHeight,
            generatedAt: new Date().toISOString(),
            textdraws: project.textdraws,
            warnings: this.validate(project, index),
            simpleModels: project.simpleModels,
            assets: assetsOut,
            models: modelAssets,
            images,
            stats: this.stats(project),
            metrics: {
                baseWidth: project.baseWidth,
                baseHeight: project.baseHeight,
                lineHeightUnits: 9,
                glyphHeightUnits: 10,
                colorCodes: TEXTDRAW_COLOR_CODES,
                atlas: FONT_ATLAS_METRICS,
            },
        };
    }

    /**
     * The PNG a font 5 textdraw shows for its preview model: a cached render from
     * `.samp-mcp/textdraw-assets/models`, or a fresh one produced from the .dff the
     * model id maps to (sibling .txd textures resolved through the model pipeline).
     */
    private async resolveModelAsset(
        td: TextdrawDef,
        opts: { inlineAssets: boolean; maxTextureSize: number },
    ): Promise<PreviewAsset | null> {
        const rendered = await models.textdrawAsset(td.previewModel as number, {
            rot: td.previewRot,
            zoom: td.previewZoom,
            vehCol: td.previewVehCol,
            size: MODEL_PREVIEW_SIZE,
            render: true,
        });
        if (!rendered) return null;
        const fileName = path.basename(rendered.file);
        if (opts.inlineAssets) {
            const buffer = await fs.readFile(rendered.file).catch(() => null);
            if (!buffer) return null;
            return { url: `data:image/png;base64,${buffer.toString('base64')}`, width: rendered.width, height: rendered.height, source: rendered.source };
        }
        return { url: `models/${fileName}`, width: rendered.width, height: rendered.height, source: rendered.source };
    }

    /** Reads a PNG that was exported by a previous scan (keeps the page self-contained when asked). */
    private async resolveTextureOnDisk(asset: PreviewAsset, key: string, opts: { inlineAssets: boolean }): Promise<PreviewAsset> {
        const fileName = asset.url.replace(/^assets\//, '');
        const file = this.abs(ASSET_DIR, fileName);
        if (!existsSync(file)) return asset;
        const buffer = await fs.readFile(file).catch(() => null);
        if (!buffer) return asset;
        const url = opts.inlineAssets ? `data:image/png;base64,${buffer.toString('base64')}` : `assets/${fileName}`;
        this.decodedCache.set(key, { url, width: asset.width, height: asset.height, source: asset.source });
        return { ...asset, url };
    }

    private async handlePreviewRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url || '/', `http://127.0.0.1:${this.previewServerPort}`);
        const send = (status: number, body: Buffer | string, type = 'application/json'): void => {
            res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
            res.end(body);
        };

        try {
            if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
                const html = await fs.readFile(this.abs(PREVIEW_DIR, 'index.html')).catch(() => null);
                if (!html) {
                    send(404, 'Preview page not generated yet. Run textdraw_preview first.', 'text/plain');
                    return;
                }
                send(200, html, 'text/html; charset=utf-8');
                return;
            }
            if (req.method === 'GET' && url.pathname === '/api/textdraws') {
                const project = url.searchParams.get('project') || this.previewProject;
                const payload = await this.buildPayload(slugifyId(project), { exportPng: false, inlineAssets: false, maxTextureSize: 256 });
                send(200, JSON.stringify(payload));
                return;
            }
            if (req.method === 'GET' && url.pathname === '/api/state') {
                const project = url.searchParams.get('project') || this.previewProject;
                const stat = await fs.stat(this.projectFile(project)).catch(() => null);
                send(200, JSON.stringify({
                    project,
                    mtimeMs: stat ? stat.mtimeMs : 0,
                    size: stat ? stat.size : 0,
                    servedAt: new Date().toISOString(),
                }));
                return;
            }
            if (req.method === 'POST' && url.pathname === '/api/textdraws') {
                const body = await readBody(req);
                const parsed = JSON.parse(body) as { project?: string; textdraws?: Record<string, unknown>[] };
                const project = slugifyId(parsed.project || this.previewProject);
                if (!Array.isArray(parsed.textdraws)) {
                    send(400, JSON.stringify({ error: 'textdraws[] is required' }));
                    return;
                }
                const loaded = await this.loadProject(project);
                const incoming = parsed.textdraws.map((td) => hydrateDef(td, []));
                const byId = new Map(incoming.map((td) => [td.id, td]));
                const kept = loaded.textdraws.filter((td) => !byId.has(td.id));
                loaded.textdraws = [...kept, ...incoming];
                for (const td of loaded.textdraws) {
                    if (!td.id) td.id = slugifyId(td.name);
                }
                const file = await this.saveProject(loaded);
                // Refresh the static page so the file:// version stays in sync.
                const payload = await this.buildPayload(project, { exportPng: true, inlineAssets: true, maxTextureSize: 256 });
                await fs.writeFile(this.abs(PREVIEW_DIR, 'index.html'), renderPreviewHtml(payload), 'utf8');
                send(200, JSON.stringify({ saved: file, count: loaded.textdraws.length, updatedAt: loaded.updatedAt }));
                return;
            }
            if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
                const rel = url.pathname.replace(/^\/assets\//, '').replace(/\.\./g, '');
                const name = path.basename(rel);
                const buffer = await fs.readFile(this.abs(ASSET_DIR, name)).catch(() => null)
                    ?? await fs.readFile(this.abs(SPRITE_ASSET_DIR, name)).catch(() => null);
                if (!buffer) {
                    send(404, 'not found', 'text/plain');
                    return;
                }
                send(200, buffer, rel.endsWith('.jpg') ? 'image/jpeg' : 'image/png');
                return;
            }
            if (req.method === 'GET' && url.pathname.startsWith('/models/')) {
                const name = path.basename(url.pathname.replace(/^\/models\//, ''));
                const buffer = await fs.readFile(this.abs(MODEL_ASSET_DIR, name)).catch(() => null);
                if (!buffer) {
                    send(404, 'not found', 'text/plain');
                    return;
                }
                send(200, buffer, 'image/png');
                return;
            }
            if (req.method === 'POST' && url.pathname === '/api/model') {
                const body = await readBody(req);
                const parsed = JSON.parse(body) as {
                    model?: number;
                    file?: string;
                    rot?: number[];
                    zoom?: number;
                    size?: number;
                    vehCol?: number[];
                };
                const ref = parsed.file || String(parsed.model ?? '');
                if (!ref) {
                    send(400, JSON.stringify({ error: 'model id or file is required' }));
                    return;
                }
                const rot: [number, number, number] = [
                    num(parsed.rot?.[0], 0),
                    num(parsed.rot?.[1], 0),
                    num(parsed.rot?.[2], 0),
                ];
                try {
                    const rendered = await models.renderDataUrl(ref, {
                        rot,
                        zoom: num(parsed.zoom, 1) || 1,
                        size: Math.round(num(parsed.size, MODEL_PREVIEW_SIZE) || MODEL_PREVIEW_SIZE),
                        vehCol: parsed.vehCol ? [num(parsed.vehCol[0], 0), num(parsed.vehCol[1], 0)] : undefined,
                    });
                    send(200, JSON.stringify(rendered));
                } catch (error: any) {
                    send(404, JSON.stringify({ error: error.message }));
                }
                return;
            }
            send(404, JSON.stringify({ error: `unknown route ${url.pathname}` }));
        } catch (error: any) {
            send(500, JSON.stringify({ error: error.message }));
        }
    }

    // -----------------------------------------------------------------------
    // Pawn renderers
    // -----------------------------------------------------------------------

    private renderStatements(list: TextdrawDef[]): string {
        const chunks: string[] = [];
        for (const td of list) {
            const varName = td.target === 'player' ? `${td.name}[playerid]` : td.name;
            const prefix = td.target === 'player' ? 'PlayerTextDraw' : 'TextDraw';
            const create = td.target === 'player' ? 'CreatePlayerTextDraw' : 'TextDrawCreate';
            const lines: string[] = [];
            lines.push(`// ${td.name} — ${td.target}${td.group ? ` · group "${td.group}"` : ''}${td.note ? ` · ${td.note}` : ''}`);
            const createMethod = td.target === 'player' ? `${create}(playerid, ` : `${create}(`;
            lines.push(`${varName} = ${createMethod}${pawnFloat(td.x)}, ${pawnFloat(td.y)}, ${pawnString(td.text)});`);
            lines.push(`${prefix}LetterSize(${varName}, ${pawnFloat(td.letterWidth)}, ${pawnFloat(td.letterHeight)});`);
            lines.push(`${prefix}TextSize(${varName}, ${pawnFloat(td.textSizeX)}, ${pawnFloat(td.textSizeY)});`);
            lines.push(`${prefix}Alignment(${varName}, ${td.alignment});`);
            lines.push(`${prefix}Color(${varName}, ${td.color});`);
            lines.push(`${prefix}BoxColor(${varName}, ${td.boxColor});`);
            lines.push(`${prefix}BackgroundColor(${varName}, ${td.background});`);
            lines.push(`${prefix}SetOutline(${varName}, ${td.outline});`);
            lines.push(`${prefix}SetShadow(${varName}, ${td.shadow});`);
            lines.push(`${prefix}SetProportional(${varName}, ${td.proportional ? 1 : 0});`);
            lines.push(`${prefix}UseBox(${varName}, ${td.box ? 1 : 0});`);
            lines.push(`${prefix}SetSelectable(${varName}, ${td.selectable ? 1 : 0});`);
            lines.push(`${prefix}Font(${varName}, ${td.font});`);
            if (td.previewModel !== undefined) {
                lines.push(`${prefix}SetPreviewModel(${varName}, ${td.previewModel});`);
            }
            if (td.previewRot) {
                const zoom = td.previewZoom ?? 1;
                lines.push(`${prefix}SetPreviewRot(${varName}, ${pawnFloat(td.previewRot[0])}, ${pawnFloat(td.previewRot[1])}, ${pawnFloat(td.previewRot[2])}, ${pawnFloat(zoom)});`);
            }
            if (td.previewVehCol) {
                lines.push(`${prefix}SetPreviewVehCol(${varName}, ${td.previewVehCol[0]}, ${td.previewVehCol[1]});`);
            }
            if (td.font === 4 && !isSpriteReference(td.text)) {
                lines.push(`// NOTE: font 4 needs text in the form "txdname:texturename" — see samp-mcp textdraw_preview`);
            }
            chunks.push(lines.join('\n'));
        }
        return chunks.join('\n\n');
    }

    private renderDeclarations(list: TextdrawDef[]): string {
        const globals = list.filter((td) => td.target === 'global');
        const players = list.filter((td) => td.target === 'player');
        const lines: string[] = [];
        if (globals.length) {
            lines.push('// Global textdraws');
            for (const td of globals) lines.push(`new Text:${td.name} = Text:INVALID_TEXT_DRAW;`);
        }
        if (players.length) {
            if (lines.length) lines.push('');
            lines.push('// Per-player textdraws');
            for (const td of players) lines.push(`new PlayerText:${td.name}[MAX_PLAYERS] = {PlayerText:INVALID_TEXT_DRAW, ...};`);
        }
        return lines.join('\n');
    }

    private renderModule(project: TextdrawProject, list: TextdrawDef[]): string {
        const globals = list.filter((td) => td.target === 'global');
        const players = list.filter((td) => td.target === 'player');
        const slug = slugifyId(project.name);
        const out: string[] = [];
        out.push(`// ${slug} — generated by samp-mcp textdraw_export (mode=module)`);
        out.push('// Drop into gamemodes/includes/system/' + slug + '.inc and register it in main.pwn:');
        out.push(`//   #include "includes/system/${slug}.inc"`);
        out.push('#include <YSI_Coding\\y_hooks>');
        out.push('');
        if (globals.length) out.push(this.renderDeclarations(globals));
        if (players.length) {
            if (globals.length) out.push('');
            out.push(this.renderDeclarations(players));
        }
        out.push('');
        if (globals.length) {
            out.push('hook OnGameModeInit()');
            out.push('{');
            out.push(indent(this.renderStatements(globals), 4));
            out.push('    return 1;');
            out.push('}');
        }
        if (players.length) {
            out.push('');
            out.push('hook OnPlayerConnect(playerid)');
            out.push('{');
            out.push(indent(this.renderStatements(players), 4));
            out.push('    return 1;');
            out.push('}');
        }
        out.push('');
        out.push('stock ' + `${slug}_ShowForPlayer(playerid)`);
        out.push('{');
        for (const td of globals) out.push(`    TextDrawShowForPlayer(playerid, ${td.name});`);
        for (const td of players) out.push(`    PlayerTextDrawShow(playerid, ${td.name}[playerid]);`);
        out.push('    return 1;');
        out.push('}');
        out.push('');
        out.push('stock ' + `${slug}_HideForPlayer(playerid)`);
        out.push('{');
        for (const td of globals) out.push(`    TextDrawHideForPlayer(playerid, ${td.name});`);
        for (const td of players) out.push(`    PlayerTextDrawHide(playerid, ${td.name}[playerid]);`);
        out.push('    return 1;');
        out.push('}');
        if (project.simpleModels.length) {
            out.push('');
            out.push('// Custom 0.3.DL UI textures referenced by this project:');
            for (const model of project.simpleModels) {
                out.push(`//   AddSimpleModel(-1, ${model.baseid}, ${model.newid}, ${pawnString(model.dff)}, ${pawnString(model.txd)}); — hook it in OnGameModeInit`);
            }
        }
        return out.join('\n');
    }

    private renderMarkdown(project: TextdrawProject, list: TextdrawDef[]): string {
        const lines: string[] = [];
        lines.push(`# Textdraws — ${project.name}`);
        lines.push('');
        lines.push(`Generated by samp-mcp · ${list.length} textdraws · grid ${project.baseWidth}x${project.baseHeight}`);
        lines.push('');
        lines.push('| Name | Target | Group | Font | Position | Letter size | Text size | Colour | Text |');
        lines.push('|---|---|---|---|---|---|---|---|---|');
        for (const td of list) {
            lines.push([
                `\`${td.name}\``,
                td.target,
                td.group ?? '',
                String(td.font),
                `${td.x}, ${td.y}`,
                `${td.letterWidth} x ${td.letterHeight}`,
                `${td.textSizeX} x ${td.textSizeY}`,
                `\`${td.color}\``,
                td.text.replace(/\|/g, '\\|').replace(/\n/g, ' '),
            ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
        }
        return lines.join('\n');
    }
}

function indent(text: string, spaces: number): string {
    const pad = ' '.repeat(spaces);
    return text.split('\n').map((line) => (line.trim() ? pad + line : line)).join('\n');
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function listenOnFreePort(server: http.Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        let attempt = 0;
        const tryListen = (candidate: number) => {
            server.once('error', (error: any) => {
                if (error.code === 'EADDRINUSE' && attempt < 12) {
                    attempt++;
                    tryListen(candidate + 1);
                    return;
                }
                reject(error);
            });
            server.listen(candidate, '127.0.0.1', () => {
                const address = server.address();
                resolve(typeof address === 'object' && address ? address.port : candidate);
            });
        };
        tryListen(port);
    });
}

async function walkForTxds(dir: string, depth: number, limit: number): Promise<string[]> {
    const out: string[] = [];
    const queue: { dir: string; depth: number }[] = [{ dir, depth }];
    while (queue.length && out.length < limit) {
        const current = queue.shift()!;
        const entries = await fs.readdir(current.dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (out.length >= limit) break;
            const full = path.join(current.dir, entry.name);
            if (entry.isDirectory()) {
                if (current.depth <= 1) continue;
                if (/^(node_modules|\.git|\.samp-mcp-backups|\.samp-mcp)$/i.test(entry.name)) continue;
                queue.push({ dir: full, depth: current.depth - 1 });
            } else if (/\.txd$/i.test(entry.name)) {
                out.push(full);
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Preview page (self-contained HTML: renderer + drag-n-drop editor)
// ---------------------------------------------------------------------------

function jsonForHtml(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function renderPreviewHtml(payload: PreviewPayload): string {
    const data = jsonForHtml(payload);
    const title = `Textdraws · ${payload.project}`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { color-scheme: dark; --bg:#0b0f14; --panel:#141b23; --panel2:#1b2530; --line:#26313d; --text:#e6edf3; --dim:#8b9aa8; --accent:#39c07a; --warn:#e0a83a; --err:#e05a5a; }
* { box-sizing: border-box; }
body { margin:0; font:13px/1.45 "Segoe UI", Tahoma, sans-serif; background:var(--bg); color:var(--text); }
header { display:flex; align-items:center; gap:16px; padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--line); flex-wrap:wrap; }
header h1 { font-size:15px; margin:0; font-weight:600; }
header .sub { color:var(--dim); font-size:12px; }
.spacer { flex:1; }
button, select, input[type=number], input[type=text], textarea { background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:4px 8px; font:inherit; }
textarea { width:100%; resize:vertical; }
button { cursor:pointer; }
button:hover { border-color:var(--accent); }
button.primary { background:var(--accent); color:#04140b; border-color:var(--accent); font-weight:600; }
button:disabled { opacity:.45; cursor:default; }
main { display:grid; grid-template-columns:260px 1fr 300px; gap:12px; padding:12px; align-items:start; }
@media (max-width:1100px) { main { grid-template-columns:1fr; } }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px; }
.panel h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:0 0 8px; }
#list { max-height:70vh; overflow:auto; display:flex; flex-direction:column; gap:2px; }
.row { display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:6px; cursor:pointer; }
.row:hover { background:var(--panel2); }
.row.sel { background:#20364a; outline:1px solid var(--accent); }
.row .sw { width:8px; height:8px; border-radius:2px; background:#4a5967; flex:none; }
.row .nm { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.row .badge { font-size:10px; color:var(--dim); border:1px solid var(--line); border-radius:4px; padding:0 4px; }
#stageWrap { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px; overflow:auto; }
#stageOuter { position:relative; margin:0 auto; }
#stage { position:relative; transform-origin:top left; background:#10161d; overflow:hidden; }
#stage.ocean { background:linear-gradient(#0d1b2a, #08131d 60%, #05090d); }
#stage.checker { background-image:linear-gradient(45deg,#1b2530 25%,transparent 25%),linear-gradient(-45deg,#1b2530 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#1b2530 75%),linear-gradient(-45deg,transparent 75%,#1b2530 75%); background-size:16px 16px; background-position:0 0,0 8px,8px -8px,-8px 0; }
#grid { position:absolute; inset:0; pointer-events:none; display:none; }
#grid.on { display:block; }
#grid i { position:absolute; background:#ffffff14; }
.td { position:absolute; white-space:pre; }
.td.hidden { display:none; }
.td .sprite { display:block; }
.td .ph { display:flex; align-items:center; justify-content:center; font-size:9px; color:#ffd479; border:1px dashed #ffd479; text-align:center; overflow:hidden; }
.panel .warn { color:var(--warn); font-size:11px; margin:2px 0; }
.panel .err { color:var(--err); font-size:11px; margin:2px 0; }
.panel .info { color:var(--dim); font-size:11px; margin:2px 0; }
.field { display:grid; grid-template-columns:88px 1fr; gap:6px; align-items:center; margin:4px 0; }
.field label { color:var(--dim); font-size:11px; }
.field input, .field select { width:100%; }
.duo { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.trio { display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; }
.status { font-size:12px; color:var(--dim); }
.status.dirty { color:var(--warn); }
.status.ok { color:var(--accent); }
footer { color:var(--dim); font-size:11px; padding:0 16px 20px; }
code { background:var(--panel2); padding:1px 4px; border-radius:4px; }
</style>
</head>
<body>
<header>
  <h1>${payload.project}</h1>
  <span class="sub" id="stats"></span>
  <span class="spacer"></span>
  <label class="sub">screen
    <select id="res">
      <option value="640x448">640x448 (native grid)</option>
      <option value="640x480">640x480</option>
      <option value="800x600">800x600</option>
      <option value="1024x768">1024x768</option>
      <option value="1366x768">1366x768</option>
      <option value="1600x900">1600x900</option>
      <option value="1920x1080">1920x1080 (widescreen)</option>
      <option value="2560x1440">2560x1440</option>
    </select>
  </label>
  <label class="sub">zoom <input id="zoom" type="range" min="50" max="150" value="100"></label>
  <label class="sub">bg
    <select id="bg"><option value="ocean">in-game</option><option value="dark">flat dark</option><option value="checker">checker</option></select>
  </label>
  <button id="gridBtn">grid</button>
  <button id="saveBtn" class="primary" disabled>save</button>
  <button id="resetBtn">reload</button>
  <span class="status" id="status"></span>
</header>
<main>
  <section class="panel">
    <h2>Textdraws (<span id="count">0</span>)</h2>
    <input id="search" type="text" placeholder="filter name / text / group" style="width:100%; margin-bottom:6px;">
    <div id="list"></div>
    <h2 style="margin-top:12px;">Validation</h2>
    <div id="warnings"></div>
  </section>
  <section id="stageWrap">
    <div id="stageOuter"><div id="stage" class="ocean"><div id="grid"></div></div></div>
    <div class="status" id="tip">Drag a textdraw to move it (arrow keys nudge by 0.5 units, shift = 0.1). Click the list to select.</div>
  </section>
  <section class="panel">
    <h2>Properties</h2>
    <div id="props"><div class="info">Select a textdraw.</div></div>
  </section>
</main>
<footer>
  Rendered by samp-mcp · grid ${payload.baseWidth}x${payload.baseHeight} (x * W/640, y * H/448 like the client) · fonts 0-3 use the in-game character advance tables + ~r~ ~g~ ~b~ ~w~ ~p~ ~h~ ~n~ codes, font 4 shows the decoded .txd sprite tinted with the text colour, font 5 shows the .dff rendered from the textdraw's preview model/rot/zoom (drag a model to orbit it, wheel to zoom).
  Saved: <span id="savedAt"></span>
</footer>
<script>
var PAYLOAD = ${data};
var SERVER_MODE = location.protocol.indexOf('http') === 0;
var state = { selected: null, dirty: false, data: JSON.parse(JSON.stringify(PAYLOAD)), lastMtime: 0 };
var METRICS = PAYLOAD.metrics || {};
var glyphScale = 1.0;   // vertical glyph multiplier (browser font vs. the game's bitmap atlas)
var hugBoxMode = false; // Leonardo541-style box that hugs the text instead of TextDrawTextSize corners

function argb(v) {
  var hex = String(v || '0xFFFFFFFF').replace(/^0x/i, '');
  if (hex.length === 6) hex = hex + 'FF';
  var r = parseInt(hex.substr(0, 2), 16), g = parseInt(hex.substr(2, 2), 16), b = parseInt(hex.substr(4, 2), 16), a = parseInt(hex.substr(6, 2), 16);
  return { r: r, g: g, b: b, a: a };
}
function css(c, overrideAlpha) {
  var x = argb(c);
  var a = overrideAlpha === undefined ? x.a : overrideAlpha;
  return 'rgba(' + x.r + ',' + x.g + ',' + x.b + ',' + (a / 255).toFixed(3) + ')';
}
function rgbHex(c) {
  var x = argb(c);
  return '#' + [x.r, x.g, x.b].map(function (n) { return n.toString(16).padStart(2, '0'); }).join('');
}
function toArgb(hex, alpha) {
  var h = hex.replace('#', '').toUpperCase();
  return '0x' + h + (alpha === undefined ? 'FF' : alpha.toString(16).padStart(2, '0').toUpperCase());
}
function nums(v) { return Number(v) || 0; }

/* ---------------------------------------------------------------------------
   In-game text metrics.
   SA-MP renders fonts 0-3 from two bitmap atlases: 32x40 px glyph cells, a
   per-character advance (prop[] when proportional, a constant when not), a line
   height of 9 units * letterSizeY and a glyph box of 10 units * letterSizeY.
   The advance tables + glyph mapping below come from Leonardo541's TextDrawEditor
   (which reads them out of the game atlases), so the browser layout matches the
   client's character positions instead of guessing.
   --------------------------------------------------------------------------- */
var LF = String.fromCharCode(10);
var LETTER_REMAP = {
  192: 128, 193: 129, 194: 130, 196: 131, 199: 133, 200: 134, 201: 135, 202: 136,
  203: 137, 204: 138, 205: 139, 206: 140, 207: 141, 210: 142, 211: 143, 212: 144,
  214: 145, 217: 146, 218: 147, 219: 148, 220: 149, 224: 151, 225: 152, 226: 153,
  228: 154, 231: 156, 232: 157, 233: 158, 234: 159, 235: 160, 236: 161, 237: 162,
  238: 163, 239: 164, 242: 165, 243: 166, 244: 167, 246: 168, 249: 169, 250: 170,
  251: 171, 252: 172, 209: 173, 241: 174, 191: 175
};

function atlasFor(font) {
  var atlas = METRICS.atlas || {};
  return (font === 1 || font === 3) ? atlas.font1 : atlas.font2;
}
function fontStack(font) {
  if (font === 2) return 'Arial, Helvetica, sans-serif';
  if (font === 3) return '"Trebuchet MS", "Segoe UI", Arial, sans-serif';
  return 'Tahoma, Verdana, Arial, sans-serif';
}
function fontSpec(font, px) {
  var weight = (font === 1 || font === 3) ? 600 : 400;
  return weight + ' ' + Math.max(2, px) + 'px ' + fontStack(font);
}
function letterIndex(font, chr) {
  var idx = chr.charCodeAt(0);
  if (LETTER_REMAP[idx] !== undefined) idx = LETTER_REMAP[idx];
  if (font === 0 || font === 1) {
    if (idx >= 32 && idx <= 175) idx -= 32; else idx = 10;
    if (font === 0 && idx === 6) idx = 10;
  } else {
    if (idx >= 32 && idx <= 47) idx -= 32;
    else if (idx >= 48 && idx <= 58) idx += 96;
    else if (idx >= 59 && idx <= 64) idx -= 32;
    else if (idx >= 65 && idx <= 90) idx += 90;
    else if (idx >= 91 && idx <= 96) idx -= 32;
    else if (idx >= 97 && idx <= 122) idx += 58;
    else if (idx >= 123 && idx <= 150) idx -= 32;
    else if (idx >= 151 && idx <= 175) idx += 30;
    else idx = 10;
    if (font === 2 && idx === 6) idx = 10;
  }
  return idx;
}
function metricsFor(td) {
  var font = Math.round(nums(td.font));
  return {
    font: font,
    atlas: atlasFor(font) || { prop: [], unprop: 20 },
    proportional: td.proportional !== false,
    outline: Math.max(0, Math.round(nums(td.outline))),
    shadow: Math.max(0, Math.round(nums(td.shadow))),
    lsx: nums(td.letterWidth),
    lsy: nums(td.letterHeight)
  };
}
function charAdvance(m, chr) {
  var idx = letterIndex(m.font, chr);
  var width = m.proportional ? m.atlas.prop[idx] : m.atlas.unprop;
  if (typeof width !== 'number') width = m.atlas.unprop;
  return width + m.outline;
}
function argbString(r, g, b, a) {
  var hex = function (n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'); };
  return ('0x' + hex(r) + hex(g) + hex(b) + hex(a)).toUpperCase();
}
function lightenColor(value) {
  var c = argb(value);
  return argbString(c.r * 1.5, c.g * 1.5, c.b * 1.5, c.a);
}
function andColor(a, b) {
  var x = argb(a), y = argb(b);
  return argbString(x.r & y.r, x.g & y.g, x.b & y.b, x.a & y.a);
}

/* Text -> lines of colour runs. Handles the client's ~n~ newline, real newlines,
   the ~r~ ~g~ ~b~ ~w~ ~p~ ~h~ colour codes and the "_" space filler. */
function layoutText(td, m, boxWidth) {
  var body = String(td.text === undefined || td.text === null ? '' : td.text)
    .split(String.fromCharCode(13)).join('')
    .replace(/_/g, ' ');
  var lines = [];
  var runs = [];
  var run = { text: '', color: td.color };
  var pen = 0;
  var widthMax = 0;
  var sign = false;
  var active = td.color;
  var codes = METRICS.colorCodes || {};
  var wrapAtlas = (boxWidth > 0 && m.lsx > 0) ? boxWidth / m.lsx : 0;

  var pushRun = function () {
    if (run.text.length) runs.push(run);
    run = { text: '', color: active };
  };
  var pushLine = function () {
    pushRun();
    if (pen > 0) pen -= m.outline;
    lines.push({ runs: runs.length ? runs : [{ text: '', color: active }], width: Math.max(0, pen) });
    widthMax = Math.max(widthMax, Math.max(0, pen));
    runs = [];
    pen = 0;
  };

  for (var i = 0; i < body.length; i++) {
    var ch = body.charAt(i);
    if (sign) {
      sign = false;
      if (ch === 'n') { pushLine(); continue; }
      if (ch === 'h') { active = lightenColor(active); continue; }
      if (codes[ch]) { active = codes[ch]; continue; }
      continue; // unknown codes are skipped, like the client
    }
    if (ch === '~') { sign = true; continue; }
    if (ch === LF) { pushLine(); continue; }
    if (ch === ' ' && wrapAtlas > 0) {
      // wrap like the client: break at a space when the next word no longer fits
      var wordEnd = body.indexOf(' ', i + 1);
      var word = body.substring(i + 1, wordEnd === -1 ? body.length : wordEnd);
      var wordWidth = 0;
      for (var w = 0; w < word.length; w++) wordWidth += charAdvance(m, word.charAt(w));
      if (pen + wordWidth > wrapAtlas && pen > 0) { pushLine(); continue; }
    }
    if (run.color !== active) pushRun();
    run.text += ch;
    pen += charAdvance(m, ch);
  }
  pushLine();
  return { lines: lines.length ? lines : [{ runs: [{ text: '', color: active }], width: 0 }], width: widthMax };
}

function textAnchor(td, m, textWidth) {
  var x = nums(td.x);
  if (Math.round(nums(td.alignment)) === 2) return x - textWidth / 2 - m.lsx / 2;
  if (Math.round(nums(td.alignment)) === 3) return x - textWidth - m.lsx;
  return x;
}

/* Box geometry: alignment 1 = TextSize is the absolute right/bottom corner,
   3 = the opposite corner, 2 = width/height around the centre, fonts 4/5 read
   TextSize as width/height offsets from the position. In "hug" mode the box
   follows the rendered text with a 4 unit margin (Leonardo541's editor). */
function boxRect(td, layout) {
  var x = nums(td.x), y = nums(td.y), tsx = nums(td.textSizeX), tsy = nums(td.textSizeY);
  if (td.font === 4 || td.font === 5) {
    return { left: x, top: y, width: Math.max(0, tsx), height: Math.max(0, tsy) };
  }
  if (hugBoxMode && layout) {
    var lineHeight = 9 * nums(td.letterHeight);
    var textWidth = layout.width * nums(td.letterWidth);
    var anchor = textAnchor(td, metricsFor(td), textWidth);
    return {
      left: anchor - 4,
      top: y - 4,
      width: textWidth + 8,
      height: lineHeight * layout.lines.length + 8
    };
  }
  if (Math.round(nums(td.alignment)) === 2) {
    return { left: x - tsx / 2, top: y - 10, width: tsx, height: Math.max(0, tsy - y + 10) };
  }
  if (Math.round(nums(td.alignment)) === 3) {
    return { left: tsx - 5, top: y - 10, width: Math.max(0, x - tsx), height: Math.max(0, tsy - y + 10) };
  }
  return { left: x - 5, top: y - 10, width: Math.max(0, tsx - x + 5), height: Math.max(0, tsy - y + 10) };
}

function boxFillColor(td) {
  if (td.font === 4) return td.color;                    // sprites are tinted with the text colour
  if (td.font === 5) return andColor(td.color, td.background); // model previews multiply both
  return td.boxColor;
}

/* Draws fonts 0-3 on a canvas the way the client does: per-character advances
   from the atlas tables, 8-direction outline (or shadow) in the background
   colour, then the text in its own colour. */
function drawTextdrawText(td, m, layout, el) {
  var lsx = m.lsx, lsy = m.lsy;
  var lineHeight = 9 * lsy;
  var glyphHeight = 10 * lsy * glyphScale;
  var textWidth = layout.width * lsx;
  var pad = 8;
  var canvasWidth = textWidth + pad * 2 + 2;
  var canvasHeight = lineHeight * layout.lines.length + glyphHeight * 0.55 + pad * 2;
  var anchor = textAnchor(td, m, textWidth);
  var canvas = document.createElement('canvas');
  var dpr = 2;
  canvas.width = Math.max(1, Math.ceil(canvasWidth * dpr));
  canvas.height = Math.max(1, Math.ceil(canvasHeight * dpr));
  canvas.style.width = canvasWidth.toFixed(2) + 'px';
  canvas.style.height = canvasHeight.toFixed(2) + 'px';
  canvas.style.position = 'absolute';
  canvas.style.left = (anchor - pad).toFixed(2) + 'px';
  canvas.style.top = (nums(td.y) - pad).toFixed(2) + 'px';
  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'top';
  ctx.font = fontSpec(m.font, glyphHeight);

  // per-line horizontal factor so the browser glyphs span exactly the atlas width
  var scales = layout.lines.map(function (line) {
    var natural = 0;
    var flat = '';
    line.runs.forEach(function (r) { flat += r.text; });
    for (var i = 0; i < flat.length; i++) natural += ctx.measureText(flat.charAt(i)).width;
    var target = line.width * lsx;
    if (natural <= 0 || target <= 0) return 1;
    return Math.max(0.55, Math.min(1.8, target / natural));
  });

  var drawPass = function (dx, dy, fill) {
    ctx.fillStyle = fill;
    layout.lines.forEach(function (line, lineIndex) {
      var lineTop = pad + lineIndex * lineHeight + dy;
      var pen = 0;
      line.runs.forEach(function (r) {
        ctx.fillStyle = fill === null ? css(r.color) : fill;
        for (var i = 0; i < r.text.length; i++) {
          var ch = r.text.charAt(i);
          var advance = charAdvance(m, ch);
          if (ch.charCodeAt(0) > 32) {
            ctx.save();
            ctx.translate(pad + pen * lsx + dx, lineTop);
            ctx.scale(scales[lineIndex], 1);
            ctx.fillText(ch, 0, 0);
            ctx.restore();
          }
          pen += advance;
        }
      });
    });
  };

  var outlineColor = css(td.background);
  var hasBackdrop = argb(td.background).a > 0;
  if (hasBackdrop && m.outline > 0) {
    for (var ox = -m.outline; ox <= m.outline; ox += Math.max(1, m.outline)) {
      for (var oy = -m.outline; oy <= m.outline; oy += Math.max(1, m.outline)) {
        if (ox === 0 && oy === 0) continue;
        drawPass(ox, oy, outlineColor);
      }
    }
  } else if (hasBackdrop && m.shadow > 0) {
    drawPass(m.shadow, m.shadow, outlineColor);
  }
  drawPass(0, 0, null);
  el.appendChild(canvas);
}


function appendBox(el, box, color) {
  var boxEl = document.createElement('div');
  boxEl.style.position = 'absolute';
  boxEl.style.left = box.left.toFixed(2) + 'px';
  boxEl.style.top = box.top.toFixed(2) + 'px';
  boxEl.style.width = box.width.toFixed(2) + 'px';
  boxEl.style.height = box.height.toFixed(2) + 'px';
  boxEl.style.background = css(color);
  el.appendChild(boxEl);
}

function renderTextdraw(td) {
  var el = document.createElement('div');
  el.className = 'td';
  el.dataset.id = td.id;
  if (td.visible === false) el.classList.add('hidden');
  var isText = td.font !== 4 && td.font !== 5;
  var m = metricsFor(td);
  var align = Math.round(nums(td.alignment));
  var wrapWidth = 0;
  if (isText) {
    if (align === 2) wrapWidth = Math.max(0, nums(td.textSizeX));
    else if (align === 3) wrapWidth = Math.max(0, nums(td.x) - nums(td.textSizeX));
    else wrapWidth = Math.max(0, nums(td.textSizeX) - nums(td.x));
  }
  var layout = isText ? layoutText(td, m, wrapWidth) : null;
  var box = boxRect(td, layout);

  /* Optional design bitmap (the textdraw's image field): a UI mockup shown inside the
     textdraw's rectangle, under whatever the textdraw itself draws. */
  var designImage = state.data.images && state.data.images[td.id];
  if (designImage) {
    var mock = document.createElement('img');
    mock.src = designImage.url;
    mock.className = 'mock';
    mock.style.position = 'absolute';
    mock.style.left = box.left.toFixed(2) + 'px';
    mock.style.top = box.top.toFixed(2) + 'px';
    mock.style.width = box.width.toFixed(2) + 'px';
    mock.style.height = box.height.toFixed(2) + 'px';
    mock.style.objectFit = 'fill';
    mock.title = designImage.source || td.image;
    el.appendChild(mock);
  }

  if (td.font === 4) {
    var asset = state.data.assets[String(td.text).trim().toLowerCase()];
    if (td.box) appendBox(el, box, boxFillColor(td));
    if (asset) {
      /* The client samples the texture and modulates it with the textdraw colour:
         rgb multiplied by the colour, alpha by its alpha (white + FF = untouched). */
      var sprite = document.createElement('div');
      sprite.className = 'sprite';
      sprite.style.position = 'absolute';
      sprite.style.left = box.left.toFixed(2) + 'px';
      sprite.style.top = box.top.toFixed(2) + 'px';
      sprite.style.width = box.width.toFixed(2) + 'px';
      sprite.style.height = box.height.toFixed(2) + 'px';
      sprite.style.backgroundImage = 'url("' + asset.url + '")';
      sprite.style.backgroundSize = '100% 100%';
      sprite.style.backgroundRepeat = 'no-repeat';
      sprite.style.isolation = 'isolate';
      var modulate = argb(td.color);
      if (modulate.r !== 255 || modulate.g !== 255 || modulate.b !== 255) {
        var wash = document.createElement('div');
        wash.style.position = 'absolute';
        wash.style.left = '0';
        wash.style.top = '0';
        wash.style.width = '100%';
        wash.style.height = '100%';
        wash.style.background = 'rgb(' + modulate.r + ',' + modulate.g + ',' + modulate.b + ')';
        wash.style.mixBlendMode = 'multiply';
        sprite.appendChild(wash);
      }
      if (modulate.a < 255 && modulate.a > 0) sprite.style.opacity = (modulate.a / 255).toFixed(3);
      el.appendChild(sprite);
    } else {
      // no decoded texture: the client paints the sprite slot with the text colour
      var spriteLabel = document.createElement('div');
      spriteLabel.className = 'ph';
      spriteLabel.style.position = 'absolute';
      spriteLabel.style.left = box.left.toFixed(2) + 'px';
      spriteLabel.style.top = box.top.toFixed(2) + 'px';
      spriteLabel.style.width = box.width.toFixed(2) + 'px';
      spriteLabel.style.height = box.height.toFixed(2) + 'px';
      var fill = argb(td.color);
      spriteLabel.style.background = css(td.color);
      spriteLabel.style.color = (fill.r * 0.299 + fill.g * 0.587 + fill.b * 0.114) > 140 ? '#3a2c00' : '#ffd479';
      spriteLabel.style.border = '1px dashed #ffd479';
      spriteLabel.textContent = td.text || 'sprite';
      el.appendChild(spriteLabel);
    }
    return el;
  }
  if (td.font === 5) {
    if (td.box) appendBox(el, box, boxFillColor(td));
    var model = state.data.models[String(td.previewModel)];
    if (model) {
      var mimg = document.createElement('img');
      mimg.src = model.url;
      mimg.dataset.model = '1';
      mimg.style.position = 'absolute';
      mimg.style.left = box.left.toFixed(2) + 'px';
      mimg.style.top = box.top.toFixed(2) + 'px';
      mimg.style.width = box.width.toFixed(2) + 'px';
      mimg.style.height = box.height.toFixed(2) + 'px';
      mimg.style.cursor = SERVER_MODE ? 'grab' : 'default';
      mimg.draggable = false;
      mimg.title = (model.source || 'model ' + td.previewModel)
        + ' — drag to rotate (previewRot ' + previewRotOf(td).map(function (v) { return Math.round(v); }).join('/') + ')'
        + ', wheel to zoom (' + previewZoomOf(td).toFixed(2) + ')';
      mimg.addEventListener('mousedown', function (event) { startModelOrbit(event, td); });
      mimg.addEventListener('wheel', function (event) {
        event.preventDefault();
        orbitZoom(td, event.deltaY < 0 ? 1.12 : 1 / 1.12);
      }, { passive: false });
      el.appendChild(mimg);
    } else {
      var badge = document.createElement('div');
      badge.className = 'ph';
      badge.style.position = 'absolute';
      badge.style.left = box.left.toFixed(2) + 'px';
      badge.style.top = box.top.toFixed(2) + 'px';
      badge.style.width = box.width.toFixed(2) + 'px';
      badge.style.height = box.height.toFixed(2) + 'px';
      badge.textContent = 'model ' + (td.previewModel === undefined ? '?' : td.previewModel) + (SERVER_MODE ? ' · no .dff (model_scan)' : '');
      el.appendChild(badge);
    }
    return el;
  }

  if (td.box) appendBox(el, box, td.boxColor);
  if (layout) drawTextdrawText(td, m, layout, el);
  return el;
}

var stage = document.getElementById('stage');
var stageOuter = document.getElementById('stageOuter');

function render() {
  stage.querySelectorAll('.td').forEach(function (n) { n.remove(); });
  var filter = (document.getElementById('search').value || '').toLowerCase();
  var list = state.data.textdraws.filter(function (td) {
    if (!filter) return true;
    return (td.name + ' ' + td.text + ' ' + (td.group || '')).toLowerCase().indexOf(filter) >= 0;
  });
  state.visibleIds = {};
  list.forEach(function (td) {
    state.visibleIds[td.id] = true;
    stage.appendChild(renderTextdraw(td));
  });
  renderList(list);
  renderWarnings();
  applyViewport();
  document.getElementById('count').textContent = String(state.data.textdraws.length);
  var s = state.data.stats;
  document.getElementById('stats').textContent = s.global + ' global · ' + s.player + ' player · fonts ' + Object.keys(s.fonts).sort().join(',');
}

function renderList(list) {
  var host = document.getElementById('list');
  host.innerHTML = '';
  list.forEach(function (td) {
    var row = document.createElement('div');
    row.className = 'row' + (state.selected === td.id ? ' sel' : '');
    var sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = css(td.color);
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = td.name;
    var badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'f' + td.font + (td.target === 'player' ? ' p' : '');
    var eye = document.createElement('input');
    eye.type = 'checkbox';
    eye.checked = td.visible !== false;
    eye.onclick = function (e) {
      e.stopPropagation();
      var def = byId(td.id);
      def.visible = eye.checked;
      markDirty();
      render();
    };
    row.onclick = function () { state.selected = td.id; render(); };
    row.appendChild(sw); row.appendChild(nm); row.appendChild(badge); row.appendChild(eye);
    host.appendChild(row);
  });
}

function renderWarnings() {
  var host = document.getElementById('warnings');
  host.innerHTML = '';
  if (!state.data.warnings.length) {
    var ok = document.createElement('div');
    ok.className = 'info';
    ok.textContent = 'No validation issues.';
    host.appendChild(ok);
    return;
  }
  state.data.warnings.forEach(function (w) {
    var div = document.createElement('div');
    div.className = w.indexOf('ERROR') === 0 ? 'err' : w.indexOf('WARN') === 0 ? 'warn' : 'info';
    div.textContent = w;
    host.appendChild(div);
  });
}

function byId(id) { return state.data.textdraws.filter(function (td) { return td.id === id; })[0]; }

function gridHeight() { return nums(METRICS.baseHeight) || 448; }

/* CSS pixels per grid unit: the client scales textdraws x * W/640 and y * H/448 */
function stageScale() {
  var res = document.getElementById('res').value.split('x');
  var zoom = parseInt(document.getElementById('zoom').value, 10) / 100;
  return { x: (parseInt(res[0], 10) / 640) * zoom, y: (parseInt(res[1], 10) / gridHeight()) * zoom };
}

function applyViewport() {
  var scale = stageScale();
  var baseH = gridHeight();
  /* the stage is the visible screen: 640 x 448 grid units, like the client's 2D layer */
  stage.style.width = '640px';
  stage.style.height = baseH + 'px';
  stage.style.transform = 'scale(' + scale.x + ',' + scale.y + ')';
  stageOuter.style.width = (640 * scale.x) + 'px';
  stageOuter.style.height = (baseH * scale.y) + 'px';
  var grid = document.getElementById('grid');
  grid.innerHTML = '';
  for (var gx = 0; gx <= 16; gx++) {
    var v = document.createElement('i');
    v.style.left = (gx * 40) + 'px'; v.style.top = '0'; v.style.width = '1px'; v.style.height = baseH + 'px';
    grid.appendChild(v);
  }
  for (var gy = 0; gy * 40 <= baseH; gy++) {
    var hline = document.createElement('i');
    hline.style.top = (gy * 40) + 'px'; hline.style.left = '0'; hline.style.height = '1px'; hline.style.width = '640px';
    grid.appendChild(hline);
  }
}

function field(host, label, node) {
  var wrap = document.createElement('div');
  wrap.className = 'field';
  var lab = document.createElement('label');
  lab.textContent = label;
  wrap.appendChild(lab);
  wrap.appendChild(node);
  host.appendChild(wrap);
}

function numInput(value, step, onChange) {
  var input = document.createElement('input');
  input.type = 'number';
  input.step = step;
  input.value = value;
  input.oninput = function () { onChange(parseFloat(input.value)); };
  return input;
}

function renderProps() {
  var host = document.getElementById('props');
  host.innerHTML = '';
  var td = byId(state.selected);
  if (!td) {
    host.innerHTML = '<div class="info">Select a textdraw.</div>';
    return;
  }
  var title = document.createElement('div');
  title.className = 'info';
  title.textContent = td.name + ' (' + td.target + ')' + (td.id !== td.name ? ' · id ' + td.id : '');
  host.appendChild(title);

  var text = document.createElement('textarea');
  text.rows = 2;
  text.value = td.text;
  text.oninput = function () { td.text = text.value; markDirty(); refreshCanvases(); };
  field(host, 'text', text);

  field(host, 'x / y', duo(numInput(td.x, 0.5, function (v) { td.x = v; markDirty(); refreshCanvases(); }), numInput(td.y, 0.5, function (v) { td.y = v; markDirty(); refreshCanvases(); })));
  field(host, 'letter w/h', duo(numInput(td.letterWidth, 0.05, function (v) { td.letterWidth = v; markDirty(); refreshCanvases(); }), numInput(td.letterHeight, 0.05, function (v) { td.letterHeight = v; markDirty(); refreshCanvases(); })));
  field(host, 'text size w/h', duo(numInput(td.textSizeX, 1, function (v) { td.textSizeX = v; markDirty(); refreshCanvases(); }), numInput(td.textSizeY, 1, function (v) { td.textSizeY = v; markDirty(); refreshCanvases(); })));

  var font = document.createElement('select');
  [[0, '0 · hud regular'], [1, '1 · hud bold'], [2, '2 · arial'], [3, '3 · display'], [4, '4 · txd sprite'], [5, '5 · model preview']].forEach(function (pair) {
    var opt = document.createElement('option');
    opt.value = String(pair[0]);
    opt.textContent = pair[1];
    if (td.font === pair[0]) opt.selected = true;
    font.appendChild(opt);
  });
  font.onchange = function () { td.font = parseInt(font.value, 10) || 0; markDirty(); render(); };
  field(host, 'font', font);

  var align = document.createElement('select');
  [[1, '1 · left'], [2, '2 · center'], [3, '3 · right']].forEach(function (pair) {
    var opt = document.createElement('option');
    opt.value = String(pair[0]);
    opt.textContent = pair[1];
    if (td.alignment === pair[0]) opt.selected = true;
    align.appendChild(opt);
  });
  align.onchange = function () { td.alignment = parseInt(align.value, 10) || 1; markDirty(); refreshCanvases(); };
  field(host, 'align', align);

  field(host, 'color', colorRow(td, 'color'));
  field(host, 'boxColor', colorRow(td, 'boxColor'));
  field(host, 'bg', colorRow(td, 'background'));
  field(host, 'outline/shadow', duo(numInput(td.outline, 1, function (v) { td.outline = v; markDirty(); refreshCanvases(); }), numInput(td.shadow, 1, function (v) { td.shadow = v; markDirty(); refreshCanvases(); })));

  field(host, 'toggles', toggles(td));
  if (td.font === 5) {
    field(host, 'model', numInput(td.previewModel === undefined ? 0 : td.previewModel, 1, function (v) { td.previewModel = v; markDirty(); refreshCanvases(); }));
    var rotRow = document.createElement('div');
    rotRow.className = 'trio';
    [0, 1, 2].forEach(function (axis) {
      var input = numInput(previewRotOf(td)[axis], 5, function (v) {
        var rot = previewRotOf(td).slice();
        rot[axis] = v;
        td.previewRot = rot;
        markDirty();
        renderModelPreview(td);
      });
      input.title = ['rot x (tilt)', 'rot y (roll)', 'rot z (yaw)'][axis];
      rotRow.appendChild(input);
    });
    field(host, 'preview rot x/y/z', rotRow);
    field(host, 'zoom', numInput(previewZoomOf(td), 0.05, function (v) {
      td.previewZoom = Math.max(0.2, Math.min(4, v || 1));
      markDirty();
      renderModelPreview(td);
    }));
    var renderBtn = document.createElement('button');
    renderBtn.textContent = 're-render model';
    renderBtn.onclick = function () { renderModelPreview(td); };
    host.appendChild(renderBtn);
    var modelInfo = document.createElement('div');
    modelInfo.className = 'info';
    var modelAsset = state.data.models[String(td.previewModel)];
    modelInfo.textContent = modelAsset ? ('3D: ' + (modelAsset.source || 'rendered')) : 'no .dff for this model id — run model_scan / model_preview';
    host.appendChild(modelInfo);
  }
  var note = document.createElement('div');
  note.className = 'info';
  note.innerHTML = 'asset: ' + (state.data.assets[String(td.text).trim().toLowerCase()] ? '<code>texture decoded</code>' : '<code>none</code>');
  host.appendChild(note);

  var copy = document.createElement('button');
  copy.textContent = 'copy Pawn snippet';
  copy.onclick = function () { copyPawn(td); };
  host.appendChild(copy);

  field(host, 'glyph size', numInput(glyphScale, 0.05, function (v) { glyphScale = v || 1; refreshCanvases(); }));
  var hug = document.createElement('label');
  hug.className = 'info';
  var hugBox = document.createElement('input');
  hugBox.type = 'checkbox';
  hugBox.checked = hugBoxMode;
  hugBox.onchange = function () { hugBoxMode = hugBox.checked; refreshCanvases(); };
  hug.appendChild(hugBox);
  hug.appendChild(document.createTextNode(' box hugs text (4 unit margin, Leonardo541 style)'));
  host.appendChild(hug);
}

function duo(a, b) {
  var wrap = document.createElement('div');
  wrap.className = 'duo';
  wrap.appendChild(a);
  wrap.appendChild(b);
  return wrap;
}

function toggles(td) {
  var wrap = document.createElement('div');
  wrap.className = 'duo';
  [['proportional', 'proportional'], ['box', 'box'], ['selectable', 'selectable']].forEach(function (pair) {
    var label = document.createElement('label');
    label.style.color = 'var(--dim)';
    label.style.fontSize = '11px';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!td[pair[0]];
    cb.onchange = function () { td[pair[0]] = cb.checked; markDirty(); refreshCanvases(); };
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + pair[1]));
    wrap.appendChild(label);
  });
  return wrap;
}

function colorRow(td, key) {
  var wrap = document.createElement('div');
  wrap.className = 'duo';
  var picker = document.createElement('input');
  picker.type = 'color';
  picker.value = rgbHex(td[key]);
  picker.style.padding = '0';
  picker.style.height = '24px';
  var alpha = document.createElement('input');
  alpha.type = 'range';
  alpha.min = '0';
  alpha.max = '255';
  alpha.value = String(argb(td[key]).a);
  var update = function () {
    td[key] = toArgb(picker.value, parseInt(alpha.value, 10));
    markDirty();
    refreshCanvases();
  };
  picker.oninput = update;
  alpha.oninput = update;
  wrap.appendChild(picker);
  wrap.appendChild(alpha);
  return wrap;
}

var BS = String.fromCharCode(92), QUOTE = String.fromCharCode(34), LF = String.fromCharCode(10), CR = String.fromCharCode(13), TAB = String.fromCharCode(9);

/* Mirrors pawnString() in textdraw.ts so copied code compiles. */
function pawnStr(value) {
  var s = String(value === undefined || value === null ? '' : value);
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch === BS) out += BS + BS;
    else if (ch === QUOTE) out += BS + QUOTE;
    else if (ch === LF) out += BS + 'n';
    else if (ch === CR) out += '';
    else if (ch === TAB) out += BS + 't';
    else out += ch;
  }
  return QUOTE + out + QUOTE;
}

function copyPawn(td) {
  var prefix = td.target === 'player' ? 'PlayerTextDraw' : 'TextDraw';
  var lines = [];
  lines.push((td.target === 'player' ? td.name + '[playerid]' : td.name) + ' = ' + (td.target === 'player' ? 'CreatePlayerTextDraw(playerid, ' : 'TextDrawCreate(') + Number(td.x).toFixed(6) + ', ' + Number(td.y).toFixed(6) + ', ' + pawnStr(td.text) + ');');
  lines.push(prefix + 'LetterSize(' + td.name + ', ' + Number(td.letterWidth).toFixed(6) + ', ' + Number(td.letterHeight).toFixed(6) + ');');
  lines.push(prefix + 'TextSize(' + td.name + ', ' + Number(td.textSizeX).toFixed(6) + ', ' + Number(td.textSizeY).toFixed(6) + ');');
  lines.push(prefix + 'Alignment(' + td.name + ', ' + td.alignment + ');');
  lines.push(prefix + 'Color(' + td.name + ', ' + td.color + ');');
  lines.push(prefix + 'Font(' + td.name + ', ' + td.font + ');');
  if (td.font === 5 && td.previewModel !== undefined) {
    lines.push(prefix + 'SetPreviewModel(' + td.name + ', ' + td.previewModel + ');');
    var rot = previewRotOf(td);
    if (rot[0] || rot[1] || rot[2] || previewZoomOf(td) !== 1) {
      lines.push(prefix + 'SetPreviewRot(' + td.name + ', ' + rot[0].toFixed(1) + ', ' + rot[1].toFixed(1) + ', ' + rot[2].toFixed(1) + ', ' + previewZoomOf(td).toFixed(2) + ');');
    }
  }
  if (navigator.clipboard) navigator.clipboard.writeText(lines.join(String.fromCharCode(10)));
  setStatus('Pawn snippet copied to clipboard', 'ok');
}

/* ---- 3D model previews: orbit a font 5 textdraw against the live server ---- */

function previewRotOf(td) {
  var rot = td.previewRot;
  return [rot && isFinite(rot[0]) ? Number(rot[0]) : 0, rot && isFinite(rot[1]) ? Number(rot[1]) : 0, rot && isFinite(rot[2]) ? Number(rot[2]) : 0];
}

function previewZoomOf(td) {
  return td.previewZoom === undefined ? 1 : Number(td.previewZoom) || 1;
}

function renderModelPreview(td) {
  if (!SERVER_MODE) {
    setStatus('start the live preview server (textdraw_preview serve=true) to render model previews', 'dirty');
    return;
  }
  if (td.previewModel === undefined) {
    setStatus('set a preview model id first', 'dirty');
    return;
  }
  setStatus('rendering model ' + td.previewModel + '…');
  fetch('/api/model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: td.previewModel,
      rot: previewRotOf(td),
      zoom: previewZoomOf(td),
      vehCol: td.previewVehCol,
      size: 256
    })
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (res.error) { setStatus('model render failed: ' + res.error, 'dirty'); return; }
    var key = String(td.previewModel);
    var asset = state.data.models[key] || { width: res.width, height: res.height };
    asset.url = res.url;
    asset.width = res.width;
    asset.height = res.height;
    if (res.source) asset.source = res.source;
    state.data.models[key] = asset;
    refreshCanvases();
    setStatus('model ' + key + ' rendered · rot ' + previewRotOf(td).map(function (v) { return Math.round(v); }).join('/')
      + ' · zoom ' + previewZoomOf(td).toFixed(2) + (res.missing && res.missing.length ? ' · missing texture(s): ' + res.missing.join(', ') : ''), 'ok');
  }).catch(function (err) { setStatus('model render failed: ' + err.message, 'dirty'); });
}

/* Left-drag rotates the model (rx from vertical, rz from horizontal) — the same
   numbers TextDrawSetPreviewRot takes, so what you see is what the client gets. */
function startModelOrbit(event, td) {
  if (!SERVER_MODE) return;
  event.preventDefault();
  event.stopPropagation();
  var startX = event.clientX, startY = event.clientY;
  var origin = previewRotOf(td);
  var lastSent = 0, pending = false;
  var onMove = function (e) {
    var rot = origin.slice();
    rot[0] = Math.round((origin[0] + (e.clientY - startY) * 0.6) * 10) / 10;
    rot[2] = Math.round((origin[2] + (e.clientX - startX) * 0.6) * 10) / 10;
    td.previewRot = rot;
    markDirty();
    var now = Date.now();
    if (now - lastSent < 90) { pending = true; return; }
    lastSent = now;
    pending = false;
    renderModelPreview(td);
  };
  var onUp = function () {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (pending) renderModelPreview(td);
    renderProps();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function orbitZoom(td, factor) {
  if (!SERVER_MODE) return;
  td.previewZoom = Math.max(0.2, Math.min(4, Math.round(previewZoomOf(td) * factor * 100) / 100));
  markDirty();
  renderModelPreview(td);
}

function refreshCanvases() {
  var selected = state.selected;
  render();
  state.selected = selected;
  renderProps();
  var el = stage.querySelector('.td[data-id="' + selected + '"]');
  if (el && !el.classList.contains('hidden')) el.style.outline = '1px dashed var(--accent)';
}

function markDirty() {
  state.dirty = true;
  document.getElementById('saveBtn').disabled = !SERVER_MODE;
  setStatus('unsaved changes — click save to write the project file', 'dirty');
}

function setStatus(text, cls) {
  var el = document.getElementById('status');
  el.className = 'status ' + (cls || '');
  el.textContent = text;
}

function save() {
  if (!SERVER_MODE) return;
  setStatus('saving…');
  fetch('/api/textdraws', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: state.data.project, textdraws: state.data.textdraws })
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (res.error) { setStatus('save failed: ' + res.error, 'dirty'); return; }
    state.dirty = false;
    document.getElementById('saveBtn').disabled = true;
    document.getElementById('savedAt').textContent = res.updatedAt || '';
    setStatus('saved ' + res.count + ' textdraws', 'ok');
    fetch('/api/state?project=' + encodeURIComponent(state.data.project))
      .then(function (r) { return r.json(); })
      .then(function (st) { state.lastMtime = st.mtimeMs; })
      .catch(function () {});
  }).catch(function (err) { setStatus('save failed: ' + err.message, 'dirty'); });
}

function reload(force) {
  if (state.dirty && !force) { setStatus('unsaved changes — use Reload again to discard', 'dirty'); state.dirty = false; return; }
  if (SERVER_MODE) {
    fetch('/api/textdraws?project=' + encodeURIComponent(state.data.project))
      .then(function (r) { return r.json(); })
      .then(function (data) { state.data = data; state.dirty = false; document.getElementById('saveBtn').disabled = true; render(); renderProps(); setStatus('reloaded', 'ok'); })
      .catch(function () { location.reload(); });
    return;
  }
  state.data = JSON.parse(JSON.stringify(PAYLOAD));
  render();
  renderProps();
}

function poll() {
  if (!SERVER_MODE) return;
  fetch('/api/state?project=' + encodeURIComponent(state.data.project))
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!state.lastMtime) { state.lastMtime = res.mtimeMs; return; }
      if (res.mtimeMs !== state.lastMtime) {
        state.lastMtime = res.mtimeMs;
        if (!state.dirty) { state.dirty = false; reload(true); setStatus('project file changed on disk — reloaded', 'ok'); }
        else setStatus('project file changed on disk (unsaved local edits kept)', 'dirty');
      }
    })
    .catch(function () {});
}

/* Drag to move the selected textdraw. */
stage.addEventListener('mousedown', function (event) {
  var node = event.target.closest ? event.target.closest('.td') : null;
  if (!node) return;
  var id = node.dataset.id;
  var td = byId(id);
  if (!td) return;
  state.selected = id;
  var scale = stageScale();
  var startX = event.clientX, startY = event.clientY;
  var origX = td.x, origY = td.y;
  var moved = false;
  var onMove = function (e) {
    var dx = (e.clientX - startX) / scale.x;
    var dy = (e.clientY - startY) / scale.y;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 1) return;
    moved = true;
    td.x = Math.round((origX + dx) * 10) / 10;
    td.y = Math.round((origY + dy) * 10) / 10;
    markDirty();
    refreshCanvases();
  };
  var onUp = function () {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!moved) { render(); renderProps(); }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

document.addEventListener('keydown', function (event) {
  var td = byId(state.selected);
  if (!td || event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT') return;
  var step = event.shiftKey ? 0.1 : 0.5;
  if (event.key === 'ArrowLeft') { td.x -= step; }
  else if (event.key === 'ArrowRight') { td.x += step; }
  else if (event.key === 'ArrowUp') { td.y -= step; }
  else if (event.key === 'ArrowDown') { td.y += step; }
  else return;
  event.preventDefault();
  markDirty();
  refreshCanvases();
});

document.getElementById('search').oninput = function () { render(); };
document.getElementById('res').onchange = applyViewport;
document.getElementById('zoom').oninput = applyViewport;
document.getElementById('gridBtn').onclick = function () { document.getElementById('grid').classList.toggle('on'); };
document.getElementById('bg').onchange = function () {
  stage.className = document.getElementById('bg').value;
};
document.getElementById('saveBtn').onclick = save;
document.getElementById('resetBtn').onclick = function () { reload(false); };
window.addEventListener('beforeunload', function (e) {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

document.getElementById('savedAt').textContent = PAYLOAD.generatedAt;
if (!SERVER_MODE) {
  setStatus('static page — start the preview server (textdraw_preview serve=true) to edit and save', '');
}
render();
renderProps();
setInterval(poll, 2000);
</script>
</body>
</html>
`;
}
