#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import { readFile } from 'fs/promises';
import { SampClient } from './client.js';
import { PawnManager } from './scripts.js';

// dotenv quiet mode keeps JSON-RPC on stdout clean
process.env.DOTENV_CONFIG_QUIET = 'true';
dotenv.config({ quiet: true });

const APP_VERSION = "1.0.11";

const server = new McpServer({
  name: "samp-mcp-server",
  version: APP_VERSION
});

let client: SampClient | null = null;
const pawn = new PawnManager();

// Resources for persistent context
server.resource(
  "guidelines",
  "samp://guidelines",
  async (uri) => ({
    contents: [{
      uri: uri.href,
      text: await pawn.getFormattedGuidelines()
    }]
  })
);

server.resource(
  "project-info",
  "samp://project-info",
  async (uri) => {
    const p = await pawn.detectPatterns();
    return {
      contents: [{
        uri: uri.href,
        text: JSON.stringify(p, null, 2)
      }]
    };
  }
);

async function updateConnection(root: string, hostOverride?: string, portOverride?: number, passOverride?: string) {
    const detected = await pawn.detectFromRoot(root);
    const host = hostOverride || detected.host || '127.0.0.1';
    const port = portOverride || detected.port;
    const password = passOverride || detected.password;
    
    client?.close(); // close previous socket before replacing
    client = new SampClient(host, port, password);
    console.error(`Connected to SAMP server at: ${root} (Host: ${host}, Port: ${port})`);
    return { root, port, password };
}

async function getTempClient(address?: string): Promise<SampClient> {
    if (address) {
        const [host, portStr] = address.split(':');
        const port = portStr ? parseInt(portStr, 10) : 7777;
        return new SampClient(host, port);
    }
    ensureRoot();
    return client!;
}

// Run a query against the project client or a temp client (closed afterwards to avoid socket leaks)
async function queryClient<T>(address: string | undefined, fn: (c: SampClient) => Promise<T>): Promise<T> {
    const c = await getTempClient(address);
    try {
        return await fn(c);
    } finally {
        if (address) c.close();
    }
}

// Tool: Set Server Root (THE NEW CORE TOOL)
server.tool(
  "set_server_root",
  "Point the MCP server to a SAMP project directory. Automatically detects config and tracks the project.",
  { 
    path: z.string().describe("Absolute path to the SAMP server root directory"),
    host: z.string().optional().describe("Override server IP (defaults to bind in server.cfg or 127.0.0.1)")
  },
  async ({ path, host }) => {
    try {
      const info = await updateConnection(path, host);
      const p = await pawn.detectPatterns();
      const rules = await pawn.getFormattedGuidelines();
      
      return {
        content: [{ 
          type: "text", 
          text: `Successfully connected to ${path}. Host: ${client?.host}, Port: ${info.port}.${p.hasSystemModules ? `\nArchitecture: module-based system (${p.systemModuleCount} modules under gamemodes/includes/system). Design new features as ONE self-contained .inc module there and register it in main.pwn — never as filterscripts.` : ''}\n\nSYSTEM RULES FOR THIS PROJECT (MANDATORY):\n${rules}\n\nAI AGENT: Follow these rules. samp-mcp is for SAMP server operations (query/RCON/compile/audit); all file read/write/edit must go through encoding-aware file tools (e.g., mcp-file-tools) so Windows-874 Thai and CRLF line endings are preserved.` 
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Failed to connect: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Helper to check if root is set
const ensureRoot = () => {
    if (!pawn.serverRoot) {
        throw new Error("No SAMP server root set. Use 'set_server_root' first.");
    }
};

// Tool: RCON Command
server.tool(
  "rcon_command",
  "Execute a command on the SAMP server via RCON",
  { command: z.string().describe("The command to execute (e.g., 'say hello')") },
  async ({ command }) => {
    try {
      ensureRoot();
      const resp = await client!.executeRcon(command);
      return {
        content: [{ type: "text", text: resp.join('\n') || "Command sent." }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Get Server Status
server.tool(
  "get_status",
  "Get current server statistics (hostname, players, map, etc.)",
  { address: z.string().optional().describe("Optional host:port to query instead of the project server") },
  async ({ address }) => {
    try {
      const stats = await queryClient(address, (c) => c.getInfo());
      return {
        content: [{ type: "text", text: JSON.stringify(stats, null, 2) }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Get Players
server.tool(
  "get_players",
  "Get the current list of players (ID, Name, Score, Ping)",
  { address: z.string().optional().describe("Optional host:port to query instead of the project server") },
  async ({ address }) => {
    try {
      const players = await queryClient(address, (c) => c.getPlayers());
      return {
        content: [{ type: "text", text: JSON.stringify(players, null, 2) }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Get Server Rules
server.tool(
  "get_rules",
  "Get current server rules (gravity, weather, version, etc.)",
  { address: z.string().optional().describe("Optional host:port to query instead of the project server") },
  async ({ address }) => {
    try {
      const rules = await queryClient(address, (c) => c.getRules());
      return {
        content: [{ type: "text", text: JSON.stringify(rules, null, 2) }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Compile and Load Pawn Script
server.tool(
  "compile_and_load_pawn",
  "Compile a Pawn script and attempt to load it into the server. This will restart the server.",
  { scriptPath: z.string().describe("Path to the .pwn script file to compile and load") },
  async ({ scriptPath }) => {
    try {
      ensureRoot();
      // Compile
      const result = await pawn.compilePawn(scriptPath);
      if (!result.success) {
        return {
          content: [{ type: "text", text: `Compilation failed:\n${JSON.stringify(result.errors, null, 2)}` }],
          isError: true
        };
      }
      
      // Load via RCON (e.g., by restarting the server or using loadfs if available)
      // For simplicity, we'll assume a server restart is needed to load new gamemodes/filterscripts.
      // A more advanced implementation might use 'loadfs' or 'gmx' if the script is a filterscript/gamemode.
      await client!.executeRcon('gmx'); // Restart gamemode
      
      return {
        content: [{ type: "text", text: `Script '${scriptPath}' compiled successfully. Server restarted to load changes.` }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error during compile/load: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Get Server Diagnostics
server.tool(
  "get_server_diagnostics",
  "Analyze server logs for common issues (Crash signatures, Plugin load failures, etc.)",
  {},
  async () => {
    try {
      ensureRoot();
      const errors = await pawn.searchServerLog("Error", 200);
      const crashes = await pawn.searchServerLog("Crash", 200);
      const failedPlugins = await pawn.searchServerLog("Failed", 200);
      
      const summary = {
        errorsFound: errors.length,
        potentialCrashes: crashes.length,
        pluginFailures: failedPlugins.length,
        recentIssues: [...errors, ...crashes, ...failedPlugins].slice(-10)
      };

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Compile PAWN
server.tool(
  "compile_pawn",
  "Compile a .pwn script using pawncc.exe. Returns structured error/warning list.",
  { path: z.string().describe("Path to the .pwn file to compile") },
  async ({ path }) => {
    try {
      ensureRoot();
      const result = await pawn.compilePawn(path);
      return {
        content: [
          { type: "text", text: result.output },
          { type: "text", text: result.errors.length > 0 ? `Structured Errors:\n${JSON.stringify(result.errors, null, 2)}` : "No structured errors found." }
        ]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Generate Boilerplate
server.tool(
  "generate_boilerplate",
  "Generate SAMP code snippets / system-module skeletons that match the connected project architecture (CareerCity-style includes/system modules when detected). Use type 'module' for a full feature module, 'job'/'autofarm' for those module kinds, or 'command'/'dialog' for small blocks. DO NOT TRANSLATE generated Thai strings.",
  { 
    type: z.enum(["command", "dialog", "module", "job", "autofarm"]).describe("Type of snippet to generate (module/job/autofarm produce full system-module skeletons)"),
    name: z.string().describe("Name of the command/dialog/job/item")
  },
  async ({ type, name }) => {
    ensureRoot();
    const p = await pawn.detectPatterns();
    const moduleMode = !!p.hasSystemModules;
    let snippet = "";

    if (moduleMode && (type === "module" || type === "job" || type === "autofarm")) {
      snippet = await pawn.moduleSkeleton(name, type);
    } else if (type === "module") {
      snippet = `// ${name}\n// Classic project (no gamemodes/includes/system): full-module boilerplate only applies to\n// CareerCity-style module projects. Use type command/dialog/job/autofarm instead.`;
    } else if (type === "command") {
      if (!moduleMode && p.hasPawnCMD) {
        snippet = `PCMD:${name}(playerid, params[])\n{\n    // Pawn.CMD style\n    return 1;\n}`;
      } else {
        snippet = `CMD:${name}(playerid, params[])\n{\n    // ${moduleMode ? 'Command inside its system module' : 'ZCMD style'}\n    return 1;\n}`;
      }
    } else if (type === "dialog") {
      snippet = `Dialog:DIALOG_${name.toUpperCase()}(playerid, response, listitem, inputtext[])\n{\n    if (response)\n    {\n        // Handle response\n    }\n    return 1;\n}`;
    } else if (type === "job" || type === "autofarm") {
      snippet = `// ${name}\n${p.hasYSI ? 'hook ' : ''}OnPlayerKeyStateChange(playerid, newkeys, oldkeys)\n{\n    if (newkeys & KEY_NO)\n    {\n        // Add ${name} logic here\n    }\n    return 1;\n}`;
    }

    const slug = name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    const isModuleKind = moduleMode && (type === "module" || type === "job" || type === "autofarm");
    const hint = isModuleKind
      ? `\n\n// Put at: gamemodes/includes/${type === 'job' ? `system/job/j_${slug}.inc` : `system/${slug}.inc`}\n// Register in gamemodes/main.pwn: #include "includes/system/${type === 'job' ? `job/j_${slug}.inc` : `${slug}.inc`}"`
      : '';

    return {
      content: [{ type: "text", text: snippet + hint }]
    };
  }
);

// Tool: Get Coding Standards
server.tool(
  "get_coding_standards",
  "Get the coding standards and patterns for the currently connected SAMP project.",
  {},
  async () => {
    ensureRoot();
    const p = await pawn.detectPatterns();
    
    let guide = `
# SAMP Project Coding Standards (Auto-Detected)

- **SAMP Wiki**: https://sampwiki.blast.hk/wiki/Main_Page
- **Essential Libraries**: Use \`get_essential_libraries\` to see recommended plugins/includes from GitHub.
- **Target Version**: ${p.version}
- **Project Type**: ${p.hasSampctl ? 'sampctl' : 'Standard Folder'}

## detected Libraries & Preferences:
- **Command Processor**: ${p.hasPawnCMD ? 'Pawn.CMD (use PCMD:name)' : (p.hasZCMD ? 'ZCMD (use CMD:name)' : 'Unknown')}
- **Callback Hooks**: ${p.hasYSI ? 'YSI Hooks (use hook OnPlayer...)' : 'Standard Callbacks'}
- **Database**: ${p.hasMySQL ? 'MySQL detected' : 'No MySQL detected'}
- **Streamer**: ${p.hasStreamer ? 'Streamer Plugin detected' : 'No Streamer detected'}
- **Architecture**: ${p.hasSystemModules ? `System Modules (${p.systemModuleCount} modules under gamemodes/includes/system)` : 'Monolithic / Classic'}

## Standards:
1. **Encoding**: Files use Thai (windows-874) / auto-detected encodings. Use encoding-aware file tools (e.g., mcp-file-tools) for ALL .pwn and .inc file reads/writes/edits.
2. **Boilerplate**: Use \`generate_boilerplate\` to get the correct structure for this project.
`;

    if (p.hasYSI) {
      guide += `\n- **Note**: This project uses YSI. Always include <YSI_Coding\\y_hooks> when creating new modules.\n`;
    }

    if (p.hasSystemModules) {
      guide += `\n## Adding a New System (module pattern)\n- Create ONE self-contained module: gamemodes/includes/system/<name>.inc (jobs -> system/job/j_<name>.inc).\n- The module owns its state/hooks/commands/dialogs: start with #include <YSI_Coding\\y_hooks>, then hook OnGameModeInit / OnPlayerConnect / OnPlayerDisconnect / OnPlayerKeyStateChange.\n- Register it in gamemodes/main.pwn: #include "includes/system/<name>.inc".\n- Timed actions: StartProgress(...) then reward inside hook OnProgressFinish guarded by the module's state flag.\n- Messages: ErrorMsg / ServerMsg / SyntaxMsg. Per-player state: PlayerInfo[playerid][pX] or static arrays.\n- Use generate_boilerplate (type=module/job/autofarm) and design_feature to get matching module-aware output.\n`;
    }

    return {
      content: [{ type: "text", text: guide }]
    };
  }
);

// Tool: Get Essential Libraries
server.tool(
  "get_essential_libraries",
  "Get a list of high-quality, popular SA-MP libraries and plugins from GitHub topics.",
  {},
  async () => {
    const list = `
# Popular SA-MP Libraries (GitHub)

1. **sampctl** (https://github.com/Southclaws/sampctl) - Modern package management for SAMP.
2. **YSI-Includes** (https://github.com/pawn-lang/YSI-Includes) - The most powerful library for SAMP (Hooks, Timers, etc.).
3. **Pawn.CMD** (https://github.com/urShadow/Pawn.CMD) - High-performance command processor.
4. **sscanf** (https://github.com/maddinat0r/sscanf) - Essential for parsing strings/params.
5. **SA-MP MySQL** (https://github.com/pBlueG/SA-MP-MySQL) - Standard MySQL integration.
6. **Streamer Plugin** (https://github.com/samp-incognito/samp-streamer-plugin) - Essential for breaking object/label limits.
7. **CrashDetect** (https://github.com/Zeex/samp-plugin-crashdetect) - CRITICAL for debugging server crashes.
8. **Pawn.Regex** (https://github.com/urShadow/Pawn.Regex) - Fast regular expressions.
9. **easyDialog** (https://github.com/Awsomedude/easyDialog) - Simplified dialog management.
`;
    return {
      content: [{ type: "text", text: list }]
    };
  }
);

// Tool: Inspect Project
server.tool(
  "inspect_project",
  "Get a summary of the project size, line counts, and estimated command/dialog counts.",
  {},
  async () => {
    try {
      ensureRoot();
      const stats = await pawn.inspectProject();
      return {
        content: [{ type: "text", text: JSON.stringify(stats, null, 2) }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Audit Script
server.tool(
  "audit_script",
  "Scan a .pwn or .inc script for potential issues (Large arrays, Hardcoded IDs, etc.)",
  { path: z.string().describe("Path to the script file to audit") },
  async ({ path }) => {
    try {
      ensureRoot();
      const issues = await pawn.auditScript(path);
      return {
        content: [{ type: "text", text: issues.length > 0 ? JSON.stringify(issues, null, 2) : "No issues detected." }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Player Action (RCON Quick)
server.tool(
  "player_action",
  "Perform a quick RCON action on a player (kick, ban, mute)",
  { 
    action: z.enum(["kick", "ban", "mute"]).describe("Action to perform"),
    player: z.string().describe("Player ID or Name")
  },
  async ({ action, player }) => {
    try {
      ensureRoot();
      let cmd = "";
      if (action === "kick") cmd = `kick ${player}`;
      else if (action === "ban") cmd = `ban ${player}`;
      else if (action === "mute") cmd = `mute ${player}`;
      
      const resp = await client!.executeRcon(cmd);
      return {
        content: [{ type: "text", text: resp.join('\n') || `Action ${action} sent for player ${player}.` }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Generate Docs
server.tool(
  "generate_docs",
  "Generate a markdown summary of all commands and dialogs in the project.",
  {},
  async () => {
    try {
      ensureRoot();
      const docs = await pawn.generateDocs();
      return {
        content: [{ type: "text", text: docs }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Study Project (self-analyzing gamemode docs)
server.tool(
  "study_project",
  "Deep-study the connected gamemode itself: parses the main script include graph, detects libraries, command/dialog/message/state conventions, timer & MySQL & loop patterns, captures verbatim code idioms, and writes a per-project markdown study (SAMP_STUDY.md in the server root). Generic — works for any gamemode environment. Re-run to regenerate.",
  {},
  async () => {
    try {
      ensureRoot();
      const outPath = await pawn.studyProject();
      const fs = await import('fs');
      const content = fs.readFileSync(outPath, 'utf8');
      return {
        content: [
          { type: "text", text: `Study written to: ${outPath}` },
          { type: "text", text: content.length > 9000 ? content.slice(0, 9000) + "\n... (truncated — full study at " + outPath + ")" : content }
        ]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Check Includes
server.tool(
  "check_includes",
  "Scan the project for #include statements that point to missing files.",
  {},
  async () => {
    try {
      ensureRoot();
      const missing = await pawn.checkIncludes();
      return {
        content: [{ type: "text", text: missing.length > 0 ? JSON.stringify(missing, null, 2) : "All includes are present." }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Find Shadowing
server.tool(
  "find_shadowing",
  "Scan a script for potential variable shadowing (e.g., redefining playerid).",
  { path: z.string().describe("Path to the script file") },
  async ({ path }) => {
    try {
      ensureRoot();
      const issues = await pawn.findShadowing(path);
      return {
        content: [{ type: "text", text: issues.length > 0 ? JSON.stringify(issues, null, 2) : "No shadowing detected." }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);
// Tool: Inject Code
server.tool(
  "inject_code",
  "Create a temporary Filterscript with the given code and compile it (Hot Injection).",
  { code: z.string().describe("Pawn code to inject into OnFilterScriptInit") },
  async ({ code }) => {
    try {
      ensureRoot();
      const msg = await pawn.injectCode(code);
      let extra = "";
      if (client?.password) {
        const resp = await client.executeRcon('loadfs mcp_test');
        extra = resp.join('\n') ? `\nloadfs result: ${resp.join('\n')}` : '\nFilterScript loaded via RCON (loadfs mcp_test).';
      }
      return {
        content: [{ type: "text", text: msg + extra }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Audit SQL
server.tool(
  "audit_sql",
  "Scan a script for potential SQL Injection risks (missing %e in mysql_format).",
  { path: z.string().describe("Path to the script file") },
  async ({ path }) => {
    try {
      ensureRoot();
      const issues = await pawn.auditSql(path);
      return {
        content: [{ type: "text", text: issues.length > 0 ? JSON.stringify(issues, null, 2) : "No SQL risks detected." }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Create Deployment
server.tool(
  "create_deployment",
  "Batch copy all necessary server files (AMX, Plugins, CFG) to a distribution folder.",
  { outputDir: z.string().describe("Target folder for the deployment package") },
  async ({ outputDir }) => {
    try {
      ensureRoot();
      const msg = await pawn.createDeployment(outputDir);
      return {
        content: [{ type: "text", text: msg }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Get Snippet
server.tool(
  "get_snippet",
  "Get a common SAMP code snippet for various systems (MySQL, Login, Vehicle, etc.)",
  { category: z.enum(["mysql_login", "vehicle_system", "inventory_base", "admin_cmd"]).describe("Category of snippet") },
  async ({ category }) => {
    let snippet = "";
    if (category === "mysql_login") {
        snippet = `// Basic MySQL Login/Register Pattern\n#include <a_mysql>\n\n#define MYSQL_HOST "127.0.0.1"\n#define MYSQL_USER "root"\n#define MYSQL_PASS ""\n#define MYSQL_DB   "samp"\n\nnew MySQL:dbHandle;\n\nhook OnGameModeInit()\n{\n    dbHandle = mysql_connect(MYSQL_HOST, MYSQL_USER, MYSQL_PASS, MYSQL_DB);\n    if (mysql_errno(dbHandle) != 0) print("MySQL Connection Failed.");\n    return 1;\n}`;
    } else if (category === "vehicle_system") {
        snippet = `// Simple Vehicle Spawn Command\nCMD:v(playerid, params[])\n{\n    new modelid, color1, color2;\n    if (sscanf(params, "ddd", modelid, color1, color2)) return SendClientMessage(playerid, -1, "Usage: /v [modelid] [color1] [color2]");\n    \n    new Float:x, Float:y, Float:z, Float:a;\n    GetPlayerPos(playerid, x, y, z);\n    GetPlayerFacingAngle(playerid, a);\n    \n    new veh = CreateVehicle(modelid, x, y, z, a, color1, color2, -1);\n    PutPlayerInVehicle(playerid, veh, 0);\n    return 1;\n}`;
    } else if (category === "inventory_base") {
        snippet = `// Simple Inventory Struct\nenum E_PLAYER_INV {\n    invItem[20],\n    invAmount[20]\n}\nnew PlayerInv[MAX_PLAYERS][E_PLAYER_INV];\n\nstock Inventory_Add(playerid, itemid, amount)\n{\n    // Logic to add item here\n    return 1;\n}`;
    } else if (category === "admin_cmd") {
        snippet = `// Admin Check Pattern\n#define IsPlayerAdmin(%0) (PlayerInfo[%0][pAdmin] >= 1)\n\nCMD:kick(playerid, params[])\n{\n    if (!IsPlayerAdmin(playerid)) return 0;\n    // Kick logic\n    return 1;\n}`;
    }
    return {
      content: [{ type: "text", text: snippet }]
    };
  }
);



// Tool: Install Plugin
server.tool(
  "install_plugin",
  "Download and install a SAMP plugin (.dll/.so) and update server.cfg. Supports GitHub repos (e.g. 'IS4Code/YSF') or direct download URLs.",
  { 
    url: z.string().describe("GitHub repo (e.g. 'IS4Code/YSF') or direct download URL"),
    name: z.string().describe("The plugin name (e.g. 'streamer', 'YSF')")
  },
  async ({ url, name }) => {
    try {
      ensureRoot();
      const msg = await pawn.installPlugin(url, name);
      return {
        content: [{ type: "text", text: msg }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Search Plugin
server.tool(
  "search_plugin",
  "Search for SAMP plugins on GitHub by name. Returns repos and available release binaries.",
  { name: z.string().describe("Plugin name to search (e.g. 'YSF', 'streamer', 'mysql')") },
  async ({ name }) => {
    try {
      ensureRoot();
      const msg = await pawn.searchPlugin(name);
      return {
        content: [{ type: "text", text: msg }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Web Search
server.tool(
  "web_search",
  "Search the web for general information. Useful for answering questions about SA-MP versions, plugins, game mechanics, etc.",
  {
    query: z.string().describe("Search query (e.g. 'SAMP 0.3.7DL review', 'best SAMP plugins 2024')"),
    domain: z.string().optional().describe("Optional: restrict search to a specific domain (e.g. 'sa-mp.com')")
  },
  async ({ query, domain }) => {
    try {
      const msg = await pawn.webSearch(query, domain);
      return {
        content: [{ type: "text", text: msg }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Audit Performance
server.tool(
  "audit_performance",
  "Scan a script for potential performance issues (fast timers, heavy OnPlayerUpdate logic).",
  { path: z.string().describe("Path to the script file") },
  async ({ path }) => {
    try {
      ensureRoot();
      const issues = await pawn.auditPerformance(path);
      return {
        content: [{ type: "text", text: issues.length > 0 ? JSON.stringify(issues, null, 2) : "No performance issues detected." }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Install Include
server.tool(
  "install_include",
  "Download and install a .inc library from a URL (e.g. GitHub raw) into pawno/include.",
  { 
    url: z.string().url().describe("The direct URL to the .inc file"),
    name: z.string().describe("The filename (e.g. 'sscanf2.inc')")
  },
  async ({ url, name }) => {
    try {
      ensureRoot();
      const msg = await pawn.installInclude(url, name);
      return {
        content: [{ type: "text", text: msg }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Get Dashboard
server.tool(
  "get_dashboard",
  "Get a real-time summary of server health, players, and performance.",
  { address: z.string().optional().describe("Optional host:port to query instead of the project server") },
  async ({ address }) => {
    try {
      const dash = await queryClient(address, (c) => pawn.getDashboard(c));
      return {
        content: [{ type: "text", text: JSON.stringify(dash, null, 2) }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Manage Server
server.tool(
  "manage_server",
  "Start, Stop or Restart the SAMP server process",
  { action: z.enum(["start", "stop", "restart"]).describe("Action to perform") },
  async ({ action }) => {
    try {
      ensureRoot();
      const msg = await pawn.manageServer(action as any);
      return {
        content: [{ type: "text", text: msg }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Check for Updates
server.tool(
  "check_for_updates",
  "Check if a new version of SAMP-MCP is available on NPM.",
  {},
  async () => {
    try {
      const info = await pawn.checkMcpUpdate(APP_VERSION);
      if (info.needsUpdate) {
        return {
          content: [{ type: "text", text: `A new version of SAMP-MCP is available!\nCurrent: ${info.current}\nLatest: ${info.latest}\n\nUse 'update_mcp_server' to update.` }]
        };
      }
      return {
        content: [{ type: "text", text: `SAMP-MCP is up to date (v${info.current}).` }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Update MCP Server
server.tool(
  "update_mcp_server",
  "Perform a self-update of the SAMP-MCP server via NPM.",
  {},
  async () => {
    try {
      const msg = await pawn.updateMcpServer();
      return {
        content: [{ type: "text", text: msg }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Design Feature (Planning)
server.tool(
  "design_feature",
  "Before implementing ANY new system, create a structured plan with edge case analysis. The plan is shown to the user inline for review. WAIT for explicit user confirmation before writing code.",
  {
    title: z.string().describe("Short feature name (e.g. 'Airdrop System')"),
    description: z.string().describe("Detailed description of what this feature does"),
    requirements: z.array(z.string()).optional().describe("List of explicit requirements (optional)")
  },
  async ({ title, description, requirements }) => {
    try {
      ensureRoot();
      const planPath = await pawn.designFeature(title, description, requirements);
      // Read the plan back so the user can review it inline
      const planContent = await readFile(planPath, 'utf8');
      return {
        content: [
          { type: "text", text: `Plan created: ${planPath}` },
          { type: "text", text: "\n========== FEATURE PLAN ==========\n" + planContent },
          { type: "text", text: "\n========== ACTION REQUIRED ==========\nPlease review the plan above.\n\nReply 'confirm' or 'yes' to proceed with implementation.\nOr tell me what to change/modify before we start coding.\n\nDO NOT write any code until you confirm." }
        ]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Review Implementation
server.tool(
  "review_implementation",
  "After implementing a feature, verify that the plan checklist is satisfied and all expected files exist.",
  {
    planPath: z.string().describe("Path to the .md plan file created by design_feature"),
    filesModified: z.array(z.string()).describe("List of files that were created or modified")
  },
  async ({ planPath, filesModified }) => {
    try {
      ensureRoot();
      const report = await pawn.reviewImplementation(planPath, filesModified);
      return {
        content: [{ type: "text", text: report }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Prompt: SAMP Developer Setup
server.prompt(
  "SAMP_DEVELOPER_SETUP",
  "Initialize the AI to work on this SAMP project with the correct encoding rules.",
  async () => {
    const p = await pawn.detectPatterns();
    const isThai = pawn.preferredEncoding === 'windows-874';
    return {
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `You are now a SAMP Developer. This project uses ${isThai ? 'Thai (Windows-874)' : 'International'} encoding.
          
GUIDELINES:
1. samp-mcp handles SAMP server operations only (status, RCON, compile, audits).
2. For ALL file reads/writes/edits on .pwn/.inc/.cfg/logs, use encoding-aware file tools (e.g., mcp-file-tools) — never plain editors that would corrupt Windows-874 Thai.
3. Use the 'aaa_mandatory_read_first_guidelines' tool to see the full project rules.
4. Keep the original language — do NOT translate existing strings.${p.hasSystemModules ? `\n5. When building NEW systems/features, follow the project's module pattern: ONE module under gamemodes/includes/system (use generate_boilerplate type=module/job/autofarm and design_feature, which now emit module-aware plans), register it in gamemodes/main.pwn, and never put gameplay logic in main.pwn.` : ''}`
        }
      }]
    };
  }
);

// Tool: AAA Mandatory Read First Guidelines
server.tool(
  "aaa_mandatory_read_first_guidelines",
  "Call this FIRST. Returns the project's encoding rules and AI-agent workflow guidelines.",
  {},
  async () => {
    const rules = await pawn.getFormattedGuidelines();
    return {
      content: [{ type: "text", text: rules }]
    };
  }
);

// Tool: Setup AI Environment
server.tool(
  "setup_ai_environment",
  "OPTIONAL: Write AI_RULES.md and SAMP_RULES.md guidance files into the SAMP server root for external AI agents (Cursor, Windsurf, etc.). Only run when you explicitly want those files created — connecting alone never writes into your project.",
  {},
  async () => {
    try {
      const result = await pawn.setupAiEnvironment();
      return {
        content: [{ type: "text", text: result }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error setting up environment: ${error.message}` }],
        isError: true
      };
    }
  }
);

async function main() {
  // Try immediate init if env is present
  const root = process.env.SAMP_SERVER_ROOT;
  if (root) {
      try { await updateConnection(root, process.env.SAMP_HOST || '127.0.0.1'); } catch {}
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SAMP MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
