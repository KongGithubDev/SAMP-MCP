import { existsSync } from "node:fs";
import { copyFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const WINDOWS_REL_PATH = join("Programs", "mcp-file-tools", "mcp-file-tools.exe");
const UNIX_REL_PATH = join(".local", "bin", "mcp-file-tools");

const GITHUB_REPO = "dimitar-grigorov/mcp-file-tools";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

function runBinary(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: 20000 }, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve((stdout || stderr || "").trim());
        });
    });
}

function compareVersions(a: string, b: string): number {
    const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
    const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function platformAssetName(): string {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    switch (process.platform) {
        case "win32":
            return `mcp-file-tools_windows_${arch}.exe`;
        case "darwin":
            return `mcp-file-tools_darwin_${arch}`;
        default:
            return `mcp-file-tools_linux_${arch}`;
    }
}

/**
 * Bridges samp-mcp to the encoding-aware mcp-file-tools server
 * (https://github.com/dimitar-grigorov/mcp-file-tools).
 *
 * The binary is spawned as a stdio MCP child process, sandboxed to the
 * connected SAMP server root, so agents can read/write/edit Thai
 * (windows-874) scripts with CRLF preserved — through samp-mcp.
 *
 * The binary itself is NOT managed by samp-mcp's npm lifecycle: it is found at
 * a default install location (or SAMP_MCP_FILE_TOOLS_COMMAND) and used as-is.
 * updateFileTools() fetches the latest GitHub release and replaces it, keeping
 * a backup of the previous version.
 */
export class FileToolsBridge {
    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private serverRoot: string | null = null;
    private allowedRoot: string | null = null;

    setRoot(root: string) {
        this.serverRoot = root;
    }

    private defaultBinaryPath(): string {
        if (process.platform === "win32") {
            const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
            return join(base, WINDOWS_REL_PATH);
        }
        return join(homedir(), UNIX_REL_PATH);
    }

    private resolveCommand(): string | null {
        const override = process.env.SAMP_MCP_FILE_TOOLS_COMMAND;
        if (override) return override;
        const p = this.defaultBinaryPath();
        if (existsSync(p)) return p;
        return null;
    }

    /** Runs `<binary> --version` and returns the version string, or null. */
    async getInstalledVersion(binaryPath?: string): Promise<string | null> {
        const command = binaryPath ?? this.resolveCommand();
        if (!command) return null;
        try {
            const out = await runBinary(command, ["--version"]);
            return out || null;
        } catch {
            return null;
        }
    }

    /**
     * Downloads the latest mcp-file-tools release binary from GitHub and
     * replaces the installed one. The previous binary is copied to
     * `<binary>.v<old>.bak` before replacement (fresh install when missing).
     * Returns a summary; throws on failure (restoring the backup if the new
     * binary fails verification).
     */
    async updateFileTools(): Promise<string> {
        // Release any running child process first: on Windows a running .exe is
        // locked and cannot be overwritten.
        await this.dispose();

        const { version, downloadUrl } = await this.fetchLatestRelease();
        const binaryPath = this.resolveCommand();
        const installed = await this.getInstalledVersion();

        if (installed && compareVersions(installed, version) >= 0) {
            return `mcp-file-tools is already up to date (v${installed}). No update needed.`;
        }

        const response = await fetch(downloadUrl, {
            redirect: "follow",
            headers: { "User-Agent": "samp-mcp" },
        });
        if (!response.ok) {
            throw new Error(`Download failed (HTTP ${response.status}): ${downloadUrl}`);
        }
        const data = Buffer.from(await response.arrayBuffer());
        if (data.length === 0) {
            throw new Error("Downloaded file is empty; update aborted.");
        }

        let backupPath: string | null = null;
        if (binaryPath && existsSync(binaryPath)) {
            backupPath = `${binaryPath}.v${installed || "old"}.bak`;
            await copyFile(binaryPath, backupPath);
        }

        const target = binaryPath ?? this.defaultBinaryPath();
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, data);
        if (process.platform !== "win32") {
            await chmod(target, 0o755);
        }

        // Verify the replaced binary runs; roll back to the backup on failure.
        const newVersion = await this.getInstalledVersion(target);
        if (!newVersion) {
            if (backupPath) await copyFile(backupPath, target).catch(() => {});
            throw new Error("The updated binary failed to run (--version check). Previous version restored.");
        }

        const versionLabel = installed ? `v${installed} → v${newVersion}` : `v${newVersion}`;
        return [
            `mcp-file-tools updated: ${versionLabel}`,
            `Binary: ${target}`,
            backupPath
                ? `Backup of the previous version saved to: ${backupPath}`
                : "No previous binary found — fresh install (nothing to back up).",
            "The file-tools connection was closed; the new binary will be used on the next file_* call.",
        ].join("\n");
    }

    private async fetchLatestRelease(): Promise<{ version: string; assetName: string; downloadUrl: string }> {
        const response = await fetch(LATEST_RELEASE_URL, {
            headers: {
                "User-Agent": "samp-mcp",
                "Accept": "application/vnd.github+json",
            },
        });
        if (!response.ok) {
            throw new Error(
                `GitHub API request failed (HTTP ${response.status}). You may be rate-limited — try again later.`
            );
        }
        const release = (await response.json()) as {
            tag_name?: string;
            assets?: { name: string; browser_download_url?: string }[];
        };
        const version = String(release.tag_name || "").replace(/^v/, "");
        if (!version) {
            throw new Error("Could not determine the latest mcp-file-tools version from GitHub.");
        }
        const assetName = platformAssetName();
        const asset = (release.assets || []).find((a) => a.name === assetName);
        if (!asset?.browser_download_url) {
            throw new Error(`No "${assetName}" asset found in the latest release (v${version}).`);
        }
        return { version, assetName, downloadUrl: asset.browser_download_url };
    }

    private async ensureConnected() {
        if (this.client && this.transport) {
            if (this.allowedRoot === this.serverRoot) return;
            await this.dispose();
        }
        if (!this.serverRoot) {
            throw new Error("No SAMP server root set. Use 'set_server_root' first.");
        }
        const command = this.resolveCommand();
        if (!command) {
            throw new Error(
                "mcp-file-tools binary not found. Install it from https://github.com/dimitar-grigorov/mcp-file-tools " +
                "(Windows: %LOCALAPPDATA%\\Programs\\mcp-file-tools\\mcp-file-tools.exe) or set " +
                "SAMP_MCP_FILE_TOOLS_COMMAND to its path."
            );
        }
        const transport = new StdioClientTransport({
            command,
            args: [this.serverRoot]
        });
        const client = new Client({ name: "samp-mcp-file-tools", version: "1.0.0" });
        try {
            await client.connect(transport);
        } catch (error: any) {
            await transport.close().catch(() => {});
            throw new Error(`Failed to start mcp-file-tools (${command}): ${error.message}`);
        }
        this.client = client;
        this.transport = transport;
        this.allowedRoot = this.serverRoot;
    }

    async call(name: string, args: Record<string, unknown>): Promise<string> {
        await this.ensureConnected();
        try {
            return await this.invoke(name, args);
        } catch {
            // Child process died or protocol error: restart once and retry
            await this.dispose();
            await this.ensureConnected();
            return await this.invoke(name, args);
        }
    }

    private async invoke(name: string, args: Record<string, unknown>): Promise<string> {
        const result = await this.client!.callTool({ name, arguments: args });
        const content = (result as any).content as { type: string; text: string }[] | undefined;
        const text = (content || [])
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        if ((result as any).isError) {
            throw new Error(text || `${name} failed`);
        }
        return text;
    }

    async dispose() {
        const t = this.transport;
        this.transport = null;
        this.client = null;
        if (t) await t.close().catch(() => {});
    }
}