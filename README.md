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
*"Connect to my SAMP server at C:\path\to\server"*

### 3. Initialize AI Agent
Copy and paste this as your **first prompt** to the AI:
> "SAMP Project. Read `SAMP_RULES.md` and follow encoding rules. Run `set_server_root` to start."

---

## Tool Categories

### Server Management

| Command | Description |
|---|---|
| `set_server_root` | Initialize and track a SAMP project directory |
| `manage_server` | Start, Stop, or Restart the server process |
| `get_status` | View hostname, players, and map statistics |
| `rcon_command` | Execute RCON commands via AI |

### Pawn Scripting

| Command | Description |
|---|---|
| `read_pawn_script` | Read source with encoding detection + line ranges |
| `write_pawn_script` | Write source with backup + partial line replacement |
| `search_pawn_script` | Search text across all .pwn/.inc files (efficient) |
| `fuzzy_find_file` | Find files by partial name when you forgot the path |
| `get_function_body` | Extract a single function body without reading whole file |
| `compile_pawn` | Compile .pwn scripts and get structured errors |
| `restore_pawn_script` | Restore a file from its latest backup (undo) |
| `fix_script_encoding` | Recover corrupted UTF-8 Thai scripts to Windows-874 |
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

- **Thai Character Support** — Native Windows-874 encoding with UTF-8 corruption recovery
- **Safe Editing** — Automatic backups + partial line range replacement (no truncation bugs)
- **Efficient Search** — Search across all scripts, fuzzy file find, extract single functions
- **Plugin Auto-Install** — GitHub release discovery with ZIP auto-extraction
- **Web Search** — DuckDuckGo integration for SAMP-related queries
- **Caching** — Project info cached for 5 minutes to reduce token usage
- **AI-Powered** — Designed for seamless integration with LLMs

---

## License

MIT © Watcharapong Namsaeng
