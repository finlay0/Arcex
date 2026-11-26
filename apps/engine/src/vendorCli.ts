// The installed app doesn't carry its own copies of Claude Code and Codex (together over 800 MB, and minutes to unpack).
// Their adapters run the copies the user installed and signed in to, which is the vendor's own CLI as Arcex intends.
// From source, the adapters' bundled copies are still there and are used as before.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const found = new Map<string, { path: string | null; at: number }>();

/** Every match for a command on PATH, in order (Windows `where`, elsewhere `which -a`). */
function onPath(command: string): Promise<string[]> {
  return new Promise((resolve) => {
    const [tool, args] = process.platform === "win32" ? ["where.exe", [command]] : ["which", ["-a", command]];
    execFile(tool, args, { windowsHide: true, timeout: 5000 }, (error, stdout) => resolve(error ? [] : stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)));
  });
}

/** An npm shim (`claude.cmd`) names the real program it runs; this reads it out. */
function behindShim(shim: string, program: string): string | null {
  try {
    const text = readFileSync(shim, "utf8");
    const match = text.match(new RegExp(`"%(?:dp0|~dp0)%\\\\?([^"]*\\\\${program})"`, "i"));
    if (!match) return null;
    const target = path.join(path.dirname(shim), match[1]!);
    return existsSync(target) ? target : null;
  } catch {
    return null;
  }
}

/** Claude Code's own program: a native install, or the one an npm install's shim points to. */
async function claudePath(): Promise<string | null> {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  for (const hit of await onPath("claude")) {
    if (/\.exe$/i.test(hit) || (process.platform !== "win32" && !/\.(cmd|ps1)$/i.test(hit))) return hit;
    if (/\.cmd$/i.test(hit)) {
      const target = behindShim(hit, exe);
      if (target) return target;
    }
  }
  const native = path.join(os.homedir(), ".local", "bin", exe);
  return existsSync(native) ? native : null;
}

/** Codex as the user runs it. The Codex adapter starts .cmd shims itself, so the first match on PATH will do. */
async function codexPath(): Promise<string | null> {
  const hits = await onPath("codex");
  return hits.find((hit) => /\.(exe|cmd)$/i.test(hit)) ?? hits[0] ?? null;
}

/** Remembered for a minute, so starting several threads doesn't search PATH each time. */
export async function vendorCli(agentId: "claude" | "codex"): Promise<string | null> {
  const cached = found.get(agentId);
  if (cached && Date.now() - cached.at < 60_000) return cached.path;
  const result = agentId === "claude" ? await claudePath() : await codexPath();
  found.set(agentId, { path: result, at: Date.now() });
  return result;
}

/** The environment variable each adapter reads for the user's own copy. */
export const VENDOR_ENV = { claude: "CLAUDE_CODE_EXECUTABLE", codex: "CODEX_PATH" } as const;
