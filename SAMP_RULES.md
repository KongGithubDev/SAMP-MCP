# SAMP Project Rules (Universal)
For Windsurf, Cursor, Antigravity, and all AI agents:

1. **ENCODING**: This project uses **Thai (Windows-874)** (or the auto-detected encoding of each file).
   - Use encoding-aware file tools (e.g., mcp-file-tools) for ALL file reads/writes/edits so Thai (Windows-874) and CRLF line endings are preserved.
   - samp-mcp is for SAMP server operations only (status/RCON/compile/audits) — it does not edit script files.

2. **LANGUAGE PRESERVATION**:
   - DO NOT translate strings. Maintain the original project language.

3. **COMPILATION**:
   - Verify script changes with 'compile_pawn' / 'compile_and_load_pawn'.

4. **PLANNING**:
   - Use 'design_feature' before implementing new systems; WAIT for user confirmation; then 'review_implementation'.

If Thai ever shows garbled, stop and verify the file's encoding with an encoding-aware tool before writing.

**TEXTDRAW UI (textdraw editor)**:
   - Design HUD/UI textdraws with samp-mcp's textdraw tools (textdraw_create / textdraw_update keep them in a project under .samp-mcp/textdraws) instead of hand-writing coordinates.
   - LOOK at the result before compiling: textdraw_preview renders the web page (serve=true = draggable live editor that saves back to the project; textdraw_import pulls in existing TextDrawCreate code).
   - Font 4 sprites use text in the form "txdname:texturename" — run txd_scan so the preview can show the decoded .txd texture; font 5 model previews use previewModel (+ AddSimpleModel for custom 0.3.DL UI textures/models).
   - Font 5 (3D) previews show the real model: model_scan finds the .dff/.txd (loose files, models/, or a VER2 .img archive), model_preview renders it to the PNG the textdraw shows, and drag/wheel on a model in the live preview orbits+zooms it (previewRot/previewZoom, TextDrawSetPreviewRot semantics). Use model_export (OBJ/glTF) when the mesh itself needs to be inspected or edited.
   - Custom textures are authored with the TXD editor: txd_open a .txd (file, or a dictionary inside a .img), txd_import_texture turns a PNG into a texture (8888 lossless or DXT1/DXT3/DXT5/565/4444 compressed, with mip maps; DXT encodes with quality=high — cluster fit + least-squares endpoint refinement — unless fast is asked for), txd_texture renames/duplicates/removes/converts, txd_export_texture writes PNGs back out and txd_save writes the dictionary (with a .bak, or into the .img entry). Textures the editor does not touch are written back byte for byte.
   - Designing from artwork (a UI mockup or PNG) before any .txd exists: drop the bitmap at .samp-mcp/textdraw-assets/sprites/<txdname>__<texturename>.png and the preview draws it as a stand-in — the game still needs the same texture shipped inside <txdname>.txd, so keep the px → 640x448 grid maths reproducible (the sheet fits the height: scale = 448/sheetHeight, then x_offset = (640 - width*scale)/2).
   - Emit the final code with textdraw_export (mode=module produces a system-module .inc with hooks and show/hide stocks).

5. **ARCHITECTURE (module pattern, when detected)**:
   - Module-based projects build every feature as ONE self-contained module: `gamemodes/includes/system/<name>.inc` (jobs go to `system/job/j_<name>.inc`).
   - The module owns its state/hooks/commands/dialogs: `#include <YSI_Coding\y_hooks>`, then `hook OnGameModeInit` / `OnPlayerConnect` / `OnPlayerDisconnect` / `OnPlayerKeyStateChange`.
   - Register new modules in `gamemodes/main.pwn`: `#include "includes/system/<name>.inc"`.
   - Timed actions: `StartProgress(...)` + reward in `hook OnProgressFinish` guarded by a module state flag.
   - Messages: `ErrorMsg` / `ServerMsg` / `SyntaxMsg`. Per-player state: `PlayerInfo[playerid][pX]` or static `[MAX_PLAYERS]` arrays.
   - Never add gameplay logic to `main.pwn` and never create filterscripts for new features.
   - Commands: Pawn.CMD (`CMD:name` + `flags:name(CMD_xxx)` for permissions). Dialogs: easyDialog (`Dialog_Show` + `Dialog:NAME` handlers).
   - PERFORMANCE: iterate players with `foreach(new i : Player)` — never `for (i < MAX_PLAYERS)`; use YSI timers (`timer X[1000]` / `repeat`) and stop them on disconnect; all MySQL via `mysql_format` + `mysql_tquery` (cache_* in the callback), never blocking queries; world objects/3D labels are Streamer dynamic; keep `OnPlayerUpdate` and fast per-player callbacks light.
