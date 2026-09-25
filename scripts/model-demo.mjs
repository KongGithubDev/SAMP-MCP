#!/usr/bin/env node
/**
 * 3D model pipeline test / demo.
 *
 * Runs against a throwaway SA-MP server root (.freebuff/model-demo, git-ignored)
 * filled with fixtures built from the RenderWare spec (scripts/dff-fixture.mjs):
 *
 *  1. parses a .dff cube — clump/frame/geometry/material/atomic reading, the
 *     frame hierarchy (the atomic sits on a translated child frame) and node names,
 *  2. renders it to PNG with the material texture from the sibling .txd and
 *     checks the pixels really contain both the texture and the flat material,
 *  3. pulls the same model out of a VER2 .img archive by name,
 *  4. exports OBJ + MTL and glTF 2.0 and checks the geometry survives,
 *  5. drives the TextdrawManager so a font 5 textdraw shows the rendered model
 *     on the preview page (`.samp-mcp/textdraw-assets/models/<id>.png`).
 *
 * Run: node scripts/model-demo.mjs   (after `npm run build`)
 */
import { mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { models } from '../dist/model.js';
import { parseDff, flattenDff } from '../dist/dff.js';
import { decodePng } from '../dist/txd.js';
import { TextdrawManager } from '../dist/textdraw.js';
import { buildDff, buildTxd, buildImg, writeModelFixtures } from './dff-fixture.mjs';

const root = path.join(import.meta.dirname, '..', '.freebuff', 'model-demo');
const TEXTURE = 'demo_model';

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
const rel = (file) => path.relative(root, file);

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function nonTransparent(png) {
  let count = 0;
  for (let i = 3; i < png.rgba.length; i += 4) if (png.rgba[i] > 32) count++;
  return count;
}

function pixels(png) {
  const out = [];
  for (let i = 0; i < png.rgba.length; i += 4) {
    out.push([png.rgba[i], png.rgba[i + 1], png.rgba[i + 2], png.rgba[i + 3]]);
  }
  return out;
}

async function main() {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'server.cfg'), 'echo samp-mcp model fixture\n', 'utf8');

  console.log('1. write fixtures (cube .dff + matching .txd, and a VER2 .img copy)');
  const { files } = await writeModelFixtures(root, { textureName: TEXTURE, dffName: 'demo_cube' });
  const dffBuffer = buildDff({ textureName: TEXTURE });
  const txdBuffer = buildTxd({ name: TEXTURE });
  await writeFile(path.join(root, 'models', 'demo.img'), buildImg([
    { name: 'DEMO.DFF', data: dffBuffer },
    { name: 'DEMO.TXD', data: txdBuffer },
  ]));
  // a second copy under the model id 411 so the textdraw side can resolve it
  await writeFile(path.join(root, 'models', '411.dff'), dffBuffer);
  await writeFile(path.join(root, 'models', '411.txd'), txdBuffer);

  console.log('2. parse the .dff (clump, frames, hierarchy, materials, atomics)');
  const parsed = parseDff(dffBuffer, 'demo_cube.dff');
  check('clump version is recognised', parsed.version.includes('RW 3.6'), parsed.version);
  check('one geometry, one atomic', parsed.geometries.length === 1 && parsed.atomics.length === 1,
    `${parsed.geometries.length}/${parsed.atomics.length}`);
  check('24 vertices, 12 triangles, 2 materials',
    parsed.stats.vertices === 24 && parsed.stats.triangles === 12 && parsed.stats.materials === 2,
    JSON.stringify(parsed.stats));
  check('3 frames of which 2 are dummies', parsed.stats.frames === 3 && parsed.stats.dummies === 2,
    `${parsed.stats.frames}/${parsed.stats.dummies}`);
  check('node names survive the frame list extension', parsed.frames[2]?.name === 'dummy_wheel', parsed.frames[2]?.name);
  check('material texture name read from the texture chunk', parsed.geometries[0].materials[0].texture === TEXTURE,
    parsed.geometries[0].materials[0].texture);
  check('flat material colour read as r,g,b,a', parsed.geometries[0].materials[1].color.join(',') === '255,0,255,255',
    parsed.geometries[0].materials[1].color.join(','));

  const mesh = flattenDff(parsed);
  check('the atomic inherits its parent frame translation (x = 2)',
    Math.abs(mesh.bounds.center[0] - 2) < 0.001, `centre x = ${mesh.bounds.center[0]}`);

  console.log('3. scan + render through the model manager');
  models.setRoot(root);
  const scan = await models.scan({ depth: 3, limit: 50 });
  check('scan found both .dff files and the archive', scan.dffs.length === 2 && scan.archives.length === 1,
    `${scan.dffs.length} dff / ${scan.archives.length} img`);
  check('scan pairs the sibling .txd textures',
    scan.dffs.every((dff) => dff.texturesFound.length === dff.textures.length),
    JSON.stringify(scan.dffs.map((dff) => `${dff.file}:${dff.texturesFound.length}/${dff.textures.length}`)));

  const png = await models.preview('demo_cube', { width: 192, height: 192 });
  check('preview wrote a PNG next to the other model assets', await exists(path.join(root, png.file)), png.file);
  check('all material textures resolved', png.textures.missing.length === 0, png.textures.missing.join(','));
  check('the texture was actually drawn', png.textures.used.includes(TEXTURE), png.textures.used.join(','));
  check('triangles were rasterised', png.render.drawn >= 6, String(png.render.drawn));

  const rendered = decodePng(await readFile(path.join(root, png.file)));
  check('the rendered PNG decodes as RGBA', rendered && rendered.width === 192 && rendered.height === 192,
    rendered ? `${rendered.width}x${rendered.height}` : 'decode failed');
  const covered = nonTransparent(rendered);
  check('the cube covers a good part of the frame', covered > 192 * 192 * 0.08,
    `${((covered / (192 * 192)) * 100).toFixed(1)}%`);
  const px = pixels(rendered);
  check('textured pixels show the .txd gradient (blue/green tinted, r ≈ 40)',
    px.some(([r, g, b, a]) => a > 200 && r < 70 && (b > 60 || g > 60)));
  check('the flat magenta material is visible too',
    px.some(([r, g, b, a]) => a > 200 && r > 90 && b > 90 && g < 60),
    'no magenta pixel found');

  console.log('4. render the same model out of the VER2 .img archive');
  const fromImg = await models.preview('demo', { width: 128, height: 128, saveAs: 'demo_img' });
  check('model name resolved inside the archive', fromImg.source.includes('demo.img'), fromImg.source);
  check('archive textures resolved from the sibling entry', fromImg.textures.missing.length === 0,
    fromImg.textures.missing.join(','));

  console.log('5. export to OBJ/MTL and glTF');
  const obj = await models.exportModel('demo_cube', { format: 'obj' });
  const objFile = obj.files.find((file) => file.endsWith('.obj'));
  const mtlFile = obj.files.find((file) => file.endsWith('.mtl'));
  const objText = await readFile(path.join(root, objFile), 'utf8');
  const mtlText = await readFile(path.join(root, mtlFile), 'utf8');
  check('OBJ has one vertex per geometry vertex', objText.split('\n').filter((line) => line.startsWith('v ')).length === 24);
  check('OBJ has the 12 triangles', objText.split('\n').filter((line) => line.startsWith('f ')).length === 12);
  check('OBJ references both materials', objText.includes('usemtl mat_0') && objText.includes('usemtl mat_1'));
  check('MTL maps the exported texture PNG', mtlText.includes(`map_Kd ${TEXTURE}.png`), mtlText.split('\n').slice(0, 6).join(' | '));
  check('texture PNG was exported too', obj.files.some((file) => file.endsWith(`${TEXTURE}.png`)), obj.files.join(','));

  const gltf = await models.exportModel('demo_cube', { format: 'gltf' });
  const gltfText = await readFile(path.join(root, gltf.files[0]), 'utf8');
  const gltfJson = JSON.parse(gltfText);
  check('glTF has one primitive per material', gltfJson.meshes[0].primitives.length === 2,
    String(gltfJson.meshes[0].primitives.length));
  check('glTF vertices keep POSITION/NORMAL/TEXCOORD_0',
    ['POSITION', 'NORMAL', 'TEXCOORD_0'].every((key) => key in gltfJson.meshes[0].primitives[0].attributes));
  check('glTF textures point at the exported PNGs', (gltfJson.images || []).some((image) => image.uri === `${TEXTURE}.png`));

  console.log('6. font 5 textdraw integration (preview page)');
  const textdraw = new TextdrawManager();
  textdraw.setRoot(root);
  await textdraw.createTextdraw('modeldemo', { name: 'gModelIcon', font: 5, previewModel: 411, x: 320, y: 224, textSizeX: 100, textSizeY: 100 });
  const built = await textdraw.buildPreview('modeldemo', { exportPng: true, inlineAssets: true, maxTextureSize: 256 });
  check('preview reports the rendered model', built.models === 1 && built.missingModels.length === 0,
    `models=${built.models} missing=${built.missingModels.join(',')}`);
  check('model PNG landed in the model asset folder',
    await exists(path.join(root, '.samp-mcp', 'textdraw-assets', 'models', '411.png')));
  const html = await readFile(built.htmlPath, 'utf8');
  check('the page embeds the rendered model image', html.includes('data:image/png;base64,'));

  const live = await models.renderDataUrl('411', { rot: [-45, 0, -45], zoom: 1, size: 128 });
  check('live editor render returns a data URL', live.url.startsWith('data:image/png;base64,'), live.url.slice(0, 24));
  const livePng = decodePng(Buffer.from(live.url.split(',')[1], 'base64'));
  check('rotated render still covers the model (rot [-45,0,-45])',
    livePng && nonTransparent(livePng) > 128 * 128 * 0.05,
    livePng ? `${((nonTransparent(livePng) / (128 * 128)) * 100).toFixed(1)}%` : 'decode failed');

  console.log('');
  console.log(`model-demo: ${passed} checks passed${failures.length ? `, ${failures.length} failed` : ''}`);
  if (failures.length) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`artifacts in ${rel(root)} (.samp-mcp/textdraw-assets/models, .samp-mcp/model-export)`);
  console.log(`fixture: ${rel(files.dff)} + ${rel(files.txd)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
