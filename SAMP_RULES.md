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

5. **ARCHITECTURE (module pattern, when detected)**:
   - Module-based projects build every feature as ONE self-contained module: `gamemodes/includes/system/<name>.inc` (jobs go to `system/job/j_<name>.inc`).
   - The module owns its state/hooks/commands/dialogs: `#include <YSI_Coding\y_hooks>`, then `hook OnGameModeInit` / `OnPlayerConnect` / `OnPlayerDisconnect` / `OnPlayerKeyStateChange`.
   - Register new modules in `gamemodes/main.pwn`: `#include "includes/system/<name>.inc"`.
   - Timed actions: `StartProgress(...)` + reward in `hook OnProgressFinish` guarded by a module state flag.
   - Messages: `ErrorMsg` / `ServerMsg` / `SyntaxMsg`. Per-player state: `PlayerInfo[playerid][pX]` or static `[MAX_PLAYERS]` arrays.
   - Never add gameplay logic to `main.pwn` and never create filterscripts for new features.
   - Commands: Pawn.CMD (`CMD:name` + `flags:name(CMD_xxx)` for permissions). Dialogs: easyDialog (`Dialog_Show` + `Dialog:NAME` handlers).
   - PERFORMANCE: iterate players with `foreach(new i : Player)` — never `for (i < MAX_PLAYERS)`; use YSI timers (`timer X[1000]` / `repeat`) and stop them on disconnect; all MySQL via `mysql_format` + `mysql_tquery` (cache_* in the callback), never blocking queries; world objects/3D labels are Streamer dynamic; keep `OnPlayerUpdate` and fast per-player callbacks light.
