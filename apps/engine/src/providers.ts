import { exec } from "node:child_process";
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
      const auth = check.auth ? await run(check.auth) : null;
      const asked = !check.auth && probe ? await probe(agent.id) : null;
      return {
        id: agent.id,
        name: agent.name,
        installed: true,
        signedIn: auth && check.signedIn ? check.signedIn(auth.output, auth.ok) : asked?.signedIn ?? null,
        signInMethods: asked?.methods ?? [],
        version: version.output.match(/\d+\.\d+\.\d+/)?.[0] ?? null,
        signInCommand,
      };
    }),
  );
}
