#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import { SampClient } from './client.js';
import { PawnManager } from './scripts.js';

// Silence dotenv output that can break MCP JSON-RPC
process.env.DOTENV_CONFIG_QUIET = 'true';
const originalLog = console.log;
console.log = (...args: any[]) => {
  if (typeof args[0] === 'string' && (args[0].includes('[dotenv]') || args[0].includes('injecting env'))) {
    return;
  }
  originalLog.apply(console, args);
};
dotenv.config({ quiet: true });
console.log = originalLog;

const APP_VERSION = "1.0.8";

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
    
    client = new SampClient(host, port, password);
    console.error(`Connected to SAMP server at: ${root} (Host: ${host}, Port: ${port})`);
    return { root, port, password };
}

async function getTempClient(address?: string): Promise<SampClient> {
    if (address) {
        let [host, portStr] = address.split(':');
        let port = portStr ? parseInt(portStr, 10) : 7777;
        return new SampClient(host, port);
    }
    ensureRoot();
    return client!;
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
          text: `Successfully connected to ${path}. Host: ${client?.host}, Port: ${info.port}.\n\nSYSTEM RULES FOR THIS PROJECT (MANDATORY):\n${rules}\n\nAI AGENT: You are now bound by these rules. Do not use standard file tools.` 
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
      const targetClient = await getTempClient(address);
      const stats = await targetClient.getInfo();
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
      const targetClient = await getTempClient(address);
      const players = await targetClient.getPlayers();
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
      const targetClient = await getTempClient(address);
      const rules = await targetClient.getRules();
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

// Tool: Read Server Log
server.tool(
  "read_server_log",
  "Read the last N lines of the SAMP server_log.txt",
  { limit: z.number().optional().default(50).describe("Number of lines to read") },
  async ({ limit }) => {
    try {
      ensureRoot();
      const log = await pawn.readServerLog(limit);
      return {
        content: [{ type: "text", text: log }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Search Server Log
server.tool(
  "search_server_log",
  "Search for specific keywords (e.g., 'Error', 'Crash', 'Failed') in server_log.txt",
  { 
    query: z.string().describe("Keyword to search for"),
    limit: z.number().optional().default(100).describe("Number of lines to scan from the end")
  },
  async ({ query, limit }) => {
    try {
      ensureRoot();
      const matches = await pawn.searchServerLog(query, limit);
      return {
        content: [{ type: "text", text: matches.join('\n') || "No matches found." }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
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

// Tool: Read server.cfg
server.tool(
  "read_server_cfg",
  "Read the SAMP server.cfg configuration file.",
  {},
  async () => {
    try {
      ensureRoot();
      const content = await pawn.readConfig();
      return {
        content: [{ type: "text", text: content }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Write server.cfg
server.tool(
  "write_server_cfg",
  "Write/Update the entire SAMP server.cfg configuration file.",
  { content: z.string().describe("Full content of the server.cfg file") },
  async ({ content }) => {
    try {
      ensureRoot();
      await pawn.writeConfig(content);
      return {
        content: [{ type: "text", text: `Successfully updated server.cfg` }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Update server.cfg key
server.tool(
  "update_server_cfg",
  "Update a specific key in server.cfg (e.g., 'hostname', 'maxplayers').",
  { 
    key: z.string().describe("The configuration key to update"),
    value: z.string().describe("The new value for the key")
  },
  async ({ key, value }) => {
    try {
      ensureRoot();
      await pawn.updateConfig(key, value);
      return {
        content: [{ type: "text", text: `Successfully updated ${key} in server.cfg` }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: List Server Files
server.tool(
  "list_server_files",
  "List files in a SAMP server subdirectory (gamemodes, plugins, include, etc.) Use this to find .pwn and .inc source files.",
  { subdir: z.string().describe("Subdirectory to list") },
  async ({ subdir }) => {
    try {
      ensureRoot();
      const files = await pawn.listDirectory(subdir);
      return {
        content: [{ type: "text", text: files.join('\n') }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Read SAMP Source (.pwn, .inc)
server.tool(
  "read_pawn_script",
  "MANDATORY: ALWAYS use this for .pwn/.inc files. It is the ONLY safe way to handle encoding and language. Standard tools WILL corrupt files.",
  { 
    path: z.string().describe("Path to the file"),
    encoding: z.string().optional().describe("Override encoding (defaults to project's auto-detected encoding)")
  },
  async ({ path, encoding }) => {
    try {
      ensureRoot();
      const content = await pawn.readScript(path, encoding);
      return {
        content: [{ type: "text", text: content }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Write SAMP Source (.pwn, .inc)
server.tool(
  "write_pawn_script",
  "MANDATORY: ALWAYS use this for .pwn/.inc files. It is the ONLY safe way to handle encoding and language. Standard tools WILL corrupt files.",
  { 
    path: z.string().describe("Path to the file"),
    content: z.string().describe("Content to write"),
    encoding: z.string().optional().describe("Override encoding (defaults to project's auto-detected encoding)")
  },
  async ({ path, content, encoding }) => {
    try {
      ensureRoot();
      await pawn.writeScript(path, content, encoding);
      return {
        content: [{ type: "text", text: `Successfully wrote to ${path}` }]
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

// Tool: List Includes
server.tool(
  "list_includes",
  "List available .inc files in pawno/include and other common paths.",
  {},
  async () => {
    try {
      ensureRoot();
      const includes = await pawn.listIncludes();
      return {
        content: [{ type: "text", text: includes.join('\n') || "No includes found." }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Read Include
server.tool(
  "read_include",
  "Read a .inc file from the include directories (Thai support).",
  { name: z.string().describe("Name of the include file (e.g., 'sscanf2' or 'zcmd.inc')") },
  async ({ name }) => {
    try {
      ensureRoot();
      const content = await pawn.readInclude(name);
      return {
        content: [{ type: "text", text: content }]
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
  "Generate SAMP code snippets. Automatically detects if the project is Thai and provides Thai strings if so. DO NOT TRANSLATE generated Thai strings.",
  { 
    type: z.enum(["command", "dialog", "job", "autofarm"]).describe("Type of snippet to generate"),
    name: z.string().describe("Name of the command/dialog/job/item")
  },
  async ({ type, name }) => {
    ensureRoot();
    const p = await pawn.detectPatterns();
    let snippet = "";
    
    if (type === "command") {
      if (p.hasPawnCMD) {
        snippet = `PCMD:${name}(playerid, params[])\n{\n    // Pawn.CMD style\n    return 1;\n}`;
      } else {
        snippet = `CMD:${name}(playerid, params[])\n{\n    // ZCMD style\n    return 1;\n}`;
      }
    } else if (type === "dialog") {
      snippet = `Dialog:DIALOG_${name.toUpperCase()}(playerid, response, listitem, inputtext[])\n{\n    if (response)\n    {\n        // Handle response\n    }\n    return 1;\n}`;
    } else if (type === "job") {
      snippet = `// Job: ${name}\n${p.hasYSI ? 'hook ' : ''}OnPlayerKeyStateChange(playerid, newkeys, oldkeys)\n{\n    if (newkeys & KEY_NO)\n    {\n        // Start job action\n    }\n    return 1;\n}`;
    } else if (type === "autofarm") {
      const upperName = name.toUpperCase();
      snippet = `${p.hasYSI ? '#include <YSI_Coding\\y_hooks>\n#include <YSI_Coding\\y_timers>\n' : ''}\n#define     MAX_${upperName}          10\n#define     ${upperName}OBJECT        19129\n#define     ${upperName}TEXT           "{FFFFFF}กด {FFFF00}N {FFFFFF}เพื่อเก็บ ${name}"\n#define     ${upperName}NAME           "${name}"\n\n${p.hasYSI ? 'hook ' : ''}OnPlayerKeyStateChange(playerid, newkeys, oldkeys)\n{\n    if (newkeys & KEY_NO)\n    {\n        // Add ${name} collection logic here\n        // Use AutoFarm_WalkAnimation(playerid);\n    }\n    return 1;\n}`;
    }

    return {
      content: [{ type: "text", text: snippet }]
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

## Standards:
1. **Encoding**: ALWAYS use \`write_pawn_script\` for .pwn and .inc files to support Thai (windows-874).
2. **Boilerplate**: Use \`generate_boilerplate\` to get the correct structure for this project.
`;

    if (p.hasYSI) {
      guide += `\n- **Note**: This project uses YSI. Always include <YSI_Coding\\y_hooks> when creating new modules.\n`;
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
);// Tool: Inspect Project
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

// Tool: Search SAMP Resources (Wiki/Forum)
server.tool(
  "search_samp_resources",
  "Search the official SAMP Wiki and Forum Archive for information/examples.",
  { query: z.string().describe("Search keywords") },
  async ({ query }) => {
    // This is a placeholder for AI to use search_web with context
    return {
      content: [{ 
        type: "text", 
        text: `Please use the 'search_web' tool with the following query for better results: "site:sampwiki.blast.hk ${query}" OR "site:sampforum.blast.hk ${query}"` 
      }]
    };
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



// Tool: Transform Pawn Script
server.tool(
  "transform_pawn_script",
  "Clone and refactor a script (e.g. Juice -> Watermelon). MANDATORY for Thai projects to preserve encoding. DO NOT TRANSLATE Thai strings during transformation.",
  {
    sourcePath: z.string().describe("Path to the original .pwn or .inc file"),
    targetName: z.string().describe("New name for the file (e.g. 'auto_watermelon')"),
    oldTheme: z.string().describe("The word to replace (e.g., 'Juice')"),
    newTheme: z.string().describe("The replacement word (e.g., 'Watermelon')")
  },
  async ({ sourcePath, targetName, oldTheme, newTheme }) => {
    try {
      ensureRoot();
      const newPath = await pawn.transformScript(sourcePath, targetName, oldTheme, newTheme);
      return {
        content: [{ type: "text", text: `Successfully transformed script to: ${newPath}` }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Install Plugin
server.tool(
  "install_plugin",
  "Download and install a SAMP plugin library (.dll or .so) and update server.cfg.",
  { 
    url: z.string().url().describe("The direct URL to the plugin file (e.g. from GitHub releases)"),
    name: z.string().describe("The plugin name (e.g. 'streamer' or 'mysql')")
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

// Tool: Extract Strings
server.tool(
  "extract_strings",
  "Scan a script for all string literals. Useful for localization or cleanup.",
  { path: z.string().describe("Path to the script file") },
  async ({ path }) => {
    try {
      ensureRoot();
      const strings = await pawn.extractStrings(path);
      return {
        content: [{ type: "text", text: JSON.stringify(strings, null, 2) }]
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
      const targetClient = await getTempClient(address);
      const dash = await pawn.getDashboard(targetClient);
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
          
CRITICAL RULES:
1. NEVER use your built-in 'read_file' or 'write_file' tools for .pwn or .inc files. They WILL corrupt the project.
2. ALWAYS use the 'aaa_mandatory_read_first_guidelines' tool to see the full rules.
3. ALWAYS use 'read_pawn_script' and 'write_pawn_script' for all script operations.
4. If you see 'เธเธ' or garbage, use 'fix_script_encoding' immediately.`
        }
      }]
    };
  }
);

// Tool: AAA Mandatory Read First Guidelines
server.tool(
  "aaa_mandatory_read_first_guidelines",
  "CRITICAL: Call this FIRST. Returns the mandatory encoding and language rules for this specific SAMP project.",
  {},
  async () => {
    const p = await pawn.detectPatterns();
    const rules = await pawn.getFormattedGuidelines();
    return {
      content: [{ type: "text", text: rules }]
    };
  }
);

// Tool: Fix Script Encoding
server.tool(
  "fix_script_encoding",
  "Attempt to recover a .pwn/.inc file that was corrupted by an AI using the wrong encoding (e.g., showing 'ยยกต' or garbage).",
  { 
    path: z.string().describe("Path to the corrupted file") 
  },
  async ({ path }) => {
    try {
      const result = await pawn.fixScriptEncoding(path);
      return {
        content: [{ type: "text", text: result }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error fixing encoding: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Tool: Setup AI Environment
server.tool(
  "setup_ai_environment",
  "MANDATORY SETUP: Call this to install .cursorrules and SAMP_RULES.md into your SAMP server root. This forces AI agents (Cursor, Windsurf, etc.) to use the correct tools and maintain encoding.",
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
