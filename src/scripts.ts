import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import iconv from 'iconv-lite';
import jschardet from 'jschardet';

const execPromise = promisify(exec);

// Keywords hinting a module is an admin command → generate_boilerplate emits the
// cmd/admin.inc style (flags:, alias:, SendAdminMessage, instant action) instead
// of the interactive progress-bar flow.
const ADMIN_COMMAND_HINTS = /(?:^|[-_.])(admin|veh|vehicle|kick|ban|mute|spec|teleport|tp|goto|destroy|respawn|delete|clear|spawn|give|heal|armour|armor|weapon|slap|freeze|unfreeze|warn|jail|unjail|restart|announce|weather)/i;

export class PawnManager {
    public pawnccPath: string = '';
    public serverExePath: string = '';
    public serverRoot: string = '';
    public preferredEncoding: string = 'windows-874';
    private cache: Map<string, { value: any; ts: number }> = new Map();
    private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

    constructor(pawnccPath?: string, serverExePath?: string) {
        if (pawnccPath) this.pawnccPath = pawnccPath;
        if (serverExePath) {
            this.serverExePath = serverExePath;
            this.serverRoot = path.dirname(serverExePath);
        }
    }

    private async readdirRecursive(dir: string, baseDir: string = dir): Promise<string[]> {
        const results: string[] = [];
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    results.push(...await this.readdirRecursive(fullPath, baseDir));
                } else {
                    results.push(path.relative(baseDir, fullPath));
                }
            }
        } catch { }
        return results;
    }

    // ---- Cache helpers ----
    private cacheGet<T>(key: string): T | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;
        if (Date.now() - entry.ts > this.CACHE_TTL_MS) {
            this.cache.delete(key);
            return undefined;
        }
        return entry.value;
    }

    private cacheSet(key: string, value: any): void {
        this.cache.set(key, { value, ts: Date.now() });
    }

    private cacheInvalidate(keyPrefix: string): void {
        for (const key of this.cache.keys()) {
            if (key.startsWith(keyPrefix)) this.cache.delete(key);
        }
    }

    async detectFromRoot(root: string): Promise<{ port: number, host?: string, password?: string }> {
        this.serverRoot = path.resolve(root);

        // Auto-detect server exe
        const exePath = path.join(this.serverRoot, 'samp-server.exe');
        try {
            await fs.access(exePath);
            this.serverExePath = exePath;
        } catch {
            // Might be Linux?
            const linuxExe = path.join(this.serverRoot, 'samp03svr');
            try { await fs.access(linuxExe); this.serverExePath = linuxExe; } catch { }
        }

        // Auto-detect pawncc
        const pccPath = path.join(this.serverRoot, 'pawno', 'pawncc.exe');
        try {
            await fs.access(pccPath);
            this.pawnccPath = pccPath;
        } catch { }

        // Parse server.cfg
        const config = await this.readConfig();
        const portMatch = config.match(/\bport\s+(\d+)/i);
        const passMatch = config.match(/\brcon_password\s+(.+)/i);
        const bindMatch = config.match(/\b(?:bind|blind)\s+([^\s\r\n]+)/i);

        const result = {
            port: portMatch ? parseInt(portMatch[1], 10) : 7777,
            host: bindMatch ? bindMatch[1].trim() : undefined,
            password: passMatch ? passMatch[1].trim() : undefined
        };

        return result;
    }


    async readScript(filePath: string, encoding?: string, startLine?: number, endLine?: number): Promise<string> {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.serverRoot, filePath);

        // Check file exists
        try {
            await fs.access(fullPath);
        } catch {
            throw new Error(`File not found: ${filePath}`);
        }

        const buffer = await fs.readFile(fullPath);

        let text: string;

        // Manual override
        if (encoding) {
            text = iconv.decode(buffer, encoding);
        } else {
            // 1. Try preferred encoding first (biased towards project consistency)
            const preferredText = iconv.decode(buffer, this.preferredEncoding);
            const hasThaiPreferred = /[\u0E00-\u0E7F]/.test(preferredText);

            if (this.preferredEncoding === 'windows-874' && hasThaiPreferred) {
                text = preferredText;
            } else {
                // 2. Smart Recovery for Thai (detect if it's UTF-8 Thai mis-saved)
                try {
                    const utf8Str = buffer.toString('utf8');
                    const isUtf8 = Buffer.from(utf8Str, 'utf8').equals(buffer);
                    if (isUtf8 && /[\u0E00-\u0E7F]/.test(utf8Str)) {
                        text = `/* [MCP ENCODING NOTE]: This file is valid UTF-8 with Thai text (many editors/plugins expect Windows-874 for this project).
   Keep it as-is unless the owner asks to convert. */\n\n${utf8Str}`;
                    } else if (isUtf8 && !hasThaiPreferred) {
                        text = utf8Str;
                    } else {
                        // 3. Fallback: Universal Detection (jschardet)
                        const detected = jschardet.detect(buffer);
                        if (detected && detected.confidence > 0.8) {
                            try { text = iconv.decode(buffer, detected.encoding); } catch { text = iconv.decode(buffer, 'windows-874'); }
                        } else {
                            text = iconv.decode(buffer, 'windows-874');
                        }
                    }
                } catch {
                    text = iconv.decode(buffer, 'windows-874');
                }
            }
        }

        // Line range filtering (1-indexed)
        if (startLine !== undefined || endLine !== undefined) {
            const lines = text.split(/\r?\n/);
            const totalLines = lines.length;
            const start = startLine !== undefined ? Math.max(1, Math.min(startLine, totalLines)) : 1;
            const end = endLine !== undefined ? Math.max(start, Math.min(endLine, totalLines)) : totalLines;
            text = lines.slice(start - 1, end).join('\n');
            text = `/* [MCP READ: lines ${start}-${end} of ${totalLines}] */\n${text}`;
        }

        return text;
    }

    private async backupFile(fullPath: string): Promise<string | null> {
        try {
            await fs.access(fullPath);
        } catch {
            return null; // File doesn't exist yet, nothing to backup
        }

        const backupDir = path.join(this.serverRoot, '.samp-mcp-backups');
        await fs.mkdir(backupDir, { recursive: true });

        const relativePath = path.relative(this.serverRoot, fullPath);
        const safeName = relativePath.replace(/[\\/]/g, '_');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `${safeName}.${timestamp}.bak`;
        const backupPath = path.join(backupDir, backupName);

        await fs.copyFile(fullPath, backupPath);
        return backupPath;
    }

    async writeScript(filePath: string, content: string, encoding?: string, startLine?: number, endLine?: number): Promise<string> {
        const enc = encoding || this.preferredEncoding;
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.serverRoot, filePath);
        let finalContent = content;

        // Partial edit mode: replace specific line range
        if (startLine !== undefined || endLine !== undefined) {
            // Check file exists before partial edit
            try {
                await fs.access(fullPath);
            } catch {
                throw new Error(`Cannot perform partial edit: file does not exist: ${filePath}. Use writeScript without line numbers to create the file.`);
            }

            const existingBuffer = await fs.readFile(fullPath);
            const existingText = iconv.decode(existingBuffer, enc);
            const existingLines = existingText.split(/\r?\n/);
            const totalLines = existingLines.length;
            const newLines = content.split(/\r?\n/);

            // Validate line numbers
            const start = startLine !== undefined ? Math.max(1, Math.min(startLine, totalLines)) : 1;
            // If endLine not provided, replace only the single startLine (NOT to end of file)
            const end = endLine !== undefined ? Math.max(start, Math.min(endLine, totalLines)) : start;

            if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
                throw new Error(`Invalid line range: startLine (${startLine}) > endLine (${endLine})`);
            }

            const before = existingLines.slice(0, start - 1);
            const after = existingLines.slice(end);
            finalContent = [...before, ...newLines, ...after].join('\n');
        }

        const backupPath = await this.backupFile(fullPath);
        const buffer = iconv.encode(finalContent, enc);
        await fs.writeFile(fullPath, buffer);

        // Invalidate project cache if Pawn files changed
        if (fullPath.endsWith('.pwn') || fullPath.endsWith('.inc')) {
            this.cacheInvalidate('project:');
        }

        return backupPath || 'No backup needed (new file)';
    }

    async compilePawn(filePath: string): Promise<{ success: boolean; output: string; errors: any[] }> {
        try {
            const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.serverRoot, filePath);
            // pawncc writes the .amx into its current working directory, so run it
            // from the script's folder to keep output next to the source file.
            const sourceDir = path.dirname(fullPath);
            // -;+ means partial semicolon, -(+ means more verbose
            const { stdout, stderr } = await execPromise(`"${this.pawnccPath}" "${fullPath}" -;+ -(+`, { cwd: sourceDir });
            const output = (stdout || '') + (stderr || '');
            return { success: true, output, errors: this.parsePawnErrors(output) };
        } catch (error: any) {
            const output = (error.stdout || '') + (error.stderr || '') || error.message;
            return { success: false, output, errors: this.parsePawnErrors(output) };
        }
    }

    private parsePawnErrors(output: string): any[] {
        const errors: any[] = [];
        // Pattern per line: file(line) : error/warning id: message
        // pawncc on Windows emits CRCRLF; strip trailing CRs and match line by line.
        const regex = /^(.*)\((\d+)\)\s*:\s*(error|warning)\s+(\d+)\s*:\s*(.*)$/;
        for (const rawLine of output.split(/\r?\n/)) {
            const line = rawLine.replace(/\r+$/, '');
            const match = regex.exec(line);
            if (match) {
                errors.push({
                    file: match[1].trim(),
                    line: parseInt(match[2], 10),
                    type: match[3],
                    id: match[4],
                    message: match[5].trim()
                });
            }
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
            } catch {
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
        } catch {
            throw new Error(`Directory ${subdir} not found or inaccessible`);
        }
    }

    async listIncludes(): Promise<string[]> {
        const cached = this.cacheGet<string[]>('includes:list');
        if (cached) return cached;

        const paths = [
            path.join(this.serverRoot, 'pawno', 'include'),
            path.join(this.serverRoot, 'include'),
            path.join(this.serverRoot, 'gamemodes', 'include')
        ];

        let allFiles: string[] = [];
        for (const p of paths) {
            try {
                const files = await this.readdirRecursive(p);
                allFiles = allFiles.concat(files.filter(f => f.endsWith('.inc')));
            } catch { }
        }
        const result = [...new Set(allFiles)];
        this.cacheSet('includes:list', result);
        return result;
    }

    async detectPatterns(): Promise<any> {
        if (!this.serverRoot) return { error: "No root set" };

        const cached = this.cacheGet<any>('project:patterns');
        if (cached) return cached;

        const patterns: any = {
            hasSampctl: false,
            hasYSI: false,
            hasZCMD: false,
            hasPawnCMD: false,
            hasMySQL: false,
            hasStreamer: false,
            version: "0.3.7",
            thaiSupport: false,
            architecture: 'monolithic',
            hasSystemModules: false,
            systemModuleCount: 0,
            systemCategories: [],
            hasStartProgress: false,
            hasCommandFlags: false,
            hasDialogConvention: false,
            messageHelpers: []
        };

        // Check for sampctl
        try {
            await fs.access(path.join(this.serverRoot, 'pawn.json'));
            patterns.hasSampctl = true;
            const pawnJson = JSON.parse(await fs.readFile(path.join(this.serverRoot, 'pawn.json'), 'utf8'));
            if (pawnJson.runtime?.version) patterns.version = pawnJson.runtime.version;
        } catch { }

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

            // Check for Thai characters in hostname or other fields
            if (/[\u0E00-\u0E7F]/.test(config)) {
                patterns.thaiSupport = true;
            }
        } catch { }

        // Detect module-based architecture (gamemodes/includes/system/*.inc)
        patterns.hasSystemModules = false;
        patterns.systemModuleCount = 0;
        patterns.systemCategories = [];
        patterns.hasStartProgress = false;
        patterns.hasCommandFlags = false;
        patterns.hasDialogConvention = false;
        patterns.messageHelpers = [];

        const gmIncDir = path.join(this.serverRoot, 'gamemodes', 'includes');
        try {
            const gmTop = await fs.readdir(gmIncDir);
            if (gmTop.includes('system')) {
                patterns.hasSystemModules = true;
                patterns.architecture = 'system-modules';
                const sysRoot = path.join(gmIncDir, 'system');
                const countModules = async (dir: string, rel: string) => {
                    const entries = await fs.readdir(dir);
                    for (const entry of entries) {
                        const full = path.join(dir, entry);
                        const st = await fs.stat(full);
                        if (st.isDirectory()) {
                            await countModules(full, rel === '' ? entry : rel + '/' + entry);
                        } else if (entry.toLowerCase().endsWith('.inc')) {
                            patterns.systemModuleCount++;
                        }
                    }
                    if (rel !== '' && !patterns.systemCategories.includes(rel)) patterns.systemCategories.push(rel);
                };
                await countModules(sysRoot, '');

                // Sample a handful of modules for the runtime conventions in use
                let sampled = 0;
                const sampleDir = async (dir: string) => {
                    const entries = await fs.readdir(dir);
                    for (const entry of entries) {
                        if (sampled >= 12) return;
                        const full = path.join(dir, entry);
                        const st = await fs.stat(full);
                        if (st.isDirectory()) {
                            await sampleDir(full);
                        } else if (entry.toLowerCase().endsWith('.inc')) {
                            sampled++;
                            const text = await this.readScript(full).catch(() => '');
                            if (/StartProgress\s*\(/.test(text)) patterns.hasStartProgress = true;
                            if (/^\s*flags\s*:\s*\w+/m.test(text)) patterns.hasCommandFlags = true;
                            if (/Dialog\s*:\s*\w+/.test(text)) patterns.hasDialogConvention = true;
                        }
                    }
                };
                await sampleDir(sysRoot);
            }
        } catch { }

        // Shared message macros (gamemodes/includes/defines.inc)
        try {
            const definesText = await this.readScript(path.join('gamemodes', 'includes', 'defines.inc')).catch(() => '');
            patterns.messageHelpers = ['SyntaxMsg', 'ServerMsg', 'ErrorMsg'].filter(m => definesText.includes(m));
        } catch { }

        // Final check: scan main.pwn or some files for Thai
        if (!patterns.thaiSupport) {
            patterns.thaiSupport = await this.detectThaiProject();
        }

        this.preferredEncoding = patterns.thaiSupport ? 'windows-874' : 'utf-8';

        this.cacheSet('project:patterns', patterns);
        return patterns;
    }

    async detectThaiProject(): Promise<boolean> {
        if (!this.serverRoot) return false;
        
        const filesToCheck = [
            'gamemodes/main.pwn', 
            'gamemodes/mode.pwn', 
            'server.cfg'
        ];
        
        for (const f of filesToCheck) {
            try {
                const content = await this.readScript(f);
                if (/[\u0E00-\u0E7F]/.test(content)) return true;
            } catch { }
        }
        
        // List some files in gamemodes and check one
        try {
            const gmFiles = await this.listDirectory('gamemodes');
            const pwnFiles = gmFiles.filter(f => f.endsWith('.pwn'));
            if (pwnFiles.length > 0) {
                const content = await this.readScript(path.join('gamemodes', pwnFiles[0]));
                if (/[\u0E00-\u0E7F]/.test(content)) return true;
            }
        } catch { }

        return false;
    }

    async inspectProject(): Promise<any> {
        if (!this.serverRoot) return { error: "No root set" };

        const cached = this.cacheGet<any>('project:inspect');
        if (cached) return cached;

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
                    } catch { }
                }
            }
        };

        await walk(this.serverRoot);

        const result = {
            totalFiles: files.length,
            totalLines,
            estimatedCommands: commandCount,
            estimatedDialogs: dialogCount,
            root: this.serverRoot
        };
        this.cacheSet('project:inspect', result);
        return result;
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
                    } catch { }
                }
            }
        };

        await walk(this.serverRoot);

        docs += "## Commands\n" + (commands.length > 0 ? commands.join('\n') : "No commands found.") + "\n\n";
        docs += "## Dialogs\n" + (dialogs.length > 0 ? dialogs.join('\n') : "No dialogs found.") + "\n";

        return docs;
    }

    async studyProject(): Promise<string> {
        if (!this.serverRoot) throw new Error("No root set. Run set_server_root first.");

        const gmDir = path.join(this.serverRoot, 'gamemodes');
        const outPath = path.join(this.serverRoot, 'SAMP_STUDY.md');

        // 1) locate the gamemode main script and parse its include graph
        let mainRel = 'gamemodes/main.pwn';
        try { await fs.access(path.join(this.serverRoot, mainRel)); }
        catch {
            let found = '';
            try {
                const list = await fs.readdir(gmDir);
                found = list.find(f => f.toLowerCase().endsWith('.pwn')) || '';
            } catch { }
            if (!found) throw new Error('No gamemode .pwn found under gamemodes/.');
            mainRel = 'gamemodes/' + found;
        }

        const mainText = await this.readScript(mainRel).catch(() => '');
        const libs: string[] = [];          // <angle> includes (libraries)
        const wired: string[] = [];         // active "local" includes, relative to gamemodes/
        for (const ln of mainText.split(/\r?\n/)) {
            const s = ln.trim();
            if (!s || s.startsWith('//') || s.startsWith('/*') || s.startsWith('*')) continue;
            const ang = s.match(/^#include\s+<([^>]+)>/);
            if (ang) { libs.push(ang[1].trim()); continue; }
            const quo = s.match(/^#include\s+"([^"]+)"/);
            if (quo) wired.push(quo[1].trim());
        }

        // 2) scan the wired files + core headers for conventions & performance stats
        const dirCount: Record<string, number> = {};
        let totalLines = 0, cmdDefs = 0, pcmdDefs = 0, ycmdDefs = 0, flagsDefs = 0;
        let dialogDefs = 0, dialogShow = 0, nativeDialog = 0, hookCount = 0;
        let tquery = 0, mysqlFormat = 0, cacheGet = 0, setTimer = 0, yTimerDefs = 0, repeatUse = 0;
        let foreachPlayer = 0, forMaxPlayers = 0, startProgress = 0, progressFinish = 0;
        let hasCmdReceived = false;
        const msgUse: Record<string, number> = {};
        const msgCands = ['ErrorMsg', 'ServerMsg', 'SyntaxMsg', 'UsageMsg', 'SuccessMsg', 'InfoMsg'];
        let stateArray = '', stateEnumName = '', stateFields: string[] = [];
        const ex: any = { cmd: '', flags: '', dialogShow: '', dialogDef: '', progressCall: '', finishHook: '', tquery: '', keyHook: '', msg: '' };
        const trunc = (x: string, n: number) => x.length > n ? x.substring(0, n) + '...' : x;

        const scanFiles: string[] = [mainRel];
        for (const rel of wired) scanFiles.push(path.join('gamemodes', rel));

        const scanFile = async (relKey: string, fullPath: string) => {
            let text: string;
            try { text = await this.readScript(fullPath); } catch { return; }
            totalLines += text.split(/\r?\n/).length;
            const d = path.dirname(relKey).replace(/^gamemodes[/\\]/, '').replace(/\\/g, '/');
            dirCount[d] = (dirCount[d] || 0) + 1;

            // per-player state array declaration (e.g. new PlayerInfo[MAX_PLAYERS][E_PLAYERS])
            if (!stateEnumName) {
                const arr = text.match(/new\s+([A-Za-z_]\w*)\[MAX_PLAYERS\]\[([A-Za-z_]\w*)\]/);
                if (arr) { stateArray = arr[1]; stateEnumName = arr[2]; }
            }

            let inBlock = false;
            for (const raw of text.split(/\r?\n/)) {
                const s = raw.trim();
                if (s.startsWith('/*')) inBlock = true;
                if (inBlock) { if (s.includes('*/')) inBlock = false; continue; }
                if (!s || s.startsWith('//') || s.startsWith('#')) continue;

                if (/^CMD:[A-Za-z_]/.test(s)) cmdDefs++;
                else if (/^PCMD:[A-Za-z_]/.test(s)) pcmdDefs++;
                else if (/^(YCMD|Y_COMMAND):[A-Za-z_]/.test(s)) ycmdDefs++;
                if (/^flags\s*:\s*\w+/.test(s)) flagsDefs++;
                if (/^Dialog\s*:\s*\w+/.test(s)) dialogDefs++;
                if (/^hook\s+\w+/.test(s)) hookCount++;
                if (/^timer\s+\w+\s*\[\s*\d+\s*\]/.test(s)) yTimerDefs++;
                if (/for\s*\(\s*new\s+i\s*=\s*0\s*;\s*i\s*<\s*MAX_PLAYERS/.test(s)) forMaxPlayers++;
                foreachPlayer += (s.match(/foreach\(new i : Player\)/g) || []).length;
                dialogShow += (s.match(/Dialog_Show\(/g) || []).length;
                nativeDialog += (s.match(/ShowPlayerDialog\(/g) || []).length;
                tquery += (s.match(/mysql_tquery\(/g) || []).length;
                mysqlFormat += (s.match(/mysql_format\(/g) || []).length;
                cacheGet += (s.match(/cache_get_value_name(?:_int|_float)?\(/g) || []).length;
                setTimer += (s.match(/SetTimer(Ex)?\(/g) || []).length;
                repeatUse += (s.match(/\brepeat\s+\w+/g) || []).length;
                startProgress += (s.match(/StartProgress\(/g) || []).length;
                if (/^hook\s+OnProgressFinish\s*\(/.test(s)) progressFinish++;
                if (/OnPlayerCommandReceived\(/.test(s)) hasCmdReceived = true;
                for (const c of msgCands) if (s.includes(c + '(')) msgUse[c] = (msgUse[c] || 0) + 1;

                if (!ex.flags && /^flags\s*:\s*\w+/.test(s)) ex.flags = trunc(raw, 140);
                if (!ex.cmd && /^CMD:[A-Za-z_]/.test(s)) ex.cmd = trunc(raw, 140);
                if (!ex.dialogShow && /Dialog_Show\(/.test(s)) ex.dialogShow = trunc(raw, 160);
                if (!ex.dialogDef && /^Dialog\s*:\s*\w+/.test(s)) ex.dialogDef = trunc(raw, 140);
                if (!ex.progressCall && /StartProgress\(/.test(s)) ex.progressCall = trunc(raw, 150);
                if (!ex.tquery && /mysql_tquery\(/.test(s) && !s.includes('%')) ex.tquery = trunc(raw, 150);
                if (!ex.msg && msgCands.some(c => s.includes(c + '('))) {
                    ex.msg = trunc(raw, 140);
                }
                if (!ex.finishHook && /^hook\s+OnProgressFinish\s*\(/.test(s)) {
                    ex.finishHook = trunc(raw, 140);
                }
                if (!ex.keyHook && /^hook\s+OnPlayerKeyStateChange\s*\(/.test(s)) {
                    ex.keyHook = trunc(raw, 140);
                }
            }
        };

        for (const rel of scanFiles) {
            const full = path.isAbsolute(rel) ? rel : path.join(this.serverRoot, rel);
            await scanFile(rel, full);
        }

        // sample fields of the per-player enum (may live in a different file than the array)
        if (stateEnumName && stateFields.length === 0) {
            for (const rel of scanFiles) {
                const full = path.isAbsolute(rel) ? rel : path.join(this.serverRoot, rel);
                let t2: string;
                try { t2 = await this.readScript(full); } catch { continue; }
                const re = new RegExp('enum\\s+' + stateEnumName + '\\s*\\{([\\s\\S]{0,6000})');
                const m = t2.match(re);
                if (m) {
                    const seen = new Set<string>();
                    const found: string[] = [];
                    for (const f of m[1].match(/[A-Za-z_]\w*(?=\s*(?:,|:))/g) || []) {
                        const base = (f.split(':').pop() || f).trim();
                        if (!seen.has(base)) { seen.add(base); found.push(base); }
                    }
                    const pFields = found.filter(x => /^p[A-Z]/.test(x));
                    const filtered = pFields.length > 0
                        ? pFields
                        : found.filter(x => !/^(Float|bool|Timer|Text3D|PlayerText3D|Iterator|bool:|Float:)$/.test(x));
                    stateFields = filtered.slice(0, 16);
                    break;
                }
            }
        }

        // 3) infer conventions
        const libText = libs.map(l => l.toLowerCase()).join(' ');
        const cmdSystem = /pawn.?cmd/.test(libText) ? 'Pawn.CMD (CMD:name / PCMD:name)'
            : /zcmd/.test(libText) ? 'ZCMD (CMD:name)'
            : /y_commands/.test(libText) ? 'YSI y_commands (CMD: / YCMD:)'
            : 'undetected (check main includes)';
        const dlgSystem = dialogShow > 0 && /easydialog/.test(libText) ? 'easyDialog (Dialog_Show + Dialog:NAME handlers)'
            : dialogDefs > 0 ? 'Dialog:-style definitions (y_dialogs-like / easyDialog)'
            : nativeDialog > 0 ? 'native ShowPlayerDialog + OnDialogResponse'
            : 'undetected';
        const modulePattern = dirCount['includes/system'] > 0 || dirCount['includes/system/job'] > 0;
        const msgs = msgCands.filter(c => (msgUse[c] || 0) > 0);

        // 4) build the markdown study
        const L: string[] = [];
        const P = (x: string) => L.push(x);
        P('# SAMP Gamemode Study');
        P('');
        P('Auto-generated by samp-mcp `study_project` against the connected server root. It reflects what this script actually uses — edit code only with encoding-aware file tools so Thai (Windows-874) and CRLF stay intact.');
        P('');
        P('## 1. Overview');
        P(`- Main script: \`${mainRel}\``);
        P(`- Wired local includes: ${wired.length} | Files scanned: ${scanFiles.length} | Lines scanned: ${totalLines.toLocaleString()}`);
        P(`- Commands defined: ${cmdDefs} CMD:${pcmdDefs > 0 ? `, ${pcmdDefs} PCMD:` : ''}${ycmdDefs > 0 ? `, ${ycmdDefs} YCMD:` : ''}${flagsDefs > 0 ? ` | ${flagsDefs} flags: permission gates` : ''}`);
        P(`- Dialogs: ${dialogDefs} Dialog: defs, ${dialogShow} Dialog_Show calls${nativeDialog > 0 ? `, ${nativeDialog} native ShowPlayerDialog` : ''}`);
        P(`- System modules pattern: ${modulePattern ? 'YES (modules under includes/system)' : 'no / undetected'}`);
        P('');
        P('## 2. Libraries (angle includes in the gamemode)');
        if (libs.length) { for (const l of libs) P(`- \`${l}\``); } else P('- (none found)');
        P('');
        P('## 3. Include layout (wired files by folder)');
        const cats = Object.keys(dirCount).sort();
        for (const c of cats) P(`- ${c || '.'}: ${dirCount[c]}`);
        P('');
        P('## 4. Command system');
        P(`- Inferred: **${cmdSystem}**`);
        P(`- Evidence: ${cmdDefs} CMD: definitions${pcmdDefs > 0 ? `, ${pcmdDefs} PCMD:` : ''}${flagsDefs > 0 ? `, ${flagsDefs} flags: declarations` : ''}${hasCmdReceived ? '; permission auto-check present (OnPlayerCommandReceived)' : ''}`);
        P(`- Convention: define \`CMD:name(playerid, params[])\` inside the owning module/file; ${flagsDefs > 0 ? 'gate admin commands with \`flags:name(CMD_xxx)\` (bits verified against the player permission bitmask)' : 'no flag-gated commands observed'}.`);
        if (ex.flags || ex.cmd) { P(''); P('```pawn'); if (ex.flags) P(ex.flags); if (ex.cmd) P(ex.cmd); P('```'); }
        P('');
        P('## 5. Dialogs');
        P(`- Inferred: **${dlgSystem}**`);
        P(`- Evidence: ${dialogDefs} \`Dialog:NAME(playerid, response, listitem, inputtext[])\` handlers, ${dialogShow} \`Dialog_Show(...)\` calls${nativeDialog > 0 ? `, ${nativeDialog} native ShowPlayerDialog calls` : ''}.`);
        if (ex.dialogShow || ex.dialogDef) { P(''); P('```pawn'); if (ex.dialogShow) P(ex.dialogShow); if (ex.dialogDef) P(ex.dialogDef); P('```'); }
        P('');
        P('## 6. Player messages & state');
        const msgList = msgs.map(m => `${m}(${(msgUse as any)[m]})`).join(', ');
        P(`- Message macros in use: ${msgList || '(none matched standard list)'}`);
        if (stateEnumName) P(`- Per-player state: \`new ${stateArray}[MAX_PLAYERS][${stateEnumName}]\` (enum ${stateEnumName}; sample fields: ${stateFields.join(', ')}). Access it as \`${stateArray}[playerid][pX]\` like the rest of the script.`);
        else P('- No per-player enum array detected — state likely lives in per-module static arrays / PVars.');
        P('');
        P('## 7. Timers, progress & async work');
        P(`- YSI timers (\`timer X[interval]\`): ${yTimerDefs} definitions | \`repeat\` usages: ${repeatUse} | legacy \`SetTimer\`: ${setTimer}`);
        P(`- Timed player actions: StartProgress calls ${startProgress}${progressFinish > 0 ? ` with ${progressFinish} \`hook OnProgressFinish\` handlers (guard by module state flag)` : ''}`);
        P(`- MySQL: \`mysql_tquery\` ${tquery} | \`mysql_format\` ${mysqlFormat} | cache reads ${cacheGet}${tquery > 0 ? ' → all DB work is threaded callbacks (cache_* inside), never blocking queries' : ''}`);
        if (ex.progressCall || ex.finishHook || ex.tquery) { P(''); P('```pawn'); if (ex.progressCall) P(ex.progressCall); if (ex.finishHook) P(ex.finishHook); if (ex.tquery) P(ex.tquery); P('```'); }
        P('');
        P('## 8. Iteration & hot paths (performance)');
        P(`- \`foreach(new i : Player)\`: ${foreachPlayer} | \`for (new i = 0; i < MAX_PLAYERS...)\`: ${forMaxPlayers} | top-level \`hook\` handlers: ${hookCount}`);
        P(`- Derived rules: ${forMaxPlayers > 0 ? 'prefer converting for(MAX_PLAYERS) loops to foreach(Player); ' : ''}use YSI timers (already ${yTimerDefs} here) and stop them on disconnect; keep OnPlayerUpdate and fast per-player callbacks light; ${tquery > 0 ? 'keep MySQL threaded (mysql_format + mysql_tquery + cache_* in callback); ' : ''}world objects/3D labels via Streamer dynamic calls; reset per-player state in OnPlayerConnect and clean up in OnPlayerDisconnect.`);
        if (ex.keyHook) { P(''); P('```pawn'); P(ex.keyHook); P('```'); }
        P('');
        P('## 9. How to add a feature here');
        if (modulePattern) {
            P(`- Create ONE self-contained module under \`gamemodes/includes/system/<name>.inc\` (or \`system/job/\` for job modules) owning its state, hooks, commands and dialogs.`);
            P('- Wire it in the gamemode main script with a quoted include in the same style as neighbours (keep dependency order).');
            P('- Follow sections 4-8: same command/dialog/message/timer/DB style as the snippets above.');
        } else {
            P('- No module layout detected: mirror the include ordering and conventions above, or let design_feature propose a structure.');
        }
        P('- All reads/writes/edits of .pwn/.inc go through encoding-aware file tools; never re-save with plain editors.');
        P('- Verify with compile_pawn before finishing.');
        P('');
        P('---');
        P('Regenerate anytime with the study_project tool (it re-scans the script).');

        const md = L.join('\n');
        await fs.writeFile(outPath, '\uFEFF' + md, 'utf8');
        return outPath;
    }

    async checkIncludes(): Promise<any[]> {
        if (!this.serverRoot) return [];

        const missing: any[] = [];
        const existingIncludes = await this.listIncludes();
        // Normalize existing names to basename for comparison
        const existingNames = existingIncludes.map(f => path.basename(f, '.inc').toLowerCase());

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
                            const baseName = path.basename(name, '.inc');
                            if (!existingNames.includes(baseName)) {
                                missing.push({ file: item, include: name });
                            }
                        }
                    } catch { }
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
        try { await fs.mkdir(fsDir, { recursive: true }); } catch { }

        const scriptPath = path.join(fsDir, 'mcp_test.pwn');
        const scriptContent = `#include <a_samp>\n#include <YSI_Coding\\y_hooks>\n\npublic OnFilterScriptInit()\n{\n    print("--- MCP Live Injection Started ---");\n    ${code}\n    return 1;\n}`;

        await this.writeScript(scriptPath, scriptContent);

        // Compile
        const result = await this.compilePawn(scriptPath);
        if (!result.success) throw new Error(`Compilation failed:\n${JSON.stringify(result.errors)}`);

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
            } catch { }
        }

        // Copy all .amx from gamemodes and filterscripts
        const copyAmx = async (dir: string, _sub: string) => {
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

        try { await copyAmx('gamemodes', ''); } catch { }
        try { await copyAmx('filterscripts', ''); } catch { }

        // Copy server executables if they exist
        const exes = ['samp-server.exe', 'samp-npc.exe', 'announce.exe'];
        for (const exe of exes) {
            try {
                await fs.copyFile(path.join(this.serverRoot, exe), path.join(absOutputDir, exe));
            } catch { }
        }

        return `Deployment package created at ${absOutputDir}`;
    }

    async installInclude(url: string, name: string): Promise<string> {
        if (!this.serverRoot) return "No root set";

        const includeDir = path.join(this.serverRoot, 'pawno', 'include');
        try { await fs.mkdir(includeDir, { recursive: true }); } catch { }

        const dest = path.join(includeDir, name.endsWith('.inc') ? name : `${name}.inc`);

        // Using fetch (available in Node 18+)
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to download: ${response.statusText}`);

        const content = await response.text();
        await fs.writeFile(dest, content, 'utf8'); // Most includes are UTF-8 or ASCII

        return `Successfully installed ${name} to ${dest}`;
    }

    async getDashboard(client: any): Promise<any> {

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
            players: `${players.length} / ${info.maxPlayers}`,
            map: info.mapname,
            averagePing: Math.round(avgPing),
            version: rules.version,
            weather: rules.weather,
            time: rules.worldtime
        };
    }

    // ---- Search & Discovery helpers ----

    private async githubSearchRepos(query: string): Promise<any[]> {
        try {
            const apiUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}`;
            const response = await fetch(apiUrl, {
                headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'SAMP-MCP' }
            });
            if (!response.ok) return [];
            const data: any = await response.json();
            return data.items || [];
        } catch { return []; }
    }

    private async githubListReleases(repo: string): Promise<any[]> {
        try {
            const apiUrl = `https://api.github.com/repos/${repo}/releases`;
            const response = await fetch(apiUrl, {
                headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'SAMP-MCP' }
            });
            if (!response.ok) return [];
            return await response.json();
        } catch { return []; }
    }

    private findBestAsset(assets: any[], nameHint: string, ext: string): any | null {
        if (!assets || assets.length === 0) return null;
        const lowerHint = nameHint.toLowerCase();
        const lowerExt = ext.toLowerCase();

        // Priority 1: name matches + correct extension
        let match = assets.find((a: any) =>
            a.name.toLowerCase().includes(lowerHint) &&
            a.name.toLowerCase().endsWith(lowerExt)
        );
        if (match) return match;

        // Priority 2: any asset with correct extension
        match = assets.find((a: any) => a.name.toLowerCase().endsWith(lowerExt));
        if (match) return match;

        // Priority 3: zip/rar/tar that might contain the binary
        const archiveExts = ['.zip', '.tar.gz', '.tgz', '.rar'];
        match = assets.find((a: any) =>
            a.name.toLowerCase().includes(lowerHint) &&
            archiveExts.some((ae: string) => a.name.toLowerCase().endsWith(ae))
        );
        if (match) return match;

        // Priority 4: any archive
        match = assets.find((a: any) =>
            archiveExts.some((ae: string) => a.name.toLowerCase().endsWith(ae))
        );
        return match || null;
    }

    private async extractPluginFromZip(zipPath: string, outputDir: string, nameHint: string, ext: string): Promise<string | null> {
        const tempDir = path.join(outputDir, `.samp-mcp-extract-${Date.now()}`);
        try {
            await fs.mkdir(tempDir, { recursive: true });

            // Cross-platform extraction
            if (process.platform === 'win32') {
                await execPromise(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force"`);
            } else {
                await execPromise(`unzip -o "${zipPath}" -d "${tempDir}"`);
            }

            // Recursively find matching binary
            const findBinary = async (dir: string): Promise<string | null> => {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullEntryPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        const found = await findBinary(fullEntryPath);
                        if (found) return found;
                    } else if (entry.name.toLowerCase().endsWith(ext)) {
                        if (!nameHint || entry.name.toLowerCase().includes(nameHint.toLowerCase())) {
                            return fullEntryPath;
                        }
                    }
                }
                // If no name match, return any binary with correct ext
                for (const entry of entries) {
                    const fullEntryPath = path.join(dir, entry.name);
                    if (!entry.isDirectory() && entry.name.toLowerCase().endsWith(ext)) {
                        return fullEntryPath;
                    }
                }
                return null;
            };

            const binaryPath = await findBinary(tempDir);
            if (!binaryPath) return null;

            const destFileName = path.basename(binaryPath);
            const destPath = path.join(outputDir, destFileName);
            await fs.copyFile(binaryPath, destPath);
            return destPath;
        } catch {
            return null;
        } finally {
            // Cleanup temp dir
            try {
                const rm = await import('fs/promises');
                await rm.rm(tempDir, { recursive: true, force: true });
            } catch { /* ignore cleanup errors */ }
        }
    }

    async searchPlugin(name: string): Promise<string> {
        const isWindows = process.platform === 'win32';
        const ext = isWindows ? '.dll' : '.so';
        const lowerName = name.toLowerCase();
        const results: string[] = [
            `[Search Results for "${name}"]`,
            ``
        ];

        // Known SA-MP plugin mappings (owner/repo)
        const knownPlugins: Record<string, string> = {
            'ysf': 'IS4Code/YSF',
            'streamer': 'samp-inc/samp-streamer-plugin',
            'sscanf': 'maddinat0r/sscanf',
            'mysql': 'pBlueG/SA-MP-MySQL',
            'pawn-regex': 'katursis/Pawn.Regex',
            'pawnraknet': 'katursis/Pawn.RakNet',
            'pawncmd': 'katursis/Pawn.CMD',
            'skycrypt': 'Southclaws/samp-logger',
            'sampctl': 'Southclaws/sampctl',
            'crashdetect': 'Zeex/samp-plugin-crashdetect',
            'mapandreas': 'Southclaws/MapAndreas',
            'nativechecker': 'Zeex/samp-plugin-nativechecker'
        };

        const reposToCheck: Array<{ full_name: string; html_url: string; description?: string }> = [];

        // 1. Check known plugins first
        if (knownPlugins[lowerName]) {
            const repoFull = knownPlugins[lowerName];
            try {
                const apiUrl = `https://api.github.com/repos/${repoFull}`;
                const resp = await fetch(apiUrl, {
                    headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'SAMP-MCP' }
                });
                if (resp.ok) {
                    const repo: any = await resp.json();
                    reposToCheck.push({ full_name: repo.full_name, html_url: repo.html_url, description: repo.description });
                    results.push(`[Known Plugin] Found canonical repo for "${name}":`);
                }
            } catch { /* ignore */ }
        }

        // 2. GitHub repo search (broader query)
        const searchQueries = [`${name} samp`, `${name} sa-mp plugin`];
        for (const q of searchQueries) {
            if (reposToCheck.length >= 3) break;
            const found = await this.githubSearchRepos(q);
            for (const repo of found) {
                if (reposToCheck.length >= 3) break;
                if (!reposToCheck.some(r => r.full_name === repo.full_name)) {
                    reposToCheck.push(repo);
                }
            }
        }

        if (reposToCheck.length > 0) {
            results.push('Repos:');
            for (const repo of reposToCheck) {
                let releaseInfo = '';
                try {
                    const relApi = `https://api.github.com/repos/${repo.full_name}/releases/latest`;
                    const relRes = await fetch(relApi, {
                        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'SAMP-MCP' }
                    });
                    if (relRes.ok) {
                        const rel: any = await relRes.json();
                        const asset = this.findBestAsset(rel.assets || [], name, ext);
                        if (asset) {
                            releaseInfo = ` → ${rel.tag_name} | ${asset.name}`;
                        } else {
                            releaseInfo = ` → ${rel.tag_name} | (no assets)`;
                        }
                    }
                } catch { }
                results.push(`  ${repo.full_name}${releaseInfo}`);
                results.push(`    ${repo.html_url}`);
            }
        } else {
            results.push(`No repos found for "${name}".`);
        }

        results.push('');
        results.push(`Use: /install_plugin "owner/repo" "${name}"`);
        return results.join('\n');
    }

    async installPlugin(source: string, name: string): Promise<string> {
        if (!this.serverRoot) return "No root set";

        const pluginDir = path.join(this.serverRoot, 'plugins');
        try { await fs.mkdir(pluginDir, { recursive: true }); } catch { }

        const isWindows = process.platform === 'win32';
        const ext = isWindows ? '.dll' : '.so';
        const fileName = name.endsWith(ext) ? name : `${name}${ext}`;
        const dest = path.join(pluginDir, fileName);
        const pluginNameOnly = fileName.replace(ext, '');

        let downloadUrl: string | null = null;
        let isArchive = false;
        let archiveName = '';

        // Detect GitHub repo reference: "owner/repo" or "https://github.com/owner/repo"
        const githubRepoMatch = source.match(/github\.com\/([^\/]+\/[^\/]+)/) || source.match(/^([^\/]+\/[^\/]+)$/);

        if (githubRepoMatch) {
            const sourceRepo = githubRepoMatch[1];
            const repoName = sourceRepo.split('/')[1] || sourceRepo;
            try {
                // --- Try latest release ---
                const apiUrl = `https://api.github.com/repos/${sourceRepo}/releases/latest`;
                const apiResponse = await fetch(apiUrl, {
                    headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'SAMP-MCP' }
                });

                if (apiResponse.ok) {
                    const release: any = await apiResponse.json();
                    const assets: any[] = release.assets || [];
                    const asset = this.findBestAsset(assets, pluginNameOnly, ext);

                    if (asset && asset.name.toLowerCase().endsWith(ext)) {
                        downloadUrl = asset.browser_download_url;
                    } else if (asset) {
                        // Archive found - will attempt auto-extraction
                        downloadUrl = asset.browser_download_url;
                        isArchive = true;
                        archiveName = asset.name;
                    } else {
                        // No asset in latest → try older releases
                        const allReleases = await this.githubListReleases(sourceRepo);
                        let foundInOld = false;
                        for (const rel of allReleases.slice(0, 5)) {
                            const oldAsset = this.findBestAsset(rel.assets || [], pluginNameOnly, ext);
                            if (oldAsset && oldAsset.name.toLowerCase().endsWith(ext)) {
                                downloadUrl = oldAsset.browser_download_url;
                                foundInOld = true;
                                break;
                            } else if (oldAsset) {
                                downloadUrl = oldAsset.browser_download_url;
                                isArchive = true;
                                archiveName = oldAsset.name;
                                foundInOld = true;
                                break;
                            }
                        }

                        if (!foundInOld) {
                            return [
                                `[WARNING] No pre-built ${ext} binary found in ${sourceRepo} releases.`,
                                `Latest release: ${release.html_url}`,
                                `Latest assets: ${assets.map((a: any) => a.name).join(', ') || 'None'}`,
                                ``,
                                `This plugin may require manual compilation from source.`,
                                `Steps:`,
                                `  1. git clone https://github.com/${sourceRepo}`,
                                `  2. Windows: Open .sln in Visual Studio → Build Release → copy ${ext} to plugins/`,
                                `  3. Linux: run "make" → copy ${ext} to plugins/`,
                                ``,
                                `Alternatively, try /search_plugin "${name}" to find other sources.`,
                                ``
                            ].join('\n');
                        }
                    }
                } else if (apiResponse.status === 404) {
                    // Repo not found → search for alternatives
                    const searchResults = await this.githubSearchRepos(repoName);
                    const suggestions = searchResults
                        .filter((r: any) => r.full_name.toLowerCase().includes(repoName.toLowerCase()))
                        .slice(0, 3)
                        .map((r: any) => `  • ${r.full_name} (${r.html_url})`)
                        .join('\n');

                    return [
                        `[ERROR] GitHub repository "${sourceRepo}" not found or has no releases.`,
                        suggestions ? `Did you mean:\n${suggestions}` : 'No similar repositories found.',
                        ``,
                        `Try:`,
                        `  - Verify the repo name (e.g. "IS4Code/YSF")`,
                        `  - Use /search_plugin "${name}" to discover sources`,
                        `  - Provide a direct download URL instead.`,
                        ``
                    ].join('\n');
                } else {
                    return `[ERROR] GitHub API returned ${apiResponse.status}: ${apiResponse.statusText}`;
                }
            } catch (apiErr: any) {
                return `[ERROR] Failed to query GitHub API: ${apiErr.message}\nTry providing a direct download URL instead.`;
            }
        } else if (/^https?:\/\//.test(source)) {
            // Direct URL
            downloadUrl = source;
            if (source.toLowerCase().endsWith('.zip')) {
                isArchive = true;
                archiveName = path.basename(source);
            }
        } else {
            return `[ERROR] Unrecognized source format: "${source}".\nProvide a GitHub repo (e.g. "IS4Code/YSF") or a direct URL.\nOr use /search_plugin "${name}" to find sources.`;
        }

        if (!downloadUrl) {
            return `[ERROR] Could not determine download URL for plugin "${name}".`;
        }

        // Download
        let finalDest = dest;
        try {
            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            const buffer = Buffer.from(await response.arrayBuffer());

            if (isArchive) {
                // Save zip to temp, extract, find binary
                const tempZip = dest + '.zip';
                await fs.writeFile(tempZip, buffer);
                const extractResult = await this.extractPluginFromZip(tempZip, pluginDir, pluginNameOnly, ext);
                try { await fs.unlink(tempZip); } catch { }
                if (extractResult) {
                    finalDest = extractResult;
                } else {
                    return [
                        `[WARNING] Downloaded archive "${archiveName}" but could not find ${ext} binary inside.`,
                        `Extraction may have failed or the archive does not contain a ${ext} file.`,
                        `You may need to extract it manually to plugins/`,
                        ``
                    ].join('\n');
                }
            } else {
                await fs.writeFile(dest, buffer);
            }
        } catch (dlErr: any) {
            return `[ERROR] Failed to download plugin: ${dlErr.message}\nURL: ${downloadUrl}`;
        }

        // Update server.cfg
        let config = await this.readConfig();
        const pluginsLineMatch = config.match(/^plugins\s+(.*)/m);

        if (pluginsLineMatch) {
            const currentPlugins = pluginsLineMatch[1].trim().split(/\s+/).filter(p => p);
            if (!currentPlugins.includes(pluginNameOnly)) {
                config = config.replace(/^plugins\s+.*/m, `plugins ${pluginsLineMatch[1].trim()} ${pluginNameOnly}`);
            }
        } else {
            config += `\nplugins ${pluginNameOnly}`;
        }

        await this.writeConfig(config);

        return `Installed ${path.basename(finalDest)} → plugins/ | server.cfg updated`;
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

    async checkMcpUpdate(current: string = "1.0.8"): Promise<{ current: string, latest: string, needsUpdate: boolean }> {
        try {
            const { stdout } = await execPromise('npm view @konggithubdev/samp-mcp version --registry=https://npm.pkg.github.com');
            const latest = stdout.trim();
            return {
                current,
                latest,
                needsUpdate: latest !== current
            };
        } catch {
            return { current, latest: current, needsUpdate: false };
        }
    }

    async updateMcpServer(): Promise<string> {
        try {
            await execPromise('npm install -g @konggithubdev/samp-mcp');
            return "SAMP-MCP has been updated to the latest version. Please restart your MCP client.";
        } catch (error: any) {
            throw new Error(`Update failed: ${error.message}`);
        }
    }

    /**
     * English-only slug for plan filenames and module identifiers. Thai
     * characters are stripped because the project names modules in English
     * (respawncars.inc, j_cow.inc, ...) and Thai chars would break pawncc
     * include paths / Pawn identifiers. Runs of junk collapse to one underscore.
     */
    private englishSlug(input: string, keepHyphen = false): string {
        const allowed = keepHyphen ? /[^a-zA-Z0-9_-]+/g : /[^a-zA-Z0-9]+/g;
        return input
            .replace(allowed, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '')
            .toLowerCase();
    }

    async designFeature(title: string, description: string, requirements?: string[]): Promise<string> {
        if (!this.serverRoot) throw new Error("No root set. Run set_server_root first.");

        const planDir = path.join(this.serverRoot, '.samp-mcp-plans');
        await fs.mkdir(planDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeTitle = (this.englishSlug(title, true) || 'feature').substring(0, 50);
        const filename = `${timestamp}_${safeTitle}.md`;
        const filepath = path.join(planDir, filename);

        const reqList = requirements && requirements.length > 0
            ? requirements.map(r => `  - ${r}`).join('\n')
            : '  - (none specified)';

        const pat = await this.detectPatterns().catch(() => null);
        const moduleMode = !!(pat && pat.hasSystemModules);
        const slug = this.englishSlug(title) || 'feature';
        const archIntro = moduleMode
            ? `\n\n**Architecture**: this project builds features as self-contained system modules. Implement this feature as ONE module and register it in gamemodes/main.pwn — never add gameplay logic to main.pwn or create filterscripts for it.`
            : '';
        const archFiles = moduleMode
            ? `- [ ] NEW module: gamemodes/includes/system/${slug}.inc (self-contained: state + hooks + commands + dialogs)\n- [ ] If this is a work/job feature: gamemodes/includes/system/job/j_${slug}.inc instead\n- [ ] Register it in gamemodes/main.pwn: #include "includes/system/${slug}.inc"\n- [ ] No filterscripts, no gameplay logic in main.pwn`
            : `- [ ] Identify main script file\n- [ ] Identify include files needed\n- [ ] Identify filterscripts to create (if any)`;
        const archEvents = moduleMode
            ? `- [ ] hook OnGameModeInit: create static objects / 3D labels / start repeat timers\n- [ ] hook OnPlayerConnect: reset per-player state for this module\n- [ ] hook OnPlayerDisconnect: stop timers, clear transient state\n- [ ] hook OnPlayerKeyStateChange: KEY_NO actions guarded by IsPlayerInRangeOfPoint\n- [ ] hook OnProgressFinish: reward player, guarded by module state flag\n- [ ] Dialog:NAME for menus; CMD:name (with flags: for permissions) inside the module`
            : `- [ ] OnGameModeInit / OnFilterScriptInit\n- [ ] OnPlayerConnect / OnPlayerDisconnect\n- [ ] OnPlayerDeath / OnPlayerSpawn\n- [ ] OnPlayerKeyStateChange / OnPlayerUpdate\n- [ ] Timers (SetTimer / SetTimerEx)\n- [ ] Commands (ZCMD / Pawn.CMD)`;
        const archSteps = moduleMode
            ? `1. Create the module file (path from section 3) starting with: #include <YSI_Coding\\y_hooks>\n2. Add module state, hook OnGameModeInit (objects/labels/timers) and hook OnPlayerConnect (reset)\n3. Interaction flow: hook OnPlayerKeyStateChange -> StartProgress(...) -> reward in hook OnProgressFinish\n4. Add CMD:name (flags: for admin) and Dialog:NAME inside the module\n5. Register in main.pwn: #include "includes/system/${slug}.inc" (match surrounding tab style)\n6. Verify: compile_pawn on gamemodes/main.pwn, then audit_script on the new module`
            : `1. Step 1:\n2. Step 2:\n3. Step 3:`;

        const plan = `# Feature Plan: ${title}
Generated: ${new Date().toISOString()}
Status: PENDING_REVIEW

## 1. Overview
${description}${archIntro}

## 2. Explicit Requirements
${reqList}

## 3. Files to Create / Modify
${archFiles}

## 4. Data Structures & Variables
- [ ] Define enums/constants
- [ ] Define global variables / arrays
- [ ] Define player variables (if using per-player data)

## 5. Event Handlers & Callbacks
${archEvents}

## 6. Edge Cases Checklist (CRITICAL)
**Review every item before implementing:**
- [ ] **Player disconnect** mid-process: What happens if a player disconnects while the feature is active?
- [ ] **Player death** mid-process: What happens if a player dies during the feature?
- [ ] **New player connect**: Will players who connect AFTER the feature starts see everything correctly?
- [ ] **Server restart / crash**: Will state persist or reset correctly?
- [ ] **Concurrent actions**: Can 2+ players use this feature simultaneously without conflict?
- [ ] **Admin / GM exceptions**: Are admins affected differently?
- [ ] **Resource cleanup**: Are timers destroyed, objects removed, textdraws hidden on reset?
- [ ] **Thai text / Encoding**: All user-facing strings use correct encoding?

## 7. Implementation Steps
${archSteps}

## 8. Testing Checklist
- [ ] Compile without errors
- [ ] Test normal flow (happy path)
- [ ] Test edge case: Player disconnect mid-process
- [ ] Test edge case: Player death mid-process
- [ ] Test edge case: New player joins during active state
- [ ] Test edge case: Server restart scenario
- [ ] Verify Thai text displays correctly (if applicable)

---
> **AI RULE**: This plan MUST be reviewed and confirmed by the user before any code is written.
> After implementation, use 'review_implementation' to verify all checklist items are satisfied.
`;

        // Write with UTF-8 BOM so editors auto-detect UTF-8 (not Windows-874)
        const bomPlan = '\uFEFF' + plan;
        await fs.writeFile(filepath, bomPlan, 'utf8');
        return filepath;
    }

    async moduleSkeleton(name: string, kind: 'module' | 'job' | 'autofarm' = 'module', adminCommand?: boolean): Promise<string> {
        const p = await this.detectPatterns().catch(() => null);
        const slugRaw = this.englishSlug(name);
        const id = (slugRaw || 'feature').toLowerCase();
        const Cap = id.charAt(0).toUpperCase() + id.slice(1);
        const isJob = kind === 'job';
        // Admin style when explicitly requested, or auto-detected from the name;
        // an explicit adminCommand:false disables the auto-detection.
        const isAdmin = kind === 'module' && (adminCommand === true || (adminCommand !== false && ADMIN_COMMAND_HINTS.test(name)));
        const fileName = (isJob ? 'j_' : '') + id;
        const hasProg = !!(p && p.hasStartProgress);
        const helpers = (p && p.messageHelpers) || [];
        const mErr = helpers.indexOf('ErrorMsg') !== -1 ? 'ErrorMsg(playerid, "...")' : 'SendClientMessage(playerid, 0xFA0000FF, "...")';
        const mOk = helpers.indexOf('ServerMsg') !== -1 ? 'ServerMsg(playerid, "...")' : 'SendClientMessage(playerid, 0x0060FFFF, "...")';
        const mSyntax = helpers.indexOf('SyntaxMsg') !== -1 ? 'SyntaxMsg(playerid, "...")' : 'SendClientMessage(playerid, 0xFFFF00FF, "...")';

        let s = '';
        s += `// ${Cap} - ${isAdmin ? 'admin command module (cmd/admin.inc style)' : kind === 'autofarm' ? 'collect / farm module' : 'self-contained system module'}\n`;
        s += `// Put at: gamemodes/includes/${isJob ? 'system/job/' : 'system/'}${fileName}.inc\n`;
        s += `// Register in gamemodes/main.pwn:\n`;
        s += `// #include "includes/system/${isJob ? 'job/' : ''}${fileName}.inc"\n`;
        s += `#include    <YSI_Coding\\y_hooks>\n\n`;

        if (isAdmin) {
            s += `// Instant admin action — no progress bar (cmd/admin.inc /veh family idiom):\n`;
            s += `alias:${id}("...")  // Thai alias, e.g. "รีรถเสก"\n`;
            s += `flags:${id}(CMD_LEAD_ADMIN)  // permission: CMD_DEV / CMD_LEAD_ADMIN / CMD_ADM_1 ...\n`;
            s += `CMD:${id}(playerid, params[]) {\n`;
            s += `    new\n`;
            s += `        targetid\n`;
            s += `    ;\n`;
            s += `    if (sscanf(params, "u", targetid))\n`;
            s += `        return ${mSyntax};\n`;
            s += `    if (!IsPlayerConnected(targetid))\n`;
            s += `        return ${mErr};\n`;
            s += `    // <act on the target — reuse shared state like adminVehicle[] in the /veh family>\n`;
            s += `    SendAdminMessage(COLOR_YELLOW, CMD_LEAD_ADMIN, "[แจ้งเตือนผู้ดูแลระบบ]: %s ใช้คำสั่ง /${id} กับ %s", GetPlayerNameEx(playerid), GetPlayerNameEx(targetid));\n`;
            s += `    return 1;\n`;
            s += `}\n\n`;
            s += `// hook OnGameModeInit() { ... }  // start repeat timers / set globals (see respawncars.inc)\n`;
            s += `// hook OnGameModeExit()  { ... }  // stop repeat timers\n`;
            return s;
        }

        let state = `static\n    ${Cap}_Busy[MAX_PLAYERS]`;
        if (!hasProg) state += `\n,   Timer: ${Cap}_Timer[MAX_PLAYERS]`;
        s += state + '\n;\n\n';
        s += `hook OnGameModeInit() {\n`;
        s += `    // static world objects / labels and repeat timers for this feature\n`;
        s += `    // e.g. Data[i][Obj] = CreateDynamicObject(...); Data[i][Lbl] = CreateDynamic3DTextLabel(...);\n`;
        s += `    return 1;\n}\n\n`;
        s += `hook OnPlayerConnect(playerid) {\n    ${Cap}_Busy[playerid] = 0;\n}\n\n`;
        s += `hook OnPlayerDisconnect(playerid, reason) {\n    // stop ${Cap} timers / clear transient state\n    ${Cap}_Busy[playerid] = 0;\n    return 1;\n}\n\n`;
        s += `hook OnPlayerKeyStateChange(playerid, newkeys, oldkeys) {\n`;
        s += `    if (newkeys & KEY_NO && !IsPlayerInAnyVehicle(playerid)) {\n`;
        s += `        // first verify the action point: if (IsPlayerInRangeOfPoint(playerid, 2.0, X, Y, Z))\n`;
        s += `        if (${Cap}_Busy[playerid])\n            return ${mErr};\n`;
        s += `        ${Cap}_Busy[playerid] = 1;\n`;
        if (hasProg) {
            s += `        StartProgress(playerid, "action in progress...", 1500, 0, INVALID_OBJECT_ID, COLOR_WHITE);\n`;
        } else {
            s += `        ${Cap}_Timer[playerid] = repeat ${Cap}_Tick(playerid);\n`;
        }
        s += `    }\n    return 1;\n}\n\n`;
        if (hasProg) {
            s += `hook OnProgressFinish(playerid, objectid) {\n`;
            s += `    if (${Cap}_Busy[playerid]) {\n`;
            s += `        ${Cap}_Busy[playerid] = 0;\n`;
            s += `        // reward the player here (money / items / effect)\n`;
            s += `        ${mOk};\n`;
            s += `    }\n    return Y_HOOKS_CONTINUE_RETURN_0;\n}\n\n`;
        } else {
            s += `timer ${Cap}_Tick[100](playerid) {\n`;
            s += `    if (${Cap}_Busy[playerid]) {\n`;
            s += `        ${Cap}_Busy[playerid] = 0;\n`;
            s += `        // reward the player here (money / items / effect)\n`;
            s += `        ${mOk};\n`;
            s += `    }\n    return 1;\n}\n\n`;
        }
        s += `// Commands & dialogs for this feature live INSIDE this module:\n`;
        s += `// flags:${id}(CMD_LEAD_ADMIN)\n`;
        s += `// CMD:${id}(playerid, params[]) { ... return 1; }\n`;
        s += `// Dialog:DIALOG_${id.toUpperCase()}(playerid, response, listitem, inputtext[]) { ... }\n`;
        return s;
    }

    async reviewImplementation(planPath: string, filesModified: string[]): Promise<string> {
        if (!this.serverRoot) throw new Error("No root set. Run set_server_root first.");

        const fullPath = path.isAbsolute(planPath) ? planPath : path.join(this.serverRoot, planPath);
        let planContent: string;
        try {
            planContent = await fs.readFile(fullPath, 'utf8');
        } catch {
            throw new Error(`Plan not found: ${planPath}`);
        }

        // Verify all files exist
        const missingFiles: string[] = [];
        for (const f of filesModified) {
            const fp = path.isAbsolute(f) ? f : path.join(this.serverRoot, f);
            try { await fs.access(fp); } catch { missingFiles.push(f); }
        }

        const lines = planContent.split('\n');
        const unchecked = lines.filter(l => l.trim().startsWith('- [ ]'));

        const report = `# Implementation Review Report
Plan: ${planPath}

## File Verification
- Files specified: ${filesModified.length}
- Files found: ${filesModified.length - missingFiles.length}
- Files missing: ${missingFiles.length > 0 ? missingFiles.join(', ') : 'None'}

## Checklist Status
- Total unchecked items: ${unchecked.length}
${unchecked.length > 0 ? unchecked.slice(0, 20).join('\n') : 'All items checked!'}

## Action Required
${unchecked.length > 0 || missingFiles.length > 0
    ? 'WARNING: Some checklist items are unchecked or files are missing. Please review before marking complete.'
    : 'All checklist items appear satisfied. Mark plan as COMPLETE if you agree.'}
`;
        return report;
    }

    async setupAiEnvironment(): Promise<string> {
        if (!this.serverRoot) return "No root set. Run set_server_root first.";
        
        const isThai = this.preferredEncoding === 'windows-874';
        const arch = await this.detectPatterns().catch(() => null);
        const moduleMode = !!(arch && arch.hasSystemModules);
        const archRuleCursor = moduleMode
            ? '\r\n8. **ARCHITECTURE (system-module pattern)**: Build new features as ONE self-contained module under gamemodes/includes/system/<name>.inc (jobs: system/job/j_<name>.inc), owning its state/hooks/commands/dialogs via YSI y_hooks. Register it in gamemodes/main.pwn (#include "includes/system/<name>.inc"). Timed actions use StartProgress + hook OnProgressFinish, messages use ErrorMsg/ServerMsg/SyntaxMsg, per-player state uses PlayerInfo[playerid][pX] or static arrays. Never add gameplay logic to main.pwn or create filterscripts for features. Performance: foreach for player loops; YSI timers stopped on disconnect; threaded mysql_format + mysql_tquery only; Streamer dynamic objects; keep OnPlayerUpdate light.'
            : '';
        const archRuleSamp = moduleMode
            ? '\r\n7. **ARCHITECTURE (SYSTEM-MODULE PATTERN)**:\r\n   - New features are ONE self-contained module: gamemodes/includes/system/<name>.inc (jobs -> system/job/j_<name>.inc), owning its state/hooks/commands/dialogs via YSI y_hooks.\r\n   - Register it in gamemodes/main.pwn with #include "includes/system/<name>.inc".\r\n   - Timed actions: StartProgress + hook OnProgressFinish. Messages: ErrorMsg/ServerMsg/SyntaxMsg. Per-player state: PlayerInfo[playerid][pX] or static arrays.\r\n   - No gameplay logic in main.pwn; no filterscripts for new features.'
            : '';
        const cursorRules = `
# SAMP AI AGENT RULES (samp-mcp + file tools)

1. **ENCODING**: This project uses **${isThai ? 'Thai (Windows-874)' : 'International'}** encoding. Keep it byte-for-byte.
2. **FILE TOOLS**: Use samp-mcp's file_* tools (file_read/file_write/file_edit/file_grep/file_search) for ALL file reads/writes/edits — they delegate to encoding-aware mcp-file-tools which preserves Windows-874 Thai and CRLF. NEVER re-save scripts with plain editors.
3. **SAMP-MCP SCOPE**: samp-mcp handles SAMP server operations (status/RCON/compile/audits) AND file access via its file_* tools (delegated to mcp-file-tools).
4. **NO TRANSLATION**: Maintain the project's primary language.
5. **PLANNING RULE (CRITICAL)**: 
   - Before implementing ANY new feature or system, you **MUST** use 'design_feature' to create a structured plan.
   - The plan MUST include edge case analysis (disconnect, death, new connect, restart, concurrent actions, cleanup).
   - **WAIT for user confirmation** before writing any code.
   - After implementation, use 'review_implementation' to verify checklist completion.
6. **CODE STYLE (COMPACT)**:
   - Group related variable declarations: use \`new VAR1, VAR2;\` instead of separate \`new\` lines.
   - Keep function calls compact on a single line when it fits ~80-100 chars: \`ShowPlayerDialog(playerid, DIALOG_LOGIN, DIALOG_STYLE_INPUT, "Login", "text", "OK", "Cancel");\`
   - **AVOID** putting every argument on its own line unless readability genuinely suffers.
7. **COMMENTS RULE**:
   - **DO NOT** add excessive inline comments that state the obvious.
   - Only comment on complex logic or non-obvious decisions.
   - **ASK the user** "ต้องการ comment อธิบายโค้ดด้วยไหม?" before adding detailed comments.
   - Never comment every single line (e.g. \`// increment i\` on \`i++\`).
${archRuleCursor}
When Thai shows garbled, stop and re-check the file's real encoding with an encoding-aware tool before writing anything.
`;
        const sampRules = `# SAMP Project Rules (Universal)
For Windsurf, Cursor, Antigravity, and all AI agents:

1. **ENCODING**: This project uses **${isThai ? 'Thai (Windows-874)' : 'Universal Auto-Detection'}**.
   - Use samp-mcp's file_* tools (file_read/file_write/file_edit/file_grep — delegated to encoding-aware mcp-file-tools) for ALL file reads/writes/edits so Thai (Windows-874) and CRLF line endings are preserved.
   - samp-mcp also exposes file access through its file_* tools (delegated to mcp-file-tools).

2. **LANGUAGE PRESERVATION**:
   - **DO NOT** translate strings. Maintain the original project language.

3. **PLANNING RULE (CRITICAL)**:
   - Before implementing ANY new feature or system, you **MUST** use 'design_feature' to create a structured plan.
   - The plan MUST include edge case analysis: disconnect, death, new player connect, server restart, concurrent actions, resource cleanup.
   - **WAIT for user confirmation** before writing any code.
   - After implementation, use 'review_implementation' to verify checklist completion.

4. **CODE STYLE (COMPACT)**:
   - Group related variable declarations on a single line: \`new VAR1, VAR2;\` instead of multiple \`new\` lines.
   - Keep function calls on a single line when it fits ~80-100 chars. Do NOT put every argument on its own line.

5. **COMMENTS RULE**:
   - Do NOT add excessive comments that state the obvious.
   - Only comment complex logic or non-obvious decisions.
   - Ask user "ต้องการ comment อธิบายโค้ดด้วยไหม?" before adding detailed comments.
   - Never comment every single line.

6. **COMPILATION**:
   - Use 'compile_and_load_pawn' to verify changes and reload server.
${archRuleSamp}
If Thai ever shows garbled, stop and verify the file's encoding with an encoding-aware tool before writing.
`;

        await fs.writeFile(path.join(this.serverRoot, 'AI_RULES.md'), cursorRules, 'utf8');
        await fs.writeFile(path.join(this.serverRoot, 'SAMP_RULES.md'), sampRules, 'utf8');
        
        return `AI Environment setup complete in ${this.serverRoot}. Rules written to AI_RULES.md and SAMP_RULES.md. Encoding set to ${this.preferredEncoding}.`;
    }

    async getFormattedGuidelines(): Promise<string> {
        const p = await this.detectPatterns();
        const isThai = this.preferredEncoding === 'windows-874';
        const archRule = p.hasSystemModules
            ? `\n5. **ARCHITECTURE (system-module pattern detected)**:\n   - Build every new feature as ONE self-contained module: gamemodes/includes/system/<name>.inc (jobs go to gamemodes/includes/system/job/j_<name>.inc).\n   - The module owns its state/hooks/commands/dialogs. Start with #include <YSI_Coding\\y_hooks>, then wire it through hook OnGameModeInit / OnPlayerConnect / OnPlayerDisconnect / OnPlayerKeyStateChange.\n   - Register the module in gamemodes/main.pwn: #include "includes/system/<name>.inc" (match the surrounding tab style).\n   - Timed actions: StartProgress(playerid, "label", ms, 0, objectid, color) then reward inside hook OnProgressFinish guarded by the module's state flag.\n   - Messages via ErrorMsg / ServerMsg / SyntaxMsg macros; per-player state in PlayerInfo[playerid][pX] or static arrays (new X[MAX_PLAYERS]).\n   - Never put gameplay logic in main.pwn and never create filterscripts for new features.\n   - Commands are Pawn.CMD: CMD:name(playerid, params[]) inside the module, plus flags:name(CMD_xxx) when admin-gated (permission bits are auto-checked vs PlayerInfo[playerid][pCMDPermission] in OnPlayerCommandReceived).\n   - Dialogs are easyDialog: Dialog_Show(playerid, DIALOG_X, DIALOG_STYLE_INPUT, caption, "...", "OK", "Cancel") and the handler Dialog:DIALOG_X(playerid, response, listitem, inputtext[]).\n   - PERFORMANCE (mirrors this codebase): iterate connected players with foreach(new i : Player), never for (i < MAX_PLAYERS); use YSI timers (timer X[1000] / repeat) and stop/clean them on disconnect; all MySQL is threaded via mysql_format + mysql_tquery(g_SQL, query, "Callback", ...) reading cache_* inside the callback — never blocking mysql_query; world objects/labels are Streamer dynamic (CreateDynamicObject / CreateDynamic3DTextLabel); keep OnPlayerUpdate and per-player fast callbacks light; size strings realistically and prefer static for big buffers.`
            : '';
        
        return `
# SAMP PROJECT RULES FOR AI AGENTS (samp-mcp + mcp-file-tools)

1. **ENCODING**:
   - This project uses **${isThai ? 'Thai (Windows-874)' : 'International (auto-detected)'}** encoding.
   - All file reads/writes/edits go through samp-mcp's file_* tools (file_read/file_write/file_edit/file_grep), which delegate to encoding-aware mcp-file-tools that detect and preserve the real encoding (Windows-874 Thai, CRLF). Never re-save or transcode scripts with plain editors.
   - samp-mcp exposes both SAMP server operations (status/query, RCON, compile, audits) and file access via its file_* tools.

2. **LANGUAGE PRESERVATION**:
   - **DO NOT** translate existing strings. 
   - Maintain the project's primary language (${isThai ? 'Thai' : 'English'}).
   - If the project is Thai, stay in Thai. If it is English, stay in English.

3. **CORRUPTION RECOVERY**:
   ${isThai ? "- If Thai shows as garbage, stop: re-read with an encoding-aware tool (e.g., mcp-file-tools) and verify the file was not re-saved as UTF-8 before editing." : "- Ensure you don't introduce encoding mismatches."}

4. **PROJECT CONTEXT**:
   - Thai Support: ${p.thaiSupport ? 'YES' : 'NO'}
   - Preferred Encoding: ${this.preferredEncoding}
   - Logic Style: ${p.hasYSI ? 'YSI (Hooks enabled)' : 'Standard'}
   - Commands: ${p.hasPawnCMD ? 'Pawn.CMD' : (p.hasZCMD ? 'ZCMD' : 'Standard')}
   - Architecture: ${p.hasSystemModules ? `System Modules (${p.systemModuleCount} in gamemodes/includes/system)` : 'Monolithic / Classic'}
${archRule}

${p.hasSystemModules ? '6' : '5'}. **CODE STYLE**:
   - Group declarations: \`new a, b, c;\` NOT multiple \`new\` lines.
   - Compact calls: single line when fits ~80-100 chars.
   - Minimal comments: only complex logic, never obvious ones.
   - Ask user before adding detailed comments.
`;
    }

    // ---- Web Search ----

    async webSearch(query: string, domain?: string): Promise<string> {
        try {
            let searchQuery = query;
            if (domain) searchQuery += ` site:${domain}`;

            const encodedQuery = encodeURIComponent(searchQuery);
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate',
                'Referer': 'https://duckduckgo.com/',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            };

            // Try DuckDuckGo lite first (less bot protection)
            let html: string;
            try {
                const liteUrl = `https://lite.duckduckgo.com/lite/`;
                const response = await fetch(liteUrl, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `q=${encodedQuery}`
                });
                html = await response.text();
            } catch {
                // Fallback to regular HTML endpoint
                const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
                const response = await fetch(url, { headers });
                html = await response.text();
            }

            const results: string[] = [];

            // DuckDuckGo lite result parsing
            const resultBlocks = html.match(/<tr>\s*<td[^>]*class="result[^"]*"[^>]*>[\s\S]*?<\/td>\s*<\/tr>/g) || [];
            for (const block of resultBlocks.slice(0, 5)) {
                const linkMatch = block.match(/<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
                const snippetMatch = block.match(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/);
                if (linkMatch) {
                    const title = this.stripHtml(linkMatch[2]).trim();
                    const href = this.decodeHtmlEntities(linkMatch[1]);
                    const snippet = snippetMatch ? this.stripHtml(snippetMatch[1]).trim() : '';
                    results.push(`${title}\n${snippet}\nURL: ${href}`);
                }
            }

            // Fallback: DuckDuckGo HTML result parsing
            if (results.length === 0) {
                const ddBlocks = html.match(/<div class="result[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g) || [];
                for (const block of ddBlocks.slice(0, 5)) {
                    const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
                    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
                    if (titleMatch) {
                        const title = this.stripHtml(titleMatch[2]).trim();
                        const href = this.decodeHtmlEntities(titleMatch[1]);
                        const snippet = snippetMatch ? this.stripHtml(snippetMatch[1]).trim() : '';
                        results.push(`${title}\n${snippet}\nURL: ${href}`);
                    }
                }
            }

            // Second fallback: any link with result class
            if (results.length === 0) {
                const anyLinks = html.match(/<a[^>]*href="([^"]*)"[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/a>/g) || [];
                for (const link of anyLinks.slice(0, 5)) {
                    const m = link.match(/href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
                    if (m) {
                        results.push(`${this.stripHtml(m[2]).trim()}\nURL: ${this.decodeHtmlEntities(m[1])}`);
                    }
                }
            }

            if (results.length > 0) {
                return `Results for "${query}":\n` + results.slice(0, 3).join('\n');
            }

            // DuckDuckGo might be blocking. Provide helpful fallback.
            return [
                `No results for "${query}" (DuckDuckGo may block bots).`,
                `Try: https://duckduckgo.com/?q=${encodedQuery}`,
                `Or use /search_plugin for plugins.`
            ].join('\n');

        } catch (err: any) {
            return `Web search error: ${err.message}`;
        }
    }

    private stripHtml(html: string): string {
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    private decodeHtmlEntities(str: string): string {
        return str.replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")
                  .replace(/&nbsp;/g, ' ');
    }
}



