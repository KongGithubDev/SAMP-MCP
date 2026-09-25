#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import { readFile } from 'fs/promises';
import { SampClient } from './client.js';
import { PawnManager } from './scripts.js';
import { FileToolsBridge } from './filetools.js';
import { TextdrawManager } from './textdraw.js';
import {
  TxdEditorManager,
  type TxdExportResult,
  type TxdImportOptions,
  type TxdSaveResult,
  type TxdTextureInfo,
  type TxdWorkspaceInfo,
} from './txd-edit.js';
import { models } from './model.js';

// dotenv quiet mode keeps JSON-RPC on stdout clean
process.env.DOTENV_CONFIG_QUIET = 'true';
dotenv.config({ quiet: true });

const APP_VERSION = "1.3.0";

const server = new McpServer({
  name: "samp-mcp-server",
  version: APP_VERSION
});

let client: SampClient | null = null;
const pawn = new PawnManager();
const fileTools = new FileToolsBridge();
const textdraw = new TextdrawManager();
const txdEditor = new TxdEditorManager();

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
    textdraw.setRoot(root);
    txdEditor.setRoot(root);
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
      fileTools.setRoot(path);
      const p = await pawn.detectPatterns();
      const rules = await pawn.getFormattedGuidelines();
      
      return {
        content: [{ 
          type: "text", 
          text: `Successfully connected to ${path}. Host: ${client?.host}, Port: ${info.port}.${p.hasSystemModules ? `\nArchitecture: module-based system (${p.systemModuleCount} modules under gamemodes/includes/system). Design new features as ONE self-contained .inc module there and register it in main.pwn — never as filterscripts.` : ''}\n\nSYSTEM RULES FOR THIS PROJECT (MANDATORY):\n${rules}\n\nAI AGENT: Follow these rules. samp-mcp handles SAMP server operations (query/RCON/compile/audit) AND file access via its file_* tools (file_read/file_write/file_edit/file_grep/...), which delegate to encoding-aware mcp-file-tools so Windows-874 Thai and CRLF line endings are preserved.` 
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

// =====================================================================
// File Tools — delegated to the encoding-aware mcp-file-tools server.
// Preserves Windows-874 (Thai) and CRLF when reading/writing .pwn/.inc.
// =====================================================================

async function fileToolResult(name: string, args: Record<string, unknown>) {
  try {
    const text = await fileTools.call(name, args);
    return { content: [{ type: "text" as const, text }] };
  } catch (error: any) {
    return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
  }
}

server.tool(
  "file_read",
  "Read a file with encoding auto-detection (delegated to mcp-file-tools). Thai windows-874 and CRLF are preserved.",
  {
    path: z.string().describe("Path to the file to read"),
    encoding: z.string().optional().describe("Encoding name (auto-detected if omitted)"),
    offset: z.number().optional().describe("Start reading from this line number (1-indexed)"),
    limit: z.number().optional().describe("Maximum number of lines to read"),
    maxCharacters: z.number().optional().describe("Truncate content at this character count"),
    lineNumbers: z.boolean().optional().describe("Prefix every line with N<tab>"),
  },
  async (params) => fileToolResult("read_text_file", params as Record<string, unknown>)
);

server.tool(
  "file_read_many",
  "Read multiple files at once with encoding support (delegated to mcp-file-tools).",
  {
    paths: z.array(z.string()).describe("Array of file paths to read"),
    encoding: z.string().optional().describe("Encoding for all files (auto-detected per file if omitted)"),
  },
  async (params) => fileToolResult("read_multiple_files", params as Record<string, unknown>)
);

server.tool(
  "file_write",
  "Write a file back in its original encoding (delegated to mcp-file-tools). CRLF and BOM are preserved for existing files.",
  {
    path: z.string().describe("Path to the file to write"),
    content: z.string().describe("Content to write"),
    encoding: z.string().optional().describe("Target encoding (defaults to the existing file's detected encoding)"),
    bom: z.string().optional().describe("BOM mode: auto (default), always, never, preserve"),
    lineEndings: z.string().optional().describe("Line endings: preserve (default), crlf, lf, asis"),
  },
  async (params) => fileToolResult("write_file", params as Record<string, unknown>)
);

server.tool(
  "file_edit",
  "In-place line edits to one file with diff preview, encoding-safe (delegated to mcp-file-tools). Pass exactly one of edits or patch.",
  {
    path: z.string().describe("Path to the file to edit"),
    edits: z.array(z.object({
      oldText: z.string(),
      newText: z.string(),
      similarity: z.number().optional(),
      replaceAll: z.boolean().optional(),
    })).optional().describe("Edit operations (oldText/newText pairs)"),
    patch: z.string().optional().describe("Unified diff string with ---, +++ and @@ hunks"),
    dryRun: z.boolean().optional().describe("Preview the diff without writing (default false)"),
    encoding: z.string().optional().describe("File encoding (auto-detected if omitted)"),
    forceWritable: z.boolean().optional().describe("Clear read-only flag before editing"),
  },
  async (params) => fileToolResult("edit_file", params as Record<string, unknown>)
);

server.tool(
  "file_grep",
  "Regex search across file contents with encoding support (delegated to mcp-file-tools). Searches directories recursively.",
  {
    pattern: z.string().optional().describe("Regular expression to search for (or use patterns)"),
    patterns: z.array(z.string()).optional().describe("Array of regexes; a line matching any is a hit"),
    paths: z.array(z.string()).describe("Array of file or directory paths to search"),
    outputMode: z.string().optional().describe("content (default), files_with_matches, or count"),
    caseSensitive: z.boolean().optional().describe("Case-sensitive matching (default true)"),
    matchesOnly: z.boolean().optional().describe("Return the matched substring instead of the whole line"),
    contextBefore: z.number().optional().describe("Lines to show before each match"),
    contextAfter: z.number().optional().describe("Lines to show after each match"),
    maxMatches: z.number().optional().describe("Maximum results per page (default 1000)"),
    offset: z.number().optional().describe("Skip the first N results to page"),
    include: z.string().optional().describe("Glob to include files (e.g. *.pwn)"),
    exclude: z.string().optional().describe("Glob to exclude files"),
    includes: z.array(z.string()).optional().describe("Globs; a file matching any is included"),
    excludes: z.array(z.string()).optional().describe("Globs; a file matching any is excluded"),
    encoding: z.string().optional().describe("File encoding (auto-detected if omitted)"),
  },
  async (params) => fileToolResult("grep_text_files", params as Record<string, unknown>)
);

server.tool(
  "file_search",
  "Recursively find files/directories matching a glob pattern (delegated to mcp-file-tools).",
  {
    path: z.string().describe("Root directory to search from"),
    pattern: z.string().describe("Glob pattern (e.g. **/*.pwn)"),
    excludePatterns: z.array(z.string()).optional().describe("Patterns to exclude"),
    maxResults: z.number().optional().describe("Maximum results (default 10000)"),
    sortBy: z.string().optional().describe("name (default), mtime, or size"),
    reverse: z.boolean().optional().describe("Flip the order"),
  },
  async (params) => fileToolResult("search_files", params as Record<string, unknown>)
);

server.tool(
  "file_tree",
  "Compact indented tree of a directory, optionally with per-file encoding (delegated to mcp-file-tools).",
  {
    path: z.string().describe("Root directory"),
    maxDepth: z.number().optional().describe("Maximum recursion depth (0 = unlimited)"),
    maxFiles: z.number().optional().describe("Maximum entries (default 1000)"),
    dirsOnly: z.boolean().optional().describe("Only show directories"),
    exclude: z.array(z.string()).optional().describe("Patterns to exclude"),
    showEncoding: z.boolean().optional().describe("Show each file's detected encoding"),
  },
  async (params) => fileToolResult("tree", params as Record<string, unknown>)
);

server.tool(
  "file_list",
  "List directory contents with optional glob filter (delegated to mcp-file-tools).",
  {
    path: z.string().describe("Path to the directory"),
    pattern: z.string().optional().describe("Glob pattern (default *)"),
    sortBy: z.string().optional().describe("name (default), mtime, or size"),
    reverse: z.boolean().optional().describe("Flip the order"),
  },
  async (params) => fileToolResult("list_directory", params as Record<string, unknown>)
);

server.tool(
  "file_detect_encoding",
  "Detect a file's real encoding with confidence score (delegated to mcp-file-tools).",
  {
    path: z.string().describe("Path to the file"),
    mode: z.string().optional().describe("sample (default), chunked, or full"),
  },
  async (params) => fileToolResult("detect_encoding", params as Record<string, unknown>)
);

server.tool(
  "file_convert_encoding",
  "Convert a file between encodings (delegated to mcp-file-tools). Backs up by default is off — pass backup=true.",
  {
    path: z.string().optional().describe("Single file to convert"),
    paths: z.array(z.string()).optional().describe("Batch of files to convert"),
    from: z.string().optional().describe("Source encoding (auto-detected per file if omitted)"),
    to: z.string().describe("Target encoding"),
    backup: z.boolean().optional().describe("Create a .bak backup before converting"),
    dryRun: z.boolean().optional().describe("Report what would change, write nothing"),
    allowLowConfidence: z.boolean().optional().describe("Convert even when detection confidence is low"),
  },
  async (params) => fileToolResult("convert_encoding", params as Record<string, unknown>)
);

server.tool(
  "file_info",
  "Get file/directory metadata (size, timestamps, permissions) via mcp-file-tools.",
  { path: z.string().describe("Path to a file or directory") },
  async (params) => fileToolResult("get_file_info", params as Record<string, unknown>)
);

server.tool(
  "file_line_endings",
  "Detect or convert line endings (CRLF/LF/mixed) via mcp-file-tools.",
  {
    path: z.string().describe("Path to the file"),
    action: z.string().describe("detect or convert"),
    style: z.string().optional().describe("lf or crlf (required for convert)"),
    encoding: z.string().optional().describe("Auto-detected by default"),
  },
  async (params) => fileToolResult("manage_line_endings", params as Record<string, unknown>)
);

server.tool(
  "file_bom",
  "Detect, strip, or add a Unicode BOM via mcp-file-tools.",
  {
    path: z.string().describe("Path to the file"),
    action: z.string().describe("detect, strip, or add"),
    encoding: z.string().optional().describe("BOM encoding (required for add)"),
  },
  async (params) => fileToolResult("manage_bom", params as Record<string, unknown>)
);

server.tool(
  "file_allowed_dirs",
  "Show directories the file backend (mcp-file-tools) may access.",
  {},
  async () => fileToolResult("list_allowed_directories", {})
);

server.tool(
  "file_encodings",
  "List all encodings supported by the file backend (mcp-file-tools).",
  {},
  async () => fileToolResult("list_encodings", {})
);

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
  "Generate SAMP code snippets / system-module skeletons that match the connected project architecture (system-module includes/system architecture when detected). Use type 'module' for a full feature module, 'job'/'autofarm' for those module kinds, or 'command'/'dialog' for small blocks. DO NOT TRANSLATE generated Thai strings.",
  { 
    type: z.enum(["command", "dialog", "module", "job", "autofarm"]).describe("Type of snippet to generate (module/job/autofarm produce full system-module skeletons)"),
    name: z.string().describe("Name of the command/dialog/job/item"),
    adminCommand: z.boolean().optional().describe("Emit the admin-command style (flags:CMD_LEAD_ADMIN, alias:, SendAdminMessage, instant action — cmd/admin.inc /veh family) instead of the interactive progress-bar flow. Auto-detected from the name (e.g. veh, kick, ban) when omitted; pass false to force the interactive skeleton.")
  },
  async ({ type, name, adminCommand }) => {
    ensureRoot();
    const p = await pawn.detectPatterns();
    const moduleMode = !!p.hasSystemModules;
    let snippet = "";

    if (moduleMode && (type === "module" || type === "job" || type === "autofarm")) {
      snippet = await pawn.moduleSkeleton(name, type, adminCommand);
    } else if (type === "module") {
      snippet = `// ${name}\n// Classic project (no gamemodes/includes/system): full-module boilerplate only applies to\n// system-module projects. Use type command/dialog/job/autofarm instead.`;
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
1. **Encoding**: Files use Thai (windows-874) / auto-detected encodings. Use samp-mcp's file_* tools (file_read/file_write/file_edit/file_grep — delegated to encoding-aware mcp-file-tools) for ALL .pwn and .inc file reads/writes/edits.
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

// Tool: Update mcp-file-tools binary
server.tool(
  "update_file_tools",
  "Download the latest mcp-file-tools release binary from GitHub and replace the installed one. The previous version is backed up next to it as <binary>.v<old>.bak; also works as a fresh install when the binary is missing. Reports when already up to date.",
  {},
  async () => {
    try {
      const msg = await fileTools.updateFileTools();
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

// =====================================================================
// Textdraw Editor (SA-MP textdraw projects, txd/TXD sprites, web preview)
// =====================================================================

const tdProps = {
  text: z.string().optional().describe('Textdraw text. Font 4 sprites use "txdname:texturename"; "_" renders as a space.'),
  target: z.enum(["global", "player"]).optional().describe('Global TextDraw (default) or per-player PlayerTextDraw'),
  x: z.number().optional().describe('X on the 640x448 textdraw grid'),
  y: z.number().optional().describe('Y on the 640x448 textdraw grid'),
  letterWidth: z.number().optional().describe('TextDrawLetterSize x (character width)'),
  letterHeight: z.number().optional().describe('TextDrawLetterSize y (character height)'),
  textSizeX: z.number().optional().describe('TextDrawTextSize x (box corner/width or clickable area)'),
  textSizeY: z.number().optional().describe('TextDrawTextSize y (box corner/height)'),
  font: z.number().optional().describe('0-3 = hud/arial/display fonts, 4 = txd sprite, 5 = 3D model preview'),
  alignment: z.number().optional().describe('1 = left, 2 = center, 3 = right'),
  color: z.string().optional().describe('Text colour, SA-MP ARGB (0xRRGGBBAA). CSS-style #RRGGBB(AA) is also accepted (RGBA order)'),
  boxColor: z.string().optional().describe('Box colour (ARGB); alpha 0 makes the box invisible'),
  background: z.string().optional().describe('TextDrawBackgroundColor (ARGB)'),
  shadow: z.number().optional().describe('TextDrawSetShadow size'),
  outline: z.number().optional().describe('TextDrawSetOutline size'),
  proportional: z.boolean().optional().describe('TextDrawSetProportional'),
  box: z.boolean().optional().describe('TextDrawUseBox'),
  selectable: z.boolean().optional().describe('TextDrawSetSelectable (needs textSizeX/textSizeY for the clickable area)'),
  previewModel: z.number().optional().describe('Model id for font 5 previews (TextDrawSetPreviewModel)'),
  previewRot: z.array(z.number()).optional().describe('[rx, ry, rz] preview rotation'),
  previewZoom: z.number().optional().describe('Preview zoom for TextDrawSetPreviewRot'),
  previewVehCol: z.array(z.number()).optional().describe('[colour1, colour2] for vehicle model previews'),
  image: z.string().optional().describe('Optional bitmap (png/jpg) inside the server root, shown on the preview page for UI mockups'),
  group: z.string().optional().describe('Group/category name used for filtering and bulk export'),
  note: z.string().optional().describe('Free-form note kept with the textdraw'),
};

server.tool(
  "textdraw_list",
  "List textdraws of a saved textdraw project (UI/HUD design store under .samp-mcp/textdraws). Without a project, lists the available projects. Returns the definitions, stats and validation warnings.",
  {
    project: z.string().optional().describe('Project name (default: default)'),
    group: z.string().optional().describe('Only textdraws of this group'),
    target: z.enum(["all", "global", "player"]).optional().describe('Filter by textdraw kind'),
    search: z.string().optional().describe('Filter by name, text or group substring'),
  },
  async ({ project, group, target, search }) => {
    try {
      if (!project) {
        const info = await textdraw.listProjects();
        return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
      }
      const result = await textdraw.listTextdraws(project, { group, target, search });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "textdraw_create",
  "Create a textdraw in a textdraw project (kept as JSON under the server root, so it can be reviewed, versioned and exported to Pawn). Supports the full SA-MP property set including txd sprites (font 4) and model previews (font 5).",
  {
    project: z.string().optional().describe('Project name (default: default)'),
    name: z.string().describe('Pawn variable name, e.g. gLogo or PlayerHud'),
    ...tdProps,
  },
  async ({ project, ...def }) => {
    try {
      ensureRoot();
      const result = await textdraw.createTextdraw(project || 'default', def as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "textdraw_update",
  "Update one textdraw of a project (by id or Pawn name). Only the fields you pass are changed — use it to nudge position, colours, letter size, font, sprite text, preview model, etc.",
  {
    project: z.string().optional().describe('Project name (default: default)'),
    textdraw: z.string().describe('Textdraw id or Pawn variable name to update'),
    name: z.string().optional().describe('Rename the Pawn variable name'),
    id: z.string().optional().describe('Rename the internal id'),
    visible: z.boolean().optional().describe('Show it on the preview page by default'),
    ...tdProps,
  },
  async ({ project, textdraw: target, ...patch }) => {
    try {
      ensureRoot();
      const result = await textdraw.updateTextdraw(project || 'default', target, patch as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "textdraw_delete",
  "Delete one or more textdraws from a project (by id or Pawn variable name).",
  {
    project: z.string().optional().describe('Project name (default: default)'),
    targets: z.array(z.string()).describe('Ids or Pawn variable names to delete'),
  },
  async ({ project, targets }) => {
    try {
      ensureRoot();
      const result = await textdraw.deleteTextdraw(project || 'default', targets);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "textdraw_import",
  "Import textdraws into a project from: existing TextDrawCreate / CreatePlayerTextDraw code (+ all TextDraw* setters and AddSimpleModel entries) in .pwn/.inc files, a samp-mcp project JSON, or a TextDrawEditor (Leonardo541) project JSON — so legacy UI, and designs made in that browser editor, can be edited, previewed and exported from here. Accepts a file or a directory.",
  {
    project: z.string().optional().describe('Project name (default: default)'),
    path: z.string().describe('File or directory (relative to the server root or absolute) to import from'),
    mode: z.enum(["merge", "replace"]).optional().describe('merge (default) updates same-named textdraws, replace clears the project first'),
  },
  async ({ project, path, mode }) => {
    try {
      ensureRoot();
      const result = await textdraw.importFromScript(project || 'default', path, mode === 'replace' ? 'replace' : 'merge');
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "textdraw_export",
  "Export textdraws as ready-to-use Pawn code: statements (create + setters), declarations, a full system-module .inc (y_hooks, OnGameModeInit/OnPlayerConnect, show/hide stocks), a markdown table, or raw JSON.",
  {
    project: z.string().optional().describe('Project name (default: default)'),
    mode: z.enum(["statements", "declarations", "module", "markdown", "json"]).describe('Output format'),
    target: z.enum(["all", "global", "player"]).optional().describe('Limit to global or per-player textdraws'),
    group: z.string().optional().describe('Limit to one group'),
    name: z.string().optional().describe('Limit to a single textdraw'),
  },
  async ({ project, mode, target, group, name }) => {
    try {
      ensureRoot();
      const result = await textdraw.exportTextdraws(project || 'default', { mode, target, group, name });
      return { content: [{ type: "text" as const, text: result.content }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "textdraw_preview",
  "Render every textdraw of a project on a web page (HTML + embedded textures) so you can see the UI without starting SA-MP: 640x448 grid scaled to real resolutions, box/alignment/colour/outline rendering, decoded .txd sprites for font 4, model-preview placeholders for font 5. With serve=true it also starts a local editor server where you can drag textdraws and save the changes back.",
  {
    project: z.string().optional().describe('Project name (default: default)'),
    serve: z.boolean().optional().describe('Start the local preview/editor server on 127.0.0.1 and return its URL'),
    port: z.number().optional().describe('Port for the preview server (default 7788, next free port if busy)'),
    exportPng: z.boolean().optional().describe('Write decoded .txd textures as PNG files next to the page (default true)'),
    inlineAssets: z.boolean().optional().describe('Embed textures in the page as data URLs so it works standalone (default true)'),
    maxTextureSize: z.number().optional().describe('Downscale textures above this size (default 256)'),
  },
  async ({ project, serve, port, exportPng, inlineAssets, maxTextureSize }) => {
    try {
      ensureRoot();
      const projectName = project || 'default';
      let url: string | null = null;
      if (serve) {
        const server = await textdraw.startPreviewServer(projectName, port);
        url = server.url;
      }
      const result = await textdraw.buildPreview(projectName, {
        exportPng: exportPng !== false,
        inlineAssets: inlineAssets !== false,
        maxTextureSize: maxTextureSize ?? 256,
      });
      const lines = [
        `Preview page: ${result.htmlPath}`,
        `Project data: ${result.dataPath}`,
        url || result.url ? `Live editor server: ${url || result.url}` : 'Static page only — pass serve=true for the draggable live editor (save back to the project file).',
        `Textdraws rendered: ${result.textdraws} · decoded textures: ${result.assets} · 3D model previews: ${result.models}`,
        result.missingTextures.length ? `Sprites without a decoded texture (run txd_scan): ${result.missingTextures.join(', ')}`
          : result.designOverrides.length ? `Sprites drawn from design-time images (not in a .txd yet, so the game shows nothing until you ship them): ${result.designOverrides.join(', ')}`
          : 'All referenced sprites were resolved from .txd dictionaries.',
        result.missingModels.length ? `Font 5 texts without a .dff (run model_scan + model_preview): ${result.missingModels.join(', ')}` : '',
        result.warnings.length ? `Validation:\n${result.warnings.join('\n')}` : 'Validation: no issues.',
      ];
      return { content: [{ type: "text" as const, text: lines.join('\n') }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "textdraw_preview_server",
  "Start/stop/status of the live textdraw preview server (127.0.0.1). While it runs, the page reloads itself when the project file changes and the browser can drag textdraws and save them straight back into the project.",
  {
    action: z.enum(["start", "stop", "status"]).describe('start, stop or status'),
    project: z.string().optional().describe('Project to serve (default: default)'),
    port: z.number().optional().describe('Preferred port (default 7788)'),
  },
  async ({ action, project, port }) => {
    try {
      if (action === 'status') {
        return { content: [{ type: "text" as const, text: textdraw.previewServerStatus() }] };
      }
      if (action === 'stop') {
        return { content: [{ type: "text" as const, text: await textdraw.stopPreviewServer() }] };
      }
      ensureRoot();
      const started = await textdraw.startPreviewServer(project || 'default', port);
      return {
        content: [{ type: "text" as const, text: `Textdraw preview server running:\n  URL: ${started.url}\n  Page: ${started.htmlPath}\nOpen the URL in a browser: drag textdraws on the screen, then press save to write them back into the project file.` }]
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "txd_scan",
  "Scan the SA-MP server for .txd texture dictionaries, list their textures (sizes/formats) and decode them to PNG so font 4 sprite textdraws can be previewed. Writes an index under .samp-mcp/textdraws/txd-index.json and PNGs to .samp-mcp/textdraw-preview/assets.",
  {
    dir: z.string().optional().describe('Directory to scan (default: the server root)'),
    depth: z.number().optional().describe('How many directory levels to descend (default 3)'),
    exportPng: z.boolean().optional().describe('Write decoded textures as PNG (default true)'),
    maxTextureSize: z.number().optional().describe('Downscale textures above this size (default 256)'),
    limit: z.number().optional().describe('Maximum number of .txd files to read (default 64)'),
  },
  async ({ dir, depth, exportPng, maxTextureSize, limit }) => {
    try {
      ensureRoot();
      const result = await textdraw.scanTxds({
        dir,
        depth: depth ?? 3,
        exportPng: exportPng !== false,
        maxTextureSize: maxTextureSize ?? 256,
        limit: limit ?? 64,
      });
      const summary = [
        `Scanned ${result.scannedFiles} .txd file(s); index written to ${result.indexFile}`,
        ...result.dictionaries.map((d) => `  ${d.file} → ${d.textureCount} textures${d.error ? ` (${d.error})` : ''}`),
      ];
      return {
        content: [
          { type: "text" as const, text: summary.join('\n') },
          { type: "text" as const, text: JSON.stringify({ ...result, textures: result.textures.slice(0, 200) }, null, 2) },
        ]
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "txd_open",
  "Open a RenderWare texture dictionary (.txd) for editing, the way Magic.TXD does: a file on the server, a dictionary inside a VER2 .img archive (img + entry), or a brand new one (create=true). Lists every texture with its size, raster format, mip levels and section bytes, and keeps the dictionary in memory so txd_import_texture / txd_texture / txd_export_texture / txd_save can work on it. Nothing is written to disk until txd_save. With no arguments it lists the dictionaries currently open.",
  {
    file: z.string().optional().describe('Path to the .txd, relative to the server root or absolute'),
    img: z.string().optional().describe('Path to a VER2 .img archive to take the dictionary from (e.g. models/gta3.img)'),
    entry: z.string().optional().describe('The .txd name inside that archive (used together with img)'),
    create: z.boolean().optional().describe('Create the dictionary when the file does not exist yet'),
  },
  async ({ file, img, entry, create }) => {
    try {
      ensureRoot();
      if (!file && !img) {
        const open = txdEditor.list();
        const lines = open.length
          ? open.map((w) => `  ${w.id} — ${w.textures.length} textures${w.dirty ? ' (unsaved changes)' : ''}`)
          : ['  (none)'];
        return {
          content: [{
            type: "text" as const,
            text: `Open dictionaries:\n${lines.join('\n')}\n\nPass file (a .txd path), img + entry (a dictionary inside an archive), or create=true to open one.\ntxd_scan lists the .txd files of this server and decodes them to PNG.`,
          }, { type: "text" as const, text: JSON.stringify({ open }, null, 2) }],
        };
      }
      const workspace = await txdEditor.open({ file, img, entry, create });
      return { content: [{ type: "text" as const, text: formatTxdWorkspace(workspace) }, { type: "text" as const, text: JSON.stringify(workspace, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "txd_import_texture",
  "Import a PNG into an open dictionary as a texture: re-encode it into 8888/888/565/555/4444/LUM8/DXT1/DXT3/DXT5, generate the mip chain, and replace the texture when the name already exists. The DXT formats use a squish-style encoder (cluster fit with least-squares endpoint refinement) by default — quality=fast trades a little fidelity for speed on bulk conversions. This is how a custom sprite or 0.3.DL UI texture is authored (draw the PNG, import it here, txd_save, then reference it as font 4 \"txdname:texturename\"). Nothing is written to disk until txd_save.",
  {
    txd: z.string().optional().describe('Open dictionary: its id/path (as returned by txd_open), or a .txd path to open on the fly'),
    png: z.string().describe('PNG file to import (relative to the server root or absolute)'),
    name: z.string().optional().describe('Texture name (default: the PNG file name). Max 31 printable ASCII characters'),
    format: z.enum(["auto", "8888", "888", "565", "555", "4444", "LUM8", "DXT1", "DXT3", "DXT5"]).optional().describe('Raster format (default auto = 8888, lossless; DXT1/DXT5 compress)'),
    mipmaps: z.union([z.number(), z.enum(["full", "keep"])]).optional().describe('Mip levels: a count, "full" for the whole chain down to 1x1, or "keep" to copy the replaced texture (default 1, like stock SA dictionaries)'),
    mask: z.string().optional().describe('Optional mask texture name for the char[32] mask field'),
    replace: z.boolean().optional().describe('Overwrite when the name exists (default true)'),
    quality: z.enum(["high", "fast"]).optional().describe('DXT block-compression effort (default high = cluster fit + least-squares endpoint refinement; fast = single range fit). Ignored for the lossless formats'),
  },
  async ({ txd, png, name, format, mipmaps, mask, replace, quality }) => {
    try {
      ensureRoot();
      if (!txd) return { content: [{ type: "text" as const, text: 'Error: pass txd (the dictionary to import into)' }], isError: true };
      const loaded = await txdEditor.loadPng(png);
      const textureName = (name || png.replace(/\\/g, '/').split('/').pop()!.replace(/\.[a-z0-9]+$/i, '')).trim();
      const importOptions: TxdImportOptions & { replace?: boolean } = {
        name: textureName,
        image: loaded.image,
        format: format as any,
        mipmaps: mipmaps as any,
        mask,
        replace: replace !== false,
        quality: quality as any,
      };
      const result = await txdEditor.importTexture(txd, importOptions);
      const entry = result.workspace.textures.find((t) => t.name === textureName)!;
      const summary = [
        `${result.replaced ? 'Replaced' : 'Imported'} "${entry.name}" from ${loaded.file}`,
        `  ${entry.width}x${entry.height} ${entry.format}, ${entry.levels} level(s), ${entry.bytes} section bytes${entry.format.startsWith('DXT') ? `, DXT quality ${entry.quality}` : ''}`,
        formatTxdWorkspace(result.workspace),
        'Run txd_save to write the dictionary (nothing on disk changed yet).',
      ];
      return { content: [{ type: "text" as const, text: summary.join('\n') }, { type: "text" as const, text: JSON.stringify(result.workspace, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "txd_texture",
  "Edit one texture of an open dictionary: rename (patches the char[32] name field, and works even for rasters samp-mcp cannot decode), duplicate, remove, or convert to another raster format with an optional mip chain. Conversions decode the first mip level, re-encode it and invalidate the old raster (DXT targets use the high-quality squish-style encoder unless quality=fast); nothing is written to disk until txd_save.",
  {
    txd: z.string().optional().describe('Open dictionary id/path (or a .txd path to open on the fly)'),
    action: z.enum(["rename", "duplicate", "remove", "convert"]).describe('What to do with the texture'),
    texture: z.string().describe('Texture to edit (exact name, case-insensitive)'),
    name: z.string().optional().describe('New name for rename/duplicate (default <name>_copy)'),
    format: z.enum(["8888", "888", "565", "555", "4444", "LUM8", "DXT1", "DXT3", "DXT5"]).optional().describe('Target raster format for convert'),
    mipmaps: z.union([z.number(), z.enum(["full", "keep"])]).optional().describe('Mip levels for convert (default keep: the level count the texture already has)'),
    quality: z.enum(["high", "fast"]).optional().describe('DXT block-compression effort for convert (default high: cluster fit + least-squares endpoint refinement; fast = single range fit)'),
  },
  async ({ txd, action, texture, name, format, mipmaps, quality }) => {
    try {
      ensureRoot();
      if (!txd) return { content: [{ type: "text" as const, text: 'Error: pass txd (the dictionary to edit)' }], isError: true };
      const result = await txdEditor.editTexture(txd, action, {
        texture,
        name,
        format: format as any,
        mipmaps: mipmaps as any,
        quality: quality as any,
      });
      return {
        content: [
          { type: "text" as const, text: `${result.message} in ${result.workspace.id}\n${formatTxdWorkspace(result.workspace)}\nRun txd_save to write the dictionary.` },
          { type: "text" as const, text: JSON.stringify(result.workspace, null, 2) },
        ],
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "txd_export_texture",
  "Decode the textures of an open dictionary — including imports that were not saved yet — into PNG files, so a sprite or 0.3.DL texture can be checked in an image viewer or edited in a paint tool before or after it is written back.",
  {
    txd: z.string().optional().describe('Open dictionary id/path (or a .txd path to open on the fly)'),
    texture: z.string().optional().describe('One texture to export (default: every texture of the dictionary)'),
    out: z.string().optional().describe('Output directory (default .samp-mcp/txd-export/<dictionary>)'),
  },
  async ({ txd, texture, out }) => {
    try {
      ensureRoot();
      if (!txd) return { content: [{ type: "text" as const, text: 'Error: pass txd (the dictionary to export from)' }], isError: true };
      const result: TxdExportResult = await txdEditor.exportTexture(txd, { texture, out });
      const lines = [
        `Exported ${result.files.length} texture(s) of ${result.dictionary}`,
        ...result.files.map((f) => `  ${f.name} — ${f.width}x${f.height} ${f.format} ${f.levels} level(s) → ${f.file}`),
      ];
      if (result.missing.length) lines.push(`Without decodable pixels: ${result.missing.join(', ')}`);
      return { content: [{ type: "text" as const, text: lines.join('\n') }, { type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "txd_save",
  "Write an edited dictionary back to disk: to its own file (a .bak copy is made first), to a new .txd (out), or into a VER2 .img archive (img + entry — rewritten in place, or appended when it needs more sectors, and never touching the other entries). The written bytes are parsed back before the result is reported. With discard=true the workspace is dropped without saving.",
  {
    txd: z.string().optional().describe('Open dictionary id/path (or a .txd path to open on the fly)'),
    out: z.string().optional().describe('Write to this .txd path instead of the file the dictionary came from'),
    img: z.string().optional().describe('Write into this VER2 .img archive instead'),
    entry: z.string().optional().describe('The archive entry to replace (default: the entry the dictionary was opened from)'),
    backup: z.boolean().optional().describe('Copy the previous file to <file>.bak first (default true)'),
    discard: z.boolean().optional().describe('Throw the workspace away instead of saving it'),
  },
  async ({ txd, out, img, entry, backup, discard }) => {
    try {
      ensureRoot();
      if (!txd) return { content: [{ type: "text" as const, text: 'Error: pass txd (the dictionary to save)' }], isError: true };
      if (discard) {
        const message = txdEditor.discard(txd);
        return { content: [{ type: "text" as const, text: message }] };
      }
      const result: TxdSaveResult = await txdEditor.save(txd, { out, img, entry, backup: backup !== false });
      const lines = result.target === 'img'
        ? [
          `Wrote ${result.textures} texture(s) into ${result.file} (entry ${entry ?? 'as opened'}, ${result.bytes} bytes, sector ${result.sector}, ${result.sectors} sectors, ${result.mode})`,
        ]
        : [
          `Saved ${result.file} — ${result.textures} texture(s), ${result.bytes} bytes${result.backup ? `, previous file copied to ${result.backup}` : ''}`,
        ];
      if (result.warnings.length) lines.push(...result.warnings.map((w) => `Note: ${w}`));
      lines.push('Run txd_scan (and textdraw_preview/model_preview) to refresh anything that renders these textures.');
      return { content: [{ type: "text" as const, text: lines.join('\n') }, { type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

/** One dictionary as the txd_* tools report it: a header plus one line per texture. */
function formatTxdWorkspace(workspace: TxdWorkspaceInfo): string {
  const lines = [
    `${workspace.id} — ${workspace.textures.length} texture(s), ${workspace.version}, device id ${workspace.deviceId}`,
    `  on disk ${workspace.sourceBytes} bytes${workspace.outputBytes === workspace.sourceBytes ? ' (saving changes nothing)' : `, ${workspace.outputBytes} bytes if saved now`}${workspace.dirty ? ' · UNSAVED changes' : ''}`,
  ];
  for (const texture of workspace.textures as TxdTextureInfo[]) {
    const size = texture.width > 0 ? `${texture.width}x${texture.height}` : '    ?    ';
    const dxt = texture.format.startsWith('DXT') ? `, ${texture.quality} quality` : '';
    lines.push(`  ${texture.name} — ${size} ${texture.format}${dxt}, ${texture.levels} level(s), ${texture.bytes} B${texture.dirty ? ' (edited)' : ''}${texture.error ? ` · ${texture.error}` : ''}`);
  }
  if (workspace.notes.length) lines.push(...workspace.notes.map((note) => `Note: ${note}`));
  return lines.join('\n');
}

/** 0xRRGGBBAA / #RRGGBB(AA) → RGBA byte tuple for the model renderer. */
function parseBackground(value: string): [number, number, number, number] | null {
  const trimmed = value.trim();
  const cssOrder = trimmed.startsWith('#');
  const text = trimmed.replace(/^#/, '').replace(/^0x/i, '');
  const hex = /^[0-9a-f]{6}$/i.test(text) ? text + 'FF'
    : /^[0-9a-f]{8}$/i.test(text) ? (cssOrder ? text.slice(6, 8) + text.slice(0, 6) : text)
    : null;
  if (!hex) return null;
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
    parseInt(hex.slice(6, 8), 16),
  ];
}

server.tool(
  "model_scan",
  "Find the 3D models this server can show in a font 5 textdraw preview: loose .dff files (and their .txd dictionaries), models inside VER2 .img archives (gta3.img / samp.img), and the AddSimpleModel model ids the textdraw projects reference. Parses each .dff (clumps, atomics, frames, vertices, triangles, materials, texture names) and writes an index under .samp-mcp/textdraws/model-index.json.",
  {
    dir: z.string().optional().describe('Directory to scan (default: the server root)'),
    depth: z.number().optional().describe('How many directory levels to descend (default 3)'),
    limit: z.number().optional().describe('Maximum number of .dff files to read (default 200)'),
    img: z.string().optional().describe('Also index this .img archive (default: every .img found near the root, e.g. models/gta3.img)'),
  },
  async ({ dir, depth, limit, img }) => {
    try {
      ensureRoot();
      const result = await models.scan({ dir, depth: depth ?? 3, limit: limit ?? 200, img });
      const lines = [`Scanned ${result.scannedFiles} .dff file(s) · index: ${result.indexFile}`];
      for (const dff of result.dffs.slice(0, 40)) {
        lines.push(`  ${dff.file} — ${dff.stats.vertices} verts, ${dff.stats.triangles} tris, ${dff.stats.materials} materials, ${dff.stats.dummies} dummies${dff.modelIds.length ? ` · model ids ${dff.modelIds.join(',')}` : ''}${dff.textures.length ? ` · textures ${dff.texturesFound.length}/${dff.textures.length}` : ''}`);
      }
      for (const archive of result.archives) {
        lines.push(`  archive ${archive.file} (VER${archive.version}) — ${archive.entries} entries, ${archive.listed.length} .dff listed${archive.error ? ` · ${archive.error}` : ''}`);
      }
      for (const warning of result.warnings) lines.push(`  ! ${warning}`);
      return {
        content: [
          { type: "text" as const, text: lines.join('\n') },
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ]
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "model_preview",
  "Render a GTA model (.dff, with its .txd textures) to a PNG the way a font 5 textdraw shows it, without starting the game: pass a model id (from AddSimpleModel / <id>.dff), a file path, or a bare name (also searched inside indexed .img archives). Renders with TextDrawSetPreviewRot semantics (rot, zoom, vehicle colours) and saves the result to .samp-mcp/textdraw-assets/models so textdraw_preview picks it up.",
  {
    model: z.union([z.number(), z.string()]).optional().describe('Model id (e.g. 411), a .dff path, or a model name (searched on disk and in .img archives)'),
    file: z.string().optional().describe('Explicit .dff path (alternative to model)'),
    rot: z.array(z.number()).optional().describe('[rx, ry, rz] like TextDrawSetPreviewRot (degrees; rx tilts, rz yaws)'),
    zoom: z.number().optional().describe('Preview zoom (TextDrawSetPreviewRot zoom, default 1)'),
    vehCol: z.array(z.number()).optional().describe('[primary, secondary] vehicle colours for models whose materials mark body parts'),
    width: z.number().optional().describe('Output width in pixels (default 256, max 1024)'),
    height: z.number().optional().describe('Output height in pixels (default: same as width)'),
    background: z.string().optional().describe('Background colour (0xRRGGBBAA / #RRGGBB); omit for transparency'),
    yaw: z.number().optional().describe('Camera orbit around the model in degrees (default 40, 0 = straight at the front)'),
    pitch: z.number().optional().describe('Camera elevation in degrees (default 20)'),
    txd: z.string().optional().describe('Force a texture dictionary name when the material textures live elsewhere'),
    saveAs: z.string().optional().describe('Asset file name to save as (default: the model id or model name)'),
  },
  async ({ model, file, rot, zoom, vehCol, width, height, background, yaw, pitch, txd, saveAs }) => {
    try {
      ensureRoot();
      const ref = file || (model === undefined ? '' : String(model));
      if (!ref) return { content: [{ type: "text" as const, text: 'Error: pass model (id/name) or file (.dff path)' }], isError: true };
      const rgba = background ? parseBackground(background) : null;
      const result = await models.preview(ref, {
        rot: rot ? [rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0] : undefined,
        zoom,
        vehCol: vehCol && vehCol.length >= 2 ? [vehCol[0], vehCol[1]] : undefined,
        width: width ?? 256,
        height: height ?? width ?? 256,
        background: rgba,
        cameraYaw: yaw,
        cameraPitch: pitch,
        txd,
        saveAs,
      });
      const lines = [
        `Model: ${result.model} (${result.source})`,
        `PNG: ${result.file} · ${result.width}x${result.height} · ${result.bytes} bytes`,
        `Mesh: ${result.mesh.vertices} vertices · ${result.mesh.triangles} triangles · ${result.mesh.materials} materials (${result.mesh.texturedMaterials} textured)`,
        `Model: ${result.stats.atomics} atomics · ${result.stats.frames} frames (${result.stats.dummies} dummies) · ${result.stats.materials} materials${result.stats.skinned ? ' · skinned' : ''}`, 
        `Render: rot ${result.render.rot.map((v) => v.toFixed(1)).join('/')} zoom ${result.render.zoom} · ${result.render.drawn} triangles visible · ${(result.render.coverage * 100).toFixed(1)}% covered`,
        result.textures.used.length ? `Textures drawn: ${result.textures.used.join(', ')}` : 'Textures drawn: none (untextured materials)',
        result.textures.missing.length ? `Textures without a .txd/PNG: ${result.textures.missing.join(', ')}` : 'All material textures resolved.',
        result.warnings.length ? `Warnings:\n${result.warnings.join('\n')}` : 'Warnings: none.',
        'A font 5 textdraw using this model id (or the saveAs name) now shows this PNG in textdraw_preview.',
      ];
      return { content: [{ type: "text" as const, text: lines.join('\n') }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
    }
  }
);

server.tool(
  "model_export",
  "Export a GTA model for external tools: Wavefront OBJ + MTL, or glTF 2.0, with every resolved .txd/PNG texture written next to it as a PNG. Use it to inspect or edit a model in Blender/three.js, or to check that a custom .dff/.txd pair looks right.",
  {
    model: z.union([z.number(), z.string()]).optional().describe('Model id, a .dff path, or a model name (also searched inside indexed .img archives)'),
    file: z.string().optional().describe('Explicit .dff path (alternative to model)'),
    format: z.enum(["obj", "gltf"]).optional().describe('obj (default, + MTL) or gltf (glTF 2.0 JSON)'),
    out: z.string().optional().describe('Output directory (default .samp-mcp/model-export/<model>)'),
    txd: z.string().optional().describe('Force a texture dictionary name'),
  },
  async ({ model, file, format, out, txd }) => {
    try {
      ensureRoot();
      const ref = file || (model === undefined ? '' : String(model));
      if (!ref) return { content: [{ type: "text" as const, text: 'Error: pass model (id/name) or file (.dff path)' }], isError: true };
      const result = await models.exportModel(ref, { format: format === 'gltf' ? 'gltf' : 'obj', out, txd });
      const lines = [
        `Exported ${result.model} (${result.source}) as ${result.format}`,
        ...result.files.map((f) => `  ${f}`),
        `Mesh: ${result.mesh.vertices} vertices · ${result.mesh.triangles} triangles · ${result.mesh.materials} materials`,
        result.textures.exported.length ? `Textures exported: ${result.textures.exported.join(', ')}` : 'Textures exported: none',
        result.textures.missing.length ? `Textures without a .txd/PNG: ${result.textures.missing.join(', ')}` : 'All material textures resolved.',
      ];
      return { content: [{ type: "text" as const, text: lines.join('\n') }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
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
2. For ALL file reads/writes/edits on .pwn/.inc/.cfg/logs, use samp-mcp's file_* tools (file_read/file_write/file_edit/file_grep — delegated to encoding-aware mcp-file-tools) — never plain editors that would corrupt Windows-874 Thai.
3. Use the 'aaa_mandatory_read_first_guidelines' tool to see the full project rules.
4. Keep the original language — do NOT translate existing strings.${p.hasSystemModules ? `\n5. When building NEW systems/features, follow the project's module pattern: ONE module under gamemodes/includes/system (use generate_boilerplate type=module/job/autofarm and design_feature, which now emit module-aware plans), register it in gamemodes/main.pwn, and never put gameplay logic in main.pwn.` : ''}
5. HUD/UI work goes through the textdraw editor: textdraw_create / textdraw_update / textdraw_import keep the design in a project file, textdraw_preview shows it on a web page (serve=true = draggable, saveable editor, drag a model preview to orbit it), txd_scan decodes .txd dictionaries for font 4 sprites, model_scan/model_preview/model_export handle the 3D side (loose .dff/.txd, .img archives, font 5 previews), textdraw_export emits the Pawn code (mode=module for a system module). Custom textures are built with the TXD editor: txd_open / txd_import_texture / txd_texture / txd_export_texture / txd_save edit a .txd (or a dictionary inside a .img) in place.`
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
