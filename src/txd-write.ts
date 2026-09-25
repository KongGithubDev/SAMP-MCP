import {
  CHUNK_EXTENSION,
  CHUNK_STRUCT,
  CHUNK_TEXTURENATIVE,
  CHUNK_TEXDICTIONARY,
  dxtAlphaTable,
  dxtColorTable,
  rasterLevelBytes,
  type DecodedTexture,
  type TxdWriteFormat,
} from './txd.js';

/**
 * RenderWare TXD writer: raster encoders, mip chain generation and the section
 * builders the TXD editor saves with.
 *
 * Every field mirrors what stock GTA: SA dictionaries — and the Magic.TXD-written
 * ones in a SA-MP server's models/txd folder — actually contain (measured across
 * 132 dictionaries / 2012 textures):
 *
 *   - dictionary 0x16 = struct 0x01 { u16 numTextures, u16 deviceId } + one
 *     textureNative per texture + an empty extension 0x03,
 *   - textureNative 0x15 = struct 0x01 { 92-byte header + raster } + empty
 *     extension 0x03 (never a second struct),
 *   - header +72 rasterFormat (0x8000 added when mipmapped), +76 d3dFormat,
 *     +80/+82 u16 size, +84 depth, +85 numLevels, +86 rasterType 4,
 *     +87 flags (0x01 has alpha, 0x08 compressed), +88 first level byte length,
 *     +92 pixels,
 *   - level 0 sits directly after the header and every later level is preceded
 *     by its own u32 byte length (so a mipmapped texture carries 4 extra bytes
 *     per extra level — this is what 8888/1280x1280 with 11 levels at 8,738,252
 *     struct bytes proves),
 *   - uncompressed rows keep Direct3D's 4-byte pitch.
 *
 * The encoders use the decoder's own dxtColorTable/dxtAlphaTable, so an encoded
 * block always decodes back to the colours the encoder measured.
 */

/** RW 3.6.0.3, the stream version every GTA: SA (and SA-MP) dictionary uses. */
export const RW_SA_VERSION = 0x1803ffff;

/** Texture names live in a char[32] field, so 31 characters plus the NUL fit. */
export const TXD_NAME_LIMIT = 31;

/** Real SA dictionaries beyond this are rejected by the game's renderer. */
export const TXD_MAX_TEXTURE_SIZE = 4096;

/** Block-compression effort for the DXT formats: `fast` = one range fit, `high` = iterative cluster/least-squares refinement. */
export type TxdQuality = 'fast' | 'high';

const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_R5G6B5 = 23;
const D3DFMT_A1R5G5B5 = 25;
const D3DFMT_A4R4G4B4 = 26;
const D3DFMT_L8 = 50;
const D3DFMT_DXT1 = 0x31545844; // 'DXT1'
const D3DFMT_DXT3 = 0x33545844; // 'DXT3'
const D3DFMT_DXT5 = 0x35545844; // 'DXT5'

interface FormatSpec {
  rasterFormat: number;
  d3dFormat: number;
  depth: number;
  /** The format can carry alpha (used for the header flag and the format picker). */
  alpha: boolean;
  compressed: boolean;
}

const FORMAT_SPECS: Record<TxdWriteFormat, FormatSpec> = {
  '8888': { rasterFormat: 0x0500, d3dFormat: D3DFMT_A8R8G8B8, depth: 32, alpha: true, compressed: false },
  '888': { rasterFormat: 0x0600, d3dFormat: D3DFMT_X8R8G8B8, depth: 32, alpha: false, compressed: false },
  '565': { rasterFormat: 0x0200, d3dFormat: D3DFMT_R5G6B5, depth: 16, alpha: false, compressed: false },
  '555': { rasterFormat: 0x0100, d3dFormat: D3DFMT_A1R5G5B5, depth: 16, alpha: false, compressed: false },
  '4444': { rasterFormat: 0x0300, d3dFormat: D3DFMT_A4R4G4B4, depth: 16, alpha: true, compressed: false },
  'LUM8': { rasterFormat: 0x0400, d3dFormat: D3DFMT_L8, depth: 8, alpha: false, compressed: false },
  'DXT1': { rasterFormat: 0x0100, d3dFormat: D3DFMT_DXT1, depth: 16, alpha: true, compressed: true },
  'DXT3': { rasterFormat: 0x0300, d3dFormat: D3DFMT_DXT3, depth: 16, alpha: true, compressed: true },
  'DXT5': { rasterFormat: 0x0300, d3dFormat: D3DFMT_DXT5, depth: 16, alpha: true, compressed: true },
};

/** Every raster format the writer can produce, lossless first. */
export const TXD_TEXTURE_FORMATS: TxdWriteFormat[] = [
  '8888', '888', '565', '555', '4444', 'LUM8', 'DXT1', 'DXT3', 'DXT5',
];

/** One texture as the writer needs it: metadata plus the mip chain. */
interface TxdWriteTexture {
  name: string;
  mask?: string;
  format: TxdWriteFormat;
  /** Mip levels, level 0 first (build them with buildMipChain). */
  levels: DecodedTexture[];
  /** Override the filter/addressing u32. Default 0x1106 mipmapped, 0x1102 otherwise. */
  filterMode?: number;
  /** Override the header's has-alpha flag (default: measured from level 0). */
  hasAlpha?: boolean;
  /** Block-compression effort for DXT formats (default 'high'). */
  quality?: TxdQuality;
  /** Override the platformId (9 = Direct3D 9, the SA default). */
  platform?: number;
}

/**
 * A dictionary entry as it is written: either re-encoded from pixels, or a
 * textureNative section reused verbatim (formats the editor cannot decode keep
 * their original bytes this way).
 */
export type TxdWriteEntry = TxdWriteTexture | { section: Buffer };

/** True for entries carried over byte for byte instead of re-encoded. */
function isRawSection(entry: TxdWriteEntry): entry is { section: Buffer } {
  return 'section' in entry;
}

interface TextureHeader {
  rasterFormat: number;
  d3dFormat: number;
  depth: number;
  flags: number;
}

/** The raster/format/depth/flags quadruple a texture header is written with. */
export function textureFormatHeader(
  format: TxdWriteFormat,
  opts: { mipmaps: boolean; alpha: boolean },
): TextureHeader {
  const spec = FORMAT_SPECS[format];
  if (!spec) throw new Error(`unsupported write format "${format}"`);
  let flags = spec.compressed ? 0x08 : 0x00;
  if (opts.alpha && spec.alpha) flags |= 0x01;
  return {
    // Bit 0x8000 is "this raster has mipmaps" and appears on every mipmapped
    // texture in the wild (0x8500, 0x8600, 0x8300, 0x8100).
    rasterFormat: spec.rasterFormat | (opts.mipmaps ? 0x8000 : 0),
    d3dFormat: spec.d3dFormat,
    depth: spec.depth,
    flags,
  };
}

/** True when the image needs an alpha channel (per-format threshold). */
export function textureUsesAlpha(format: TxdWriteFormat, level: DecodedTexture): boolean {
  if (!FORMAT_SPECS[format]?.alpha) return false;
  // DXT1 stores either nothing or 1-bit alpha, so half-transparent pixels count
  // as transparent there; every other alpha format keeps 255-vs-anything.
  const threshold = format === 'DXT1' ? 128 : 255;
  for (let i = 3; i < level.rgba.length; i += 4) {
    if (level.rgba[i] < threshold) return true;
  }
  return false;
}

/** Number of levels a full mip chain has (each step halves, never below 1x1). */
function fullLevelCount(width: number, height: number): number {
  let levels = 1;
  let w = Math.max(1, width);
  let h = Math.max(1, height);
  while (w > 1 || h > 1) {
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    levels++;
  }
  return levels;
}

/** Box-filter downsample (area average), so odd sizes keep every source pixel. */
function downsample(image: DecodedTexture): DecodedTexture {
  const width = Math.max(1, image.width >> 1);
  const height = Math.max(1, image.height >> 1);
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * image.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width));
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * image.width + sx) * 4;
          r += image.rgba[s];
          g += image.rgba[s + 1];
          b += image.rgba[s + 2];
          a += image.rgba[s + 3];
          count++;
        }
      }
      const d = (y * width + x) * 4;
      rgba[d] = Math.round(r / count);
      rgba[d + 1] = Math.round(g / count);
      rgba[d + 2] = Math.round(b / count);
      rgba[d + 3] = Math.round(a / count);
    }
  }
  return { width, height, rgba };
}

/**
 * Mip chain for a texture: `'full'` halves down to 1x1 (what Magic.TXD writes —
 * a 1280x1280 texture ends up with 11 levels), a number asks for that many
 * levels, and 1 keeps a single level (what stock SA dictionaries do).
 */
export function buildMipChain(image: DecodedTexture, levels: 'full' | number = 'full'): DecodedTexture[] {
  const max = fullLevelCount(image.width, image.height);
  const wanted = levels === 'full' ? max : Math.max(1, Math.min(max, Math.round(levels)));
  const chain: DecodedTexture[] = [image];
  while (chain.length < wanted) chain.push(downsample(chain[chain.length - 1]));
  return chain;
}

// ---------------------------------------------------------------------------
// Uncompressed rasters
// ---------------------------------------------------------------------------

/** 8888 keeps the alpha byte, 888 forces it opaque (both are 4 bytes per pixel). */
function encode8888(rgba: Buffer, width: number, height: number, alpha: boolean): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; p < width * height; p++, i += 4) {
    out[i] = rgba[i + 2]; // Direct3D 8/9 rasters are BGRA
    out[i + 1] = rgba[i + 1];
    out[i + 2] = rgba[i];
    out[i + 3] = alpha ? rgba[i + 3] : 255;
  }
  return out;
}

function quantBits(value: number, bits: number): number {
  const max = (1 << bits) - 1;
  return Math.min(max, Math.max(0, Math.round((value * max) / 255)));
}

function encode16(rgba: Buffer, width: number, height: number, format: '565' | '555' | '4444'): Buffer {
  const rowBytes = (width * 2 + 3) & ~3;
  const out = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      let value: number;
      if (format === '565') {
        value = (quantBits(rgba[s], 5) << 11) | (quantBits(rgba[s + 1], 6) << 5) | quantBits(rgba[s + 2], 5);
      } else if (format === '555') {
        value = (quantBits(rgba[s], 5) << 10) | (quantBits(rgba[s + 1], 5) << 5) | quantBits(rgba[s + 2], 5);
      } else {
        value = (quantBits(rgba[s + 3], 4) << 12) | (quantBits(rgba[s], 4) << 8)
          | (quantBits(rgba[s + 1], 4) << 4) | quantBits(rgba[s + 2], 4);
      }
      out.writeUInt16LE(value, y * rowBytes + x * 2);
    }
  }
  return out;
}

/** LUM8 is luminance only, so colour information is dropped (as in the game). */
function encodeLum8(rgba: Buffer, width: number, height: number): Buffer {
  const rowBytes = (width + 3) & ~3;
  const out = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      out[y * rowBytes + x] = Math.round(0.299 * rgba[s] + 0.587 * rgba[s + 1] + 0.114 * rgba[s + 2]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DXT1 / DXT3 / DXT5
// ---------------------------------------------------------------------------

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

/** The 16 RGBA pixels of one 4x4 block, repeating the edge pixel outside the image. */
function gatherBlock(level: DecodedTexture, bx: number, by: number): number[] {
  const block = new Array<number>(64);
  for (let y = 0; y < 4; y++) {
    const sy = Math.min(level.height - 1, by * 4 + y);
    for (let x = 0; x < 4; x++) {
      const sx = Math.min(level.width - 1, bx * 4 + x);
      const s = (sy * level.width + sx) * 4;
      const d = (y * 4 + x) * 4;
      block[d] = level.rgba[s];
      block[d + 1] = level.rgba[s + 1];
      block[d + 2] = level.rgba[s + 2];
      block[d + 3] = level.rgba[s + 3];
    }
  }
  return block;
}

/**
 * Fast path: range-fit colour endpoints for one block — project the pixels
 * (only the ones that matter) on their widest axis, inset the extremes, quantise
 * to 16-bit 565 and pick the nearest palette entry per pixel, then re-centre the
 * endpoints on the pixels that chose them once. `quality: 'high'` replaces this
 * with the iterative cluster/least-squares encoder below.
 */
function packColourBlockFast(block: number[], fourColours: boolean): Buffer {
  const keep: number[] = [];
  const transparent: number[] = [];
  for (let i = 0; i < 16; i++) {
    // In the three-colour mode pixels below the 1-bit alpha threshold become
    // palette entry 3 (transparent) and must not drag the endpoints along.
    if (!fourColours && block[i * 4 + 3] < 128) transparent.push(i);
    else keep.push(i);
  }
  if (keep.length === 0) keep.push(0); // a fully transparent block still needs endpoints

  let axis = 0;
  let axisRange = -1;
  for (let c = 0; c < 3; c++) {
    let min = 255, max = 0;
    for (const i of keep) {
      const v = block[i * 4 + c];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max - min > axisRange) {
      axisRange = max - min;
      axis = c;
    }
  }

  let low = keep[0];
  let high = keep[0];
  for (const i of keep) {
    if (block[i * 4 + axis] < block[low * 4 + axis]) low = i;
    if (block[i * 4 + axis] > block[high * 4 + axis]) high = i;
  }
  const inset = (block[high * 4 + axis] - block[low * 4 + axis]) / 16;
  const lo = [0, 1, 2].map((c) => clamp255(block[low * 4 + c] + (c === axis ? inset : 0)));
  const hi = [0, 1, 2].map((c) => clamp255(block[high * 4 + c] - (c === axis ? inset : 0)));

  let c0 = (quantBits(lo[0], 5) << 11) | (quantBits(lo[1], 6) << 5) | quantBits(lo[2], 5);
  let c1 = (quantBits(hi[0], 5) << 11) | (quantBits(hi[1], 6) << 5) | quantBits(hi[2], 5);
  // DXT1 with 1-bit alpha needs the "c0 <= c1" ordering for its three-colour +
  // transparent mode; every other case follows the usual c0 > c1 ordering.
  if (fourColours ? c0 < c1 : c0 > c1) {
    const swap = c0;
    c0 = c1;
    c1 = swap;
  }

  const codes = new Array<number>(16).fill(0);
  let table = dxtColorTable(c0, c1, fourColours);
  const assign = () => {
    // A DXT1 block whose endpoints ended up equal would make the decoder treat
    // entry 3 as transparent black, so that entry stays unused in that case.
    const lastCode = fourColours && c0 !== c1 ? 3 : 2;
    for (const i of keep) {
      let best = 0;
      let bestDistance = Infinity;
      for (let k = 0; k <= lastCode; k++) {
        const dr = table[k][0] - block[i * 4];
        const dg = table[k][1] - block[i * 4 + 1];
        const db = table[k][2] - block[i * 4 + 2];
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = k;
        }
      }
      codes[i] = best;
    }
  };
  assign();

  if (fourColours) {
    // Refine: average the pixels that chose endpoint 0 / endpoint 1 and retry.
    const refine = (code: number): number[] | null => {
      let r = 0, g = 0, b = 0, count = 0;
      for (const i of keep) {
        if (codes[i] !== code) continue;
        r += block[i * 4];
        g += block[i * 4 + 1];
        b += block[i * 4 + 2];
        count++;
      }
      return count ? [r / count, g / count, b / count] : null;
    };
    const lo2 = refine(0);
    const hi2 = refine(1);
    if (lo2 && hi2) {
      let n0 = (quantBits(lo2[0], 5) << 11) | (quantBits(lo2[1], 6) << 5) | quantBits(lo2[2], 5);
      let n1 = (quantBits(hi2[0], 5) << 11) | (quantBits(hi2[1], 6) << 5) | quantBits(hi2[2], 5);
      if (n0 < n1) {
        const swap = n0;
        n0 = n1;
        n1 = swap;
      }
      c0 = n0;
      c1 = n1;
      table = dxtColorTable(c0, c1, fourColours);
      assign();
    }
  }

  for (const i of transparent) codes[i] = 3;
  let indices = 0;
  for (let i = 0; i < 16; i++) indices |= (codes[i] & 0x03) << (2 * i);

  const out = Buffer.alloc(8);
  out.writeUInt16LE(c0, 0);
  out.writeUInt16LE(c1, 2);
  out.writeUInt32LE(indices >>> 0, 4);
  return out;
}

/**
 * Palette slot weights. Entry k of a DXT colour table is the linear combination
 * `a * c0 + b * c1`, which is what the least-squares fit below leans on; the
 * DXT5 alpha table follows the same shape.
 */
const FOUR_COLOUR_SLOTS: [number, number][] = [[1, 0], [0, 1], [2 / 3, 1 / 3], [1 / 3, 2 / 3]];
const THREE_COLOUR_SLOTS: [number, number][] = [[1, 0], [0, 1], [1 / 2, 1 / 2]];
/** DXT5's 8-value alpha mode: index 0 = a0, 1 = a1, 2..7 = the six-step ramp. */
const ALPHA8_SLOTS: [number, number][] = ([[1, 0], [0, 1]] as [number, number][]).concat(
  [1, 2, 3, 4, 5, 6].map((step) => [(7 - step) / 7, step / 7] as [number, number]),
);
/** DXT5's 6-value mode ([a0 <= a1]): four ramp steps plus the constants 0 and 255. */
const ALPHA6_SLOTS: [number, number][] = ([[1, 0], [0, 1]] as [number, number][]).concat(
  [1, 2, 3, 4].map((step) => [(5 - step) / 5, step / 5] as [number, number]),
  [[0, 0], [0, 0]] as [number, number][],
);

function quantizeColour(rgb: number[]): number {
  return (quantBits(rgb[0], 5) << 11) | (quantBits(rgb[1], 6) << 5) | quantBits(rgb[2], 5);
}

/**
 * Least-squares endpoint fit for a block whose pixel → palette-entry assignment
 * is already known — the "refine" half of a squish-style compressor. Because
 * every palette entry is a fixed linear combination of the two endpoints, the
 * optimal (end0, end1) is the solution of a 2x2 normal-equation system per
 * channel: it beats re-centring the endpoints on their own cluster mean, which
 * is what the fast path does.
 */
function fitEndpoints(
  keep: number[],
  codes: number[],
  slots: [number, number][],
  channels: number,
  sample: (pixel: number, channel: number) => number,
): { end0: number[]; end1: number[]; fitted: boolean } {
  const counts = new Array<number>(slots.length).fill(0);
  const sums: number[][] = slots.map(() => new Array<number>(channels).fill(0));
  for (const i of keep) {
    const slot = codes[i];
    if (slot < 0 || slot >= slots.length) continue;
    counts[slot]++;
    for (let c = 0; c < channels; c++) sums[slot][c] += sample(i, c);
  }
  const end0 = new Array<number>(channels).fill(0);
  const end1 = new Array<number>(channels).fill(0);
  let fitted = false;
  for (let c = 0; c < channels; c++) {
    let s00 = 0, s01 = 0, s11 = 0, r0 = 0, r1 = 0;
    for (let slot = 0; slot < slots.length; slot++) {
      const count = counts[slot];
      if (count === 0) continue;
      const [a, b] = slots[slot];
      const mean = sums[slot][c];
      s00 += count * a * a;
      s01 += count * a * b;
      s11 += count * b * b;
      r0 += a * mean;
      r1 += b * mean;
    }
    const det = s00 * s11 - s01 * s01;
    if (Math.abs(det) < 1e-9) continue;
    end0[c] = (s11 * r0 - s01 * r1) / det;
    end1[c] = (s00 * r1 - s01 * r0) / det;
    fitted = true;
  }
  return { end0, end1, fitted };
}

/** Nearest palette entry per pixel; returns the total squared error. */
function assignColourCodes(keep: number[], block: number[], table: number[][], lastCode: number, codes: number[]): number {
  let error = 0;
  for (const i of keep) {
    let best = 0;
    let bestDistance = Infinity;
    for (let k = 0; k <= lastCode; k++) {
      const entry = table[k];
      const dr = entry[0] - block[i * 4];
      const dg = entry[1] - block[i * 4 + 1];
      const db = entry[2] - block[i * 4 + 2];
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = k;
      }
    }
    codes[i] = best;
    error += bestDistance;
  }
  return error;
}

/** DXT1 with 1-bit alpha needs "c0 <= c1" for its three-colour mode, others "c0 > c1". */
function orderColourPair(c0: number, c1: number, fourColours: boolean): [number, number] {
  const swap = fourColours ? c0 < c1 : c0 > c1;
  return swap ? [c1, c0] : [c0, c1];
}

/**
 * Endpoint candidates to try for one block. A single range fit handles smooth
 * blocks, but one outlier (a dark edge, a single highlight) stretches the range
 * and ruins the rest, so a few cheap seeds are tried and the best wins.
 */
function colourSeeds(block: number[], keep: number[]): number[][][] {
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (const i of keep) {
    for (let c = 0; c < 3; c++) {
      const value = block[i * 4 + c];
      if (value < min[c]) min[c] = value;
      if (value > max[c]) max[c] = value;
    }
  }
  let axis = 0;
  for (let c = 1; c < 3; c++) if (max[c] - min[c] > max[axis] - min[axis]) axis = c;
  let low = keep[0];
  let high = keep[0];
  for (const i of keep) {
    if (block[i * 4 + axis] < block[low * 4 + axis]) low = i;
    if (block[i * 4 + axis] > block[high * 4 + axis]) high = i;
  }
  const colourOf = (i: number): number[] => [block[i * 4], block[i * 4 + 1], block[i * 4 + 2]];
  const lo = colourOf(low);
  const hi = colourOf(high);
  const inset = (hi[axis] - lo[axis]) / 16;
  const seeds: number[][][] = [
    [lo, hi],
    [
      lo.map((value, c) => clamp255(value + (c === axis ? inset : 0))),
      hi.map((value, c) => clamp255(value - (c === axis ? inset : 0))),
    ],
    [[min[0], min[1], min[2]], [max[0], max[1], max[2]]],
  ];
  // Farthest pair, seeded from the darkest pixel: robust when one corner drags
  // the extremes away from the cluster that actually matters.
  const luminance = (i: number): number => block[i * 4] + block[i * 4 + 1] + block[i * 4 + 2];
  let dark = keep[0];
  for (const i of keep) if (luminance(i) < luminance(dark)) dark = i;
  const farthest = (from: number): number => {
    let pick = from;
    let best = -1;
    for (const i of keep) {
      const dr = block[i * 4] - block[from * 4];
      const dg = block[i * 4 + 1] - block[from * 4 + 1];
      const db = block[i * 4 + 2] - block[from * 4 + 2];
      const distance = dr * dr + dg * dg + db * db;
      if (distance > best) {
        best = distance;
        pick = i;
      }
    }
    return pick;
  };
  const a = farthest(dark);
  seeds.push([colourOf(a), colourOf(farthest(a))]);
  return seeds;
}

/**
 * High-quality colour block: for every seed, alternate "assign the nearest
 * palette entry" with a least-squares endpoint fit until it settles (the loop
 * libsquish uses), measuring the error *after* the 565 quantisation — i.e.
 * against what the game really decodes — and keep the best result. Blocks whose
 * error falls under 2% of their own deviation stop early, which is what keeps a
 * bulk conversion affordable.
 */
function packColourBlockHigh(block: number[], fourColours: boolean): Buffer {
  const keep: number[] = [];
  const transparent: number[] = [];
  for (let i = 0; i < 16; i++) {
    if (!fourColours && block[i * 4 + 3] < 128) transparent.push(i);
    else keep.push(i);
  }
  if (keep.length === 0) keep.push(0);

  const slots = fourColours ? FOUR_COLOUR_SLOTS : THREE_COLOUR_SLOTS;
  const codes = new Array<number>(16).fill(0);
  let bestC0 = 0;
  let bestC1 = 0;
  let bestCodes = codes.slice();
  let bestError = Infinity;

  let meanR = 0, meanG = 0, meanB = 0;
  for (const i of keep) {
    meanR += block[i * 4];
    meanG += block[i * 4 + 1];
    meanB += block[i * 4 + 2];
  }
  meanR /= keep.length;
  meanG /= keep.length;
  meanB /= keep.length;
  let deviation = 0;
  for (const i of keep) {
    deviation += (block[i * 4] - meanR) ** 2 + (block[i * 4 + 1] - meanG) ** 2 + (block[i * 4 + 2] - meanB) ** 2;
  }

  for (const seed of colourSeeds(block, keep)) {
    let [c0, c1] = orderColourPair(quantizeColour(seed[0]), quantizeColour(seed[1]), fourColours);
    for (let iteration = 0; iteration < 3; iteration++) {
      const table = dxtColorTable(c0, c1, fourColours);
      // A DXT1 block with equal endpoints would make entry 3 transparent, so it
      // stays unused there (the fast path guards this the same way).
      const lastCode = fourColours && c0 !== c1 ? 3 : 2;
      const error = assignColourCodes(keep, block, table, lastCode, codes);
      if (error < bestError) {
        bestError = error;
        bestC0 = c0;
        bestC1 = c1;
        bestCodes = codes.slice();
      }
      if (error === 0) break;
      const fit = fitEndpoints(keep, codes, slots, 3, (pixel, channel) => block[pixel * 4 + channel]);
      if (!fit.fitted) break;
      const [next0, next1] = orderColourPair(
        quantizeColour([clamp255(fit.end0[0]), clamp255(fit.end0[1]), clamp255(fit.end0[2])]),
        quantizeColour([clamp255(fit.end1[0]), clamp255(fit.end1[1]), clamp255(fit.end1[2])]),
        fourColours,
      );
      if (next0 === c0 && next1 === c1) break;
      c0 = next0;
      c1 = next1;
    }
    if (bestError <= deviation * 0.02) break;
  }

  for (const i of transparent) bestCodes[i] = 3;
  let indices = 0;
  for (let i = 0; i < 16; i++) indices |= (bestCodes[i] & 0x03) << (2 * i);
  const out = Buffer.alloc(8);
  out.writeUInt16LE(bestC0, 0);
  out.writeUInt16LE(bestC1, 2);
  out.writeUInt32LE(indices >>> 0, 4);
  return out;
}

/** 16 4-bit alphas for DXT3 (the decoder expands them with v * 17). */
function packAlpha4(block: number[]): Buffer {
  const out = Buffer.alloc(8);
  for (let i = 0; i < 16; i++) {
    out[i >> 1] |= quantBits(block[i * 4 + 3], 4) << ((i & 1) * 4);
  }
  return out;
}

/**
 * DXT5 fast path: the alpha endpoints are the block's extremes (a0 = max,
 * a1 = min), so a fully opaque or fully transparent pixel round-trips exactly.
 * 16 indices are packed as 3 bits each, little endian.
 */
function packAlpha8Fast(block: number[]): Buffer {
  let min = 255;
  let max = 0;
  for (let i = 0; i < 16; i++) {
    const a = block[i * 4 + 3];
    if (a < min) min = a;
    if (a > max) max = a;
  }
  const table = dxtAlphaTable(max, min);
  const codes = new Array<number>(16).fill(0);
  for (let i = 0; i < 16; i++) {
    const alpha = block[i * 4 + 3];
    let best = 0;
    let bestDistance = Infinity;
    for (let k = 0; k < 8; k++) {
      const distance = Math.abs(table[k] - alpha);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = k;
      }
    }
    codes[i] = best;
  }
  const out = Buffer.alloc(8);
  out[0] = max;
  out[1] = min;
  packAlphaIndices(codes).copy(out, 2);
  return out;
}

/** Packs DXT5's 16 three-bit alpha indices (little endian, 6 bytes). */
function packAlphaIndices(codes: number[]): Buffer {
  const out = Buffer.alloc(6);
  for (let i = 0; i < 16; i++) {
    const bit = i * 3;
    out[bit >> 3] |= (codes[i] << (bit & 7)) & 0xff;
    if ((bit & 7) > 5) out[(bit >> 3) + 1] |= codes[i] >> (8 - (bit & 7));
  }
  return out;
}

/**
 * High-quality DXT5 alpha block: every quartile pairing of the sorted alpha
 * values is scored (a ramp wants a tighter pair than its extremes, a two-tone
 * block wants its two tones), the block's own extreme pair always included, and
 * the four lowest-error candidates then run the same assign/least-squares-fit
 * loop the colour blocks use; the lowest error wins.
 */
function packAlpha8High(block: number[]): Buffer {
  const alphas: number[] = [];
  for (let i = 0; i < 16; i++) alphas.push(block[i * 4 + 3]);
  const sorted = [...alphas].sort((a, b) => a - b);

  // Error of a pair exactly as the game decodes it, plus the per-pixel codes.
  const scoreOf = (a0: number, a1: number): { error: number; codes: number[] } => {
    const table = dxtAlphaTable(a0, a1);
    const picked = new Array<number>(16).fill(0);
    let error = 0;
    for (let i = 0; i < 16; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let k = 0; k < 8; k++) {
        const distance = Math.abs(table[k] - alphas[i]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = k;
        }
      }
      picked[i] = best;
      error += bestDistance * bestDistance;
    }
    return { error, codes: picked };
  };

  // Candidate pairs: every quartile pairing — a smooth ramp wants a tighter pair
  // than its extremes, while a two-tone block wants exactly its two tones — and,
  // when the block holds both 0 and 255, the six-value mode (a0 <= a1) whose
  // literal 0/255 entries are the only way to hit a hard-edged mask exactly.
  // Distinct values matter here: a ramp block repeats each of its four steps four
  // times, so indexing the raw sorted list would only ever offer one pair.
  const distinct = [...new Set(sorted)];
  // The coarse steps let a candidate sit slightly outside the block's own range,
  // which is exactly what a smooth ramp needs (its best pair brackets the steps
  // rather than ending on them).
  const steps = [0, 85, 170, 255];
  const top = [...new Set([...distinct.slice(-4), ...steps])];
  const bottom = [...new Set([...distinct.slice(0, 4), ...steps])];
  const seen = new Set<string>();
  const candidates: [number, number][] = [];
  const push = (a0: number, a1: number) => {
    const key = `${a0}:${a1}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push([a0, a1]);
  };
  for (const a0 of top) {
    for (const a1 of bottom) {
      // a0 >= a1 selects the 8-value mode. The 6-value mode (a0 <= a1) is only
      // worth it for the literal 0/255 pair below, so the other orderings are not
      // screened at all — that halves the block's screening cost.
      if (a0 < a1) continue;
      push(a0, a1);
    }
  }
  if (sorted[0] === 0 && sorted[15] === 255) push(0, 255);

  // Score every candidate (cheap) and refine only the best few, which is where
  // the assign/least-squares loop earns its keep.
  const ranked = candidates
    .map((candidate) => ({ candidate, ...scoreOf(candidate[0], candidate[1]) }))
    .sort((left, right) => left.error - right.error);

  const keep: number[] = [];
  for (let i = 0; i < 16; i++) keep.push(i);
  let bestA0 = ranked[0].candidate[0];
  let bestA1 = ranked[0].candidate[1];
  let bestCodes = ranked[0].codes;
  let bestError = ranked[0].error;

  for (const entry of ranked.slice(0, 4)) {
    let a0 = entry.candidate[0];
    let a1 = entry.candidate[1];
    const codes = new Array<number>(16).fill(0);
    // Alpha converges slowly on a ramp (four steps only bracket the ends), so the
    // refinement runs longer here than it does for colour blocks.
    for (let iteration = 0; iteration < 6; iteration++) {
      const table = dxtAlphaTable(a0, a1);
      let error = 0;
      for (const i of keep) {
        let best = 0;
        let bestDistance = Infinity;
        for (let k = 0; k < 8; k++) {
          const distance = Math.abs(table[k] - alphas[i]);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = k;
          }
        }
        codes[i] = best;
        error += bestDistance * bestDistance;
      }
      if (error < bestError) {
        bestError = error;
        bestA0 = a0;
        bestA1 = a1;
        bestCodes = codes.slice();
      }
      if (error === 0) break;
      const slots = a0 > a1 ? ALPHA8_SLOTS : ALPHA6_SLOTS;
      const fit = fitEndpoints(keep, codes, slots, 1, (pixel) => alphas[pixel]);
      if (!fit.fitted) break;
      const next0 = clamp255(fit.end0[0]);
      const next1 = clamp255(fit.end1[0]);
      if (next0 === a0 && next1 === a1) break;
      a0 = next0;
      a1 = next1;
    }
    if (bestError === 0) break;
  }

  const out = Buffer.alloc(8);
  out[0] = bestA0;
  out[1] = bestA1;
  packAlphaIndices(bestCodes).copy(out, 2);
  return out;
}

function encodeDxt(rgba: Buffer, width: number, height: number, format: 'DXT1' | 'DXT3' | 'DXT5', quality: TxdQuality): Buffer {
  const level: DecodedTexture = { width, height, rgba };
  const blocksX = Math.max(1, (width + 3) >> 2);
  const blocksY = Math.max(1, (height + 3) >> 2);
  const blockBytes = format === 'DXT1' ? 8 : 16;
  const out = Buffer.alloc(blocksX * blocksY * blockBytes);
  let offset = 0;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const block = gatherBlock(level, bx, by);
      const packColours = (fourColours: boolean) => (quality === 'fast'
        ? packColourBlockFast(block, fourColours)
        : packColourBlockHigh(block, fourColours));
      if (format === 'DXT1') {
        // fourColours = false enables the 3-colour + transparent mode when the
        // block has pixels below the 1-bit alpha threshold.
        const hasTransparent = block.some((_, i) => i % 4 === 3 && block[i] < 128);
        packColours(!hasTransparent).copy(out, offset);
      } else if (format === 'DXT3') {
        packAlpha4(block).copy(out, offset);
        packColours(true).copy(out, offset + 8);
      } else {
        (quality === 'fast' ? packAlpha8Fast(block) : packAlpha8High(block)).copy(out, offset);
        packColours(true).copy(out, offset + 8);
      }
      offset += blockBytes;
    }
  }
  return out;
}

/** Encodes one mip level of an image in the given format (exactly its raster size). */
function encodeRaster(format: TxdWriteFormat, level: DecodedTexture, quality: TxdQuality = 'high'): Buffer {
  const { width, height, rgba } = level;
  let data: Buffer;
  switch (format) {
    case '8888': data = encode8888(rgba, width, height, true); break;
    case '888': data = encode8888(rgba, width, height, false); break;
    case '565':
    case '555':
    case '4444': data = encode16(rgba, width, height, format); break;
    case 'LUM8': data = encodeLum8(rgba, width, height); break;
    case 'DXT1':
    case 'DXT3':
    case 'DXT5': data = encodeDxt(rgba, width, height, format, quality); break;
    default: throw new Error(`unsupported write format "${format}"`);
  }
  const expected = rasterLevelBytes(format, width, height);
  if (data.length !== expected) {
    throw new Error(`internal error: ${format} ${width}x${height} encoded to ${data.length} bytes, expected ${expected}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function chunk(type: number, payload: Buffer, version = RW_SA_VERSION): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(type >>> 0, 0);
  header.writeUInt32LE(payload.length, 4);
  header.writeUInt32LE(version >>> 0, 8);
  return Buffer.concat([header, payload]);
}

/** Latin-1 into a fixed field, always NUL terminated — texture names are char[32]. */
function writeFixedString(buffer: Buffer, offset: number, length: number, value: string): void {
  buffer.write(value.slice(0, length - 1), offset, length - 1, 'latin1');
}

/** Byte length of the textureNative section an entry would be written as. */
export function textureChunkBytes(entry: TxdWriteEntry): number {
  if (isRawSection(entry)) return entry.section.length;
  let raster = 0;
  for (let i = 0; i < entry.levels.length; i++) {
    const level = entry.levels[i];
    raster += rasterLevelBytes(entry.format, level.width, level.height) + (i > 0 ? 4 : 0);
  }
  return 12 + 12 + 92 + raster + 12;
}

/** One textureNative section: struct (92-byte header + raster) plus an empty extension. */
function buildTextureNativeChunk(texture: TxdWriteTexture): Buffer {
  const levels = texture.levels;
  if (!levels.length) throw new Error(`texture "${texture.name}" has no mip levels to write`);
  const mipmaps = levels.length > 1;
  const alpha = texture.hasAlpha ?? textureUsesAlpha(texture.format, levels[0]);
  const header = textureFormatHeader(texture.format, { mipmaps, alpha });
  const encoded = levels.map((level) => encodeRaster(texture.format, level, texture.quality));

  const struct = Buffer.alloc(92);
  struct.writeUInt32LE(texture.platform ?? 9, 0); // Direct3D 9 platform id
  struct.writeUInt32LE(texture.filterMode ?? (mipmaps ? 0x1106 : 0x1102), 4);
  writeFixedString(struct, 8, 32, texture.name);
  writeFixedString(struct, 40, 32, texture.mask ?? '');
  struct.writeUInt32LE(header.rasterFormat >>> 0, 72);
  struct.writeUInt32LE(header.d3dFormat >>> 0, 76);
  struct.writeUInt16LE(levels[0].width, 80);
  struct.writeUInt16LE(levels[0].height, 82);
  struct.writeUInt8(header.depth, 84);
  struct.writeUInt8(levels.length, 85);
  struct.writeUInt8(4, 86); // rasterType: 4 on every PC dictionary measured
  struct.writeUInt8(header.flags, 87);
  struct.writeUInt32LE(encoded[0].length, 88);

  const raster: Buffer[] = [struct, encoded[0]];
  for (let i = 1; i < encoded.length; i++) {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(encoded[i].length, 0);
    raster.push(size, encoded[i]);
  }

  return chunk(CHUNK_TEXTURENATIVE, Buffer.concat([
    chunk(CHUNK_STRUCT, Buffer.concat(raster)),
    chunk(CHUNK_EXTENSION, Buffer.alloc(0)),
  ]));
}

/**
 * A complete dictionary: struct { numTextures, deviceId }, every textureNative,
 * then an empty extension — the layout of all 132 dictionaries measured here.
 */
export function buildTxdBuffer(opts: {
  textures: TxdWriteEntry[];
  /** 2 in stock SA dictionaries, 0 in Magic.TXD output; both load fine. */
  deviceId?: number;
  version?: number;
}): Buffer {
  const struct = Buffer.alloc(4);
  struct.writeUInt16LE(opts.textures.length, 0);
  struct.writeUInt16LE(opts.deviceId ?? 2, 2);
  return chunk(CHUNK_TEXDICTIONARY, Buffer.concat([
    chunk(CHUNK_STRUCT, struct),
    ...opts.textures.map((entry) => (isRawSection(entry) ? entry.section : buildTextureNativeChunk(entry))),
    chunk(CHUNK_EXTENSION, Buffer.alloc(0)),
  ]), opts.version ?? RW_SA_VERSION);
}
