import { exec, spawn } from "node:child_process";
import type { ProviderStatus, Settings } from "@arcex/contracts";
import { BUILTIN, agentList } from "./agents.ts";

/**
 * For agents with no sign-in check of their own: whether a session opens. Null when it could not tell. Opening a
 * session sends no message, so it spends nothing.
 */
export type Probe = (agentId: string) => Promise<{ signedIn: boolean | null; methods: { id: string; name: string }[] }>;

// Fixed commands only. They ask each maker's own tool whether it is installed and signed in.
// Arcex never reads the credentials themselves.
const CHECKS: Record<string, { version: string; auth?: string; signedIn?(output: string, ok: boolean): boolean | null }> = {
  claude: {
    version: "claude --version",
    auth: "claude auth status",
    signedIn: (output) => (/"loggedIn":\s*true/.test(output) ? true : /"loggedIn":\s*false/.test(output) ? false : null),
  },
  codex: {
    version: "codex --version",
    auth: "codex login status",
    signedIn: (output, ok) => (/logged in/i.test(output) && ok ? true : /not logged in/i.test(output) || !ok ? false : null),
  },
  opencode: { version: "opencode --version" },
  gemini: { version: "gemini --version" },
  // OpenCode and Gemini have no status command: the probe asks the agent itself.
};

// The newest published version of each maker's tool, read from the public npm registry at most every six hours.
// Nothing about the user is sent: it is a plain request for the package's latest version.
const releases = new Map<string, { at: number; version: Promise<string | null> }>();
function latestRelease(pkg: string): Promise<string | null> {
  const cached = releases.get(pkg);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.version;
  const version = fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } })
    .then((response) => (response.ok ? (response.json() as Promise<{ version?: unknown }>) : null))
    .then((body) => (body && typeof body.version === "string" && /^\d+\.\d+\.\d+$/.test(body.version) ? body.version : null))
    .catch(() => null);
  releases.set(pkg, { at: Date.now(), version });
  return version;
}

/** Whether version `a` is older than `b`, both plain x.y.z. */
function older(a: string, b: string): boolean {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) < (right[index] ?? 0);
  return false;
}

function run(command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ ok: !error, output: `${stdout}${stderr}`.slice(0, 4000) }),
    );
  });
}

export async function providerStatus(settings: Settings, probe?: Probe): Promise<ProviderStatus[]> {
  return Promise.all(
    agentList(settings).map(async (agent): Promise<ProviderStatus> => {
      const check = CHECKS[agent.id];
      const signInCommand = BUILTIN[agent.id]?.signIn ?? "";
      // Agents the user added are started with their own command. Arcex cannot tell more until one runs.
      if (!check) {
        const asked = probe ? await probe(agent.id) : null;
        return { id: agent.id, name: agent.name, installed: true, signedIn: asked?.signedIn ?? null, version: null, signInCommand, signInMethods: asked?.methods ?? [] };
      }
      const version = await run(check.version);
      if (!version.ok) return { id: agent.id, name: agent.name, installed: false, signedIn: null, version: null, signInCommand };
      const release = BUILTIN[agent.id]?.release;
      const [auth, latest] = await Promise.all([check.auth ? run(check.auth) : null, release ? latestRelease(release.npm) : null]);
      const asked = !check.auth && probe ? await probe(agent.id) : null;
      const current = version.output.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
      return {
        id: agent.id,
        name: agent.name,
        installed: true,
        signedIn: auth && check.signedIn ? check.signedIn(auth.output, auth.ok) : asked?.signedIn ?? null,
        signInMethods: asked?.methods ?? [],
        version: current,
        signInCommand,
        ...(BUILTIN[agent.id]?.providers ? { providersCommand: BUILTIN[agent.id]!.providers } : {}),
        ...(release && current && latest && older(current, latest) ? { update: { latest, command: release.update } } : {}),
      };
    }),
  );
}

/**
 * Opens a terminal window running one of Arcex's own fixed sign-in commands, for sign-ins that only work in a terminal
 * (OpenCode's provider picker, Claude's and Codex's logins). The user finishes there; the maker's tool keeps the result.
 */
export function openTerminal(command: string): void {
  if (!/^[\w .@/-]{1,80}$/.test(command)) throw new Error("that command can't be opened");
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/d", "/c", `start "Arcex sign-in" cmd.exe /k ${command}`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
  } else if (process.platform === "darwin") {
    spawn("osascript", ["-e", `tell application "Terminal" to do script "${command}"`, "-e", 'tell application "Terminal" to activate'], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("x-terminal-emulator", ["-e", command], { detached: true, stdio: "ignore" }).unref();
  }
}
