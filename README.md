<div align="center">

# samp-mcp

**A comprehensive MCP server for SA-MP server development and management**

[![npm version](https://img.shields.io/npm/v/samp-mcp.svg)](https://www.npmjs.com/package/samp-mcp)
[![npm downloads](https://img.shields.io/npm/dm/samp-mcp.svg)](https://www.npmjs.com/package/samp-mcp)
[![license](https://img.shields.io/npm/l/samp-mcp.svg)](LICENSE)

Manage, script, and audit SA-MP servers with AI assistance.

</div>

---

## Installation

```sh
npm install -g samp-mcp
# or
yarn global add samp-mcp
```

Requires **Node.js ≥ 18** and a functional **SA-MP server** directory.

---

## Module-aware design

For projects that organize code as system modules (e.g. `gamemodes/includes/system/*.inc` — the CareerCity pattern), samp-mcp auto-detects the architecture and aligns its tooling with it:

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
samp-mcp deliberately does **not** read or write script files. Use an encoding-aware
file server such as **mcp-file-tools** for all file work — it auto-detects and preserves
Windows-874 (Thai) and CRLF, so `.pwn`/`.inc` text never gets garbled.

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

### Pawn Intelligence

| Command | Description |
|---|---|
| `compile_pawn` | Compile .pwn scripts and get structured errors |
| `compile_and_load_pawn` | Compile then hot-load a script via RCON (`gmx`) |
| `generate_boilerplate` | Generate Commands, Dialogs, or Job templates |
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

### Meta

| Command | Description |
|---|---|
| `check_for_updates` | Check if a new version of SAMP-MCP is available on NPM |
| `update_mcp_server` | Perform a self-update of the server via NPM |

---

## Features

- **SAMP Server Operations** — query (status/players/rules/dashboard), RCON, player actions, process management
- **Pawn Intelligence** — pawncc compile with structured errors, audits (SQL / performance / shadowing), include checks, log diagnostics
- **Works With Encoding-Aware File Tools** — file reads/writes/edits are delegated to `mcp-file-tools`, which auto-detects Windows-874 (Thai) and preserves CRLF
- **Plugin Auto-Install** — GitHub release discovery with ZIP auto-extraction
- **Web Search** — DuckDuckGo integration for SAMP-related queries
- **Caching** — Project info cached for 5 minutes to reduce token usage
- **AI-Powered** — Designed for seamless integration with LLMs

---

## Development

```sh
npm install        # includes dev tooling (eslint, typescript-eslint, ts-prune)
npm run check      # lint + dead-code checks + build (also runs before publish)
```

Individual gates:

| Script | Purpose |
|---|---|
| `npm run lint` | ESLint — unused imports/vars/args, unused expressions, syntax duplicates |
| `npm run deadcode` | Flags class methods that are never referenced by any MCP tool or other code (`scripts/check-dead-methods.mjs`) |
| `npm run prune` | `ts-prune` — unused exports |
| `npm run build` | `tsc` with `noUnusedLocals`/`noUnusedParameters`, which also reject unused imports, locals and private members |

---

## License

MIT © Watcharapong Namsaeng
