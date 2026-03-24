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
| `compile_pawn` | Compile .pwn scripts and get structured errors |
| `read_pawn_script` | Read source with Windows-874 (Thai) support |
| `write_pawn_script` | Write source maintaining correct encoding |
| `generate_boilerplate` | Generate Commands, Dialogs, or Job templates |
| `inject_code` | Compile and test snippets without server restart |

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
| `install_include` | Download and install .inc libraries from URL |
| `install_plugin` | Install .dll/.so plugins and update server.cfg |
| `generate_docs` | Generate markdown documentation for the project |
| `create_deployment` | Batch copy all necessary server files for distribution |

### Meta

| Command | Description |
|---|---|
| `check_for_updates` | Check if a new version of SAMP-MCP is available on NPM |
| `update_mcp_server` | Perform a self-update of the server via NPM |

---

## Features

- **Thai Character Support** — Native Windows-874 encoding for scripts
- **Library Discovery** — Find "Gold Standard" SAMP tools on GitHub
- **Real-time Monitoring** — Integrated dashboard for server health
- **AI-Powered** — Designed for seamless integration with LLMs

---

## License

MIT © Watcharapong Namsaeng
