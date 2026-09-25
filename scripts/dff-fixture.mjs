#!/usr/bin/env node
/**
 * Fixture builders for the model pipeline tests.
 *
 * Everything here is written straight from the RenderWare stream layout
 * documented on GTAMods (RpClump 0x10, RpGeometry 0x0F, RpMaterial 0x07,
 * Texture Dictionary 0x16) rather than from samp-mcp's own parser, so the
 * tests check the parser against an independent implementation.
 *
 * The generated model is a textured cube:
 *   - 24 vertices / 12 triangles, texture coordinates + normals present,
 *   - material 0 = textured with the companion .txd texture,
 *   - material 1 = untextured flat magenta (byte order r,g,b,a),
 *   - frame 0 = root (identity), frame 1 = child translated to x = 2 (the
 *     atomic hangs off it, so a correct reader must apply the hierarchy),
 *   - frame 2 = a named dummy ("dummy_wheel") with no geometry.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RW_VERSION = 0x1803ffff; // RW 3.6.0.3 (GTA SA)

export function chunk(type, payload, version = RW_VERSION) {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(type >>> 0, 0);
  header.writeUInt32LE(payload.length, 4);
  header.writeUInt32LE(version >>> 0, 8);
  return Buffer.concat([header, payload]);
}


function f32(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buffer.writeFloatLE(value, i * 4));
  return buffer;
}

function i32(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buffer.writeInt32LE(value, i * 4));
  return buffer;
}

/** 8888 (BGRA) gradient texture with a transparent corner. */
function gradientPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      pixels[o] = Math.round((x / (size - 1)) * 255);
      pixels[o + 1] = Math.round((y / (size - 1)) * 255);
      pixels[o + 2] = 40;
      pixels[o + 3] = x < 4 && y < 4 ? 0 : 255;
    }
  }
  return pixels;
}

/**
 * One texture-native section.
 *
 * The 92-byte header mirrors a real SA dictionary (verified field by field
 * against background.txd / models/fonts.txd / models/generic/vehicle.txd):
 *   +80 u16 width, +82 u16 height, +84 u8 depth, +85 u8 numLevels,
 *   +86 u8 rasterType, +87 u8 flags, +88 u32 raster bytes, +92 pixels.
 */
function textureNative({ name, size }) {
  const data = gradientPixels(size);
  const header = Buffer.alloc(92);
  header.writeUInt32LE(9, 0); // Direct3D 9 platform
  header.writeUInt32LE(0x1102, 4);
  header.write(name, 8, 32, 'latin1');
  header.writeUInt32LE(0x0500, 72); // FORMAT_8888
  header.writeUInt32LE(21, 76); // D3DFMT_A8R8G8B8
  header.writeUInt16LE(size, 80);
  header.writeUInt16LE(size, 82);
  header.writeUInt8(32, 84); // depth
  header.writeUInt8(1, 85); // mip levels
  header.writeUInt8(4, 86); // raster type
  header.writeUInt8(0x01, 87); // flags: has alpha
  header.writeUInt32LE(data.length, 88);

  return chunk(0x15, Buffer.concat([
    chunk(0x01, Buffer.concat([header, data])),
  ]));
}

/** A .txd holding exactly one API-compatible texture. */
export function buildTxd({ name = 'demo_model', size = 32 } = {}) {
  const dictionaryStruct = Buffer.alloc(4);
  dictionaryStruct.writeUInt16LE(1, 0);
  dictionaryStruct.writeUInt16LE(9, 2);
  return chunk(0x16, Buffer.concat([
    chunk(0x01, dictionaryStruct),
    textureNative({ name, size }),
  ]));
}

const CUBE_FACES = [
  { normal: [0, 0, 1] },
  { normal: [0, 0, -1] },
  { normal: [1, 0, 0] },
  { normal: [-1, 0, 0] },
  { normal: [0, 1, 0] },
  { normal: [0, -1, 0] },
];

function cubeGeometry() {
  const positions = [];
  const normals = [];
  const uvs = [];
  const triangles = [];
  CUBE_FACES.forEach((face, faceIndex) => {
    const [nx, ny, nz] = face.normal;
    // build the four corners of this face around the unit cube
    const center = [nx, ny, nz];
    const up = Math.abs(nz) === 1 ? [0, 1, 0] : [0, 0, 1];
    const right = [up[1] * nz - up[2] * ny, up[2] * nx - up[0] * nz, up[0] * ny - up[1] * nx];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const base = faceIndex * 4;
    corners.forEach(([u, v]) => {
      positions.push(
        center[0] + right[0] * u + up[0] * v,
        center[1] + right[1] * u + up[1] * v,
        center[2] + right[2] * u + up[2] * v,
      );
      normals.push(nx, ny, nz);
      uvs.push((u + 1) / 2, (v + 1) / 2);
    });
    const material = faceIndex === 0 ? 1 : 0; // the top face uses the flat material
    triangles.push([base + 0, base + 1, base + 2, material]);
    triangles.push([base + 0, base + 2, base + 3, material]);
  });
  return { positions, normals, uvs, triangles };
}

function material({ color, textureName }) {
  const struct = Buffer.alloc(28);
  struct.writeUInt32LE(0, 0); // flags
  struct.writeUInt8(color[0], 4);
  struct.writeUInt8(color[1], 5);
  struct.writeUInt8(color[2], 6);
  struct.writeUInt8(color[3], 7);
  struct.writeUInt32LE(0, 8); // unused
  struct.writeUInt32LE(textureName ? 1 : 0, 12); // isTextured
  struct.writeFloatLE(0, 16); // ambient
  struct.writeFloatLE(0, 20); // specular
  struct.writeFloatLE(1, 24); // diffuse
  const chunks = [chunk(0x01, struct)];
  if (textureName) {
    const textureStruct = Buffer.alloc(4);
    textureStruct.writeUInt16LE(1, 0); // filter: nearest/linear
    textureStruct.writeUInt16LE(1, 2); // addressing: wrap
    chunks.push(chunk(0x06, Buffer.concat([
      chunk(0x01, textureStruct),
      chunk(0x02, Buffer.from(textureName + '\0', 'latin1')),
    ])));
  }
  return chunk(0x07, Buffer.concat(chunks));
}

/**
 * A .dff clump: cube geometry, two materials, one atomic on a translated child
 * frame plus a named dummy frame.
 */
export function buildDff({ textureName = 'demo_model' } = {}) {
  const { positions, normals, uvs, triangles } = cubeGeometry();

  const geometryStruct = Buffer.concat([
    i32([0x00000004 | 0x00000010]), // textured + normals
    i32([triangles.length]),
    i32([positions.length / 3]),
    i32([1]), // morph targets
    f32(uvs),
    Buffer.concat(triangles.map(([a, b, c, m]) => {
      const t = Buffer.alloc(8);
      t.writeUInt16LE(b, 0); // vertex2
      t.writeUInt16LE(a, 2); // vertex1
      t.writeUInt16LE(m, 4); // material
      t.writeUInt16LE(c, 6); // vertex3
      return t;
    })),
    f32([0, 0, 0, 1]), // bounding sphere
    i32([1]), // has vertices
    i32([1]), // has normals
    f32(positions),
    f32(normals),
  ]);

  const geometry = chunk(0x0f, Buffer.concat([
    chunk(0x01, geometryStruct),
    chunk(0x08, Buffer.concat([
      chunk(0x01, i32([2])),
      material({ color: [255, 255, 255, 255], textureName }),
      material({ color: [255, 0, 255, 255], textureName: '' }),
    ])),
  ]));

  // frame list: root, translated child, named dummy
  const frameEntries = [];
  const pushFrame = (matrix, position, parent) => {
    frameEntries.push(Buffer.concat([f32(matrix), f32(position), i32([parent]), i32([3])]));
  };
  pushFrame([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0], -1);
  pushFrame([1, 0, 0, 0, 1, 0, 0, 0, 1], [2, 0, 0], 0);
  pushFrame([0, 0, 1, 0, 1, 0, -1, 0, 0], [0, 0, 0.5], 1);

  const names = ['', '', 'dummy_wheel'];
  const nameBlob = Buffer.concat(names.map((name) => Buffer.from(name + '\0', 'latin1')));
  const offsets = [];
  let cursor = 4 + names.length * 4;
  for (const name of names) {
    offsets.push(cursor);
    cursor += name.length + 1;
  }
  const offsetBytes = Buffer.alloc(offsets.length * 4);
  offsets.forEach((value, index) => offsetBytes.writeUInt32LE(value, index * 4));
  const nodeNamePlugin = chunk(0x0253f2fe, Buffer.concat([i32([names.length]), offsetBytes, nameBlob]), 0);

  const frameList = chunk(0x0e, Buffer.concat([
    chunk(0x01, Buffer.concat([i32([frameEntries.length]), ...frameEntries])),
    chunk(0x03, nodeNamePlugin),
  ]));

  const geometryList = chunk(0x1a, Buffer.concat([chunk(0x01, i32([1])), geometry]));

  const atomic = chunk(0x14, chunk(0x01, i32([1, 0, 5, 0]))); // frame 1, geometry 0

  return chunk(0x10, Buffer.concat([
    chunk(0x01, i32([1, 0, 0])), // 1 atomic, 0 lights, 0 cameras
    frameList,
    geometryList,
    atomic,
  ]));
}

/**
 * A VER2 .img archive holding the given entries ([{name, data}]).
 *
 * Entry layout mirrors a stock gta3.img: 32 bytes of `{ int32 sector;
 * int32 sectors; char[24] name }` — the name sits at offset +8 and the second
 * field counts whole 2048-byte sectors, not bytes.
 */
export function buildImg(entries) {
  const tableSize = 8 + entries.length * 32;
  const dataStartSector = Math.ceil(tableSize / 2048);
  const header = Buffer.alloc(8);
  header.write('VER2', 0, 4, 'latin1');
  header.writeUInt32LE(entries.length, 4);

  const table = Buffer.alloc(entries.length * 32);
  const blobs = [];
  let sector = dataStartSector;
  entries.forEach((entry, index) => {
    const offset = index * 32;
    const sectors = Math.ceil(entry.data.length / 2048);
    table.writeInt32LE(sector, offset);
    table.writeInt32LE(sectors, offset + 4);
    table.write(entry.name, offset + 8, 24, 'latin1');
    blobs.push(entry.data);
    sector += sectors;
  });

  const head = Buffer.concat([header, table]);
  const padding = Buffer.alloc(dataStartSector * 2048 - head.length);
  const parts = [head, padding];
  blobs.forEach((blob, index) => {
    parts.push(blob);
    if (index < blobs.length - 1) {
      const rest = blob.length % 2048;
      if (rest !== 0) parts.push(Buffer.alloc(2048 - rest));
    }
  });
  return Buffer.concat(parts);
}

/** Writes the fixture files into `<root>/models` and returns their paths. */
export async function writeModelFixtures(root, { textureName = 'demo_model', dffName = 'demo_cube' } = {}) {
  const dir = path.join(root, 'models');
  await mkdir(dir, { recursive: true });
  const dff = buildDff({ textureName });
  const txd = buildTxd({ name: textureName });
  const files = {
    dff: path.join(dir, `${dffName}.dff`),
    txd: path.join(dir, `${dffName}.txd`),
  };
  await writeFile(files.dff, dff);
  await writeFile(files.txd, txd);
  return { files, dff, txd };
}
