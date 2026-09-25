import { type DecodedTexture, rwVersionString } from './txd.js';

/**
 * Minimal RenderWare DFF (clump) reader + software renderer.
 *
 * SA-MP shows 3D models two ways, and both are far easier to design when the
 * mesh can be seen outside the game:
 *
 *  - font 5 textdraws: `TextDrawSetPreviewModel(td, 411)` renders a rotating
 *    3D model preview (optionally a custom 0.3.DL model registered with
 *    AddSimpleModel).
 *  - custom model slots: the .dff/.txd pair the server ships.
 *
 * This module parses the clump hierarchy (Struct, Frame List, Geometry List,
 * Geometry + Material List, Atomic), flattens it into world-space triangles,
 * and renders those with a z-buffered software rasteriser (bilinear texture
 * sampling from the matching .txd, lambert shading, alpha blending) so samp-mcp
 * can produce the PNG a font 5 textdraw shows. It also exports OBJ/MTL and
 * glTF for people who want to open the model in Blender or three.js.
 *
 * Layouts follow the GTAMods "RenderWare Stream Section" documentation:
 * RpClump (0x10), RpGeometry (0x0F), RpMaterial (0x07).
 */

const CHUNK_STRUCT = 0x01;
const CHUNK_STRING = 0x02;
const CHUNK_EXTENSION = 0x03;
const CHUNK_TEXTURE = 0x06;
const CHUNK_MATERIAL = 0x07;
const CHUNK_MATERIALLIST = 0x08;
const CHUNK_FRAMELIST = 0x0e;
const CHUNK_GEOMETRY = 0x0f;
const CHUNK_CLUMP = 0x10;
/** Atomic: struct { frameIndex, geometryIndex, flags, unused }. */
const CHUNK_ATOMIC = 0x14;
/** Geometry list: struct { numGeometries } + Geometry chunks. */
const CHUNK_GEOMETRYLIST = 0x1a;
/** Pre-3.4 writers used 0x11 for atomics; keep reading it for old models. */
const LEGACY_ATOMIC = 0x11;

/** Extension plugin ids we recognise (by name only — their payload is skipped). */
const PLG_BINMESH = 0x0253f2f9;
const PLG_NODE_NAME = 0x0253f2fe;
const PLG_SKIN = 0x0253f2f7;
const PLG_2DEFFECT = 0x0253f2f8;
const PLG_FRAME = 0x0253f2ff;

const CHUNK_ATOMIC_IDS = [CHUNK_ATOMIC, LEGACY_ATOMIC];

const rpGEOMETRYTRISTRIP = 0x00000001;
const rpGEOMETRYTEXTURED = 0x00000004;
const rpGEOMETRYPRELIT = 0x00000008;
const rpGEOMETRYNORMALS = 0x00000010;
const rpGEOMETRYTEXTURED2 = 0x00000080;
const rpGEOMETRYNATIVE = 0x01000000;

/** Address modes of an RW sampler (filterAddressing low word = filter, high = addressing). */
const ADDRESS_WRAP = 1;
const ADDRESS_MIRROR = 2;
const ADDRESS_CLAMP = 3;

interface RwChunk {
  type: number;
  size: number;
  version: number;
  dataStart: number;
  end: number;
}

interface DffTriangle {
  a: number;
  b: number;
  c: number;
  material: number;
}

interface DffMaterial {
  index: number;
  /** rgba 0-255 as streamed. SA marks vehicle body parts through the alpha byte. */
  color: [number, number, number, number];
  texture: string;
  mask: string;
  /** 1 wrap, 2 mirror, 3 clamp. */
  addressing: number;
  filtered: boolean;
  ambient: number;
  specular: number;
  diffuse: number;
}

interface DffGeometry {
  index: number;
  format: number;
  numVertices: number;
  numTriangles: number;
  numTexSets: number;
  native: boolean;
  skinned: boolean;
  hasNormals: boolean;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array | null;
  colors: Uint8Array | null;
  triangles: DffTriangle[];
  materials: DffMaterial[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  extensions: string[];
}

interface DffFrame {
  index: number;
  name: string;
  parent: number;
  position: [number, number, number];
  /** Row-major 4x4 local transform. */
  local: Float32Array;
  /** Row-major 4x4 transform with all parents applied. */
  world: Float32Array;
}

interface DffAtomic {
  frame: number;
  geometry: number;
  flags: number;
}

interface DffClump {
  version: number;
  frames: DffFrame[];
  atomics: DffAtomic[];
  geometries: DffGeometry[];
}

export interface DffModel {
  file: string;
  /** Human readable RenderWare version of the clump. */
  version: string;
  geometries: DffGeometry[];
  frames: DffFrame[];
  atomics: DffAtomic[];
  clumps: DffClump[];
  /** Texture names referenced by any material, in first-use order. */
  textures: string[];
  stats: {
    clumps: number;
    geometries: number;
    atomics: number;
    frames: number;
    dummies: number;
    vertices: number;
    triangles: number;
    materials: number;
    skinned: boolean;
  };
  warnings: string[];
}

export interface MeshData {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array | null;
  colors: Uint8Array | null;
  triangles: DffTriangle[];
  materials: DffMaterial[];
  bounds: { center: [number, number, number]; radius: number; min: [number, number, number]; max: [number, number, number] };
  stats: { vertices: number; triangles: number; materials: number; texturedMaterials: number };
  warnings: string[];
}

interface MeshRenderOptions {
  width: number;
  height: number;
  /** TextDrawSetPreviewRot angles (degrees) applied to the model. */
  rot?: [number, number, number];
  /** TextDrawSetPreviewRot zoom factor (1 = fit, > 1 = closer). */
  zoom?: number;
  /** Camera orbit around the model: 0 yaw looks at the model's front (-Y). */
  cameraYaw?: number;
  cameraPitch?: number;
  /** Background RGBA; null/omitted renders on transparency. */
  background?: [number, number, number, number] | null;
  /** 1-3; renders at N× and box-filters down. Default 2 (1 when the image is huge). */
  supersample?: number;
  /** TextDrawSetPreviewVehCol [primary, secondary] for vehicle models. */
  vehCol?: [number, number];
  texture?: (name: string) => DecodedTexture | null;
}

export interface MeshRenderResult {
  image: DecodedTexture;
  triangles: number;
  drawn: number;
  coverage: number;
  texturesUsed: string[];
  texturesMissing: string[];
}

/**
 * Walks the child chunks inside [start, end). RenderWare stores the *payload*
 * size in the header, so a chunk occupies 12 + size bytes; `size` is kept as the
 * total (header included) to keep the offset arithmetic obvious. Validated
 * against stock GTA: SA and modded files (models/generic/*.DFF, gta3.img
 * entries), where the payload convention walks every file exactly.
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

function readCString(buf: Buffer, offset: number, end: number): string {
  if (offset < 0 || offset >= end) return '';
  let stop = offset;
  while (stop < end && buf[stop] !== 0) stop++;
  return buf.subarray(offset, stop).toString('latin1').replace(/[^\x20-\x7e]/g, '').trim();
}

function readFloats(buf: Buffer, offset: number, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = buf.readFloatLE(offset + i * 4);
  return out;
}

function identity4(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function multiply4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
  }
  return out;
}

function transformPoint(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

function transformDirection(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[4] * x + m[5] * y + m[6] * z,
    m[8] * x + m[9] * y + m[10] * z,
  ];
}

/** Parses one material chunk (Struct + optional Texture). */
function parseMaterial(buf: Buffer, chunk: RwChunk, index: number, version: number): DffMaterial {
  const material: DffMaterial = {
    index,
    color: [255, 255, 255, 255],
    texture: '',
    mask: '',
    addressing: ADDRESS_WRAP,
    filtered: true,
    ambient: 0,
    specular: 0,
    diffuse: 1,
  };
  const kids = readChunks(buf, chunk.dataStart, chunk.end);
  const struct = kids.find((k) => k.type === CHUNK_STRUCT);
  if (struct && struct.dataStart + 16 <= struct.end) {
    const base = struct.dataStart;
    material.color = [buf[base + 4], buf[base + 5], buf[base + 6], buf[base + 7]];
    if (version > 0x30400 && base + 28 <= struct.end) {
      material.ambient = buf.readFloatLE(base + 16);
      material.specular = buf.readFloatLE(base + 20);
      material.diffuse = buf.readFloatLE(base + 24);
    }
  }
  const texture = kids.find((k) => k.type === CHUNK_TEXTURE);
  if (texture) {
    const textureKids = readChunks(buf, texture.dataStart, texture.end);
    const texStruct = textureKids.find((k) => k.type === CHUNK_STRUCT);
    if (texStruct && texStruct.dataStart + 4 <= texStruct.end) {
      const filter = buf.readUInt16LE(texStruct.dataStart);
      const addressing = buf.readUInt16LE(texStruct.dataStart + 2);
      material.filtered = filter !== 0;
      material.addressing = addressing & 0x0f;
    }
    const names = textureKids.filter((k) => k.type === CHUNK_STRING);
    if (names[0]) material.texture = readCString(buf, names[0].dataStart, names[0].end);
    if (names[1]) material.mask = readCString(buf, names[1].dataStart, names[1].end);
  }
  return material;
}

interface GeometryPayload {
  format: number;
  numTriangles: number;
  numVertices: number;
  numTexSets: number;
  native: boolean;
  colors: Uint8Array | null;
  uvs: Float32Array | null;
  triangles: DffTriangle[];
  positions: Float32Array;
  normals: Float32Array;
  hasNormals: boolean;
}

/**
 * Reads a geometry struct. RW 3.3 and older stored ambient/specular/diffuse in
 * the geometry itself (12 extra bytes before the vertex data), so both layouts
 * are tried and the one whose triangle indices actually resolve wins.
 */
function parseGeometryPayload(buf: Buffer, struct: RwChunk, skipSurface: boolean): GeometryPayload | null {
  let off = struct.dataStart + (skipSurface ? 28 : 16);
  const end = struct.end;
  if (struct.dataStart + 16 > end) return null;

  const format = buf.readUInt32LE(struct.dataStart);
  const numTriangles = buf.readUInt32LE(struct.dataStart + 4);
  const numVertices = buf.readUInt32LE(struct.dataStart + 8);
  const numMorphTargets = buf.readUInt32LE(struct.dataStart + 12);
  if (numVertices <= 0 || numTriangles <= 0 || numVertices > 2_000_000 || numTriangles > 2_000_000) return null;

  const native = (format & rpGEOMETRYNATIVE) !== 0;
  let numTexSets = (format >>> 16) & 0xff;
  if (numTexSets === 0) {
    if (format & rpGEOMETRYTEXTURED) numTexSets = 1;
    else if (format & rpGEOMETRYTEXTURED2) numTexSets = 2;
  }

  let colors: Uint8Array | null = null;
  let uvs: Float32Array | null = null;
  const triangles: DffTriangle[] = [];

  if (!native) {
    if (format & rpGEOMETRYPRELIT) {
      if (off + numVertices * 4 > end) return null;
      colors = new Uint8Array(numVertices * 4);
      for (let i = 0; i < numVertices * 4; i++) colors[i] = buf[off + i];
      off += numVertices * 4;
    }
    if (numTexSets > 0) {
      if (off + numVertices * 8 * numTexSets > end) return null;
      uvs = new Float32Array(numVertices * 2);
      for (let i = 0; i < numVertices; i++) {
        uvs[i * 2] = buf.readFloatLE(off + i * 8);
        uvs[i * 2 + 1] = buf.readFloatLE(off + i * 8 + 4);
      }
      off += numVertices * 8 * numTexSets;
    }
    if (off + numTriangles * 8 > end) return null;
    for (let t = 0; t < numTriangles; t++) {
      const b = buf.readUInt16LE(off);
      const a = buf.readUInt16LE(off + 2);
      const material = buf.readUInt16LE(off + 4);
      const c = buf.readUInt16LE(off + 6);
      if (a >= numVertices || b >= numVertices || c >= numVertices) return null;
      triangles.push({ a, b, c, material });
      off += 8;
    }
  }

  let positions: Float32Array = new Float32Array(0);
  let normals: Float32Array = new Float32Array(0);
  let hasNormals = (format & rpGEOMETRYNORMALS) !== 0;
  const targetCount = Math.max(1, numMorphTargets);
  for (let target = 0; target < targetCount; target++) {
    if (off + 24 > end) break;
    off += 16; // bounding sphere
    const hasVertices = buf.readUInt32LE(off) !== 0;
    off += 4;
    const hasN = buf.readUInt32LE(off) !== 0;
    off += 4;
    if (hasVertices) {
      if (target === 0 && off + numVertices * 12 <= end) positions = readFloats(buf, off, numVertices * 3);
      off += numVertices * 12;
    }
    if (hasN) {
      if (target === 0 && off + numVertices * 12 <= end) {
        normals = readFloats(buf, off, numVertices * 3);
        hasNormals = normals.some((value) => value !== 0);
      }
      off += numVertices * 12;
    }
  }
  if (positions.length !== numVertices * 3) return null;

  return { format, numTriangles, numVertices, numTexSets, native, colors, uvs, triangles, positions, normals, hasNormals };
}

/** Parses a geometry chunk (Struct carries the actual vertex/triangle data). */
function parseGeometry(buf: Buffer, chunk: RwChunk, index: number, warnings: string[]): DffGeometry | null {
  const kids = readChunks(buf, chunk.dataStart, chunk.end);
  const struct = kids.find((k) => k.type === CHUNK_STRUCT);
  if (!struct) return null;
  const version = chunk.version;
  // 0x1400 (RW 3.4) and newer moved the surface properties into the material.
  const preferSurface = (version >>> 16) < 0x1400;
  const payload = preferSurface
    ? (parseGeometryPayload(buf, struct, true) ?? parseGeometryPayload(buf, struct, false))
    : (parseGeometryPayload(buf, struct, false) ?? parseGeometryPayload(buf, struct, true));
  if (!payload) return null;

  const {
    format, numTriangles, numVertices, numTexSets, native, colors, uvs, triangles, positions, normals, hasNormals,
  } = payload;
  if (native) warnings.push('geometry is stored in the platform-native format (console asset) — vertices unavailable');
  if (format & rpGEOMETRYTRISTRIP) warnings.push('triangle strip geometry is drawn as a triangle list');

  const materials: DffMaterial[] = [];
  const materialList = kids.find((k) => k.type === CHUNK_MATERIALLIST);
  if (materialList) {
    const listKids = readChunks(buf, materialList.dataStart, materialList.end);
    const listStruct = listKids.find((k) => k.type === CHUNK_STRUCT);
    const declared = listStruct && listStruct.dataStart + 4 <= listStruct.end ? buf.readUInt32LE(listStruct.dataStart) : 0;
    let seen = 0;
    for (const kid of listKids) {
      if (kid.type !== CHUNK_MATERIAL) continue;
      materials.push(parseMaterial(buf, kid, seen++, version));
    }
    if (declared !== materials.length) warnings.push(`material list declares ${declared} materials but stores ${materials.length}`);
  }

  const extensions: string[] = [];
  let skinned = false;
  const parseExtension = (ext: RwChunk): void => {
    const plugins = readChunks(buf, ext.dataStart, ext.end);
    for (const plugin of plugins) {
      if (plugin.type === PLG_SKIN) {
        skinned = true;
        extensions.push('Skin PLG');
      } else if (plugin.type === PLG_BINMESH) extensions.push('Bin Mesh PLG');
      else if (plugin.type === PLG_2DEFFECT) extensions.push('2d Effect');
      else if (plugin.type === PLG_FRAME) extensions.push('Frame PLG');
    }
  };
  for (const kid of kids) if (kid.type === CHUNK_EXTENSION) parseExtension(kid);
  if (skinned) warnings.push('skinned geometry exports its bind pose only (no bone animation is applied)');

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < numVertices; i++) {

    for (let axis = 0; axis < 3; axis++) {
      const v = positions[i * 3 + axis] || 0;
      if (v < min[axis]) min[axis] = v;
      if (v > max[axis]) max[axis] = v;
    }
  }
  if (!Number.isFinite(min[0])) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  return {
    index,
    format,
    numVertices,
    numTriangles,
    numTexSets,
    native,
    skinned,
    hasNormals,
    positions,
    normals,
    uvs,
    colors,
    triangles,
    materials,
    bounds: { min, max },
    extensions,
  };
}

/** Frame index of a chunk that looks like an atomic (struct with frame/geometry indices). */
function atomicFrameOf(buf: Buffer, chunk: RwChunk): number | null {
  const struct = readChunks(buf, chunk.dataStart, chunk.end).find((k) => k.type === CHUNK_STRUCT);
  if (!struct) return null;
  const payload = struct.size - 12;
  if (payload !== 12 && payload !== 16) return null;
  const frame = buf.readInt32LE(struct.dataStart);
  return frame >= 0 && frame < 1_000_000 ? frame : null;
}

/** Parses a frame list chunk into frames with local and world (hierarchy-applied) matrices. */
function parseFrameList(buf: Buffer, chunk: RwChunk): DffFrame[] {
  const kids = readChunks(buf, chunk.dataStart, chunk.end);
  const struct = kids.find((k) => k.type === CHUNK_STRUCT);
  if (!struct || struct.dataStart + 4 > struct.end) return [];
  const count = buf.readUInt32LE(struct.dataStart);
  // 0x1400 (RW 3.4) stores matrix-then-position; older files store the position first.
  const matrixFirst = (chunk.version >>> 16) >= 0x1400;
  const frames: DffFrame[] = [];
  let off = struct.dataStart + 4;

  for (let i = 0; i < count; i++) {
    if (off + 56 > struct.end) break;
    let matrix: number[];
    let pos: [number, number, number];
    if (matrixFirst) {
      matrix = Array.from({ length: 9 }, (_, k) => buf.readFloatLE(off + k * 4));
      pos = [buf.readFloatLE(off + 36), buf.readFloatLE(off + 40), buf.readFloatLE(off + 44)];
    } else {
      pos = [buf.readFloatLE(off), buf.readFloatLE(off + 4), buf.readFloatLE(off + 8)];
      matrix = Array.from({ length: 9 }, (_, k) => buf.readFloatLE(off + 12 + k * 4));
    }
    const parent = buf.readInt32LE(off + 48);
    const flags = buf.readUInt32LE(off + 52);
    off += 56;

    // Frame flags: bit 0 = a position is stored, bit 1 = a rotation is stored
    // (GTA also sets 0x20000, which is not a different matrix encoding).
    let local = identity4();
    const identityRotation = matrix.every((value, k) => Math.abs(value - (k % 4 === 0 ? 1 : 0)) < 1e-4);
    const hasRotation = (flags & 0x2) !== 0 || !identityRotation;
    const hasPosition = (flags & 0x1) !== 0 || pos.some((value) => value !== 0);
    if (hasRotation || hasPosition) {
      // right/up/at are stored as the three columns of the rotation.
      local = new Float32Array([
        matrix[0], matrix[3], matrix[6], hasPosition ? pos[0] : 0,
        matrix[1], matrix[4], matrix[7], hasPosition ? pos[1] : 0,
        matrix[2], matrix[5], matrix[8], hasPosition ? pos[2] : 0,
        0, 0, 0, 1,
      ]);
    }
    frames.push({
      index: i,
      name: '',
      parent: parent >= 0 && parent < count && parent !== i ? parent : -1,
      position: pos,
      local,
      world: local,
    });
  }
  // Node names live in the frame list extension (plugin 0x0253F2FE). Writers
  // disagree on the payload: some store a frame count plus name offsets, others
  // only the names themselves — try the offset table, then fall back to reading
  // the names in order.
  const ext = kids.find((k) => k.type === CHUNK_EXTENSION);
  if (ext) {
    const namePlugin = readChunks(buf, ext.dataStart, ext.end).find((p) => p.type === PLG_NODE_NAME);
    if (namePlugin) {
      const payload = namePlugin.end - namePlugin.dataStart;
      const names: string[] = [];
      const declared = payload >= 4 ? buf.readUInt32LE(namePlugin.dataStart) : 0;
      if (declared > 0 && declared <= frames.length && payload >= 4 + declared * 4) {
        for (let i = 0; i < declared; i++) {
          const offset = buf.readUInt32LE(namePlugin.dataStart + 4 + i * 4);
          names.push(
            readCString(buf, namePlugin.dataStart + offset, namePlugin.end)
            || readCString(buf, namePlugin.dataStart + 4 + offset, namePlugin.end),
          );
        }
      }
      if (!names.some(Boolean)) {
        names.length = 0;
        for (const piece of buf.subarray(namePlugin.dataStart, namePlugin.end).toString('latin1').split('\0')) {
          names.push(piece.replace(/[^\x20-\x7e]/g, '').trim());
        }
        if (names.length === frames.length - 1 && !names.includes('')) names.push('');
      }
      for (let i = 0; i < Math.min(names.length, frames.length); i++) {
        if (names[i]) frames[i].name = names[i];
      }
    }
  }

  // Resolve world transforms (frame 0 is normally the root).
  const resolved = new Set<number>();
  const resolve = (index: number, depth: number): Float32Array => {
    const frame = frames[index];
    if (!frame) return identity4();
    if (resolved.has(index)) return frame.world;
    if (depth > frames.length) {
      resolved.add(index);
      frame.world = frame.local;
      return frame.world;
    }
    frame.world = frame.parent >= 0 && frame.parent !== index
      ? multiply4(resolve(frame.parent, depth + 1), frame.local)
      : frame.local;
    resolved.add(index);
    return frame.world;
  };
  for (let i = 0; i < frames.length; i++) resolve(i, 0);
  return frames;
}

/**
 * Parses a .dff buffer. Every top-level clump is read (models such as the SA
 * player skin ship more than one) and merged into a single model.
 */
export function parseDff(buffer: Buffer, file: string): DffModel {
  const warnings: string[] = [];
  const model: DffModel = {
    file,
    version: 'unknown',
    geometries: [],
    frames: [],
    atomics: [],
    clumps: [],
    textures: [],
    stats: {
      clumps: 0, geometries: 0, atomics: 0, frames: 0, dummies: 0,
      vertices: 0, triangles: 0, materials: 0, skinned: false,
    },
    warnings,
  };
  const top = readChunks(buffer, 0, buffer.length);
  const clumpChunks = top.filter((c) => c.type === CHUNK_CLUMP);
  if (!clumpChunks.length) {
    warnings.push('not a RenderWare clump (.dff) — the file starts with chunk 0x' + (top[0]?.type ?? 0).toString(16));
    return model;
  }

  for (const clumpChunk of clumpChunks) {
    model.version = rwVersionString(clumpChunk.version);
    const clump: DffClump = { version: clumpChunk.version, frames: [], atomics: [], geometries: [] };
    const kids = readChunks(buffer, clumpChunk.dataStart, clumpChunk.end);
    const struct = kids.find((k) => k.type === CHUNK_STRUCT);
    const frameChunk = kids.find((k) => k.type === CHUNK_FRAMELIST);
    // Section ids differ between writers, so the geometry list is recognised by
    // its contents (a struct plus Geometry children) and atomics by their
    // 16-byte struct — the ids are only used as a hint.
    const geometryChildrenOf = (chunk: RwChunk): RwChunk[] =>
      readChunks(buffer, chunk.dataStart, chunk.end).filter((k) => k.type === CHUNK_GEOMETRY);
    const holdsGeometries = (chunk: RwChunk): boolean => geometryChildrenOf(chunk).length > 0;
    const geometryListFromId = kids.find((k) => k.type === CHUNK_GEOMETRYLIST);
    const geometryList = geometryListFromId && holdsGeometries(geometryListFromId)
      ? geometryListFromId
      : kids.find((k) => k.type !== CHUNK_CLUMP && holdsGeometries(k));
    const atomicChunks = kids.filter((k) => CHUNK_ATOMIC_IDS.includes(k.type) || (k.type !== CHUNK_STRUCT && k.type !== CHUNK_FRAMELIST && k.type !== CHUNK_EXTENSION && !holdsGeometries(k) && atomicFrameOf(buffer, k) !== null));

    if (frameChunk) {
      clump.frames = parseFrameList(buffer, frameChunk);
      for (const frame of clump.frames) {
        frame.index = model.frames.length + frame.index;
        if (frame.parent >= 0) frame.parent += model.frames.length;
      }
      model.frames.push(...clump.frames);
    }

    const declaredAtomics = struct && struct.dataStart + 4 <= struct.end ? buffer.readUInt32LE(struct.dataStart) : 0;

    const geometries: DffGeometry[] = [];
    const geometryChunks: RwChunk[] = [];
    if (geometryList) geometryChunks.push(...geometryChildrenOf(geometryList));
    // Pre-3.4 clumps keep the geometry inside its atomic.
    for (const kid of atomicChunks) geometryChunks.push(...geometryChildrenOf(kid));
    for (const geometryChunk of geometryChunks) {
      const geometry = parseGeometry(buffer, geometryChunk, model.geometries.length + geometries.length, warnings);
      if (geometry) geometries.push(geometry);
    }
    clump.geometries = geometries;
    model.geometries.push(...geometries);

    const hasGeometryIndex = geometryList !== undefined;
    let geometryCursor = 0;
    for (const kid of atomicChunks) {
      const atomicStruct = readChunks(buffer, kid.dataStart, kid.end).find((k) => k.type === CHUNK_STRUCT);
      if (!atomicStruct || atomicStruct.dataStart + 12 > atomicStruct.end) continue;
      const base = atomicStruct.dataStart;
      const frameOffset = buffer.readInt32LE(base);
      // Before RW 3.4 the geometry is a child of its atomic, so the atomic
      // struct has no geometry index (4 bytes shorter).
      const geometryOffset = hasGeometryIndex ? buffer.readInt32LE(base + 4) : geometryCursor++;
      const flags = buffer.readUInt32LE(base + (hasGeometryIndex ? 8 : 4));
      const frameIndex = model.frames.length - clump.frames.length + frameOffset;
      const geometryIndex = model.geometries.length - geometries.length + geometryOffset;
      if (!model.frames[frameIndex] || !model.geometries[geometryIndex]) continue;
      const atomic: DffAtomic = { frame: frameIndex, geometry: geometryIndex, flags };
      clump.atomics.push(atomic);
      model.atomics.push(atomic);
    }
    if (declaredAtomics !== clump.atomics.length) {
      warnings.push(`clump struct declares ${declaredAtomics} atomics but ${clump.atomics.length} were readable`);
    }
    model.clumps.push(clump);
  }

  const textureSet = new Set<string>();
  for (const geometry of model.geometries) {
    for (const material of geometry.materials) {
      if (material.texture && !textureSet.has(material.texture.toLowerCase())) {
        textureSet.add(material.texture.toLowerCase());
        model.textures.push(material.texture);
      }
    }
  }

  model.stats.clumps = model.clumps.length;
  model.stats.geometries = model.geometries.length;
  model.stats.atomics = model.atomics.length;
  model.stats.frames = model.frames.length;
  model.stats.dummies = Math.max(0, model.frames.length - model.atomics.length);
  model.stats.vertices = model.geometries.reduce((sum, geometry) => sum + geometry.numVertices, 0);
  model.stats.triangles = model.geometries.reduce((sum, geometry) => sum + geometry.triangles.length, 0);
  model.stats.materials = model.geometries.reduce((sum, geometry) => sum + geometry.materials.length, 0);
  model.stats.skinned = model.geometries.some((geometry) => geometry.skinned);
  return model;
}

/** Flattens a parsed model into one world-space triangle soup ready for rendering/export. */
export function flattenDff(model: DffModel): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const triangles: DffTriangle[] = [];
  const materials: DffMaterial[] = [];
  const warnings = [...model.warnings];
  let hasUvs = false;
  let hasColors = false;
  let vertexOffset = 0;

  for (const atomic of model.atomics) {
    const geometry = model.geometries[atomic.geometry];
    const frame = model.frames[atomic.frame];
    if (!geometry || !frame) continue;
    const world = frame.world;
    const materialMap = new Map<number, number>();
    for (const material of geometry.materials) {
      materialMap.set(material.index, materials.length);
      materials.push(material);
    }
    for (let i = 0; i < geometry.numVertices; i++) {
      const [x, y, z] = transformPoint(world, geometry.positions[i * 3] || 0, geometry.positions[i * 3 + 1] || 0, geometry.positions[i * 3 + 2] || 0);
      positions.push(x, y, z);
      if (geometry.hasNormals) {
        const [nx, ny, nz] = transformDirection(world, geometry.normals[i * 3] || 0, geometry.normals[i * 3 + 1] || 0, geometry.normals[i * 3 + 2] || 0);
        normals.push(nx, ny, nz);
      } else {
        normals.push(0, 0, 0);
      }
      if (geometry.uvs) {
        hasUvs = true;
        uvs.push(geometry.uvs[i * 2] || 0, geometry.uvs[i * 2 + 1] || 0);
      } else {
        uvs.push(0, 0);
      }
      if (geometry.colors) {
        hasColors = true;
        colors.push(geometry.colors[i * 4], geometry.colors[i * 4 + 1], geometry.colors[i * 4 + 2], geometry.colors[i * 4 + 3]);
      } else {
        colors.push(255, 255, 255, 255);
      }
    }
    for (const triangle of geometry.triangles) {
      triangles.push({
        a: triangle.a + vertexOffset,
        b: triangle.b + vertexOffset,
        c: triangle.c + vertexOffset,
        material: materialMap.get(triangle.material) ?? 0,
      });
    }
    vertexOffset += geometry.numVertices;
  }

  if (!normals.some((value) => value !== 0)) {
    // No normals in the file: derive smooth normals from the faces.
    for (let t = 0; t < triangles.length; t++) {
      const triangle = triangles[t];
      const ax = positions[triangle.a * 3], ay = positions[triangle.a * 3 + 1], az = positions[triangle.a * 3 + 2];
      const bx = positions[triangle.b * 3], by = positions[triangle.b * 3 + 1], bz = positions[triangle.b * 3 + 2];
      const cx = positions[triangle.c * 3], cy = positions[triangle.c * 3 + 1], cz = positions[triangle.c * 3 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const index of [triangle.a, triangle.b, triangle.c]) {
        normals[index * 3] += nx;
        normals[index * 3 + 1] += ny;
        normals[index * 3 + 2] += nz;
      }
    }
    for (let i = 0; i < normals.length; i += 3) {
      const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
      normals[i] /= length;
      normals[i + 1] /= length;
      normals[i + 2] /= length;
    }
    warnings.push('geometry had no normals — smooth normals were generated for the preview');
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertexOffset; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i * 3 + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  if (!Number.isFinite(min[0])) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }
  const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let radius = 0;
  for (let i = 0; i < vertexOffset; i++) {
    radius = Math.max(radius, Math.hypot(positions[i * 3] - center[0], positions[i * 3 + 1] - center[1], positions[i * 3 + 2] - center[2]));
  }

  return {
    name: model.file,
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: hasUvs ? Float32Array.from(uvs) : null,
    colors: hasColors ? Uint8Array.from(colors) : null,
    triangles,
    materials,
    bounds: { center, radius: radius || 1, min, max },
    stats: {
      vertices: vertexOffset,
      triangles: triangles.length,
      materials: materials.length,
      texturedMaterials: materials.filter((material) => material.texture).length,
    },
    warnings,
  };
}

function rotateMatrix(rx: number, ry: number, rz: number): Float32Array {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  // Rz * Ry * Rx, row-major, matching the SA preview convention (rx tilts, rz yaws).
  return new Float32Array([
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, 0,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, 0,
    -sy, cy * sx, cy * cx, 0,
    0, 0, 0, 1,
  ]);
}

function sampleAxis(mode: number, value: number): number {
  if (mode === ADDRESS_CLAMP) return Math.min(1, Math.max(0, value));
  if (mode === ADDRESS_MIRROR) {
    const wrapped = Math.abs(value % 2);
    return wrapped > 1 ? 2 - wrapped : wrapped;
  }
  return value - Math.floor(value);
}

interface SampledTexture {
  rgb: [number, number, number];
  alpha: number;
}

function sampleBilinear(texture: DecodedTexture, u: number, v: number, addressing: number): SampledTexture {
  const { width, height, rgba } = texture;
  const x = sampleAxis(addressing, u) * width - 0.5;
  const y = (1 - sampleAxis(addressing, v)) * height - 0.5; // GTA textures are bottom-up vs PNG
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sum: [number, number, number, number] = [0, 0, 0, 0];
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const px = Math.min(width - 1, Math.max(0, x0 + dx));
      const py = Math.min(height - 1, Math.max(0, y0 + dy));
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      const offset = (py * width + px) * 4;
      sum[0] += rgba[offset] * weight;
      sum[1] += rgba[offset + 1] * weight;
      sum[2] += rgba[offset + 2] * weight;
      sum[3] += rgba[offset + 3] * weight;
    }
  }
  return { rgb: [sum[0], sum[1], sum[2]], alpha: sum[3] / 255 };
}

/**
 * Software rasteriser for a flattened model.
 *
 * Lighting is fixed to the camera (key + fill + rim) so the preview stays
 * readable while the model rotates, materials are modulated by the texture and
 * vertex colours, and alpha is blended over the given background.
 */
export function renderMesh(mesh: MeshData, opts: MeshRenderOptions): MeshRenderResult {
  const width = Math.max(16, Math.round(opts.width));
  const height = Math.max(16, Math.round(opts.height));
  const supersample = Math.min(3, Math.max(1, Math.round(opts.supersample ?? (width * height > 400000 ? 1 : 2))));
  const w = width * supersample;
  const h = height * supersample;

  const rot = opts.rot ?? [0, 0, 0];
  const modelMatrix = rotateMatrix((rot[0] * Math.PI) / 180, (rot[1] * Math.PI) / 180, (rot[2] * Math.PI) / 180);
  const zoom = Math.max(0.05, opts.zoom ?? 1);
  const yaw = ((opts.cameraYaw ?? 40) * Math.PI) / 180;
  const pitch = ((opts.cameraPitch ?? 20) * Math.PI) / 180;

  const eyeDir: [number, number, number] = [
    Math.sin(yaw) * Math.cos(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
    Math.sin(pitch),
  ];
  const forward: [number, number, number] = [-eyeDir[0], -eyeDir[1], -eyeDir[2]];
  const worldUp: [number, number, number] = [0, 0, 1];
  let right: [number, number, number] = [
    forward[1] * worldUp[2] - forward[2] * worldUp[1],
    forward[2] * worldUp[0] - forward[0] * worldUp[2],
    forward[0] * worldUp[1] - forward[1] * worldUp[0],
  ];
  const rightLength = Math.hypot(right[0], right[1], right[2]) || 1;
  right = [right[0] / rightLength, right[1] / rightLength, right[2] / rightLength];
  const up: [number, number, number] = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];

  const radius = mesh.bounds.radius;
  // Orbit and frame the model around its own bounding box centre, not the origin
  // (GTA models often sit far away from (0,0,0) inside their frame hierarchy).
  const focus: [number, number, number] = [...mesh.bounds.center];
  const fov = (32 * Math.PI) / 180;
  const focal = (0.5 * Math.min(w, h)) / Math.tan(fov / 2);
  const distance = Math.max(radius * 1.25, (3.35 * radius) / zoom);
  const eye: [number, number, number] = [
    focus[0] + eyeDir[0] * distance,
    focus[1] + eyeDir[1] * distance,
    focus[2] + eyeDir[2] * distance,
  ];

  const background = opts.background ?? null;
  const red = new Float32Array(w * h);
  const green = new Float32Array(w * h);
  const blue = new Float32Array(w * h);
  const alpha = new Float32Array(w * h);
  const depth = new Float32Array(w * h).fill(Infinity);
  if (background) {
    const [r, g, b, a] = background;
    for (let i = 0; i < w * h; i++) {
      red[i] = r;
      green[i] = g;
      blue[i] = b;
      alpha[i] = a / 255;
    }
  }

  const textureCache = new Map<string, DecodedTexture | null>();
  const texturesUsed = new Set<string>();
  const texturesMissing = new Set<string>();
  const lookupTexture = (name: string): DecodedTexture | null => {
    const key = name.toLowerCase();
    if (textureCache.has(key)) return textureCache.get(key) ?? null;
    const texture = opts.texture ? opts.texture(name) : null;
    textureCache.set(key, texture);
    if (texture) texturesUsed.add(name);
    else texturesMissing.add(name);
    return texture;
  };

  const lights: Array<{ dir: [number, number, number]; intensity: number }> = [
    { dir: [-0.38, 0.62, 0.68], intensity: 0.62 },
    { dir: [0.72, 0.12, 0.36], intensity: 0.34 },
    { dir: [0.2, 0.3, -0.92], intensity: 0.22 },
  ];
  const ambient = 0.42;
  const vehCol = opts.vehCol;

  const viewPositions = new Float32Array(mesh.positions.length);
  const viewNormals = new Float32Array(mesh.normals.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const [rx, ry, rz] = transformPoint(modelMatrix, mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
    const px = rx - eye[0], py = ry - eye[1], pz = rz - eye[2];
    viewPositions[i] = px * right[0] + py * right[1] + pz * right[2];
    viewPositions[i + 1] = px * up[0] + py * up[1] + pz * up[2];
    viewPositions[i + 2] = px * forward[0] + py * forward[1] + pz * forward[2];
    const [nx, ny, nz] = transformDirection(modelMatrix, mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]);
    viewNormals[i] = nx * right[0] + ny * right[1] + nz * right[2];
    viewNormals[i + 1] = nx * up[0] + ny * up[1] + nz * up[2];
    viewNormals[i + 2] = nx * forward[0] + ny * forward[1] + nz * forward[2];
  }

  let drawn = 0;
  for (const triangle of mesh.triangles) {
    const indices = [triangle.a, triangle.b, triangle.c];
    const screen: Array<[number, number, number]> = [];
    let behind = false;
    for (const index of indices) {
      const z = viewPositions[index * 3 + 2];
      if (z <= 0.05) {
        behind = true;
        break;
      }
      screen.push([w / 2 + (focal * viewPositions[index * 3]) / z, h / 2 - (focal * viewPositions[index * 3 + 1]) / z, z]);
    }
    if (behind) continue;

    const area = (screen[1][0] - screen[0][0]) * (screen[2][1] - screen[0][1]) - (screen[2][0] - screen[0][0]) * (screen[1][1] - screen[0][1]);
    if (!Number.isFinite(area) || Math.abs(area) < 1e-6) continue;

    const material = mesh.materials[triangle.material] ?? mesh.materials[0];
    const texture = material?.texture ? lookupTexture(material.texture) : null;
    let baseColor: [number, number, number] = [255, 255, 255];
    let baseAlpha = 1;
    if (material) {
      const [mr, mg, mb, ma] = material.color;
      const marked = ma <= 3 && (mr !== 255 || mg !== 255 || mb !== 255);
      if (vehCol && marked) {
        const value = ma === 0 ? vehCol[0] : ma === 1 ? vehCol[1] : null;
        if (value !== null) {
          baseColor = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
          baseAlpha = 1;
        }
      }
      if (!(vehCol && marked)) {
        if (mr || mg || mb) baseColor = [mr, mg, mb];
        baseAlpha = ma === 0 ? 1 : ma / 255;
      }
    }

    const minX = Math.max(0, Math.floor(Math.min(screen[0][0], screen[1][0], screen[2][0])));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(screen[0][0], screen[1][0], screen[2][0])));
    const minY = Math.max(0, Math.floor(Math.min(screen[0][1], screen[1][1], screen[2][1])));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(screen[0][1], screen[1][1], screen[2][1])));
    if (maxX < minX || maxY < minY) continue;
    drawn++;

    const invArea = 1 / area;
    const invW = [1 / screen[0][2], 1 / screen[1][2], 1 / screen[2][2]];
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const x = px + 0.5;
        const y = py + 0.5;
        const l0 = ((screen[1][0] - x) * (screen[2][1] - y) - (screen[2][0] - x) * (screen[1][1] - y)) * invArea;
        const l1 = ((screen[2][0] - x) * (screen[0][1] - y) - (screen[0][0] - x) * (screen[2][1] - y)) * invArea;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
        const denom = l0 * invW[0] + l1 * invW[1] + l2 * invW[2];
        if (denom <= 0) continue;
        const z = 1 / denom;
        const pixel = py * w + px;
        if (z >= depth[pixel]) continue;

        const w0 = (l0 * invW[0]) / denom;
        const w1 = (l1 * invW[1]) / denom;
        const w2 = (l2 * invW[2]) / denom;

        let r = baseColor[0];
        let g = baseColor[1];
        let b = baseColor[2];
        let a = baseAlpha;

        if (texture && mesh.uvs) {
          const u = (mesh.uvs[triangle.a * 2] * w0) + (mesh.uvs[triangle.b * 2] * w1) + (mesh.uvs[triangle.c * 2] * w2);
          const v = (mesh.uvs[triangle.a * 2 + 1] * w0) + (mesh.uvs[triangle.b * 2 + 1] * w1) + (mesh.uvs[triangle.c * 2 + 1] * w2);
          const texel = sampleBilinear(texture, u, v, material?.addressing ?? ADDRESS_WRAP);
          r = (r * texel.rgb[0]) / 255;
          g = (g * texel.rgb[1]) / 255;
          b = (b * texel.rgb[2]) / 255;
          a *= texel.alpha;
        } else if (!material?.texture) {
          // Untextured material: keep the flat material colour.
        }
        if (mesh.colors) {
          const cr = (mesh.colors[triangle.a * 4] * w0 + mesh.colors[triangle.b * 4] * w1 + mesh.colors[triangle.c * 4] * w2) / 255;
          const cg = (mesh.colors[triangle.a * 4 + 1] * w0 + mesh.colors[triangle.b * 4 + 1] * w1 + mesh.colors[triangle.c * 4 + 1] * w2) / 255;
          const cb = (mesh.colors[triangle.a * 4 + 2] * w0 + mesh.colors[triangle.b * 4 + 2] * w1 + mesh.colors[triangle.c * 4 + 2] * w2) / 255;
          r *= cr;
          g *= cg;
          b *= cb;
        }

        let nx = (viewNormals[triangle.a * 3] * w0) + (viewNormals[triangle.b * 3] * w1) + (viewNormals[triangle.c * 3] * w2);
        let ny = (viewNormals[triangle.a * 3 + 1] * w0) + (viewNormals[triangle.b * 3 + 1] * w1) + (viewNormals[triangle.c * 3 + 1] * w2);
        let nz = (viewNormals[triangle.a * 3 + 2] * w0) + (viewNormals[triangle.b * 3 + 2] * w1) + (viewNormals[triangle.c * 3 + 2] * w2);
        const normalLength = Math.hypot(nx, ny, nz);
        if (normalLength > 1e-5) {
          nx /= normalLength;
          ny /= normalLength;
          nz /= normalLength;
        } else {
          nx = 0;
          ny = 0;
          nz = 1;
        }
        if (nz < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        let light = ambient;
        for (const lamp of lights) {
          const dot = nx * lamp.dir[0] + ny * lamp.dir[1] + nz * lamp.dir[2];
          if (dot > 0) light += dot * lamp.intensity;
        }
        light = Math.min(1.35, light);
        r *= light;
        g *= light;
        b *= light;

        const srcA = Math.min(1, Math.max(0, a));
        const dstA = alpha[pixel];
        const outA = srcA + dstA * (1 - srcA);
        if (outA <= 0.0015) continue;
        red[pixel] = (r * srcA + red[pixel] * dstA * (1 - srcA)) / outA;
        green[pixel] = (g * srcA + green[pixel] * dstA * (1 - srcA)) / outA;
        blue[pixel] = (b * srcA + blue[pixel] * dstA * (1 - srcA)) / outA;
        alpha[pixel] = outA;
        if (srcA >= 0.5) depth[pixel] = z;
      }
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  let covered = 0;
  const samples = supersample * supersample;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          const index = (y * supersample + sy) * w + (x * supersample + sx);
          const pixelAlpha = alpha[index];
          r += red[index] * pixelAlpha;
          g += green[index] * pixelAlpha;
          b += blue[index] * pixelAlpha;
          a += pixelAlpha;
        }
      }
      const offset = (y * width + x) * 4;
      const outAlpha = a / samples;
      if (a > 0) {
        rgba[offset] = Math.max(0, Math.min(255, Math.round(r / a)));
        rgba[offset + 1] = Math.max(0, Math.min(255, Math.round(g / a)));
        rgba[offset + 2] = Math.max(0, Math.min(255, Math.round(b / a)));
      }
      rgba[offset + 3] = Math.max(0, Math.min(255, Math.round(outAlpha * 255)));
      if (outAlpha > 0.5) covered++;
    }
  }

  return {
    image: { width, height, rgba },
    triangles: mesh.triangles.length,
    drawn,
    coverage: covered / (width * height),
    texturesUsed: [...texturesUsed],
    texturesMissing: [...texturesMissing],
  };
}

/** Writes the flattened mesh as Wavefront OBJ (+ a matching MTL text). */
export function exportObj(mesh: MeshData, opts: { name: string; mtlFile?: string; textureFiles?: Record<string, string> }): { obj: string; mtl: string } {
  const name = opts.name.replace(/[^\w.-]+/g, '_') || 'model';
  const mtlFile = opts.mtlFile ?? `${name}.mtl`;
  const obj: string[] = [];
  obj.push(`# ${name} — exported by samp-mcp (${mesh.stats.vertices} vertices, ${mesh.stats.triangles} triangles)`);
  obj.push('# RenderWare models are Z-up and face +Y; import with Z-up to keep the orientation.');
  obj.push(`mtllib ${mtlFile}`);
  obj.push(`o ${name}`);
  for (let i = 0; i < mesh.stats.vertices; i++) {
    obj.push(`v ${mesh.positions[i * 3].toFixed(6)} ${mesh.positions[i * 3 + 1].toFixed(6)} ${mesh.positions[i * 3 + 2].toFixed(6)}`);
  }
  for (let i = 0; i < mesh.stats.vertices; i++) {
    const u = mesh.uvs ? mesh.uvs[i * 2] : 0;
    const v = mesh.uvs ? mesh.uvs[i * 2 + 1] : 0;
    obj.push(`vt ${u.toFixed(6)} ${(1 - v).toFixed(6)}`);
  }
  for (let i = 0; i < mesh.stats.vertices; i++) {
    obj.push(`vn ${mesh.normals[i * 3].toFixed(6)} ${mesh.normals[i * 3 + 1].toFixed(6)} ${mesh.normals[i * 3 + 2].toFixed(6)}`);
  }
  const groups = new Map<number, DffTriangle[]>();
  for (const triangle of mesh.triangles) {
    const list = groups.get(triangle.material) ?? [];
    list.push(triangle);
    groups.set(triangle.material, list);
  }
  for (const [materialIndex, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    obj.push(`usemtl mat_${materialIndex}`);
    obj.push(`g mat_${materialIndex}`);
    for (const triangle of list) {
      const a = triangle.a + 1, b = triangle.b + 1, c = triangle.c + 1;
      obj.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
    }
  }

  const mtl: string[] = [];
  mtl.push(`# materials for ${name} — exported by samp-mcp`);
  for (const [index, material] of mesh.materials.entries()) {
    const [r, g, b, a] = material.color;
    const textureFile = material.texture ? opts.textureFiles?.[material.texture.toLowerCase()] : undefined;
    mtl.push(`newmtl mat_${index}`);
    mtl.push(`Kd ${(material.color[0] ? r / 255 : 1).toFixed(4)} ${(material.color[1] ? g / 255 : 1).toFixed(4)} ${(material.color[2] ? b / 255 : 1).toFixed(4)}`);
    mtl.push(`Ka ${Math.min(1, material.ambient || 0).toFixed(4)} ${Math.min(1, material.ambient || 0).toFixed(4)} ${Math.min(1, material.ambient || 0).toFixed(4)}`);
    mtl.push(`Ks ${material.specular.toFixed(4)} ${material.specular.toFixed(4)} ${material.specular.toFixed(4)}`);
    mtl.push(`d ${(a === 0 ? 1 : a / 255).toFixed(4)}`);
    if (material.texture) mtl.push(`# texture: ${material.texture}${material.mask ? ` (mask ${material.mask})` : ''}`);
    if (textureFile) mtl.push(`map_Kd ${textureFile}`);
  }
  return { obj: obj.join('\n') + '\n', mtl: mtl.join('\n') + '\n' };
}

/** Writes the flattened mesh as glTF 2.0 with one primitive per material. */
export function exportGltf(mesh: MeshData, opts: { name: string; textureFiles?: Record<string, string> }): string {
  const name = opts.name.replace(/[^\w.-]+/g, '_') || 'model';
  const buffers: Buffer[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];

  const usedBytes = (): number => buffers.reduce((sum, part) => sum + part.length, 0);
  const pushView = (data: Buffer, target: number): number => {
    const byteOffset = usedBytes();
    buffers.push(data);
    // Accessor data has to start on a 4-byte boundary for the next view.
    while (usedBytes() % 4 !== 0) buffers.push(Buffer.alloc(1));
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length, target });
    return bufferViews.length - 1;
  };

  const positions = Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength);
  const normals = Buffer.from(mesh.normals.buffer, mesh.normals.byteOffset, mesh.normals.byteLength);
  const uvs = mesh.uvs ? Buffer.from(mesh.uvs.buffer, mesh.uvs.byteOffset, mesh.uvs.byteLength) : null;
  const vertexCount = mesh.stats.vertices;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertexCount * 3; i++) {
    const axis = i % 3;
    const value = mesh.positions[i];
    if (value < min[axis]) min[axis] = value;
    if (value > max[axis]) max[axis] = value;
  }
  if (!Number.isFinite(min[0])) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  const positionAccessor = accessors.length;
  accessors.push({ bufferView: pushView(positions, 34962), componentType: 5126, count: vertexCount, type: 'VEC3', min, max });
  const normalAccessor = accessors.length;
  accessors.push({ bufferView: pushView(normals, 34962), componentType: 5126, count: vertexCount, type: 'VEC3' });
  let uvAccessor: number | null = null;
  if (uvs) {
    uvAccessor = accessors.length;
    accessors.push({ bufferView: pushView(uvs, 34962), componentType: 5126, count: vertexCount, type: 'VEC2' });
  }

  const groups = new Map<number, DffTriangle[]>();
  for (const triangle of mesh.triangles) {
    const list = groups.get(triangle.material) ?? [];
    list.push(triangle);
    groups.set(triangle.material, list);
  }

  const width32 = vertexCount > 65535;
  const primitives: Record<string, unknown>[] = [];
  for (const [materialIndex, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const indices = Buffer.alloc(list.length * 3 * (width32 ? 4 : 2));
    list.forEach((triangle, i) => {
      for (const [k, vertex] of [triangle.a, triangle.b, triangle.c].entries()) {
        if (width32) indices.writeUInt32LE(vertex, (i * 3 + k) * 4);
        else indices.writeUInt16LE(vertex, (i * 3 + k) * 2);
      }
    });
    const accessor = accessors.length;
    accessors.push({
      bufferView: pushView(indices, 34963),
      componentType: width32 ? 5125 : 5123,
      count: list.length * 3,
      type: 'SCALAR',
    });
    const attributes: Record<string, number> = { POSITION: positionAccessor, NORMAL: normalAccessor };
    if (uvAccessor !== null) attributes.TEXCOORD_0 = uvAccessor;
    primitives.push({ attributes, indices: accessor, material: materialIndex, mode: 4 });
  }

  const images: Record<string, unknown>[] = [];
  const textures: Record<string, unknown>[] = [];
  const imageIndexByName = new Map<string, number>();
  const materials = mesh.materials.map((material, index) => {
    const [r, g, b, a] = material.color;
    const pbr: Record<string, unknown> = {
      baseColorFactor: [r ? r / 255 : 1, g ? g / 255 : 1, b ? b / 255 : 1, a === 0 ? 1 : a / 255],
      metallicFactor: 0,
      roughnessFactor: Math.min(1, Math.max(0.35, 1 - (material.specular || 0))),
    };
    const file = material.texture ? opts.textureFiles?.[material.texture.toLowerCase()] : undefined;
    if (file) {
      let imageIndex = imageIndexByName.get(file);
      if (imageIndex === undefined) {
        imageIndex = images.length;
        images.push({ uri: file, name: material.texture });
        textures.push({ sampler: 0, source: imageIndex });
        imageIndexByName.set(file, imageIndex);
      }
      pbr.baseColorTexture = { index: imageIndexByName.get(file) as number };
    }
    return { name: `mat_${index}${material.texture ? `_${material.texture}` : ''}`, pbrMetallicRoughness: pbr, doubleSided: true };
  });

  const buffer = Buffer.concat(buffers);
  const gltf: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'samp-mcp model_export' },
    scene: 0,
    scenes: [{ name, nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [{ name, primitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: buffer.length, uri: `data:application/octet-stream;base64,${buffer.toString('base64')}` }],
  };
  if (images.length) {
    gltf.images = images;
    gltf.textures = textures;
    gltf.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  }
  return JSON.stringify(gltf, null, 2);
}
