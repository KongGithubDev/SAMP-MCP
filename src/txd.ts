import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Minimal RenderWare TXD (texture dictionary) reader.
 *
 * SA-MP textdraws show images through two mechanisms, and both are nicer to
 * design when the texture data can be seen outside the game:
 *
 *  - font 4 sprite textdraws → the text is "<txdname>:<spritename>" and the
 *    sprite comes from a GTA .txd dictionary (stock or custom/0.3.DL).
 *  - font 5 model previews   → TextDrawSetPreviewModel(modelid) (+ optional
 *    AddSimpleModel for custom 0.3.DL models / UI textures).
 *
 * This module parses PC (Direct3D 8/9) texture dictionaries, decodes the first
 * mip level of the common GTA raster formats (8888/888/565/555/4444/LUM8 and
 * the DXT1/2/3/4/5 compressed variants) and re-encodes them as PNG, so samp-mcp
 * can render the real sprites in its textdraw preview page.
 *
 * Layouts follow the GTAMods "Texture Dictionary (RW Section)" and
 * "Raster (RW Section)" documentation.
 */

const CHUNK_STRUCT = 0x01;
const CHUNK_EXTENSION = 0x03;
const CHUNK_TEXTURENATIVE = 0x15;
const CHUNK_TEXDICTIONARY = 0x16;

const D3DFMT_DXT1 = 0x31545844; // 'DXT1'
const D3DFMT_DXT2 = 0x32545844;
const D3DFMT_DXT3 = 0x33545844;
const D3DFMT_DXT4 = 0x34545844;
const D3DFMT_DXT5 = 0x35545844;

type TxdPixelFormat =
  | '8888' | '888' | '565' | '555' | '4444' | 'LUM8' | 'PAL8' | 'DXT1' | 'DXT3' | 'DXT5' | 'unknown';

export interface TxdTexture {
  name: string;
  mask: string;
  width: number;
  height: number;
  depth: number;
  numLevels: number;
  rasterFormat: number;
  d3dFormat: number;
  format: TxdPixelFormat;
  hasAlpha: boolean;
  compressed: boolean;
  /** Bytes of the first mip level (what the decoder reads). */
  dataSize: number;
  /** Bytes of the whole raster including mip levels (0 when the writer omits it). */
  rasterBytes: number;
  decodable: boolean;
  decodeError?: string;
}

export interface TxdDictionary {
  file: string;
  /** Base name of the .txd without extension — this is what font 4 textdraws reference. */
  name: string;
  /** Direct3D device id from the dictionary struct (0 for RW 3.0-3.5 dictionaries). */
  deviceId: number;
  version: string;
  textures: TxdTexture[];
  error?: string;
}

export interface DecodedTexture {
  width: number;
  height: number;
  /** RGBA8, 4 bytes per pixel, top row first. */
  rgba: Buffer;
}

interface RwChunk {
  type: number;
  size: number;
  version: number;
  dataStart: number;
  end: number;
}

interface NativeTexture {
  texture: TxdTexture;
  dataOffset: number | null;
  paletteOffset: number | null;
  paletteEntrySize: number;
}

/**
 * Walks the child chunks inside [start, end). RenderWare stores the *payload*
 * size in the header, so a chunk occupies 12 + size bytes; `size` is kept here
 * as the total (header included) to keep the offset arithmetic obvious.
 * Verified against stock GTA: SA files (gta3.img models, models/generic/*.DFF,
 * models/*.txd), where the payload convention walks each file exactly.
 */
function readChunks(buf: Buffer, start: number, end: number): RwChunk[] {
  const chunks: RwChunk[] = [];
  let off = start;
  while (off + 12 <= end) {
    const type = buf.readUInt32LE(off);
    const total = buf.readUInt32LE(off + 4) + 12;
    const version = buf.readUInt32LE(off + 8);
    if (total < 12 || off + total > end) break;
    chunks.push({ type, size: total, version, dataStart: off + 12, end: off + total });
    off += total;
  }
  return chunks;
}

function readCString(buf: Buffer, offset: number, length: number): string {
  if (offset + length > buf.length) return '';
  const slice = buf.subarray(offset, offset + length);
  const zero = slice.indexOf(0);
  const raw = zero >= 0 ? slice.subarray(0, zero) : slice;
  return raw.toString('latin1').replace(/[^\x20-\x7e]/g, '').trim();
}

/** RenderWare stream versions seen in GTA dictionaries (bits 14+ hold the RW lib version). */
const RW_VERSIONS: Record<number, string> = {
  0x1803ffff: 'RW 3.6.0.3 (GTA SA)',
  0x1400ffff: 'RW 3.4.0.3 (GTA VC 1.1 / SA mobile assets)',
  0x1003ffff: 'RW 3.3.0.2 (GTA VC)',
  0x0800ffff: 'RW 3.0.0.0 (GTA III)',
  0x1c020fff: 'RW 3.7.0.2',
};

export function rwVersionString(version: number): string {
  const hex = (version >>> 0).toString(16).padStart(8, '0');
  const known = RW_VERSIONS[version >>> 0];
  return known ? `0x${hex.toUpperCase()} · ${known}` : `0x${hex.toUpperCase()}`;
}

function detectFormat(rasterFormat: number, d3dFormat: number, compressed: boolean): TxdPixelFormat {
  if (d3dFormat === D3DFMT_DXT1 || d3dFormat === D3DFMT_DXT2) return 'DXT1';
  if (d3dFormat === D3DFMT_DXT3 || d3dFormat === D3DFMT_DXT4) return 'DXT3';
  if (d3dFormat === D3DFMT_DXT5) return 'DXT5';

  const base = rasterFormat & 0x0f00;
  const paletted = (rasterFormat & 0x2000) !== 0 || (rasterFormat & 0x4000) !== 0;

  if (compressed) {
    // Older dictionaries flag DXT through the RW raster format instead of a D3D FourCC.
    if (base === 0x0100 || base === 0x0200) return 'DXT1';
    if (base === 0x0300) return 'DXT3';
    if (base === 0x0500) return 'DXT5';
  }
  if (paletted) return 'PAL8';
  switch (base) {
    case 0x0100: return '555';
    case 0x0200: return '565';
    case 0x0300: return '4444';
    case 0x0400: return 'LUM8';
    case 0x0500: return '8888';
    case 0x0600: return '888';
    case 0x0a00: return '555';
    default: break;
  }
  switch (d3dFormat) {
    case 21: return '8888'; // A8R8G8B8
    case 22: return '888'; // X8R8G8B8
    case 23: return '565'; // R5G6B5
    case 24:
    case 25: return '555';
    case 26: return '4444';
    case 32:
    case 50: return 'LUM8';
    case 40:
    case 41: return 'PAL8';
    default: return 'unknown';
  }
}

function mipLevelSize(format: TxdPixelFormat, width: number, height: number): number {
  const blocks = Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2);
  switch (format) {
    case 'DXT1': return blocks * 8;
    case 'DXT3':
    case 'DXT5': return blocks * 16;
    case '8888':
    case '888': return width * height * 4;
    case '565':
    case '555':
    case '4444': return width * height * 2;
    case 'LUM8':
    case 'PAL8':
      // Direct3D raster rows are 4-byte aligned.
      return ((width + 3) & ~3) * height;
    default: return 0;
  }
}

function bytesPerPixel(format: TxdPixelFormat): number {
  switch (format) {
    case '8888':
    case '888': return 4;
    case '565':
    case '555':
    case '4444': return 2;
    default: return 1;
  }
}

/** TextureNative structs are 96 bytes on Direct3D 9 (GTA SA) and 88 on Direct3D 8. */
function parseTextureNative(buf: Buffer, chunk: RwChunk): NativeTexture | null {
  const children = readChunks(buf, chunk.dataStart, chunk.end);
  const structs = children.filter((c) => c.type === CHUNK_STRUCT);
  const extensions = children.filter((c) => c.type === CHUNK_EXTENSION);
  if (structs.length === 0) return null;

  const header = structs[0];
  const p = header.dataStart;
  const platform = buf.readUInt32LE(p);
  const isD3D9 = platform === 9;
  const isD3D8 = platform === 8;

  if (!isD3D8 && !isD3D9) {
    const unsupported: TxdTexture = {
      name: readCString(buf, p + 8, 32) || '(unnamed)',
      mask: '',
      width: 0,
      height: 0,
      depth: 0,
      numLevels: 0,
      rasterFormat: 0,
      d3dFormat: 0,
      format: 'unknown',
      hasAlpha: false,
      compressed: false,
      dataSize: 0,
      rasterBytes: 0,
      decodable: false,
      decodeError: `unsupported platform id ${platform} (only PC Direct3D 8/9 dictionaries can be decoded)`,
    };
    return { texture: unsupported, dataOffset: null, paletteOffset: null, paletteEntrySize: 0 };
  }

  const name = readCString(buf, p + 8, 32);
  const mask = readCString(buf, p + 40, 32);
  const rasterFormat = buf.readUInt32LE(p + 72);
  const d3dFormat = buf.readUInt32LE(p + 76);

  // Header layout after rasterFormat/d3dFormat, verified against stock SA
  // dictionaries (background.txd, models/fonts.txd, models/generic/vehicle.txd):
  //   +80 u16 width, +82 u16 height, +84 u8 depth, +85 u8 numLevels,
  //   +86 u8 rasterType, +87 u8 flags (0x01 hasAlpha, 0x08 compressed),
  //   +88 u32 raster bytes (all mip levels), data starts at +92 (D3D9) / +88 (D3D8).
  let width: number;
  let height: number;
  let depth: number;
  let numLevels: number;

  const flags = buf.readUInt8(p + 87);
  const compressed = (flags & 0x08) !== 0;
  let hasAlpha = (flags & 0x01) !== 0;
  let rasterBytes = 0;
  let headerSize: number;

  if (isD3D9) {
    width = buf.readUInt16LE(p + 80);
    height = buf.readUInt16LE(p + 82);
    depth = buf.readUInt8(p + 84);
    numLevels = buf.readUInt8(p + 85);
    rasterBytes = p + 92 <= chunk.end ? buf.readUInt32LE(p + 88) : 0;
    headerSize = 92;
  } else {
    width = buf.readUInt16LE(p + 80);
    height = buf.readUInt16LE(p + 82);
    depth = buf.readUInt8(p + 84);
    numLevels = buf.readUInt8(p + 85);
    headerSize = 88;
  }

  const format = detectFormat(rasterFormat, d3dFormat, compressed);
  if (!hasAlpha && (format === '8888' || format === '4444' || format === 'DXT3' || format === 'DXT5')) hasAlpha = true;
  const dataSize = mipLevelSize(format, width, height);
  const texture: TxdTexture = {
    name: name || '(unnamed)',
    mask,
    width,
    height,
    depth,
    numLevels: Math.max(1, numLevels),
    rasterFormat,
    d3dFormat,
    format,
    hasAlpha,
    compressed,
    dataSize,
    rasterBytes,
    decodable: false,
  };

  // Pixel data normally follows the header in the same struct; some writers put
  // it in a second struct instead, so both layouts are considered.
  const rasterChunk = structs.length > 1 ? structs[structs.length - 1] : null;
  const rasterStart = rasterChunk ? rasterChunk.dataStart : header.dataStart;
  const rasterEnd = rasterChunk ? rasterChunk.end : header.end;

  const paletted = format === 'PAL8';
  const paletteEntrySize = paletted ? 4 : 0;
  const extensionPalette = paletted && extensions.length > 0 && extensions[0].size - 12 >= 256 * paletteEntrySize
    ? extensions[0].dataStart
    : null;

  const layout = locateRaster(
    buf,
    rasterStart,
    rasterEnd,
    dataSize,
    rasterChunk || extensionPalette !== null ? 0 : headerSize,
    extensionPalette === null ? 256 * paletteEntrySize : 0,
  );
  if (layout) {
    texture.decodable = true;
    return {
      texture,
      dataOffset: layout.dataOffset,
      paletteOffset: layout.paletteOffset ?? extensionPalette,
      paletteEntrySize,
    };
  }
  texture.decodeError = dataSize > 0
    ? `could not locate raster data (${format} ${width}x${height}, expected ${dataSize} bytes)`
    : `unsupported raster format 0x${rasterFormat.toString(16)} / d3d 0x${d3dFormat.toString(16)}`;
  return { texture, dataOffset: null, paletteOffset: extensionPalette, paletteEntrySize };
}

/**
 * Finds the first mip level inside a raster section: normally it sits right
 * after the header (later mip levels follow it), but some writers prefix the
 * pixels with their byte length or store them in a separate section — those are
 * recognised by comparing the size computed from the header.
 */
function locateRaster(
  buf: Buffer,
  start: number,
  end: number,
  expectedSize: number,
  headerBytes: number,
  paletteBytes: number,
): { dataOffset: number; paletteOffset: number | null } | null {
  if (expectedSize <= 0 || start >= end) return null;
  const paletteOffset = paletteBytes > 0 ? start : null;
  const payload = start + paletteBytes;

  if (payload + headerBytes + expectedSize <= end) return { dataOffset: payload + headerBytes, paletteOffset };

  const limit = Math.min(payload + 256, end - expectedSize);
  for (let at = payload; at <= limit; at++) {
    if (buf.readUInt32LE(at) === expectedSize && at + 4 + expectedSize <= end) return { dataOffset: at + 4, paletteOffset };
    if (at + expectedSize === end) return { dataOffset: at, paletteOffset };
  }
  return null;
}

export function parseTxd(buffer: Buffer, file: string): TxdDictionary {
  const baseName = file.replace(/\\/g, '/').split('/').pop() || file;
  const dict: TxdDictionary = {
    file,
    name: baseName.replace(/\.txd$/i, ''),
    deviceId: 0,
    version: '',
    textures: [],
  };
  if (buffer.length < 12 || buffer.readUInt32LE(0) !== CHUNK_TEXDICTIONARY) {
    dict.error = buffer.length < 12
      ? 'file is too small to be a TXD'
      : `not a texture dictionary (root section 0x${buffer.readUInt32LE(0).toString(16)})`;
    return dict;
  }
  const size = Math.min(buffer.readUInt32LE(4) + 12, buffer.length);
  const version = buffer.readUInt32LE(8);
  dict.version = rwVersionString(version);

  const children = readChunks(buffer, 12, size);
  const structChunk = children.find((c) => c.type === CHUNK_STRUCT);
  if (structChunk && version >= 0x36003 && structChunk.size >= 16) {
    dict.deviceId = buffer.readUInt16LE(structChunk.dataStart + 2);
  }

  for (const child of children) {
    if (child.type !== CHUNK_TEXTURENATIVE) continue;
    try {
      const native = parseTextureNative(buffer, child);
      if (native) dict.textures.push(native.texture);
    } catch (error: any) {
      dict.textures.push({
        name: '(unparsable)',
        mask: '',
        width: 0,
        height: 0,
        depth: 0,
        numLevels: 0,
        rasterFormat: 0,
        d3dFormat: 0,
        format: 'unknown',
        hasAlpha: false,
        compressed: false,
        dataSize: 0,
        rasterBytes: 0,
        decodable: false,
        decodeError: error.message,
      });
    }
  }
  if (dict.textures.length === 0 && !dict.error) dict.error = 'no textures found in dictionary';
  return dict;
}

// ---------------------------------------------------------------------------
// Pixel decoding
// ---------------------------------------------------------------------------

function expand5(v: number): number { return (v << 3) | (v >> 2); }
function expand6(v: number): number { return (v << 2) | (v >> 4); }
function expand4(v: number): number { return (v << 4) | v; }

function dxtColorTable(c0: number, c1: number): number[][] {
  const r0 = expand5((c0 >> 11) & 0x1f);
  const g0 = expand6((c0 >> 5) & 0x3f);
  const b0 = expand5(c0 & 0x1f);
  const r1 = expand5((c1 >> 11) & 0x1f);
  const g1 = expand6((c1 >> 5) & 0x3f);
  const b1 = expand5(c1 & 0x1f);
  const table: number[][] = [
    [r0, g0, b0, 255],
    [r1, g1, b1, 255],
  ];
  if (c0 > c1) {
    table[2] = [((2 * r0 + r1) / 3) | 0, ((2 * g0 + g1) / 3) | 0, ((2 * b0 + b1) / 3) | 0, 255];
    table[3] = [((r0 + 2 * r1) / 3) | 0, ((g0 + 2 * g1) / 3) | 0, ((b0 + 2 * b1) / 3) | 0, 255];
  } else {
    table[2] = [((r0 + r1) / 2) | 0, ((g0 + g1) / 2) | 0, ((b0 + b1) / 2) | 0, 255];
    table[3] = [0, 0, 0, 0];
  }
  return table;
}

function decodeDxt(buf: Buffer, offset: number, format: TxdPixelFormat, width: number, height: number): DecodedTexture {
  const rgba = Buffer.alloc(width * height * 4);
  const blocksX = Math.max(1, (width + 3) >> 2);
  const blocksY = Math.max(1, (height + 3) >> 2);
  const blockBytes = format === 'DXT1' ? 8 : 16;
  let off = offset;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const block = buf.subarray(off, off + blockBytes);
      off += blockBytes;
      let colorBlock = block;
      let alpha: number[] | null = null;

      if (format === 'DXT3') {
        colorBlock = block.subarray(8);
        alpha = [];
        for (let i = 0; i < 16; i++) alpha.push(expand4((block[i >> 1] >> ((i & 1) * 4)) & 0x0f));
      } else if (format === 'DXT5') {
        colorBlock = block.subarray(8);
        const a0 = block[0];
        const a1 = block[1];
        const table = [a0, a1];
        if (a0 > a1) {
          for (let i = 1; i <= 6; i++) table.push((((7 - i) * a0 + i * a1) / 7) | 0);
        } else {
          for (let i = 1; i <= 4; i++) table.push((((5 - i) * a0 + i * a1) / 5) | 0);
          table.push(0);
          table.push(255);
        }
        let bits = 0;
        for (let i = 0; i < 6; i++) bits |= block[2 + i] << (8 * i);
        alpha = [];
        for (let i = 0; i < 16; i++) alpha.push(table[(bits >>> (3 * i)) & 0x07]);
      }

      const table = dxtColorTable(colorBlock.readUInt16LE(0), colorBlock.readUInt16LE(2));
      const indices = colorBlock.readUInt32LE(4);

      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y;
        if (py >= height) break;
        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x;
          if (px >= width) break;
          const color = table[(indices >>> (2 * (4 * y + x))) & 0x03];
          const o = (py * width + px) * 4;
          rgba[o] = color[0];
          rgba[o + 1] = color[1];
          rgba[o + 2] = color[2];
          rgba[o + 3] = alpha ? alpha[4 * y + x] : color[3];
        }
      }
    }
  }
  return { width, height, rgba };
}

function decodeUncompressed(
  buf: Buffer,
  offset: number,
  format: TxdPixelFormat,
  width: number,
  height: number,
  palette: Buffer | null,
  paletteEntrySize: number,
): DecodedTexture {
  const rgba = Buffer.alloc(width * height * 4);
  const rowBytes = (width * bytesPerPixel(format) + 3) & ~3;
  for (let y = 0; y < height; y++) {
    const row = offset + y * rowBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      switch (format) {
        case '8888': { // D3D9 BGRA
          const s = row + x * 4;
          rgba[o] = buf[s + 2];
          rgba[o + 1] = buf[s + 1];
          rgba[o + 2] = buf[s];
          rgba[o + 3] = buf[s + 3];
          break;
        }
        case '888': {
          const s = row + x * 4;
          rgba[o] = buf[s + 2];
          rgba[o + 1] = buf[s + 1];
          rgba[o + 2] = buf[s];
          rgba[o + 3] = 255;
          break;
        }
        case '565': {
          const v = buf.readUInt16LE(row + x * 2);
          rgba[o] = expand5((v >> 11) & 0x1f);
          rgba[o + 1] = expand6((v >> 5) & 0x3f);
          rgba[o + 2] = expand5(v & 0x1f);
          rgba[o + 3] = 255;
          break;
        }
        case '555': {
          const v = buf.readUInt16LE(row + x * 2);
          rgba[o] = expand5((v >> 10) & 0x1f);
          rgba[o + 1] = expand5((v >> 5) & 0x1f);
          rgba[o + 2] = expand5(v & 0x1f);
          rgba[o + 3] = 255;
          break;
        }
        case '4444': {
          const v = buf.readUInt16LE(row + x * 2);
          rgba[o] = expand4((v >> 8) & 0x0f);
          rgba[o + 1] = expand4((v >> 4) & 0x0f);
          rgba[o + 2] = expand4(v & 0x0f);
          rgba[o + 3] = expand4((v >> 12) & 0x0f);
          break;
        }
        case 'LUM8': {
          const g = buf[row + x];
          rgba[o] = g;
          rgba[o + 1] = g;
          rgba[o + 2] = g;
          rgba[o + 3] = 255;
          break;
        }
        case 'PAL8': {
          const index = buf[row + x];
          const s = index * paletteEntrySize;
          if (palette && paletteEntrySize > 0 && s + paletteEntrySize <= palette.length) {
            rgba[o] = palette[s + 2];
            rgba[o + 1] = palette[s + 1];
            rgba[o + 2] = palette[s];
            rgba[o + 3] = paletteEntrySize >= 4 ? palette[s + 3] : 255;
          } else {
            rgba[o] = index;
            rgba[o + 1] = index;
            rgba[o + 2] = index;
            rgba[o + 3] = 255;
          }
          break;
        }
        default: {
          rgba[o] = 255;
          rgba[o + 1] = 0;
          rgba[o + 2] = 255;
          rgba[o + 3] = 255;
          break;
        }
      }
    }
  }
  return { width, height, rgba };
}

function decodeNative(buf: Buffer, native: NativeTexture): DecodedTexture | null {
  const { format, width, height } = native.texture;
  if (native.dataOffset === null || width <= 0 || height <= 0) return null;
  if (native.dataOffset + native.texture.dataSize > buf.length) return null;
  if (format === 'DXT1' || format === 'DXT3' || format === 'DXT5') {
    return decodeDxt(buf, native.dataOffset, format, width, height);
  }
  if (format === 'unknown') return null;
  const palette = native.paletteOffset !== null && native.paletteEntrySize > 0
    ? buf.subarray(native.paletteOffset, native.paletteOffset + 256 * native.paletteEntrySize)
    : null;
  return decodeUncompressed(
    buf,
    native.dataOffset,
    format,
    width,
    height,
    palette,
    native.paletteEntrySize || 4,
  );
}

/** Decodes the first mip level of one named texture out of a TXD buffer. */
export function decodeTxdTexture(buffer: Buffer, textureName: string): DecodedTexture | null {
  if (buffer.length < 12 || buffer.readUInt32LE(0) !== CHUNK_TEXDICTIONARY) return null;
  const size = Math.min(buffer.readUInt32LE(4) + 12, buffer.length);
  for (const child of readChunks(buffer, 12, size)) {
    if (child.type !== CHUNK_TEXTURENATIVE) continue;
    const native = parseTextureNative(buffer, child);
    if (!native || !native.texture.name.toLowerCase().startsWith(textureName.toLowerCase())) continue;
    const decoded = decodeNative(buffer, native);
    if (decoded) return decoded;
  }
  return null;
}

// ---------------------------------------------------------------------------
// PNG encoding (no external dependency: zlib deflate + CRC32)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** Encodes RGBA8 pixels as a PNG (bit depth 8, colour type 6). */
export function encodePng(image: DecodedTexture): Buffer {
  const { width, height, rgba } = image;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Halves a decoded texture until it fits maxSize, so preview pages stay small. */
export function shrinkTexture(image: DecodedTexture, maxSize: number): DecodedTexture {
  let current = image;
  while (
    current.width > maxSize && current.height > maxSize
    && current.width % 2 === 0 && current.height % 2 === 0
  ) {
    const width = current.width >> 1;
    const height = current.height >> 1;
    const next = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const s = (y * 2 * current.width + x * 2) * 4;
        const d = (y * width + x) * 4;
        next[d] = current.rgba[s];
        next[d + 1] = current.rgba[s + 1];
        next[d + 2] = current.rgba[s + 2];
        next[d + 3] = current.rgba[s + 3];
      }
    }
    current = { width, height, rgba: next };
  }
  return current;
}

export function pngDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}

// ---------------------------------------------------------------------------
// PNG decoding (design-time sprite/texture overrides are plain PNGs)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decodes a PNG (8/16 bit, non-interlaced, colour types 0/2/3/4/6) to RGBA8,
 * so "<txd>__<texture>.png" design images can be used as model textures and
 * sprite previews. Returns null for anything outside that subset.
 */
export function decodePng(buffer: Buffer): DecodedTexture | null {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];

  while (off + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(off);
    const type = buffer.toString('latin1', off + 4, off + 8);
    const dataStart = off + 8;
    if (dataStart + length + 4 > buffer.length) break;
    const data = buffer.subarray(dataStart, dataStart + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      transparency = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off = dataStart + length + 4;
  }
  if (!width || !height || !idat.length) return null;
  if (interlace !== 0) return null;
  if (bitDepth !== 8 && bitDepth !== 16) return null;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) return null;
  if (colorType === 3 && !palette) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const bytesPerSample = bitDepth / 8;
  const stride = width * channels * bytesPerSample;
  const rgba = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    if (rowStart + 1 + stride > raw.length) return null;
    const filter = raw[rowStart];
    const src = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels * bytesPerSample ? line[i - channels * bytesPerSample] : 0;
      const b = prev[i];
      const c = i >= channels * bytesPerSample ? prev[i - channels * bytesPerSample] : 0;
      const value = src[i];
      line[i] = filter === 0 ? value
        : filter === 1 ? (value + a) & 0xff
        : filter === 2 ? (value + b) & 0xff
        : filter === 3 ? (value + ((a + b) >> 1)) & 0xff
        : filter === 4 ? (value + paeth(a, b, c)) & 0xff
        : value;
    }
    for (let x = 0; x < width; x++) {
      const source = x * channels * bytesPerSample;
      const target = (y * width + x) * 4;
      const sample = (channel: number): number => line[source + channel * bytesPerSample];
      if (colorType === 3) {
        const index = line[source];
        rgba[target] = palette ? palette[index * 3] ?? 0 : 0;
        rgba[target + 1] = palette ? palette[index * 3 + 1] ?? 0 : 0;
        rgba[target + 2] = palette ? palette[index * 3 + 2] ?? 0 : 0;
        rgba[target + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const grey = sample(0);
        rgba[target] = grey;
        rgba[target + 1] = grey;
        rgba[target + 2] = grey;
        rgba[target + 3] = colorType === 4 ? sample(1) : 255;
      } else {
        rgba[target] = sample(0);
        rgba[target + 1] = sample(1);
        rgba[target + 2] = sample(2);
        rgba[target + 3] = colorType === 6 ? sample(3) : 255;
      }
    }
    line.copy(prev);
  }

  return { width, height, rgba };
}
