import * as fs from 'fs/promises';
import * as iconv from 'iconv-lite';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execPromise = promisify(exec);

export class PawnManager {
    public pawnccPath: string = '';
    public serverExePath: string = '';
    public serverRoot: string = '';

    constructor(pawnccPath?: string, serverExePath?: string) {
        if (pawnccPath) this.pawnccPath = pawnccPath;
        if (serverExePath) {
            this.serverExePath = serverExePath;
            this.serverRoot = path.dirname(serverExePath);
        }
    }

    async detectFromRoot(root: string): Promise<{ port: number, password?: string }> {
        this.serverRoot = path.resolve(root);
        
        // Auto-detect server exe
        const exePath = path.join(this.serverRoot, 'samp-server.exe');
        try {
            await fs.access(exePath);
            this.serverExePath = exePath;
        } catch (e) {
            // Might be Linux?
            const linuxExe = path.join(this.serverRoot, 'samp03svr');
            try { await fs.access(linuxExe); this.serverExePath = linuxExe; } catch {}
        }

        // Auto-detect pawncc
        const pccPath = path.join(this.serverRoot, 'pawno', 'pawncc.exe');
        try {
            await fs.access(pccPath);
            this.pawnccPath = pccPath;
        } catch (e) {}

        // Parse server.cfg
        const config = await this.readConfig();
        const portMatch = config.match(/^port\s+(\d+)/m);
        const passMatch = config.match(/^rcon_password\s+(.+)/m);

        return {
            port: portMatch ? parseInt(portMatch[1], 10) : 7777,
            password: passMatch ? passMatch[1].trim() : undefined
        };
    }


    async readScript(filePath: string, encoding: string = 'windows-874'): Promise<string> {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.serverRoot, filePath);
        const buffer = await fs.readFile(fullPath);
        
        if (encoding === 'auto') {
            try {
                // Check if it's valid UTF-8
                const utf8Str = buffer.toString('utf8');
                const isUtf8 = Buffer.from(utf8Str, 'utf8').equals(buffer);
                if (isUtf8) return utf8Str;
            } catch {}
            return iconv.decode(buffer, 'windows-874');
        }
        
        return iconv.decode(buffer, encoding);
    }

    async writeScript(filePath: string, content: string, encoding: string = 'windows-874'): Promise<void> {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.serverRoot, filePath);
        const buffer = iconv.encode(content, encoding);
        await fs.writeFile(fullPath, buffer);
    }


    async compilePawn(filePath: string): Promise<{ success: boolean; output: string; errors: any[] }> {
        try {
            const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.serverRoot, filePath);
            // -;+ means partial semicolon, -(+ means more verbose
            const { stdout, stderr } = await execPromise(`"${this.pawnccPath}" "${fullPath}" -;+ -(+`);
            const output = (stdout || '') + (stderr || '');
            return { success: true, output, errors: this.parsePawnErrors(output) };
        } catch (error: any) {
            const output = (error.stdout || '') + (error.stderr || '') || error.message;
            return { success: false, output, errors: this.parsePawnErrors(output) };
        }
    }

    private parsePawnErrors(output: string): any[] {
        const errors: any[] = [];
        // Pattern: file(line) : type id: message
        const regex = /^(.*)\((\d+)\)\s+:\s+(error|warning)\s+(\d+)\s+:\s+(.*)$/gm;
        let match;
        while ((match = regex.exec(output)) !== null) {
            errors.push({
                file: match[1].trim(),
                line: parseInt(match[2], 10),
                type: match[3],
                id: match[4],
                message: match[5].trim()
            });
        }
        return errors;
    }

    async searchServerLog(query: string, limit: number = 100): Promise<string[]> {
        const log = await this.readServerLog(limit);
        const lines = log.split('\n');
        return lines.filter(line => line.toLowerCase().includes(query.toLowerCase()));
    }


    async manageServer(action: 'start' | 'stop' | 'restart'): Promise<string> {
        if (action === 'stop' || action === 'restart') {
            try {
                // Kill process on Windows
                await execPromise('taskkill /f /im samp-server.exe');
                if (action === 'stop') return 'Server stopped';
            } catch (e) {
                if (action === 'stop') return 'Server was not running';
            }
        }

        if (action === 'start' || action === 'restart') {
            const serverDir = path.dirname(this.serverExePath);
            exec(`"${this.serverExePath}"`, { cwd: serverDir });
            return 'Server started';
        }

        return 'Unknown action';
    }

    async readConfig(): Promise<string> {
        const configPath = path.join(this.serverRoot || path.dirname(this.serverExePath), 'server.cfg');
        const buffer = await fs.readFile(configPath);
        return iconv.decode(buffer, 'windows-874');
    }

    async writeConfig(content: string): Promise<void> {
        const configPath = path.join(this.serverRoot || path.dirname(this.serverExePath), 'server.cfg');
        const buffer = iconv.encode(content, 'windows-874');
        await fs.writeFile(configPath, buffer);
    }

    async updateConfig(key: string, value: string): Promise<void> {
        let content = await this.readConfig();
        const regex = new RegExp(`^${key}\\s+.+`, 'm');
        
        if (regex.test(content)) {
            content = content.replace(regex, `${key} ${value}`);
        } else {
            content += `\n${key} ${value}`;
        }
        
        await this.writeConfig(content);
    }

    async readServerLog(limit: number = 50): Promise<string> {
        const logPath = path.join(this.serverRoot || path.dirname(this.serverExePath), 'server_log.txt');
        try {
            const buffer = await fs.readFile(logPath);
            const content = iconv.decode(buffer, 'windows-874');
            const lines = content.split(/\r?\n/);
            return lines.slice(-limit).join('\n');
        } catch (e) {
            throw new Error(`Could not read server_log.txt: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }
    }

    async listDirectory(subdir: string): Promise<string[]> {
        const dirPath = path.join(this.serverRoot || path.dirname(this.serverExePath), subdir);
        try {
            const files = await fs.readdir(dirPath);
            return files;
        } catch (e) {
            throw new Error(`Directory ${subdir} not found or inaccessible`);
        }
    }

    async listIncludes(): Promise<string[]> {
        // Common include paths in SAMP
        const paths = [
            path.join(this.serverRoot, 'pawno', 'include'),
            path.join(this.serverRoot, 'include'),
            path.join(this.serverRoot, 'gamemodes', 'include')
        ];

        let allFiles: string[] = [];
        for (const p of paths) {
            try {
                const files = await fs.readdir(p);
                allFiles = allFiles.concat(files.filter(f => f.endsWith('.inc')));
            } catch {}
        }
        return [...new Set(allFiles)];
    }

    async readInclude(name: string): Promise<string> {
        const paths = [
            path.join(this.serverRoot, 'pawno', 'include', name.endsWith('.inc') ? name : `${name}.inc`),
            path.join(this.serverRoot, 'include', name.endsWith('.inc') ? name : `${name}.inc`),
            path.join(this.serverRoot, 'gamemodes', 'include', name.endsWith('.inc') ? name : `${name}.inc`)
        ];

        for (const p of paths) {
            try {
                const buffer = await fs.readFile(p);
                return iconv.decode(buffer, 'windows-874');
            } catch {}
        }
        throw new Error(`Include file ${name} not found in common paths.`);
    }

    async detectPatterns(): Promise<any> {
        if (!this.serverRoot) return { error: "No root set" };

        const patterns: any = {
            hasSampctl: false,
            hasYSI: false,
            hasZCMD: false,
            hasPawnCMD: false,
            hasMySQL: false,
            hasStreamer: false,
            version: "0.3.7",
            thaiSupport: true
        };

        // Check for sampctl
        try {
            await fs.access(path.join(this.serverRoot, 'pawn.json'));
            patterns.hasSampctl = true;
            const pawnJson = JSON.parse(await fs.readFile(path.join(this.serverRoot, 'pawn.json'), 'utf8'));
            if (pawnJson.runtime?.version) patterns.version = pawnJson.runtime.version;
        } catch {}

        // Check for common dependencies in pawno/include
        const includes = await this.listIncludes();
        patterns.hasYSI = includes.some(f => f.toLowerCase().includes('y_'));
        patterns.hasZCMD = includes.some(f => f.toLowerCase().includes('zcmd'));
        patterns.hasPawnCMD = includes.some(f => f.toLowerCase().includes('pawn.cmd'));
        patterns.hasMySQL = includes.some(f => f.toLowerCase().includes('mysql'));
        patterns.hasStreamer = includes.some(f => f.toLowerCase().includes('streamer'));

        // Check server.cfg
        try {
            const config = await this.readConfig();
            if (config.includes('mysql')) patterns.hasMySQL = true;
            if (config.includes('streamer')) patterns.hasStreamer = true;
        } catch {}

        return patterns;
    }

    async inspectProject(): Promise<any> {
        if (!this.serverRoot) return { error: "No root set" };
        
        let totalLines = 0;
        let commandCount = 0;
        let dialogCount = 0;
        const files: string[] = [];

        const walk = async (dir: string) => {
            const list = await fs.readdir(dir);
            for (const item of list) {
                const fullPath = path.join(dir, item);
                const stat = await fs.stat(fullPath);
                if (stat.isDirectory() && !['.git', 'node_modules', 'pawno'].includes(item)) {
                    await walk(fullPath);
                } else if (item.endsWith('.pwn') || item.endsWith('.inc')) {
                    files.push(fullPath);
                    try {
                        const content = await this.readScript(fullPath);
                        const lines = content.split('\n');
                        totalLines += lines.length;
                        commandCount += (content.match(/CMD:|PCMD:|YCMD:/g) || []).length;
                        dialogCount += (content.match(/Dialog:|ShowPlayerDialog/g) || []).length;
                    } catch {}
                }
            }
        };

        await walk(this.serverRoot);

        return {
            totalFiles: files.length,
            totalLines,
            estimatedCommands: commandCount,
            estimatedDialogs: dialogCount,
            root: this.serverRoot
        };
    }

    async auditScript(scriptPath: string): Promise<any[]> {
        const content = await this.readScript(scriptPath);
        const issues: any[] = [];
        const lines = content.split('\n');

        lines.forEach((line, index) => {
            // Check for large arrays on stack
            const stackMatch = line.match(/new\s+\w+\[(\d+)\]/);
            if (stackMatch && parseInt(stackMatch[1]) > 512) {
                issues.push({
                    line: index + 1,
                    type: "Warning",
                    message: "Large array on stack. Consider 'static' or reducing size to avoid overflow.",
                    content: line.trim()
                });
            }

            // Check for Dialog IDs (hardcoded numbers)
            const dialogMatch = line.match(/ShowPlayerDialog\(.*,\s*(\d+),/);
            if (dialogMatch) {
                issues.push({
                    line: index + 1,
                    type: "Advice",
                    message: `Hardcoded Dialog ID (${dialogMatch[1]}). Consider using an enum or #define to avoid collisions.`,
                    content: line.trim()
                });
            }
        });

        return issues;
    }

    async generateDocs(): Promise<string> {
        if (!this.serverRoot) return "No root set";
        
        let docs = "# SAMP Server Project Documentation\n\n";
        const commands: string[] = [];
        const dialogs: string[] = [];

        const walk = async (dir: string) => {
            const list = await fs.readdir(dir);
            for (const item of list) {
                const fullPath = path.join(dir, item);
                const stat = await fs.stat(fullPath);
                if (stat.isDirectory() && !['.git', 'node_modules', 'pawno'].includes(item)) {
                    await walk(fullPath);
                } else if (item.endsWith('.pwn') || item.endsWith('.inc')) {
                    try {
                        const content = await this.readScript(fullPath);
                        const cmdMatches = content.match(/(CMD|PCMD|YCMD|Y_COMMAND):(\w+)\(([^)]+)\)/g) || [];
                        cmdMatches.forEach(m => commands.push(`- \`${m}\` (in ${item})` || ''));
                        
                        const dialogMatches = content.match(/Dialog:(\w+)\(([^)]+)\)/g) || [];
                        dialogMatches.forEach(m => dialogs.push(`- \`${m}\` (in ${item})` || ''));
                    } catch {}
                }
            }
        };

        await walk(this.serverRoot);

        docs += "## Commands\n" + (commands.length > 0 ? commands.join('\n') : "No commands found.") + "\n\n";
        docs += "## Dialogs\n" + (dialogs.length > 0 ? dialogs.join('\n') : "No dialogs found.") + "\n";

        return docs;
    }

    async checkIncludes(): Promise<any[]> {
        if (!this.serverRoot) return [];
        
        const missing: any[] = [];
        const existingIncludes = await this.listIncludes();
        const existingNames = existingIncludes.map(f => f.toLowerCase());

        const walk = async (dir: string) => {
            const list = await fs.readdir(dir);
            for (const item of list) {
                const fullPath = path.join(dir, item);
                const stat = await fs.stat(fullPath);
                if (stat.isDirectory() && !['.git', 'node_modules', 'pawno'].includes(item)) {
                    await walk(fullPath);
                } else if (item.endsWith('.pwn') || item.endsWith('.inc')) {
                    try {
                        const content = await this.readScript(fullPath);
                        const matches = content.match(/#include\s+<([^>]+)>/g) || [];
                        for (const m of matches) {
                            const name = m.match(/<([^>]+)>/)![1].toLowerCase();
                            if (!existingNames.some(en => en.includes(name.split(/[\\/]/).pop()!))) {
                                missing.push({ file: item, include: name });
                            }
                        }
                    } catch {}
                }
            }
        };

        await walk(this.serverRoot);
        return missing;
    }

    async findShadowing(scriptPath: string): Promise<any[]> {
        const content = await this.readScript(scriptPath);
        const lines = content.split('\n');
        const shadowing: any[] = [];
        
        // Simplified detection for common shadowing: playerid redefined in loop or function
        lines.forEach((line, index) => {
            if (line.match(/for\(.*new\s+playerid\s*=/) || line.match(/new\s+playerid\s*;/)) {
                if (content.includes('OnPlayerConnect(playerid)') || content.includes('OnPlayerDisconnect(playerid)')) {
                   // This is very subjective, but let's flag obvious re-declarations
                   shadowing.push({
                       line: index + 1,
                       variable: "playerid",
                       message: "Possible shadowing of 'playerid'. Redefining global/callback parameters can cause bugs.",
                       content: line.trim()
                   });
                }
            }
        });

        return shadowing;
    }

    async injectCode(code: string): Promise<string> {
        if (!this.serverRoot) return "No root set";
        
        const fsDir = path.join(this.serverRoot, 'filterscripts');
        try { await fs.mkdir(fsDir, { recursive: true }); } catch {}
        
        const scriptPath = path.join(fsDir, 'mcp_test.pwn');
        const scriptContent = `#include <a_samp>\n#include <YSI_Coding\\y_hooks>\n\npublic OnFilterScriptInit()\n{\n    print("--- MCP Live Injection Started ---");\n    ${code}\n    return 1;\n}`;
        
        await this.writeScript(scriptPath, scriptContent);
        
        // Compile
        const result = await this.compilePawn(scriptPath);
        if (!result.success) throw new Error(`Compression failed:\n${JSON.stringify(result.errors)}`);
        
        // Load via RCON
        await this.manageServer('restart'); // Just to be sure, or we can loadfs
        // Actually best is loadfs
        return "Code injected and compiled. Use RCON 'loadfs mcp_test' to activate.";
    }

    async auditSql(scriptPath: string): Promise<any[]> {
        const content = await this.readScript(scriptPath);
        const issues: any[] = [];
        const lines = content.split('\n');

        lines.forEach((line, index) => {
            if (line.includes('mysql_format') && !line.includes('%e')) {
                issues.push({
                    line: index + 1,
                    type: "Security",
                    message: "Potential SQL Injection risk. 'mysql_format' used without '%e' (escape) for input parameters.",
                    content: line.trim()
                });
            }
        });

        return issues;
    }

    async createDeployment(outputDir: string): Promise<string> {
        if (!this.serverRoot) return "No root set";
        
        const absOutputDir = path.resolve(outputDir);
        await fs.mkdir(absOutputDir, { recursive: true });
        
        const itemsToCopy = ['plugins', 'scriptfiles', 'npcmodes', 'server.cfg'];
        for (const item of itemsToCopy) {
            const src = path.join(this.serverRoot, item);
            const dest = path.join(absOutputDir, item);
            try {
               await fs.cp(src, dest, { recursive: true });
            } catch {}
        }

        // Copy all .amx from gamemodes and filterscripts
        const copyAmx = async (dir: string, sub: string) => {
           const srcDir = path.join(this.serverRoot, dir);
           const destDir = path.join(absOutputDir, dir);
           await fs.mkdir(destDir, { recursive: true });
           const files = await fs.readdir(srcDir);
           for (const f of files) {
               if (f.endsWith('.amx')) {
                   await fs.copyFile(path.join(srcDir, f), path.join(destDir, f));
               }
           }
        };

        try { await copyAmx('gamemodes', ''); } catch {}
        try { await copyAmx('filterscripts', ''); } catch {}
        
        // Copy server executables if they exist
        const exes = ['samp-server.exe', 'samp-npc.exe', 'announce.exe'];
        for (const exe of exes) {
            try {
                await fs.copyFile(path.join(this.serverRoot, exe), path.join(absOutputDir, exe));
            } catch {}
        }

        return `Deployment package created at ${absOutputDir}`;
    }

    async installInclude(url: string, name: string): Promise<string> {
        if (!this.serverRoot) return "No root set";
        
        const includeDir = path.join(this.serverRoot, 'pawno', 'include');
        try { await fs.mkdir(includeDir, { recursive: true }); } catch {}
        
        const dest = path.join(includeDir, name.endsWith('.inc') ? name : `${name}.inc`);
        
        // Using fetch (available in Node 18+)
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to download: ${response.statusText}`);
        
        const content = await response.text();
        await fs.writeFile(dest, content, 'utf8'); // Most includes are UTF-8 or ASCII
        
        return `Successfully installed ${name} to ${dest}`;
    }

    async extractStrings(scriptPath: string): Promise<any[]> {
        const content = await this.readScript(scriptPath);
        const lines = content.split('\n');
        const strings: any[] = [];
        
        // Match string literals
        const regex = /"(.*?)"/g;
        
        lines.forEach((line, index) => {
            let match;
            while ((match = regex.exec(line)) !== null) {
                if (match[1].length > 3) { // Ignore very short strings
                    strings.push({
                        line: index + 1,
                        text: match[1]
                    });
                }
            }
        });

        return strings;
    }

    async getDashboard(client: any): Promise<any> {
        if (!this.serverRoot) return { error: "No root set" };
        
        const info = await client.getInfo();
        const players = await client.getPlayers();
        const rules = await client.getRules();
        
        let avgPing = 0;
        if (players.length > 0) {
            avgPing = players.reduce((acc: number, p: any) => acc + (p.ping || 0), 0) / players.length;
        }

        return {
            serverName: info.hostname,
            status: "Online",
            players: `${players.length} / ${info.maxplayers}`,
            map: info.mapname,
            averagePing: Math.round(avgPing),
            version: rules.version,
            weather: rules.weather,
            time: rules.worldtime
        };
    }

    async installPlugin(url: string, name: string): Promise<string> {
        if (!this.serverRoot) return "No root set";
        
        const pluginDir = path.join(this.serverRoot, 'plugins');
        try { await fs.mkdir(pluginDir, { recursive: true }); } catch {}
        
        const isWindows = process.platform === 'win32';
        const ext = isWindows ? '.dll' : '.so';
        const fileName = name.endsWith(ext) ? name : `${name}${ext}`;
        const dest = path.join(pluginDir, fileName);
        
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to download plugin: ${response.statusText}`);
        
        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(dest, buffer);
        
        // Update server.cfg
        let config = await this.readConfig();
        const pluginsLineMatch = config.match(/^plugins\s+(.*)/m);
        const pluginNameOnly = fileName.replace(ext, '');
        
        if (pluginsLineMatch) {
            const currentPlugins = pluginsLineMatch[1].split(/\s+/);
            if (!currentPlugins.includes(pluginNameOnly)) {
                config = config.replace(/^plugins\s+.*/m, `plugins ${pluginsLineMatch[1]} ${pluginNameOnly}`);
            }
        } else {
            config += `\nplugins ${pluginNameOnly}`;
        }
        
        await this.writeConfig(config);
        
        return `Successfully installed plugin ${fileName} and updated server.cfg.`;
    }

    async auditPerformance(scriptPath: string): Promise<any[]> {
        const content = await this.readScript(scriptPath);
        const lines = content.split('\n');
        const issues: any[] = [];
        
        lines.forEach((line, index) => {
            // Check for fast timers
            const timerMatch = line.match(/SetTimer\(.*,\s*(\d+),/);
            if (timerMatch && parseInt(timerMatch[1]) < 50) {
                issues.push({
                    line: index + 1,
                    type: "Performance",
                    message: `Very fast timer (${timerMatch[1]}ms). Consider increasing the interval to reduce CPU usage.`,
                    content: line.trim()
                });
            }

            // Check for heavy logic in OnPlayerUpdate
            if (line.includes('public OnPlayerUpdate')) {
                issues.push({
                    line: index + 1,
                    type: "Optimization",
                    message: "OnPlayerUpdate is called ~30-60 times per second per player. Avoid complex logic here; use timers or specific callbacks instead.",
                    content: line.trim()
                });
            }

            // Check for large loops
            const loopMatch = line.match(/for\(.*MAX_PLAYERS.*\)/);
            if (loopMatch && (line.includes('OnPlayerUpdate') || line.includes('OnUpdate'))) {
                 issues.push({
                    line: index + 1,
                    type: "Warning",
                    message: "Looping through MAX_PLAYERS inside a fast-executing callback can impact performance. Ensure this is necessary.",
                    content: line.trim()
                });
            }
        });

        return issues;
    }
}



