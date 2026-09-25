#!/usr/bin/env node
/**
 * End-to-end test of the Textdraw Editor through the *real* MCP server: it
 * spawns dist/index.js over stdio and calls the tools exactly the way an agent
 * (or Claude Desktop) does, so the tool names, argument schemas and result
 * shapes are covered — not just the TextdrawManager methods the unit-style
 * demo script exercises.
 *
 * It works in a throwaway SA-MP root under .freebuff/ (git-ignored):
 * server.cfg, a gamemode to import from and one design-time sprite PNG.
 *
 * Run: node scripts/textdraw-mcp-test.mjs   (after `npm run build`)
 * Exit code is non-zero when any expectation fails.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { encodePng } from '../dist/txd.js';
import { buildDff, buildTxd } from './dff-fixture.mjs';

const repo = path.join(import.meta.dirname, '..');
const root = path.join(repo, '.freebuff', 'textdraw-mcp-test');
const SPRITE = 'test:badge';
const PORT = Number(process.env.TEXTDRAW_TEST_PORT || 7799);

let failures = 0;
function check(label, ok, detail = '') {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

/** 4x4 opaque checkerboard, so the sprite has real pixels behind it. */
function badgePng() {
    const rgba = Buffer.alloc(4 * 4 * 4);
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
            const o = (y * 4 + x) * 4;
            const on = (x + y) % 2 === 0;
            rgba[o] = on ? 220 : 20;
            rgba[o + 1] = on ? 40 : 20;
            rgba[o + 2] = on ? 90 : 20;
            rgba[o + 3] = 255;
        }
    }
    return encodePng({ width: 4, height: 4, rgba });
}

const gamemode = [
    '#include <a_samp>',
    'new Text:gHudTitle;',
    'new PlayerText:pNameTag[MAX_PLAYERS];',
    'public OnGameModeInit()',
    '{',
    '    gHudTitle = TextDrawCreate(320.0, 12.0, "test server");',
    '    TextDrawLetterSize(gHudTitle, 0.4, 1.6);',
    '    TextDrawAlignment(gHudTitle, 2);',
    '    TextDrawColor(gHudTitle, 0xFFCC00FF);',
    '    TextDrawFont(gHudTitle, 1);',
    '    AddSimpleModel(-1, 19379, -2000, "custom/sign.dff", "custom/sign.txd");',
    '    return 1;',
    '}',
    'public OnPlayerConnect(playerid)',
    '{',
    '    pNameTag[playerid] = CreatePlayerTextDraw(playerid, 20.0, 400.0, "name");',
    '    PlayerTextDrawLetterSize(playerid, pNameTag[playerid], 0.25, 1.0);',
    '    PlayerTextDrawFont(playerid, pNameTag[playerid], 2);',
    '    return 1;',
    '}',
    '',
].join('\n');

const serverCfg = [
    'echo Executing Server Config...',
    'lanmode 1',
    'rcon_password changeme',
    'maxplayers 32',
    'port 7777',
    'hostname samp-mcp textdraw test',
    'gamemode0 main 1',
    'filterscripts',
    'announce 0',
    'query 1',
    'maxnpc 0',
    '',
].join('\n');

await rm(root, { recursive: true, force: true });
await mkdir(path.join(root, 'gamemodes'), { recursive: true });
await mkdir(path.join(root, '.samp-mcp', 'textdraw-assets', 'sprites'), { recursive: true });
await writeFile(path.join(root, 'server.cfg'), serverCfg, 'utf8');
await writeFile(path.join(root, 'gamemodes', 'main.pwn'), gamemode, 'utf8');
await writeFile(path.join(root, '.samp-mcp', 'textdraw-assets', 'sprites', 'test__badge.png'), badgePng());

// A custom 0.3.DL model exactly where the gamemode's AddSimpleModel points.
const MODEL_TXD = 'sign_model';
await mkdir(path.join(root, 'custom'), { recursive: true });
await writeFile(path.join(root, 'custom', 'sign.dff'), buildDff({ textureName: MODEL_TXD }));
await writeFile(path.join(root, 'custom', 'sign.txd'), buildTxd({ name: MODEL_TXD }));

const client = new Client({ name: 'samp-mcp-textdraw-test', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'dist', 'index.js')],
    cwd: repo,
    env: { ...process.env, SAMP_SERVER_ROOT: root },
});
await client.connect(transport);

/**
 * Calls a tool and returns its payload. Tools answer with a human summary
 * followed (sometimes) by a machine-readable data block, so the last block
 * that parses as JSON wins; otherwise the joined text is returned.
 */
async function call(name, args = {}) {
    const res = await client.callTool({ name, arguments: args });
    const blocks = (res.content ?? []).map((c) => c.text ?? '');
    if (res.isError) throw new Error(`${name} -> ${blocks.join('\n')}`);
    for (const block of [...blocks].reverse()) {
        try { return JSON.parse(block); } catch { /* not the data block */ }
    }
    return blocks.join('\n');
}

try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const editorTools = ['textdraw_list', 'textdraw_create', 'textdraw_update', 'textdraw_delete', 'textdraw_import', 'textdraw_export', 'textdraw_preview', 'textdraw_preview_server', 'txd_scan'];
    const modelTools = ['model_scan', 'model_preview', 'model_export'];
    check('all nine textdraw tools are advertised', editorTools.every((t) => tools.includes(t)), `${tools.length} tools total`);
    check('the three 3D model tools are advertised', modelTools.every((t) => tools.includes(t)), modelTools.join(', '));

    const connected = String(await call('set_server_root', { path: root }));
    check('set_server_root accepts the SA-MP root', connected.includes('Successfully connected'), connected.split('\n')[0]);

    const scan = await call('txd_scan', {});
    check('txd_scan returns a parseable result with the index file', typeof scan.indexFile === 'string', `${scan.scannedFiles} file(s), ${scan.dictionaries?.length ?? 0} dictionaries`);

    const imported = await call('textdraw_import', { project: 'test', path: 'gamemodes/main.pwn', mode: 'replace' });
    check('textdraw_import reads TextDrawCreate/CreatePlayerTextDraw code', imported.imported === 2, imported.created?.join(', '));
    check('textdraw_import keeps AddSimpleModel entries', imported.simpleModels === 1, `${imported.simpleModels} model(s)`);

    const sprite = await call('textdraw_create', { project: 'test', name: 'gBadge', text: SPRITE, font: 4, x: 10, y: 10, textSizeX: 32, textSizeY: 32 });
    check('textdraw_create stores a font 4 sprite', sprite.textdraw.font === 4 && sprite.textdraw.text === SPRITE, `${sprite.count} textdraws`);

    const updated = await call('textdraw_update', { project: 'test', textdraw: 'gBadge', x: 44.5, y: 20.25, box: true });
    check('textdraw_update patches by name (takes `textdraw`)', updated.after.x === 44.5 && updated.after.y === 20.25 && updated.before.x === 10, `x ${updated.before.x} -> ${updated.after.x}`);

    const listed = await call('textdraw_list', { project: 'test' });
    check('textdraw_list returns definitions, stats and warnings', listed.total === 3 && listed.stats.global === 2 && Array.isArray(listed.warnings), `${listed.total} textdraws, ${listed.warnings.length} warnings`);
    check('validation knows the sprite only exists as a design-time image', listed.warnings.some((w) => w.includes('design-time image')), listed.warnings[0] ?? '');

    const statements = String(await call('textdraw_export', { project: 'test', mode: 'statements' }));
    check('textdraw_export emits Pawn statements', statements.includes('gBadge = TextDrawCreate(44.500000, 20.250000, "test:badge")'), 'statements');
    const json = await call('textdraw_export', { project: 'test', mode: 'json' });
    check('textdraw_export mode=json is parseable and re-importable', json.project === 'test' && json.textdraws.length === 3 && json.textdraws.every((t) => typeof t.name === 'string'), `${json.textdraws.length} textdraws`);
    const module = String(await call('textdraw_export', { project: 'test', mode: 'module' }));
    check('textdraw_export mode=module produces a system module', module.includes('y_hooks') || module.includes('OnGameModeInit'), 'module');

    const preview = String(await call('textdraw_preview', { project: 'test', serve: true, port: PORT, inlineAssets: false }));
    const url = (preview.match(/Live editor server: (\S+)/) ?? [])[1];
    check('textdraw_preview starts the editor server', Boolean(url), url ?? preview.split('\n').slice(-1)[0]);
    check('textdraw_preview resolves the design-time sprite', preview.includes('design-time images'), 'sprite source reported');

    const status = String(await call('textdraw_preview_server', { action: 'status' }));
    check('textdraw_preview_server reports the running server', status.includes('running at http://127.0.0.1:'), status.split('\n')[0]);

    if (url) {
        const base = url.replace(/\/$/, '');
        const page = await fetch(base + '/');
        const html = await page.text();
        const payload = await (await fetch(`${base}/api/textdraws?project=test`)).json();
        const asset = await fetch(`${base}/assets/test__badge.png`);
        check('the served page is the editor', page.status === 200 && html.includes('Textdraws'), `${html.length} bytes`);
        check('the page API returns the project', payload.textdraws.length === 3, `${payload.textdraws.length} textdraws`);
        check('sprite bytes are served from the sprites directory', asset.status === 200 && (await asset.arrayBuffer()).byteLength > 40, `HTTP ${asset.status}`);
        check('the sprite asset is the design-time image', payload.assets[SPRITE]?.source.includes('design override'), payload.assets[SPRITE]?.source ?? 'missing');
    }

    // ---- 3D models -------------------------------------------------------
    const modelScan = await call('model_scan', { depth: 3, limit: 20 });
    check('model_scan finds the AddSimpleModel .dff', modelScan.dffs.some((d) => d.file.includes('sign.dff')), `${modelScan.scannedFiles} dff file(s)`);
    check('model_scan maps the AddSimpleModel id (-2000) to that .dff', Boolean(modelScan.modelIds?.['-2000']), JSON.stringify(modelScan.modelIds));
    check('model_scan resolves the companion .txd texture', modelScan.dffs.some((d) => d.textures.includes(MODEL_TXD) && d.texturesFound.includes(MODEL_TXD)), JSON.stringify(modelScan.dffs.map((d) => `${d.file}:${d.texturesFound.length}/${d.textures.length}`)));
    check('model_scan reports the geometry it parsed', modelScan.dffs.some((d) => d.stats.triangles === 12 && d.stats.vertices === 24), JSON.stringify(modelScan.dffs[0]?.stats));
    check('model_scan flags model ids with no .dff (font 5 default 411)', Array.isArray(modelScan.unmappedModelIds), modelScan.unmappedModelIds.join(','));

    const modelPreview = String(await call('model_preview', { model: -2000, rot: [-45, 0, -45], zoom: 1, width: 128, height: 128, background: '0x101820FF' }));
    check('model_preview renders by AddSimpleModel id', modelPreview.includes('128x128') && modelPreview.includes('PNG:'), modelPreview.split('\n')[1] ?? '');
    check('model_preview drew the .txd texture', modelPreview.includes(`Textures drawn: ${MODEL_TXD}`), modelPreview.match(/Textures drawn:.*/)?.[0] ?? '');
    check('model_preview reports the parsed hierarchy', /atomics .* frames/.test(modelPreview), modelPreview.split('\n')[3] ?? '');

    const modelExport = String(await call('model_export', { model: 'sign', format: 'gltf' }));
    check('model_export writes glTF for a bare model name', modelExport.includes('.gltf') && modelExport.includes('12 triangles'), modelExport.split('\n')[1] ?? '');
    const objExport = String(await call('model_export', { model: -2000, format: 'obj' }));
    check('model_export writes OBJ + MTL + texture PNG', objExport.includes('.obj') && objExport.includes('.mtl') && objExport.includes(`${MODEL_TXD}.png`), objExport.split('\n').slice(1, 3).join(' '));

    const modelIcon = await call('textdraw_create', { project: 'test', name: 'gModelIcon', font: 5, previewModel: -2000, x: 320, y: 260, textSizeX: 96, textSizeY: 96, previewRot: [-45, 0, -45] });
    check('textdraw_create stores a font 5 model preview', modelIcon.textdraw.font === 5 && modelIcon.textdraw.previewModel === -2000, JSON.stringify(modelIcon.textdraw.previewRot));

    const modelPreviewPage = String(await call('textdraw_preview', { project: 'test', inlineAssets: false }));
    check('textdraw_preview renders the font 5 model from its .dff', modelPreviewPage.includes('3D model previews: 1'), modelPreviewPage.split('\n')[3] ?? '');
    check('no unmapped model ids are reported any more', !modelPreviewPage.includes('Font 5 texts without a .dff'), 'missing-model line absent');

    if (url) {
        const base = url.replace(/\/$/, '');
        const payload = await (await fetch(`${base}/api/textdraws?project=test`)).json();
        const modelAsset = payload.models['-2000'];
        check('the page payload carries the rendered model', Boolean(modelAsset) && modelAsset.url.startsWith('models/'), modelAsset?.url ?? 'missing');
        const modelPng = await fetch(base + '/' + modelAsset.url);
        check('the model PNG is served by the editor', modelPng.status === 200 && Number(modelPng.headers.get('content-type')?.includes('image/png')), `HTTP ${modelPng.status}`);
        const rendered = await (await fetch(base + '/api/model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: -2000, rot: [0, 0, 0], zoom: 1.5, size: 64 }),
        })).json();
        check('POST /api/model re-renders on demand (orbit + wheel zoom)', String(rendered.url ?? '').startsWith('data:image/png;base64,'), rendered.source ?? JSON.stringify(rendered).slice(0, 80));
        check('the live render reuses the decoded texture', Array.isArray(rendered.missing) && rendered.missing.length === 0, (rendered.missing ?? []).join(','));
    }

    const removed = await call('textdraw_delete', { project: 'test', targets: ['gBadge'] });
    check('textdraw_delete removes by name', removed.removed.length === 1 && removed.left === 3, `left ${removed.left}`);

    const stopped = String(await call('textdraw_preview_server', { action: 'stop' }));
    check('textdraw_preview_server stops cleanly', stopped.includes('stopped'), stopped.split('\n')[0]);
} catch (error) {
    check('no tool threw', false, error.message);
} finally {
    await client.close();
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll textdraw MCP tool checks passed.');
process.exitCode = failures ? 1 : 0;
// the stdio child closes asynchronously — do not force process.exit while it does
setTimeout(() => process.exit(process.exitCode), 250).unref();
