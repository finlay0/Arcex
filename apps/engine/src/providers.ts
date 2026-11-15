import { exec } from "node:child_process";
import type { ProviderStatus, Settings } from "@arcex/contracts";
import { BUILTIN, agentList } from "./agents.ts";

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
};

function run(command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ ok: !error, output: `${stdout}${stderr}`.slice(0, 4000) }),
    );
  });
}

export async function providerStatus(settings: Settings): Promise<ProviderStatus[]> {
  return Promise.all(
    agentList(settings).map(async (agent): Promise<ProviderStatus> => {
      const check = CHECKS[agent.id];
      const signInCommand = BUILTIN[agent.id]?.signIn ?? "";
      // Agents the user added are started with their own command. Arcex cannot tell more until one runs.
      if (!check) return { id: agent.id, name: agent.name, installed: true, signedIn: null, version: null, signInCommand };
      const version = await run(check.version);
      if (!version.ok) return { id: agent.id, name: agent.name, installed: false, signedIn: null, version: null, signInCommand };
      const auth = check.auth ? await run(check.auth) : null;
      return {
        id: agent.id,
        name: agent.name,
        installed: true,
        signedIn: auth && check.signedIn ? check.signedIn(auth.output, auth.ok) : null,
        version: version.output.match(/\d+\.\d+\.\d+/)?.[0] ?? null,
        signInCommand,
      };
    }),
  );
}
