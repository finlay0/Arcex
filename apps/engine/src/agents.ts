import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import type { ProviderId } from "@arcex/contracts";

const engineRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Providers are the vendor's own ACP entry point, run unmodified. The user signs in through the vendor's CLI. */
const PROVIDERS: Record<ProviderId, { pkg: string; bin: string }> = {
  claude: { pkg: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp" },
  codex: { pkg: "@agentclientprotocol/codex-acp", bin: "codex-acp" },
};

export const providerIds = Object.keys(PROVIDERS) as ProviderId[];

function entryPoint(id: ProviderId): string {
  const { pkg, bin } = PROVIDERS[id];
  // Read the bin path from the package manifest. require.resolve cannot be used: these packages restrict "exports".
  const dir = path.join(engineRoot, "node_modules", pkg);
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { bin: Record<string, string> };
  return path.join(dir, manifest.bin[bin]!);
}

export type AgentSession = {
  sessionId: string;
  /** False when a saved conversation could not be reopened and a fresh one was started instead. */
  resumed: boolean;
  prompt(text: string): Promise<acp.PromptResponse>;
  cancel(): Promise<void>;
  close(): void;
};

/** Starts one agent process and opens a session in `cwd`, reopening `resumeId` when the agent supports it. */
export async function startSession(options: {
  provider: ProviderId;
  cwd: string;
  resumeId: string | null;
  onUpdate(update: acp.SessionUpdate): void;
  onPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  onExit(detail: string): void;
}): Promise<AgentSession> {
  const child: ChildProcess = spawn(process.execPath, [entryPoint(options.provider)], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderrTail = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });
  child.once("exit", (code) => options.onExit(`The agent stopped unexpectedly (${code}). ${stderrTail}`.trim()));

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );

  // Reopening a session replays its history as updates. The timeline is already saved, so those are dropped.
  let live = false;
  const connection = acp
    .client()
    .onNotification("session/update", ({ params }) => {
      if (live) options.onUpdate(params.update);
    })
    .onRequest("session/request_permission", ({ params }) => options.onPermission(params))
    .connect(stream);
  const agent = connection.agent;

  try {
    const init = await agent.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "arcex", title: "Arcex", version: "0.0.0" },
    });

    let sessionId: string | null = null;
    if (options.resumeId && init.agentCapabilities?.loadSession) {
      try {
        await agent.request("session/load", { sessionId: options.resumeId, cwd: options.cwd, mcpServers: [] });
        sessionId = options.resumeId;
      } catch {
        sessionId = null;
      }
    }
    const resumed = sessionId !== null;
    sessionId ??= (await agent.request("session/new", { cwd: options.cwd, mcpServers: [] })).sessionId;
    live = true;

    const id = sessionId;
    return {
      sessionId: id,
      resumed,
      prompt: (text) => agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text }] }),
      cancel: () => agent.notify("session/cancel", { sessionId: id }),
      close: () => {
        connection.close();
        child.kill();
      },
    };
  } catch (error) {
    child.removeAllListeners("exit");
    connection.close();
    child.kill();
    throw error;
  }
}
