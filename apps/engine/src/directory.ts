// The agent directory: the official ACP registry, which lists the coding agents of every major model maker.
// Adding one stores how to start it. npm agents run through npx at the pinned version. Binary agents are downloaded
// over HTTPS, checked against the registry's checksum when it gives one, and unpacked into Arcex's data folder.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DirectoryAgent } from "@arcex/contracts";

const REGISTRY = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const FRESH_MS = 24 * 60 * 60 * 1000;
const MAX_DOWNLOAD = 400 * 1024 * 1024;

/** The model makers' own agents, shown first and in this order. The rest follow by name. */
const FEATURED = [
  "github-copilot-cli", "cursor", "grok-build", "mistral-vibe", "qwen-code", "kimi-code", "minimax-code", "glm-acp-agent",
  "muse-code", "antigravity-acp", "kiro", "junie", "amp-acp", "factory-droid", "devin", "goose", "cline", "kilo", "auggie",
];
/** Already built into Arcex, so not offered again. */
const BUILT_IN = new Set(["claude-acp", "codex-acp", "gemini", "opencode", "opencode-v2"]);

type Target = { archive: string; cmd: string; args?: string[]; env?: Record<string, string>; sha256?: string };
type Entry = {
  id: string; name: string; version: string; description?: string; website?: string; repository?: string; icon?: string;
  distribution: { npx?: { package: string; args?: string[]; env?: Record<string, string> }; uvx?: { package: string; args?: string[]; env?: Record<string, string> }; binary?: Record<string, Target> };
};

/** How an added agent starts: a command line for the shell, plus extra environment. */
export type Installed = { command: string; env: Record<string, string>; version: string };

function platformKey(): string {
  const osName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `${osName}-${arch}`;
}

/** Arguments come from the registry. They are quoted for the shell, and anything a shell could act on is refused. */
function quote(value: string): string {
  if (/["%^&|<>`$\r\n]/.test(value)) throw new Error("the directory entry has an argument Arcex won't pass to a shell");
  return /[\s()]/.test(value) ? `"${value}"` : value;
}

function run(file: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { cwd, windowsHide: true, timeout: 180_000 }, (error) => (error ? reject(error) : resolve())),
  );
}

export function createDirectory(dataDir: string) {
  const cacheFile = path.join(dataDir, "agent-directory.json");
  const iconsDir = path.join(dataDir, "agent-icons");
  const agentsDir = path.join(dataDir, "agents");
  mkdirSync(iconsDir, { recursive: true });

  async function entries(refresh = false): Promise<Entry[]> {
    const fresh = existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < FRESH_MS;
    if (!fresh || refresh) {
      try {
        const response = await fetch(REGISTRY, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`the directory answered ${response.status}`);
        const body = await response.text();
        if (body.length > 5_000_000) throw new Error("the directory is unexpectedly large");
        JSON.parse(body);
        writeFileSync(cacheFile, body);
      } catch (error) {
        if (!existsSync(cacheFile)) throw new Error(`couldn't reach the agent directory: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const parsed = JSON.parse(readFileSync(cacheFile, "utf8")) as { agents?: Entry[] };
    return (parsed.agents ?? []).filter((entry) => typeof entry?.id === "string" && /^[\w.-]{1,80}$/.test(entry.id) && entry.distribution);
  }

  /** What runs on this computer, preferring npx (the maker's own package manager install) over a download. */
  function howToRun(entry: Entry): "npx" | "uvx" | "binary" | null {
    if (entry.distribution.npx?.package) return "npx";
    if (entry.distribution.binary?.[platformKey()]?.archive) return "binary";
    if (entry.distribution.uvx?.package) return "uvx";
    return null;
  }

  return {
    async list(refresh = false): Promise<DirectoryAgent[]> {
      const all = (await entries(refresh)).filter((entry) => !BUILT_IN.has(entry.id) && !/legacy|archived/i.test(`${entry.name} ${entry.description ?? ""}`));
      const rank = (id: string) => (FEATURED.includes(id) ? FEATURED.indexOf(id) : FEATURED.length);
      return all
        .map((entry) => ({
          id: entry.id,
          name: String(entry.name).slice(0, 60),
          description: String(entry.description ?? "").slice(0, 200),
          version: String(entry.version).slice(0, 40),
          website: typeof entry.website === "string" && /^https:\/\//.test(entry.website) ? entry.website : typeof entry.repository === "string" && /^https:\/\//.test(entry.repository) ? entry.repository : null,
          featured: FEATURED.includes(entry.id),
          runs: howToRun(entry),
        }))
        .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
    },

    /** Gets an agent ready to start: nothing to fetch for npx and uvx, a checked download for a binary. */
    async install(id: string): Promise<Installed & { name: string }> {
      const entry = (await entries()).find((candidate) => candidate.id === id);
      if (!entry) throw new Error("that agent isn't in the directory");
      const kind = howToRun(entry);
      if (kind === "npx" || kind === "uvx") {
        const spec = entry.distribution[kind]!;
        const runner = kind === "npx" ? "npx -y" : "uvx";
        return { name: entry.name, version: entry.version, env: spec.env ?? {}, command: [runner, quote(spec.package), ...(spec.args ?? []).map(quote)].join(" ") };
      }
      if (kind !== "binary") throw new Error(`${entry.name} has no build for this computer yet`);
      const target = entry.distribution.binary![platformKey()]!;
      if (!/^https:\/\//.test(target.archive)) throw new Error("the download isn't over HTTPS");
      const dir = path.join(agentsDir, entry.id, entry.version.replace(/[^\w.-]/g, "_"));
      const cmd = path.resolve(dir, target.cmd);
      if (!cmd.startsWith(dir + path.sep)) throw new Error("the directory entry points outside its folder");
      if (!existsSync(cmd)) {
        const response = await fetch(target.archive, { signal: AbortSignal.timeout(300_000) });
        if (!response.ok) throw new Error(`the download answered ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_DOWNLOAD) throw new Error("the download is unexpectedly large");
        if (target.sha256 && createHash("sha256").update(bytes).digest("hex") !== target.sha256.toLowerCase()) {
          throw new Error("the download didn't match the directory's checksum, so it wasn't used");
        }
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        const name = decodeURIComponent(new URL(target.archive).pathname.split("/").pop() ?? "download");
        if (/\.(zip|tar\.gz|tgz|tar\.xz|tar)$/i.test(name)) {
          const archive = path.join(dir, `.download-${path.basename(name)}`);
          writeFileSync(archive, bytes);
          // tar ships with Windows 10 and later and reads zip as well.
          await run(process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar", ["-xf", archive, "-C", dir], dir);
          rmSync(archive, { force: true });
        } else {
          // A single executable, saved under the name the entry runs.
          mkdirSync(path.dirname(cmd), { recursive: true });
          writeFileSync(cmd, bytes, { mode: 0o755 });
        }
        if (!existsSync(cmd)) throw new Error("the download didn't contain the agent's program");
      }
      return { name: entry.name, version: entry.version, env: target.env ?? {}, command: [`"${cmd}"`, ...(target.args ?? []).map(quote)].join(" ") };
    },

    /** The agent's icon from the directory, a one-colour SVG, kept locally. Null when missing or not plainly an image. */
    async icon(id: string): Promise<string | null> {
      if (!/^[\w.-]{1,80}$/.test(id)) return null;
      const file = path.join(iconsDir, `${id}.svg`);
      if (!existsSync(file)) {
        const entry = (await entries()).find((candidate) => candidate.id === id);
        if (!entry?.icon || !/^https:\/\/cdn\.agentclientprotocol\.com\//.test(entry.icon)) return null;
        try {
          const response = await fetch(entry.icon, { signal: AbortSignal.timeout(10_000) });
          const body = response.ok ? await response.text() : "";
          // Served only as an image mask, but still refuse anything that isn't a plain drawing.
          if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(body) || body.length > 100_000 || /<script|<foreignObject|\son\w+\s*=|javascript:/i.test(body)) return null;
          writeFileSync(file, body);
        } catch {
          return null;
        }
      }
      return readFileSync(file, "utf8");
    },
  };
}

export type Directory = ReturnType<typeof createDirectory>;
