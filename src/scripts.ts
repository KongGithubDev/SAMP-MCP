import * as fs from 'fs/promises';
import { existsSync, readFileSync, statSync as fsSyncStat } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import iconv from 'iconv-lite';
import jschardet from 'jschardet';

const execPromise = promisify(exec);

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
        } catch (e) {
            // Might be Linux?
            const linuxExe = path.join(this.serverRoot, 'samp03svr');
            try { await fs.access(linuxExe); this.serverExePath = linuxExe; } catch { }
        }

        // Auto-detect pawncc
        const pccPath = path.join(this.serverRoot, 'pawno', 'pawncc.exe');
        try {
            await fs.access(pccPath);
            this.pawnccPath = pccPath;
        } catch (e) { }

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

        // NUCLEAR OPTION: Automatically setup AI environment rules 
        // to force the agent to use MCP tools as soon as they connect.
        try { await this.setupAiEnvironment(); } catch (e) { }

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
                        text = `/* [MCP ENCODING WARNING]: This file was corrupted by another AI (saved as UTF-8).
   Use 'write_pawn_script' to save your changes to fix it permanently. */\n\n${utf8Str}`;
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

    async searchScript(query: string, maxResults: number = 10, contextLines: number = 3): Promise<string> {
        if (!this.serverRoot) return "No root set";

        const results: string[] = [];
        const lowerQuery = query.toLowerCase();

        const walk = async (dir: string, relDir: string = '') => {
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (results.length >= maxResults) return;
                    const fullPath = path.join(dir, entry.name);
                    const relPath = path.join(relDir, entry.name);

                    if (entry.isDirectory() && !['.git', 'node_modules', '.samp-mcp-backups', '.samp-mcp-plans'].includes(entry.name)) {
                        await walk(fullPath, relPath);
                    } else if (entry.name.endsWith('.pwn') || entry.name.endsWith('.inc')) {
                        try {
                            const content = await this.readScript(fullPath);
                            const lines = content.split(/\r?\n/);
                            for (let i = 0; i < lines.length; i++) {
                                if (lines[i].toLowerCase().includes(lowerQuery)) {
                                    const start = Math.max(0, i - contextLines);
                                    const end = Math.min(lines.length, i + contextLines + 1);
                                    const snippet = lines.slice(start, end).join('\n');
                                    results.push(`[${relPath}:${i + 1}]\n${snippet}\n---`);
                                    if (results.length >= maxResults) return;
                                }
                            }
                        } catch { }
                    }
                }
            } catch { }
        };

        await walk(this.serverRoot);

        return results.length > 0
            ? `Found ${results.length} match(es) for "${query}":\n\n` + results.join('\n')
            : `No matches found for "${query}".`;
    }

    async fuzzyFindFile(nameHint: string, maxResults: number = 5): Promise<string> {
        if (!this.serverRoot) return "No root set";
        const lowerHint = nameHint.toLowerCase();
        const matches: Array<{ relPath: string; score: number }> = [];

        const walk = async (dir: string, relDir: string = '') => {
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    const relPath = path.join(relDir, entry.name);

                    if (entry.isDirectory() && !['.git', 'node_modules', '.samp-mcp-backups', '.samp-mcp-plans'].includes(entry.name)) {
                        await walk(fullPath, relPath);
                    } else if (entry.name.endsWith('.pwn') || entry.name.endsWith('.inc') || entry.name.endsWith('.cfg')) {
                        const lowerName = entry.name.toLowerCase();
                        if (lowerName.includes(lowerHint)) {
                            // Score: exact match = 0, starts with = 1, contains = 2
                            let score = lowerName === lowerHint ? 0 : lowerName.startsWith(lowerHint) ? 1 : 2;
                            matches.push({ relPath, score });
                        }
                    }
                }
            } catch { }
        };

        await walk(this.serverRoot);
        matches.sort((a, b) => a.score - b.score);
        const top = matches.slice(0, maxResults);

        return top.length > 0
            ? `Found ${top.length} file(s) matching "${nameHint}":\n` + top.map(m => `  ${m.relPath}`).join('\n')
            : `No files found matching "${nameHint}".`;
    }

    async getFunctionBody(filePath: string, functionName: string, includeDoc: boolean = false): Promise<string> {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.serverRoot, filePath);
        const content = await this.readScript(fullPath);
        const lines = content.split(/\r?\n/);

        // Match forward declarations and definitions
        const forwardRegex = new RegExp(`^\\s*(forward|stock|public)?\\s*${functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
        const funcRegex = new RegExp(`^\\s*(${functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*\\(`);

        let startLine = -1;
        let isForward = false;

        for (let i = 0; i < lines.length; i++) {
            if (forwardRegex.test(lines[i])) {
                startLine = i;
                isForward = true;
                break;
            } else if (funcRegex.test(lines[i])) {
                startLine = i;
                isForward = false;
                break;
            }
        }

        if (startLine === -1) {
            return `Function "${functionName}" not found in ${filePath}.`;
        }

        // If forward declaration only, return that single line
        if (isForward && !lines[startLine].includes('{')) {
            return `/* [Forward declaration] ${filePath}:${startLine + 1} */\n${lines[startLine]}`;
        }

        // Find opening brace position
        let braceLine = startLine;
        while (braceLine < lines.length && !lines[braceLine].includes('{')) {
            braceLine++;
        }
        if (braceLine >= lines.length) {
            return `/* [${filePath}:${startLine + 1}] */\n${lines[startLine]}`;
        }

        // Count braces to find end of function body
        let braceCount = 0;
        let endLine = braceLine;
        for (let i = braceLine; i < lines.length; i++) {
            for (const char of lines[i]) {
                if (char === '{') braceCount++;
                else if (char === '}') braceCount--;
            }
            if (braceCount === 0) {
                endLine = i;
                break;
            }
        }

        // Optional: include doc comment above
        let docStart = startLine;
        if (includeDoc) {
            for (let i = startLine - 1; i >= 0; i--) {
                const trimmed = lines[i].trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed === '') {
                    docStart = i;
                    if (trimmed.startsWith('/*') && !trimmed.endsWith('*/')) break;
                } else {
                    break;
                }
            }
        }

        const bodyLines = lines.slice(docStart, endLine + 1);
        return `/* [${filePath}:${docStart + 1}-${endLine + 1}] Function: ${functionName} */\n${bodyLines.join('\n')}`;
    }

    async fixScriptEncoding(filePath: string): Promise<string> {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.serverRoot, filePath);

        // Check file exists
        try {
            await fs.access(fullPath);
        } catch {
            throw new Error(`File not found: ${filePath}`);
        }

        const buffer = await fs.readFile(fullPath);

        // Detect if file is valid UTF-8
        const utf8Str = buffer.toString('utf8');
        const isUtf8 = Buffer.from(utf8Str, 'utf8').equals(buffer);

        if (!isUtf8) {
            return `[INFO] File "${filePath}" is not UTF-8. No conversion needed. Current encoding appears correct.`;
        }

        const hasThai = /[\u0E00-\u0E7F]/.test(utf8Str);
        if (!hasThai) {
            return `[INFO] File "${filePath}" is UTF-8 but contains no Thai characters. No conversion needed.`;
        }

        // File is UTF-8 with Thai → convert to windows-874
        try {
            const backupPath = await this.backupFile(fullPath);
            const windows874Buffer = iconv.encode(utf8Str, 'windows-874');
            await fs.writeFile(fullPath, windows874Buffer);
            return `Successfully fixed encoding for "${filePath}".\nConverted from UTF-8 → windows-874 (Thai).\nBackup: ${backupPath || 'N/A'}`;
        } catch (err: any) {
            throw new Error(`Failed to convert encoding: ${err.message}`);
        }
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

    async restoreScript(filePath: string, backupPath?: string): Promise<string> {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.serverRoot, filePath);
        const backupDir = path.join(this.serverRoot, '.samp-mcp-backups');

        if (backupPath) {
            const target = path.isAbsolute(backupPath) ? backupPath : path.join(backupDir, backupPath);
            await fs.copyFile(target, fullPath);
            return `Restored ${filePath} from ${backupPath}`;
        }

        // Find the latest backup for this file
        const relativePath = path.relative(this.serverRoot, fullPath);
        const safeName = relativePath.replace(/[\\/]/g, '_');

        try {
            const files = await fs.readdir(backupDir);
            const matching = files
                .filter(f => f.startsWith(safeName + '.') && f.endsWith('.bak'))
                .sort((a, b) => b.localeCompare(a)); // Newest first

            if (matching.length === 0) {
                throw new Error('No backups found for this file.');
            }

            const latest = path.join(backupDir, matching[0]);
            await fs.copyFile(latest, fullPath);
            return `Restored ${filePath} from latest backup: ${matching[0]}`;
        } catch (e: any) {
            throw new Error(`Restore failed: ${e.message}`);
        }
    }

    async listBackups(filePath?: string): Promise<any[]> {
        const backupDir = path.join(this.serverRoot, '.samp-mcp-backups');
        try {
            const files = await fs.readdir(backupDir);
            let backups = files
                .filter(f => f.endsWith('.bak'))
                .map(f => {
                    const stat = fsSyncStat(path.join(backupDir, f));
                    return {
                        name: f,
                        size: stat.size,
                        created: stat.mtime.toISOString()
                    };
                })
                .sort((a, b) => b.created.localeCompare(a.created));

            if (filePath) {
                const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.serverRoot, filePath);
                const relativePath = path.relative(this.serverRoot, fullPath);
                const safeName = relativePath.replace(/[\\/]/g, '_');
                backups = backups.filter(b => b.name.startsWith(safeName + '.'));
            }

            return backups;
        } catch {
            return [];
        }
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

    async readInclude(name: string): Promise<string> {
        const fileName = name.endsWith('.inc') ? name : `${name}.inc`;
        const searchPaths = [
            path.join(this.serverRoot, 'pawno', 'include'),
            path.join(this.serverRoot, 'include'),
            path.join(this.serverRoot, 'gamemodes', 'include')
        ];

        for (const basePath of searchPaths) {
            try {
                // Try direct path first
                const directPath = path.join(basePath, fileName);
                const buffer = await fs.readFile(directPath);
                return iconv.decode(buffer, 'windows-874');
            } catch { }

            // Fallback: search recursively in subdirectories
            try {
                const files = await this.readdirRecursive(basePath);
                const match = files.find(f => f.toLowerCase() === fileName.toLowerCase() ||
                    f.toLowerCase().replace(/\\/g, '/').endsWith(fileName.toLowerCase()));
                if (match) {
                    const buffer = await fs.readFile(path.join(basePath, match));
                    return iconv.decode(buffer, 'windows-874');
                }
            } catch { }
        }
        throw new Error(`Include file ${name} not found in common paths.`);
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
            thaiSupport: false
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
            } catch { }
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

        let reposToCheck: Array<{ full_name: string; html_url: string; description?: string }> = [];

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
        const checkVersion = current;
        try {
            const { stdout } = await execPromise('npm view samp-mcp version');
            const latest = stdout.trim();
            return {
                current,
                latest,
                needsUpdate: latest !== current
            };
        } catch (e) {
            return { current, latest: current, needsUpdate: false };
        }
    }

    async updateMcpServer(): Promise<string> {
        try {
            await execPromise('npm install -g samp-mcp');
            return "SAMP-MCP has been updated to the latest version. Please restart your MCP client.";
        } catch (error: any) {
            throw new Error(`Update failed: ${error.message}`);
        }
    }

    async transformScript(sourcePath: string, targetName: string, oldTheme: string, newTheme: string): Promise<string> {
        const content = await this.readScript(sourcePath);
        
        // Character substitution with case awareness
        const replaceTheme = (text: string, oldT: string, newT: string) => {
            let result = text;
            
            // 1. UPPER_CASE (e.g. JUICE -> WATERMELON)
            result = result.split(oldT.toUpperCase()).join(newT.toUpperCase());
            
            // 2. lowercase (e.g. juice -> watermelon)
            result = result.split(oldT.toLowerCase()).join(newT.toLowerCase());
            
            // 3. TitleCase / CamelCase (e.g. Juice -> Watermelon)
            const oldTitle = oldT.charAt(0).toUpperCase() + oldT.slice(1).toLowerCase();
            const newTitle = newT.charAt(0).toUpperCase() + newT.slice(1).toLowerCase();
            result = result.split(oldTitle).join(newTitle);
            
            // 4. Exact match as fallback
            result = result.split(oldT).join(newT);
            
            return result;
        };

        const transformed = replaceTheme(content, oldTheme, newTheme);
        
        const sourceExt = path.extname(sourcePath) || '.pwn';
        const targetFileName = targetName.endsWith(sourceExt) ? targetName : targetName + sourceExt;
        
        const sourceFullPath = path.isAbsolute(sourcePath) ? sourcePath : path.join(this.serverRoot, sourcePath);
        const sourceDir = path.dirname(sourceFullPath);
        const targetFullPath = path.join(sourceDir, targetFileName);
        
        await this.writeScript(targetFullPath, transformed);
        return targetFullPath;
    }

    async designFeature(title: string, description: string, requirements?: string[]): Promise<string> {
        if (!this.serverRoot) throw new Error("No root set. Run set_server_root first.");

        const planDir = path.join(this.serverRoot, '.samp-mcp-plans');
        await fs.mkdir(planDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeTitle = title.replace(/[^a-zA-Z0-9\u0E00-\u0E7F_-]/g, '_').substring(0, 50);
        const filename = `${timestamp}_${safeTitle}.md`;
        const filepath = path.join(planDir, filename);

        const reqList = requirements && requirements.length > 0
            ? requirements.map(r => `  - ${r}`).join('\n')
            : '  - (none specified)';

        const plan = `# Feature Plan: ${title}
Generated: ${new Date().toISOString()}
Status: PENDING_REVIEW

## 1. Overview
${description}

## 2. Explicit Requirements
${reqList}

## 3. Files to Create / Modify
- [ ] Identify main script file
- [ ] Identify include files needed
- [ ] Identify filterscripts to create (if any)

## 4. Data Structures & Variables
- [ ] Define enums/constants
- [ ] Define global variables / arrays
- [ ] Define player variables (if using per-player data)

## 5. Event Handlers & Callbacks
- [ ] OnGameModeInit / OnFilterScriptInit
- [ ] OnPlayerConnect / OnPlayerDisconnect
- [ ] OnPlayerDeath / OnPlayerSpawn
- [ ] OnPlayerKeyStateChange / OnPlayerUpdate
- [ ] Timers (SetTimer / SetTimerEx)
- [ ] Commands (ZCMD / Pawn.CMD)

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
1. Step 1:
2. Step 2:
3. Step 3:

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
                const cursorRules = `
# CRITICAL: SAMP ENCODING RULES (MANDATORY)

1. **ENCODING**: This project uses **${isThai ? 'Thai (Windows-874)' : 'International'}** encoding. 
2. **FORBIDDEN TOOLS**: NEVER use your built-in 'read_file', 'write_file', 'grep', or 'edit_file' tools on **.pwn** or **.inc** files. They WILL corrupt Thai characters (e.g. 'เธเธ').
3. **MANDATORY TOOLS**: You **MUST** use 'samp-mcp' tools:
   - Use 'read_pawn_script' to read.
   - Use 'write_pawn_script' to write.
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

FAILURE TO FOLLOW THESE RULES WILL RESULT IN PERMANENT DATA CORRUPTION.
`;
        const sampRules = `# SAMP Project Rules (Universal)
MANDATORY for Windsurf, Cursor, Antigravity, and all AI Agents:

1. **ENCODING (CRITICAL)**:
   - This project uses **${isThai ? 'Thai (Windows-874)' : 'Universal Auto-Detection'}**.
   - **NEVER** use built-in tools like 'read_file', 'write_file', or 'grep' on .pwn or .inc files.
   - **MANDATORY**: You **MUST** use the following SAMP-MCP tools:
     - 'read_pawn_script': To read source code safely.
     - 'write_pawn_script': To save code without corruption.
     - 'fix_script_encoding': Use immediately if you see garbage (เธเธ) in any file.

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

FAILURE TO USE SAMP-MCP TOOLS WILL CAUSE PERMANENT DATA CORRUPTION.
`;

        await fs.writeFile(path.join(this.serverRoot, 'AI_RULES.md'), cursorRules, 'utf8');
        await fs.writeFile(path.join(this.serverRoot, 'SAMP_RULES.md'), sampRules, 'utf8');
        
        return `AI Environment setup complete in ${this.serverRoot}. Rules written to AI_RULES.md and SAMP_RULES.md. Encoding set to ${this.preferredEncoding}.`;
    }

    async getFormattedGuidelines(): Promise<string> {
        const p = await this.detectPatterns();
        const isThai = this.preferredEncoding === 'windows-874';
        
        return `
# UNIVERSAL RULES FOR ALL AI AGENTS (SAMP-MCP)

1. **ENCODING (CRITICAL)**:
   - This project uses **${isThai ? 'Thai (Windows-874)' : 'International (UTF-8)'}** encoding.
   - Standard file tools (view_file, write_file) **WILL** corrupt Thai characters if present.
   - You **MUST** use 'read_pawn_script' and 'write_pawn_script' for all .pwn and .inc files.

2. **LANGUAGE PRESERVATION**:
   - **DO NOT** translate existing strings. 
   - Maintain the project's primary language (${isThai ? 'Thai' : 'English'}).
   - If the project is Thai, stay in Thai. If it is English, stay in English.

3. **CORRUPTION RECOVERY**:
   ${isThai ? "- If you see garbled text (???? or ยยกต), use 'fix_script_encoding' immediately." : "- Ensure you don't introduce encoding mismatches."}

4. **PROJECT CONTEXT**:
   - Thai Support: ${p.thaiSupport ? 'YES' : 'NO'}
   - Preferred Encoding: ${this.preferredEncoding}
   - Logic Style: ${p.hasYSI ? 'YSI (Hooks enabled)' : 'Standard'}
   - Commands: ${p.hasPawnCMD ? 'Pawn.CMD' : (p.hasZCMD ? 'ZCMD' : 'Standard')}

5. **CODE STYLE**:
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



