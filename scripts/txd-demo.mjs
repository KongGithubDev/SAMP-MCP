#!/usr/bin/env node
/**
 * TXD writer + editor test.
 *
 * Runs against throwaway fixtures under .freebuff/txd-demo (git-ignored):
 *
 *  1. every raster format the writer supports is encoded into a dictionary,
 *     parsed back by the reader and compared pixel by pixel against the source
 *     image (exact for the lossless formats, within the format's quantisation
 *     for 565/555/4444/LUM8 and the DXT codecs),
 *  2. the mip chain layout is checked against the sizes the format implies —
 *     the test computes the expected payload itself, including the u32 byte
 *     length that precedes every level after level 0 (the layout real
 *     Magic.TXD output uses),
 *  3. single-level dictionaries of real GTA: SA files are rebuilt from their own
 *     decoded pixels and must come out byte for byte identical (skipped when the
 *     machine has no game assets — set SAMP_TXD_SAMPLE_DIR to point at one),
 *  4. the editor round trip: import PNG → convert → rename → duplicate → remove
 *     → export → save, with the textures that were not touched written back byte
 *     for byte, plus a save into a VER2 .img archive.
 *
 * Run: node scripts/txd-demo.mjs   (after `npm run build`)
 * Exit code is non-zero when any expectation fails.
 */
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { TxdEditorManager } from '../dist/txd-edit.js';
import { buildMipChain, buildTxdBuffer } from '../dist/txd-write.js';
import {
  CHUNK_TEXTURENATIVE,
  decodeTxdTexture,
  decodeTxdTextureAt,
  encodePng,
  parseTxd,
  readTxdSections,
} from '../dist/txd.js';
import { chunk, buildImg } from './dff-fixture.mjs';

const root = path.join(import.meta.dirname, '..', '.freebuff', 'txd-demo');
const RW_SA_VERSION = 0x1803ffff;
const LOSSLESS = ['8888', '888', '565', '555', '4444', 'LUM8'];
const ALL_FORMATS = [...LOSSLESS, 'DXT1', 'DXT3', 'DXT5'];

let passed = 0;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const rel = (file) => path.relative(root, file).split(path.sep).join('/');

/** 32x32 image: smooth colour gradient, smooth alpha ramp, translucency in a corner. */
function sourceImage(size = 32, hardAlpha = false) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      rgba[o] = Math.round((x / (size - 1)) * 255);
      rgba[o + 1] = Math.round((y / (size - 1)) * 255);
      rgba[o + 2] = Math.round(((x + y) / (2 * (size - 1))) * 200) + 20;
      rgba[o + 3] = hardAlpha
        ? (x < size / 4 && y < size / 4 ? 0 : 255)
        : Math.min(255, 40 + Math.round((x / (size - 1)) * 215));
    }
  }
  return { width: size, height: size, rgba };
}

/** Independent size math (not imported from src) for one raster level. */
function levelBytes(format, width, height) {
  const blocks = Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2);
  if (format === 'DXT1') return blocks * 8;
  if (format === 'DXT3' || format === 'DXT5') return blocks * 16;
  if (format === '8888' || format === '888') return width * height * 4;
  if (format === '565' || format === '555' || format === '4444') return ((width * 2 + 3) & ~3) * height;
  return ((width + 3) & ~3) * height;
}

function diff(source, decoded) {
  let maxRgb = 0, maxAlpha = 0, sumRgb = 0, sumAlpha = 0, count = 0;
  for (let i = 0; i < source.rgba.length; i += 4) {
    const rgb = Math.max(
      Math.abs(source.rgba[i] - decoded.rgba[i]),
      Math.abs(source.rgba[i + 1] - decoded.rgba[i + 1]),
      Math.abs(source.rgba[i + 2] - decoded.rgba[i + 2]),
    );
    const alpha = Math.abs(source.rgba[i + 3] - decoded.rgba[i + 3]);
    maxRgb = Math.max(maxRgb, rgb);
    maxAlpha = Math.max(maxAlpha, alpha);
    sumRgb += rgb;
    sumAlpha += alpha;
    count++;
  }
  return { maxRgb, maxAlpha, meanRgb: sumRgb / count, meanAlpha: sumAlpha / count };
}

/** A hand-built legacy dictionary (92-byte header, no trailing extension) to edit. */
function legacyTxd() {
  const make = (name, format, size) => {
    const image = sourceImage(size);
    const header = Buffer.alloc(92);
    header.writeUInt32LE(9, 0);
    header.writeUInt32LE(0x1102, 4);
    header.write(name, 8, 32, 'latin1');
    if (format === '8888') {
      header.writeUInt32LE(0x0500, 72);
      header.writeUInt32LE(21, 76);
      header.writeUInt8(32, 84);
      header.writeUInt8(0x01, 87);
    } else {
      header.writeUInt32LE(0x0200, 72);
      header.writeUInt32LE(23, 76);
      header.writeUInt8(16, 84);
      header.writeUInt8(0x00, 87);
    }
    header.writeUInt16LE(size, 80);
    header.writeUInt16LE(size, 82);
    header.writeUInt8(1, 85);
    header.writeUInt8(4, 86);
    const pixels = Buffer.alloc(size * size * (format === '8888' ? 4 : 2));
    for (let i = 0, p = 0; p < size * size; p++, i += 4) {
      const o = p * (format === '8888' ? 4 : 2);
      if (format === '8888') {
        pixels[o] = image.rgba[i + 2];
        pixels[o + 1] = image.rgba[i + 1];
        pixels[o + 2] = image.rgba[i];
        pixels[o + 3] = image.rgba[i + 3];
      } else {
        pixels.writeUInt16LE(((image.rgba[i] >> 3) << 11) | ((image.rgba[i + 1] >> 2) << 5) | (image.rgba[i + 2] >> 3), o);
      }
    }
    header.writeUInt32LE(pixels.length, 88);
    return chunk(0x15, chunk(0x01, Buffer.concat([header, pixels])));
  };
  const struct = Buffer.alloc(4);
  struct.writeUInt16LE(2, 0);
  struct.writeUInt16LE(9, 2);
  return chunk(0x16, Buffer.concat([chunk(0x01, struct), make('legacy_a', '8888', 16), make('legacy_b', '565', 16)]));
}

async function main() {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'models'), { recursive: true });
  await writeFile(path.join(root, 'server.cfg'), 'echo samp-mcp txd fixture\n', 'utf8');

  console.log('1. encode → parse → decode every raster format');
  const image = sourceImage();
  const hard = sourceImage(32, true);
  for (const format of ALL_FORMATS) {
    const source = format === 'DXT1' ? hard : image;
    const levels = buildMipChain(source, 1);
    const buffer = buildTxdBuffer({
      textures: [{ name: 'swatch', format, levels, filterMode: 0x1102 }],
      deviceId: 2,
      version: RW_SA_VERSION,
    });
    const dict = parseTxd(buffer, `${format}.txd`);
    const texture = dict.textures[0];
    check(`${format}: dictionary parses with the right metadata`,
      dict.textures.length === 1 && texture.format === format && texture.width === 32 && texture.height === 32
      && texture.numLevels === 1 && texture.platform === 9 && texture.compressed === ['DXT1', 'DXT3', 'DXT5'].includes(format),
      `${texture.format} ${texture.width}x${texture.height} L${texture.numLevels} platform=${texture.platform} compressed=${texture.compressed}`);
    const decoded = decodeTxdTexture(buffer, 'swatch');
    if (!decoded) {
      check(`${format}: decodes back`, false, 'decoder returned nothing');
      continue;
    }
    const stats = diff(source, decoded);
    const keepsAlpha = ['8888', '4444', 'DXT1', 'DXT3', 'DXT5'].includes(format);
    // The dictionary is 12 + (12 + 4) + (12 + (12 + 92 + raster) + 12) + 12 bytes.
    const expectedBytes = 168 + levelBytes(format, 32, 32);
    check(`${format} round trip has the size the format implies`, buffer.length === expectedBytes,
      `${buffer.length} bytes, expected ${expectedBytes}`);
    if (format === '8888') {
      check('8888 is bit exact in colour and alpha', stats.maxRgb === 0 && stats.maxAlpha === 0, JSON.stringify(stats));
    } else if (format === '888' || format === '565' || format === '555') {
      const budget = format === '888' ? 0 : 10;
      check(`${format} keeps its colour within the format's quantisation`, stats.maxRgb <= budget, JSON.stringify(stats));
    } else if (format === '4444') {
      check('4444 stays within its 4-bit quantisation', stats.maxRgb <= 20 && stats.maxAlpha <= 20, JSON.stringify(stats));
    } else if (format === 'LUM8') {
      let maxGrey = 0;
      let greyChannels = true;
      for (let i = 0; i < source.rgba.length; i += 4) {
        const luma = Math.round(0.299 * source.rgba[i] + 0.587 * source.rgba[i + 1] + 0.114 * source.rgba[i + 2]);
        maxGrey = Math.max(maxGrey, Math.abs(decoded.rgba[i] - luma));
        if (decoded.rgba[i] !== decoded.rgba[i + 1] || decoded.rgba[i] !== decoded.rgba[i + 2]) greyChannels = false;
      }
      check('LUM8 stores the luminance it encoded as grey', maxGrey <= 2 && greyChannels, `max grey error ${maxGrey}`);
    } else if (format === 'DXT1') {
      check('DXT1 keeps the 1-bit alpha corners transparent and the rest opaque',
        decoded.rgba[3] === 0 && decoded.rgba[(31 * 32 + 31) * 4 + 3] === 255,
        `corner alpha=${decoded.rgba[3]}, opposite=${decoded.rgba[(31 * 32 + 31) * 4 + 3]}`);
      check('DXT1 colour error stays inside the block quantiser', stats.meanRgb <= 12 && stats.maxRgb <= 80, JSON.stringify(stats));
    } else {
      check(`${format} colour error stays inside the block quantiser`, stats.meanRgb <= 12, JSON.stringify(stats));
      check(`${format} keeps a smooth alpha ramp`, stats.meanAlpha <= 12, JSON.stringify(stats));
    }
    if (!keepsAlpha) {
      check(`${format} decodes as fully opaque`, decoded.rgba.every((value, index) => index % 4 !== 3 || value === 255));
    }
  }

  console.log('\n2. mip chain layout');
  const mipSource = { width: 64, height: 32, rgba: sourceImage(64).rgba.subarray(0, 64 * 32 * 4) };
  for (const [format, count] of [['8888', 'full'], ['DXT5', 'full'], ['8888', 3], ['DXT5', 1]]) {
    const levels = buildMipChain(mipSource, count);
    const expectedLevels = count === 'full' ? 7 : count;
    const buffer = buildTxdBuffer({ textures: [{ name: 'mips', format, levels }], deviceId: 2 });
    const dict = parseTxd(buffer, 'mips.txd');
    check(`${format} with mipmaps=${count}: levels = ${expectedLevels}`, levels.length === expectedLevels && dict.textures[0].numLevels === expectedLevels,
      `${levels.length}/${dict.textures[0].numLevels}`);
    check(`${format} with mipmaps=${count}: rasterFormat carries the 0x8000 mip flag`,
      (dict.textures[0].rasterFormat & 0x8000) !== 0 === (expectedLevels > 1),
      `0x${dict.textures[0].rasterFormat.toString(16)}`);

    // Independent payload math: header + level 0 + (u32 size + level) per extra level.
    let expected = 92 + levelBytes(format, 64, 32);
    for (let i = 1; i < expectedLevels; i++) {
      expected += 4 + levelBytes(format, Math.max(1, 64 >> i), Math.max(1, 32 >> i));
    }
    const sections = readTxdSections(buffer).filter((s) => s.type === CHUNK_TEXTURENATIVE);
    check(`${format} with mipmaps=${count}: the struct payload is exactly the layout above`,
      buffer.readUInt32LE(sections[0].start + 16) === expected,
      `${buffer.readUInt32LE(sections[0].start + 16)} vs ${expected}`);
    check(`${format} with mipmaps=${count}: the reader decodes it back`,
      dict.textures[0].decodeError === undefined && dict.textures[0].decodable, dict.textures[0].decodeError ?? 'ok');
    if (expectedLevels > 1) {
      const level0 = levelBytes(format, 64, 32);
      const level1 = levelBytes(format, Math.max(1, 64 >> 1), Math.max(1, 32 >> 1));
      const at = sections[0].start + 12 + 12 + 92 + level0;
      check(`${format}: level 1 is preceded by its own u32 byte length`, buffer.readUInt32LE(at) === level1, `${buffer.readUInt32LE(at)} vs ${level1}`);
    }      check(`${format} with mipmaps=${count}: filter defaults follow the level count`,
        dict.textures[0].filterMode === (expectedLevels > 1 ? 0x1106 : 0x1102),
        `0x${dict.textures[0].filterMode.toString(16)}`);
  }

  console.log('\n3. rebuild real GTA: SA dictionaries from their own pixels (byte for byte)');
  const samples = [];
  const sampleRoot = process.env.SAMP_TXD_SAMPLE_DIR || 'D:/GTASAN Muntiplayer';
  try {
    for await (const file of glob(`${sampleRoot}/**/*.txd`)) samples.push(file);
  } catch { /* no game assets on this machine */ }
  let rebuiltFiles = 0;
  let sampleTextures = 0;
  if (samples.length === 0) {
    console.log(`  skipped — no .txd found under ${sampleRoot} (set SAMP_TXD_SAMPLE_DIR to a game/models folder)`);
  }
  for (const file of samples.sort()) {
    const buffer = await readFile(file).catch(() => null);
    if (!buffer) continue;
    const dict = parseTxd(buffer, file);
    // Only single-level dictionaries whose formats are lossless: those must come
    // back bit for bit, which is the strongest check of the writer's layout.
    const usable = dict.textures.length > 0 && !dict.error
      && dict.textures.every((t) => t.platform === 9 && t.numLevels === 1 && t.decodable && LOSSLESS.includes(t.format));
    if (!usable) continue;
    const textures = dict.textures.map((meta, index) => ({
      name: meta.name,
      mask: meta.mask,
      format: meta.format,
      levels: [decodeTxdTextureAt(buffer, index)],
      filterMode: meta.filterMode,
    }));
    const rebuilt = buildTxdBuffer({ textures, deviceId: dict.deviceId, version: buffer.readUInt32LE(8) });
    // One stock file (background.txd) stores numLevels 0 for a single level,
    // which the reader treats as 1 and the writer always writes explicitly, so
    // that one byte is normalised before the comparison.
    const normalised = Buffer.from(buffer);
    for (const section of readTxdSections(normalised).filter((s) => s.type === CHUNK_TEXTURENATIVE)) {
      // section header 12 + struct header 12 + 85 = the numLevels byte
      const at = section.start + 24 + 85;
      if (normalised[at] === 0) normalised[at] = 1;
    }
    const identical = rebuilt.equals(normalised);
    let detail = '';
    if (!identical) {
      const at = [...normalised].findIndex((byte, index) => byte !== rebuilt[index]);
      detail = `${buffer.length} vs ${rebuilt.length} bytes, first difference at ${at}`;
    }
    check(`${path.basename(file)} rebuilds byte for byte (${dict.textures.length} textures)`, identical, detail);
    rebuiltFiles++;
    sampleTextures += dict.textures.length;
    if (rebuiltFiles >= 3) break;
  }
  if (rebuiltFiles > 0) console.log(`  (${rebuiltFiles} real dictionary/dictionaries, ${sampleTextures} textures)`);

  console.log('\n4. editor: import, convert, rename, duplicate, remove, export, save');
  const fixture = legacyTxd();
  const fixtureFile = path.join(root, 'models', 'legacy.txd');
  await writeFile(fixtureFile, fixture);
  const editor = new TxdEditorManager();
  editor.setRoot(root);

  const opened = await editor.open({ file: 'models/legacy.txd' });
  check('open lists both textures with their real formats',
    opened.textures.length === 2 && opened.textures[0].name === 'legacy_a' && opened.textures[0].format === '8888'
    && opened.textures[1].format === '565',
    opened.textures.map((t) => `${t.name}:${t.format}`).join(','));
  check('open reports no unsaved changes', opened.dirty === false && opened.textures.every((t) => !t.dirty),
    `dirty=${opened.dirty}`);
  check('an opened dictionary only grows by the trailing extension the fixture omits',
    opened.outputBytes === fixture.length + 12, `${opened.outputBytes} vs ${fixture.length + 12}`);

  await writeFile(path.join(root, 'art.png'), encodePng(sourceImage(16)));
  await mkdir(path.join(root, 'art'), { recursive: true });
  await writeFile(path.join(root, 'art', 'badge.png'), encodePng(sourceImage(16)));
  const png = await editor.loadPng('art/badge.png');
  check('loadPng decodes the imported PNG', png.image.width === 16 && png.image.height === 16, `${png.image.width}x${png.image.height}`);

  const imported = await editor.importTexture('models/legacy.txd', { name: 'badge', image: png.image, mipmaps: 'full' });
  check('import appends a new texture with a full mip chain',
    imported.workspace.textures.length === 3 && imported.workspace.textures[2].levels === 5,
    imported.workspace.textures.map((t) => `${t.name}:L${t.levels}`).join(','));
  check('import marks the workspace dirty', imported.workspace.dirty === true);

  const replaced = await editor.importTexture('models/legacy.txd', { name: 'legacy_b', image: png.image, format: '8888' });
  check('importing an existing name replaces it in place',
    replaced.replaced === true && replaced.workspace.textures.length === 3 && replaced.workspace.textures[1].format === '8888',
    replaced.workspace.textures.map((t) => `${t.name}:${t.format}`).join(','));

  const converted = await editor.editTexture('models/legacy.txd', 'convert', { texture: 'badge', format: 'DXT5' });
  const badge = converted.workspace.textures.find((t) => t.name === 'badge');
  check('convert re-encodes as DXT5 and keeps the level count', badge.format === 'DXT5' && badge.levels === 5,
    `${badge.format}/L${badge.levels}`);

  const duplicated = await editor.editTexture('models/legacy.txd', 'duplicate', { texture: 'badge' });
  check('duplicate copies the texture under a new name', duplicated.workspace.textures.some((t) => t.name === 'badge_copy'));
  const renamed = await editor.editTexture('models/legacy.txd', 'rename', { texture: 'badge_copy', name: 'badge2' });
  check('rename keeps the position and changes the name',
    renamed.workspace.textures[3].name === 'badge2' && renamed.workspace.textures.length === 4,
    renamed.workspace.textures.map((t) => t.name).join(','));

  const removed = await editor.editTexture('models/legacy.txd', 'remove', { texture: 'legacy_a' });
  check('remove drops just that texture',
    removed.workspace.textures.length === 3 && !removed.workspace.textures.some((t) => t.name === 'legacy_a'),
    removed.workspace.textures.map((t) => `${t.name}:${t.format}`).join(','));

  const exported = await editor.exportTexture('models/legacy.txd', { texture: 'badge' });
  check('export writes one PNG for the edited (unsaved) texture',
    exported.files.length === 1 && exported.files[0].format === 'DXT5' && exported.files[0].levels === 5,
    JSON.stringify(exported.files));
  const exportedPng = await editor.loadPng(exported.files[0].file);
  const exportStats = diff(png.image, exportedPng.image);
  check('the exported PNG still matches the imported art', exportStats.meanRgb <= 12, JSON.stringify(exportStats));

  const saved = await editor.save('models/legacy.txd', {});
  const written = await readFile(fixtureFile);
  const parsed = parseTxd(written, 'legacy.txd');
  check('save writes the file and backs the previous one up',
    saved.bytes === written.length && (await readFile(`${fixtureFile}.bak`)).equals(fixture),
    `${saved.bytes} bytes, backup ${saved.backup}`);
  check('the saved dictionary holds exactly the edited textures in order',
    parsed.textures.map((t) => `${t.name}:${t.format}:L${t.numLevels}`).join(' ') === 'legacy_b:8888:L1 badge:DXT5:L5 badge2:DXT5:L5',
    parsed.textures.map((t) => `${t.name}:${t.format}:L${t.numLevels}`).join(' '));
  check('save only notes the size change, nothing suspicious',
    saved.warnings.every((warning) => warning.startsWith('size changed')), saved.warnings.join(' | '));
  check('the saved dictionary decodes again', Boolean(decodeTxdTexture(written, 'badge')));
  const reimported = decodeTxdTextureAt(written, 0);
  check('the re-imported 8888 texture is bit exact',
    reimported && diff(png.image, reimported).maxRgb === 0 && diff(png.image, reimported).maxAlpha === 0,
    reimported ? JSON.stringify(diff(png.image, reimported)) : 'no pixels');
  const badgeBack = decodeTxdTextureAt(written, 1);
  check('the converted DXT5 texture still looks like the art (compressed, not lost)',
    badgeBack && diff(png.image, badgeBack).meanRgb <= 20,
    badgeBack ? JSON.stringify(diff(png.image, badgeBack)) : 'no pixels');
  check('workspaces are closed by saving', editor.list().length === 1 && editor.list()[0].dirty === false,
    JSON.stringify(editor.list().map((w) => `${w.id}:${w.dirty}`)));

  console.log('\n5. editor: dictionaries inside a VER2 .img archive');
  const imgFile = path.join(root, 'models', 'test.img');
  await writeFile(imgFile, buildImg([{ name: 'legacy.txd', data: fixture }]));
  const inImg = await editor.open({ img: 'models/test.img', entry: 'legacy.txd' });
  check('open reads a dictionary out of the archive', inImg.id === 'models/test.img#legacy.txd' && inImg.textures.length === 2, inImg.id);
  await editor.importTexture(inImg.id, { name: 'archive_tex', image: png.image, format: 'DXT3', mipmaps: 2 });
  const imgSaved = await editor.save(inImg.id, {});
  check('save rewrites the archive entry', imgSaved.target === 'img' && imgSaved.mode === 'appended' && imgSaved.bytes > 0,
    JSON.stringify(imgSaved));
  const archiveIndex = await editor.open({ img: 'models/test.img', entry: 'legacy.txd' });
  check('the archive entry reads back with the new texture',
    archiveIndex.textures.length === 3 && archiveIndex.textures[2].name === 'archive_tex' && archiveIndex.textures[2].format === 'DXT3',
    archiveIndex.textures.map((t) => `${t.name}:${t.format}`).join(','));

  console.log('\n6. error handling');
  const expectError = async (label, fn, needle) => {
    try {
      await fn();
      check(label, false, 'no error was thrown');
    } catch (error) {
      check(label, String(error.message).includes(needle), error.message);
    }
  };
  await expectError('a name longer than the char[32] field is refused',
    () => editor.importTexture('models/legacy.txd', { name: 'x'.repeat(32), image: png.image }),
    'char[32]');
  await expectError('editing a texture that is not there is refused',
    () => editor.editTexture('models/legacy.txd', 'remove', { texture: 'nope' }),
    'is not in');
  await expectError('opening a directory as a dictionary is refused',
    () => editor.open({ file: 'models' }),
    'is a directory');
  await expectError('importing a file that is not a PNG is refused',
    () => editor.loadPng('models/legacy.txd'),
    'not a PNG');
  await expectError('exporting a texture the archive does not hold is refused',
    () => editor.exportTexture('models/test.img#legacy.txd', { texture: 'missing' }),
    'no texture matching');
  await expectError('writing an archive entry that does not exist is refused',
    () => editor.save('models/legacy.txd', { img: 'models/test.img', entry: 'nope.txd' }),
    'has to exist');
  const discarded = editor.discard('models/test.img#legacy.txd');
  check('discard closes a workspace without saving', discarded.includes('without saving'), discarded);

  console.log('');
  console.log(`txd-demo: ${passed} checks passed${failures.length ? `, ${failures.length} failed` : ''}`);
  if (failures.length) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`artifacts in .freebuff/txd-demo (fixtures, exports, backups)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
