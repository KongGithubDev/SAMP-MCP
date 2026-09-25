<div align="center">

# samp-mcp

**A comprehensive MCP server for SA-MP server development and management**

[![GitHub Packages](https://img.shields.io/badge/package-GitHub%20Packages-24292e.svg?logo=github)](https://github.com/KongGithubDev/SAMP-MCP/pkgs/npm/samp-mcp)
[![license](https://img.shields.io/github/license/KongGithubDev/SAMP-MCP.svg)](LICENSE)

Manage, script, and audit SA-MP servers with AI assistance.

</div>

---

## Installation

```sh
npm install -g @konggithubdev/samp-mcp
# or
yarn global add @konggithubdev/samp-mcp
```

The package is published to **GitHub Packages**, so installs and updates require authentication — create a personal access token (classic) with `read:packages` scope and add it to `~/.npmrc`:

```
//npm.pkg.github.com/:_authToken=TOKEN
@konggithubdev:registry=https://npm.pkg.github.com
```

Requires **Node.js ≥ 18** and a functional **SA-MP server** directory.

File tools need the [mcp-file-tools](https://github.com/dimitar-grigorov/mcp-file-tools) binary — samp-mcp finds it at its default install location, or you can point to it explicitly with the `SAMP_MCP_FILE_TOOLS_COMMAND` environment variable.

### Updating

Already installed? Install the same package again — this always resolves the `latest` tag, so it is the most reliable way to update:

```sh
npm install -g @konggithubdev/samp-mcp
# or
yarn global add @konggithubdev/samp-mcp
```

npm's own update command works too, with one catch:

```sh
npm update -g @konggithubdev/samp-mcp   # update within the installed major (1.2.0 -> 1.3.0)
npm outdated -g --depth=0               # list every global package that is behind
npm list -g @konggithubdev/samp-mcp     # the version you currently have
```

`npm update -g` treats a global install as if it had been declared with a caret range (`^1.0.12`), so it never crosses a major version — reach for `npm install -g` when you want the latest regardless. Called without a package name, it updates **every** global package on the machine and downgrades anything that is ahead of `latest`, so keep it scoped to this package.

The `~/.npmrc` setup above is required for updates exactly as it is for the first install: without the `@konggithubdev:registry` line npm looks for the package on npmjs.com and reports `404 Not Found`, and without the `//npm.pkg.github.com/:_authToken` line it reports `401 Unauthorized`. On Linux/macOS a global install fails with `EACCES` if the npm prefix is not writable — the usual fixes are a Node version manager (nvm) or npm's own prefix setting.

**Restart your MCP client afterwards.** The running server keeps the old code in memory, so an open session keeps using the previous version until the client (Claude Desktop, Cursor, Windsurf, …) reconnects.

The server can also update itself from inside a session:

| Tool | What it does |
|---|---|
| `check_for_updates` | Compares the running version with the latest one published to GitHub Packages (`npm view @konggithubdev/samp-mcp version --registry=https://npm.pkg.github.com`) |
| `update_mcp_server` | Runs the global install for you and asks you to restart the client |

To see the version you currently have installed:

```sh
npm list -g @konggithubdev/samp-mcp
```

---

## Textdraw Editor

samp-mcp can design SA-MP textdraws (HUD, UI, logos, sprite/`txd` art) as project files and show you the result on a web page — no server restart, no launching the game.

**Workflow**

1. `textdraw_create` (or `textdraw_import` from existing `TextDrawCreate` code / another editor's project JSON) — textdraws are stored in `<server root>/.samp-mcp/textdraws/<project>.json`, so a UI can be reviewed, diffed and versioned next to the gamemode.
2. `txd_scan` (read-only survey) or the **TXD editor** (`txd_open` → `txd_import_texture` / `txd_texture` → `txd_save`) — read, build and edit the actual `.txd` texture dictionaries (8888/888/565/555/4444/LUM8 and DXT1/3/5, mip maps included) instead of shipping bitmaps by hand. See *TXD editor* below.
3. `model_scan` + `model_preview` — for font 5 (3D preview) textdraws: finds the `.dff` models on the machine (loose files, the server's `models/` folder, or inside a VER2 `.img` archive such as `gta3.img`/`samp.img`), pairs them with their `.txd` textures, and renders the model to the PNG the textdraw shows. `model_export` writes OBJ+MTL or glTF for Blender/three.js. See *3D models* below.
4. `textdraw_preview` — renders every textdraw on a web page using the classic 640x448 grid scaled to real resolutions, with boxes, alignment, colours, outline/shadow, decoded font 4 sprites and real rendered font 5 model previews (drag a model to orbit it, wheel to zoom). `serve=true` also starts a live editor server (`127.0.0.1`) where textdraws can be dragged on screen and saved straight back into the project file.
5. `textdraw_export` — emits ready-to-use Pawn: `statements`, `declarations`, a full system-module `.inc` (y_hooks + show/hide stocks), a markdown table or raw JSON.

**Sprite / image / UI notes**

- Font 4 sprite textdraws use text in the form `txdname:texturename` (e.g. `demo:demo_logo`) — the preview resolves them against the scanned dictionaries and shows the real texture.
- Working on art that has no `.txd` yet? Drop the bitmap at `.samp-mcp/textdraw-assets/sprites/<txdname>__<texturename>.png` (or `.jpg`) and the preview draws it as a stand-in; validation reports it as a design-time image so it is clear the game will not show it until the same texture is shipped inside `<txdname>.txd`.
- Font 5 model previews use `previewModel` + `previewRot`/`previewZoom` and show the real model: the `.dff` is parsed and rasterised with its `.txd` textures, and the result is cached at `.samp-mcp/textdraw-assets/models/<modelid>.png` (drop your own PNG there to override it).
- Custom 0.3.DL UI textures are supported: `AddSimpleModel(...)` lines found by `textdraw_import` are kept with the project, they map model ids to their `.dff`/`.txd`, and they are re-emitted as hints by the module export.

**3D models**

`model_scan` finds what a server can actually show and `model_preview` renders it — the same idea as browser GTA SA model viewers (e.g. [gtastuff.com/viewer](https://gtastuff.com/viewer/)), applied to font 5 textdraws:

- Reads `.dff` clumps the way RenderWare writes them: clump → frame list (with the node-name extension) → geometry list → geometry struct (format flags, vertices, normals, texture coordinates, per-triangle material ids) → material list (colour, texture, addressing) → atomics, then applies the frame hierarchy so instanced parts land in the right place.
- Finds models in loose files, the server's `models/`, `.samp-mcp/model-export/`, or inside VER2 `.img` archives (`models/gta3.img`, `samp.img`, …) — the index of an archive is read on its own, so a stock 1 GB `gta3.img` is scanned without loading it.
- Pairs each material texture with a matching `.txd` (the model's sibling dictionary, the `AddSimpleModel` txd, the `.txd` files found by the scan, or a design-time PNG), decodes 8888/888/565/555/4444/LUM8/DXT1/3/5, and falls back to `.samp-mcp/textdraw-assets/sprites/<txd>__<texture>.png` for art that has no dictionary yet.
- Renders with z-buffering, bilinear texture sampling (wrap/mirror/clamp), per-vertex colours, material colour and alpha, camera-fixed key/fill/rim lighting and 2x supersampling. `rot` follows `TextDrawSetPreviewRot` (rx tilts, rz yaws), `zoom` follows the zoom argument, `vehCol` recolours the body parts vehicle materials mark, and `yaw`/`pitch` orbit the camera.
- `model_export` writes Wavefront OBJ + MTL or glTF 2.0 (one primitive per material, textures dumped as PNG next to it).

**TXD editor (textures)**

Font 4 sprites and 0.3.DL custom UI textures live inside `.txd` dictionaries, which is what the `txd_*` editing tools build and maintain — the same job Magic.TXD does, driven through MCP tools and verified against the files themselves:

- `txd_open` opens a dictionary from a file **or from inside a VER2 `.img` archive** (`img: models/gta3.img` + `entry: vehicle.txd`), or creates a new one (`create: true`), and lists every texture with its size, raster format, mip levels, section bytes and whether it can be decoded. The dictionary stays in memory for the following calls.
- `txd_import_texture` turns a PNG into a texture: `format` = `8888` (lossless, the default), `888`, `565`, `555`, `4444`, `LUM8`, or the compressed `DXT1`/`DXT3`/`DXT5` (seeded cluster fit with least-squares endpoint refinement — squish-style — 1-bit alpha for DXT1, 8-value alpha for DXT5), `mipmaps` = `1` (stock SA), a count, `full` (halves down to 1x1, like Magic.TXD) or `keep`. Re-importing an existing name replaces that texture in place.
- `txd_texture` renames (patching the `char[32]` name field, so it also works for rasters this build cannot decode), duplicates, removes, or converts a texture to another raster format/mip count.
- DXT compression runs at `quality: high` by default — a range fit only seeds the search; from there the encoder alternates nearest-palette-entry assignment with a **least-squares endpoint fit** (the normal-equation solution per channel), scores every candidate against the palette the game will actually decode, and keeps the best. DXT5 alpha screens the quartile pairings of the block's own alphas (plus a coarse alpha grid) and refines the best four, so a smooth alpha ramp keeps its steps and a hard mask keeps its 0/255 edges. `quality: fast` keeps the old single range fit for bulk conversions.
- `txd_export_texture` decodes textures — including imports that are not saved yet — to PNG, so art can be checked or edited in a paint tool.
- `txd_save` writes the dictionary back: to its own file (copying the previous one to `<name>.txd.bak` first), to a new `.txd` (`out`), or **into the `.img` entry it came from** (rewritten in place, or appended at the end of the archive when it needs more sectors — the directory slot is the only other thing touched, so nothing else in a multi-gigabyte `gta3.img` moves). The written bytes are parsed back before the result is reported, and `discard: true` throws the edits away instead.
- Textures that were not edited are written back **byte for byte** from the original file, so Direct3D 8 dictionaries, paletted rasters and formats this build cannot re-encode survive a save untouched.

Fidelity of the writer (all measured, not assumed): a complete dictionary rebuilt from its own decoded pixels reproduces stock GTA: SA files like `models/vehicle.txd` (19 textures), `models/effectsPC.txd` (36 textures) and `background.txd` byte for byte; the mipmap layout matches what Magic.TXD writes (level 0 directly after the 92-byte header, every later level preceded by its own `u32` byte length, `0x8000` in `rasterFormat` and the `0x1106` filter when mipmapped); and the round trip is exercised per format by `npm run test:txd` (90 checks) plus the MCP-level checks in `npm run test:textdraw`.

The cost of that search (512x512 source, measured): DXT1 64 ms → 340 ms, DXT5 75 ms → 1.6 s. Fast exists for bulk work on many large textures; high is the default because one dictionary save is not a batch job.

DXT quality is measured, not claimed: `npm run test:txd-quality` writes gradient / photo-noise / UI-sprite / alpha-mask images (and real textures out of the game's own dictionaries) through the writer and back through the reader, scores PSNR (colour over opaque pixels, alpha over all, plus the transparent/opaque decision), and compares three encoders. Against the original single range fit the cluster/least-squares path gains **+1.39 dB mean colour PSNR, up to +4.96 dB** (a hard-edged alpha mask) and never loses a pixel anywhere, **+2.43 dB** on DXT5 alpha ramps; against a brute-effort reference that enumerates every endpoint pair the block implies and refines six rounds, it stays within **0.14 dB** (colour) and **0.00 dB** (alpha), i.e. the extra search buys essentially nothing — the seeds and early exit cost almost nothing either. That benchmark is part of `npm run check` (74 checks, ~1s).

**Fidelity — what is exact, what is approximated**

Exact (data level, verified by the round-trip check in `npm run demo:textdraw`):

- Every property round-trips Pawn → project → Pawn → project unchanged (position, letter/text size, colours, font, alignment, box/selectable/proportional, preview model/rotation/zoom/vehicle colours, global vs per-player).
- Pawn escapes: a newline escape inside a string literal becomes a real line break in the project and on the preview page, and is re-emitted as exactly one escape when exporting; the underscore placeholder is kept in the data and drawn as a space (the SA-MP convention for blank filler).
- Text metrics come from the game itself: the per-character advance tables of both HUD atlases (proportional `prop[]` and the monospace advance), a glyph box of 10 units × `letterSizeY`, a line height of 9 units × `letterSizeY`, and the in-string colour codes `~r~ ~g~ ~b~ ~w~ ~p~ ~h~ ~n~` with the client's exact palette. Verified in-browser against the rendered pixels.
- Outline/shadow are drawn in `TextDrawBackgroundColor` (the client's behaviour, and why a transparent background hides the outline); the outline also widens each character's advance, and `~h~` lightens the current colour — all matching the client.
- Screen scaling uses the game's grid maths (`x * W/640`, `y * H/448` — the textdraw canvas is 640x448).
- Font 4 draws the texture itself and modulates it with `TextDrawColor`: rgb multiplied by the colour, alpha multiplied by its alpha, so a full-colour UI sheet (white colour) appears exactly as authored — it is not a flat silhouette. When the texture is missing the slot is painted with that colour instead, as the client does.
- A box is only painted when `UseBox` is set (`TextDrawUseBox`), for every font — sprites and model previews included — which is what the client does; font 4 box fill uses `TextDrawColor`, font 5 uses `TextDrawColor ∩ TextDrawBackgroundColor`.
- `.txd` decoding is pixel-level verified (8888/888/565/555/4444/LUM8 and DXT1/3/5 blocks).
- `.dff` parsing is verified against an independently written RenderWare fixture (`npm run test:model`): clump/geometry/material/atomic counts, the frame hierarchy (an atomic on a translated child frame is placed at the translated position), frame/dummy names, material texture names, the per-triangle material split, and the texture actually appearing in the rendered pixels.

Approximated (the client rasterises these itself):

- Fonts 0-3 render with system fonts, so the glyph *shapes* differ slightly; character positions and total line width use the game's own advance tables (matching Leonardo541's TextDrawEditor, which supplies those tables), and a `glyph size` control tunes the vertical glyph multiplier.
- The box uses the wiki's corner semantics by default; a checkbox switches to the "box hugs the text" model of that editor (4 unit margin, height from the line count) for comparison.
- The font 5 renderer is a software rasteriser, not the game's renderer: the camera is a 3/4 orbit with a fixed field of view (the client's exact preview camera is internal), lighting approximates the game's key/fill setup, and skinned/bone-animated geometry is drawn in its bind pose. Colours, alpha, texture addressing and the model's own geometry are exact.
- Material colour bytes are read as `r, g, b, a` (the documented RenderWare order); vehicle body markers (alpha ≤ 3) only take effect when `vehCol` is supplied.

Credit: the glyph advance tables and several client behaviours above were read out of [Leonardo541/TextDrawEditor](https://github.com/Leonardo541/TextDrawEditor) (MIT); samp-mcp also imports its project `.json` exports through `textdraw_import`.

Validation is authoritative: it encodes the real client limits (fonts that never render, `y < 1` hiding the first row, trailing-space text rendering blank, empty text crashing older servers, the 800-character limit, selectable without a text size, the 2048/256 textdraw limits). Textdraws whose text is deliberately blank filler (a clickable slot, for example) are not flagged, and a sprite that resolves through a design-time image is reported as information rather than a missing texture.

**Validation** runs on every list/preview/export: font values that never render, malformed sprite references, missing textures, text beyond the client string limit, off-grid positions, selectable textdraws without a text size, duplicate variable names and the 2048/256 textdraw limits.

---

## Module-aware design

For projects that organize code as system modules (e.g. `gamemodes/includes/system/*.inc` — the system-module pattern), samp-mcp auto-detects the architecture and aligns its tooling with it:

- `get_coding_standards` reports the module layout (count, categories, StartProgress, message macros, dialog & command conventions).
- `generate_boilerplate` (`type=module|job|autofarm`) emits a complete, self-contained module skeleton matching the project's own conventions (y_hooks, `hook OnGameModeInit/...`, `StartProgress`, `ErrorMsg/ServerMsg/SyntaxMsg`, `CMD:` + `flags:`), instead of generic snippets.
- `design_feature` plans propose a concrete module file (`system/<name>.inc` or `system/job/j_<name>.inc`) plus its `#include` registration in `main.pwn`, and guide implementation through the module's hooks.
- Built-in rules tell agents to put new features in modules — never gameplay logic in `main.pwn` or filterscripts.
- `study_project` self-analyzes whatever gamemode it connects to (include graph, libraries, command/dialog/message/state conventions, timer/MySQL/loop patterns) and writes a per-project `SAMP_STUDY.md` with verbatim idioms — so any environment gets docs that match its actual script.

---

## Quick Start

### 1. Configure MCP Client
Add the following to your MCP client configuration (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "samp-mcp": {
      "command": "npx",
      "args": ["-y", "samp-mcp"]
    }
  }
}
```

### 2. Connect to Project
Once initialized, tell the AI agent:
*"Connect to my SAMP server at C:\path\to\server"* (samp-mcp: `set_server_root`)

### 3. File Handling
samp-mcp exposes `file_*` tools (`file_read`, `file_write`, `file_edit`, `file_grep`, …)
that delegate to the encoding-aware **mcp-file-tools** server — it auto-detects and
preserves Windows-874 (Thai) and CRLF, so `.pwn`/`.inc` text never gets garbled.
(You can also configure mcp-file-tools directly as a separate MCP server — samp-mcp
works either way.)

To update or install the mcp-file-tools binary itself, run `update_file_tools`:
it downloads the latest GitHub release for your platform and replaces the installed
binary, keeping a backup of the previous version (`<binary>.v<old>.bak`).

### 4. Initialize AI Agent
Copy and paste this as your **first prompt** to the AI:
> "SAMP Project. Read `SAMP_RULES.md` and follow the encoding rules. Run `set_server_root` to connect samp-mcp."

---

## Tool Categories

### Server Management

| Command | Description |
|---|---|
| `set_server_root` | Initialize and track a SAMP project directory |
| `manage_server` | Start, Stop, or Restart the server process |
| `get_status` | View hostname, players, and map statistics |
| `rcon_command` | Execute RCON commands via AI |

### File Access (encoding-safe, via mcp-file-tools)

| Command | Description |
|---|---|
| `file_read` | Read a file, auto-detecting encoding (windows-874 Thai → UTF-8) |
| `file_read_many` | Read multiple files at once |
| `file_write` | Write a file back in its original encoding (CRLF preserved) |
| `file_edit` | In-place line edits with diff preview, encoding-safe |
| `file_grep` | Regex search across file contents with encoding support |
| `file_search` | Find files by glob pattern |
| `file_tree` | Project tree, optionally showing each file's encoding |
| `file_list` | List directory contents with pattern filter |
| `file_detect_encoding` | Report a file's real encoding + confidence |
| `file_convert_encoding` | Convert a file between encodings (with backup) |
| `file_info` | Get file/directory metadata |
| `file_line_endings` | Detect or convert CRLF/LF line endings |
| `file_bom` | Detect, strip, or add a BOM |
| `file_allowed_dirs` | Show directories the file backend may access |
| `file_encodings` | List all supported encodings |

### Pawn Intelligence

| Command | Description |
|---|---|
| `compile_pawn` | Compile .pwn scripts and get structured errors |
| `compile_and_load_pawn` | Compile then hot-load a script via RCON (`gmx`) |
| `generate_boilerplate` | Generate Commands, Dialogs, Job, or Admin-Command templates — admin modules emit the cmd/admin.inc style (`flags:`, `alias:`, `SendAdminMessage`, instant action) |
| `inject_code` | Compile and test snippets without server restart |

### Plugin & Include Management

| Command | Description |
|---|---|
| `search_plugin` | Search GitHub repos for SAMP plugins with release info |
| `install_plugin` | Install .dll/.so plugins — auto-extracts ZIP archives |
| `install_include` | Download and install .inc libraries from URL |

### Web & Info

| Command | Description |
|---|---|
| `web_search` | Search the web via DuckDuckGo for SAMP-related info |

### Auditing & Diagnostics

| Command | Description |
|---|---|
| `audit_script` | Scan for large arrays or hardcoded Dialog IDs |
| `audit_sql` | Detect SQL Injection risks (missing %e in mysql_format) |
| `audit_performance` | Identify fast timers or heavy OnPlayerUpdate logic |
| `find_shadowing` | Catch variable redefinitions (e.g., playerid) |
| `get_server_diagnostics` | Analyze logs for crashes and plugin failures |

### Automation

| Command | Description |
|---|---|
| `generate_docs` | Generate markdown documentation for the project |
| `create_deployment` | Batch copy all necessary server files for distribution |

### Textdraw Editor

| Command | Description |
|---|---|
| `textdraw_list` | List textdraw projects (or the textdraws of one) with stats + validation warnings |
| `textdraw_create` | Create a textdraw (full SA-MP property set, global or per-player, font 4 sprite / font 5 model preview) |
| `textdraw_update` | Patch a textdraw by id or Pawn name |
| `textdraw_delete` | Delete textdraws from a project |
| `textdraw_import` | Import textdraws from .pwn/.inc code (+ setters, `AddSimpleModel`), a samp-mcp project JSON, or a Leonardo541 TextDrawEditor project JSON |
| `textdraw_export` | Export Pawn: statements, declarations, a system-module `.inc`, markdown or JSON |
| `textdraw_preview` | Render the web preview page; `serve=true` starts the draggable live editor |
| `textdraw_preview_server` | Start / stop / status of the live preview+editor server on 127.0.0.1 |
| `model_scan` | Find `.dff` models (loose files, `models/`, VER2 `.img` archives) + their `.txd` textures and the model ids the projects use |
| `model_preview` | Render a model (id / file / name / `.img` entry) to the PNG a font 5 textdraw shows, with `rot`/`zoom`/`vehCol`/camera controls |
| `model_export` | Export a model as OBJ+MTL or glTF 2.0 with its textures as PNG |

### TXD Editor (textures)

| Command | Description |
|---|---|
| `txd_scan` | Read-only survey: scan the server for `.txd` dictionaries, list their textures and decode them to PNG for the preview page |
| `txd_open` | Open a `.txd` for editing (file, `.img` entry, or `create=true`) and list its textures; with no arguments it lists the open dictionaries |
| `txd_import_texture` | Import a PNG as a texture (format, mip levels and DXT `quality`), replacing the texture when the name exists |
| `txd_texture` | Rename / duplicate / remove / convert one texture of an open dictionary (DXT `quality` too) |
| `txd_export_texture` | Decode the dictionary's textures (unsaved edits included) to PNG files |
| `txd_save` | Write the dictionary to its file (`.bak` kept), to a new `.txd`, or into its VER2 `.img` entry; `discard=true` drops the edits |

### Meta

| Command | Description |
|---|---|
| `check_for_updates` | Check if a new version of SAMP-MCP is available on NPM |
| `update_mcp_server` | Perform a self-update of the server via NPM |
| `update_file_tools` | Update/install the mcp-file-tools binary from GitHub (with backup) |

---

## Features

- **SAMP Server Operations** — query (status/players/rules/dashboard), RCON, player actions, process management
- **Pawn Intelligence** — pawncc compile with structured errors, audits (SQL / performance / shadowing), include checks, log diagnostics
- **Encoding-Safe File Access** — built-in `file_read`/`file_write`/`file_edit`/`file_grep`/… tools delegate to `mcp-file-tools`, which auto-detects Windows-874 (Thai) and preserves CRLF
- **Textdraw Editor** — textdraw projects (JSON), txd sprite decoding, DFF model rendering (loose `.dff`/`.txd`, `.img` archives), web preview page + live drag-and-save editor with model orbiting, Pawn import/export
- **TXD Editor** — read, build and edit RenderWare texture dictionaries like Magic.TXD does: import PNGs as textures (8888/888/565/555/4444/LUM8/DXT1/DXT3/DXT5, mip chains, squish-style DXT compression at `quality: high`), rename/duplicate/remove/convert, export PNGs, and save back to the `.txd` or into its VER2 `.img` entry — untouched textures stay byte for byte
- **Plugin Auto-Install** — GitHub release discovery with ZIP auto-extraction
- **Web Search** — DuckDuckGo integration for SAMP-related queries
- **Caching** — Project info cached for 5 minutes to reduce token usage
- **AI-Powered** — Designed for seamless integration with LLMs

---

## Development

```sh
npm install        # includes dev tooling (eslint, typescript-eslint, ts-prune)
npm run check      # lint + dead-code checks + build + model/txd/textdraw tests (also runs before publish)
```

Smoke test / demo of the textdraw editor (writes a throwaway project + synthetic `.txd` under `.freebuff/textdraw-demo`):

```sh
npm run demo:textdraw
```

Smoke test of the model pipeline (builds a cube `.dff`/`.txd`/`.img` from the RenderWare spec, then parses, renders, exports and previews it — 33 checks, under `.freebuff/model-demo`):

```sh
npm run test:model
```

Test of the TXD **writer and editor** (round-trips every raster format, checks the mip layout against the sizes the formats imply, rebuilds real GTA: SA dictionaries from their own pixels byte for byte, then drives the editor through import/convert/rename/duplicate/remove/export/save and a `.img` write — 90 checks, under `.freebuff/txd-demo`; the real-file part needs `D:/GTASAN Muntiplayer` or `SAMP_TXD_SAMPLE_DIR` and is skipped without it):

```sh
npm run test:txd
```

PSNR benchmark of the DXT encoders — `quality: high` against `quality: fast` against a brute-effort reference encoder, on synthetic images plus textures decoded out of the game's dictionaries (74 checks, ~1s):

```sh
npm run test:txd-quality
```

End-to-end test of the textdraw and TXD **MCP tools** — it starts the real stdio server and calls them the way an agent does, so tool names, argument schemas and result shapes are covered too (part of `npm run check`):

```sh
npm run test:textdraw
```

Individual gates:

| Script | Purpose |
|---|---|
| `npm run lint` | ESLint — unused imports/vars/args, unused expressions, syntax duplicates |
| `npm run deadcode` | Flags class methods that are never referenced by any MCP tool or other code (`scripts/check-dead-methods.mjs`) |
| `npm run prune` | `ts-prune` — unused exports |
| `npm run build` | `tsc` with `noUnusedLocals`/`noUnusedParameters`, which also reject unused imports, locals and private members |

### Releasing

`npm publish` runs `npm run check` first (`prepublishOnly`), so a red gate blocks the release.
`.github/workflows/publish.yml` publishes to GitHub Packages on any of these triggers:

```sh
npm version 1.3.1 --no-git-tag-version && git commit -am "chore: release v1.3.1"
git push origin main
git tag v1.3.1 && git push origin v1.3.1   # tag push -> workflow publishes
```

Publishing a GitHub Release, or running the workflow manually (`workflow_dispatch`), does the same thing.

---

## License

MIT © Watcharapong Namsaeng
