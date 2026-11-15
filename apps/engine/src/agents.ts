import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import type { Agent, ModelOption, Settings } from "@arcex/contracts";

const engineRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Agents Arcex knows how to start. Every one speaks the Agent Client Protocol and runs as its maker's own tool,
 * signed in by the user. `adapter` agents ship with Arcex; `command` agents must be installed on the computer.
 */
export const BUILTIN: Record<string, { name: string; adapter?: { pkg: string; bin: string }; command?: string; signIn: string }> = {
  claude: { name: "Claude", adapter: { pkg: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp" }, signIn: "claude auth login" },
  codex: { name: "Codex", adapter: { pkg: "@agentclientprotocol/codex-acp", bin: "codex-acp" }, signIn: "codex login" },
  opencode: { name: "OpenCode", command: "opencode acp", signIn: "opencode auth login" },
  gemini: { name: "Gemini", command: "gemini --experimental-acp", signIn: "gemini" },
};

export function agentList(settings: Settings): Agent[] {
  return [
    ...Object.entries(BUILTIN).map(([id, agent]) => ({ id, name: agent.name, builtin: true, command: agent.command ?? null })),
    ...settings.agents.map((agent) => ({ ...agent, builtin: false })),
  ];
}

type Launch = { command: string; args: string[]; shell: boolean };

function launchOf(agentId: string, settings: Settings): Launch {
  const builtin = BUILTIN[agentId];
  if (builtin?.adapter) {
    // Read the bin path from the package manifest. require.resolve cannot be used: these packages restrict "exports".
    const dir = path.join(engineRoot, "node_modules", builtin.adapter.pkg);
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { bin: Record<string, string> };
    return { command: process.execPath, args: [path.join(dir, manifest.bin[builtin.adapter.bin]!)], shell: false };
  }
  const command = builtin?.command ?? settings.agents.find((agent) => agent.id === agentId)?.command;
  if (!command) throw new Error("that agent is no longer set up");
  // A command line the user (or Arcex) wrote, so it goes through the shell as typed.
  return { command, args: [], shell: true };
}

export type Models = { options: ModelOption[]; current: string | null };

/** Agents describe their models as a "model" choice among the session's options. */
function modelsOf(response: { configOptions?: acp.SessionConfigOption[] | null }): Models | null {
  const option = response.configOptions?.find((entry) => entry.type === "select" && (entry.category === "model" || entry.id === "model"));
  if (!option || option.type !== "select") return null;
  const flat = (option.options as unknown as ({ value?: string; name?: string; description?: string | null; options?: unknown[] })[]).flatMap(
    (entry) => (Array.isArray(entry.options) ? (entry.options as typeof option.options as unknown as { value: string; name: string; description?: string | null }[]) : [entry]),
  );
  return {
    options: flat.filter((entry) => typeof entry.value === "string").map((entry) => ({ value: entry.value!, name: entry.name ?? entry.value!, description: entry.description ?? "" })),
    current: typeof option.currentValue === "string" ? option.currentValue : null,
  };
}

export type AgentSession = {
  sessionId: string;
  /** False when a saved conversation could not be reopened and a fresh one was started instead. */
  resumed: boolean;
  models: Models | null;
  setModel(value: string): Promise<void>;
  prompt(text: string): Promise<acp.PromptResponse>;
  cancel(): Promise<void>;
  close(): void;
};

/** Starts one agent process and opens a session in `cwd`, reopening `resumeId` when the agent supports it. */
export async function startSession(options: {
  agentId: string;
  settings: Settings;
  cwd: string;
  resumeId: string | null;
  /** MCP servers the agent may use in this session. Web-based ones are dropped if the agent cannot reach them. */
  mcpServers: acp.McpServer[];
  onUpdate(update: acp.SessionUpdate): void;
  onPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  onExit(detail: string): void;
}): Promise<AgentSession> {
  const launch = launchOf(options.agentId, options.settings);
  const child: ChildProcess = spawn(launch.command, launch.args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], shell: launch.shell, windowsHide: true });
  let stderrTail = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });
  const failed = new Promise<never>((_, reject) => {
    child.once("error", (error) => reject(new Error(`could not start: ${error.message}`)));
    child.once("exit", (code) => reject(new Error(`stopped before it was ready (${code}). ${stderrTail.trim().slice(-300)}`)));
  });
  failed.catch(() => {});

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
    const init = await Promise.race([
      agent.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "arcex", title: "Arcex", version: "0.1.0" },
      }),
      failed,
    ]);
    const canHttp = init.agentCapabilities?.mcpCapabilities?.http === true;
    const mcpServers = options.mcpServers.filter((server) => !("type" in server && server.type === "http") || canHttp);

    let sessionId: string | null = null;
    let models: Models | null = null;
    if (options.resumeId && init.agentCapabilities?.loadSession) {
      try {
        models = modelsOf(await Promise.race([agent.request("session/load", { sessionId: options.resumeId, cwd: options.cwd, mcpServers }), failed]));
        sessionId = options.resumeId;
      } catch {
        sessionId = null;
      }
    }
    const resumed = sessionId !== null;
    if (!sessionId) {
      const created = await Promise.race([agent.request("session/new", { cwd: options.cwd, mcpServers }), failed]);
      sessionId = created.sessionId;
      models = modelsOf(created);
    }
    live = true;
    child.removeAllListeners("exit");
    child.once("exit", (code) => options.onExit(`The agent stopped unexpectedly (${code}). ${stderrTail}`.trim()));

    const id = sessionId;
    return {
      sessionId: id,
      resumed,
      models,
      async setModel(value) {
        await agent.request("session/set_config_option", { sessionId: id, configId: "model", value });
      },
      prompt: (text) => agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text }] }),
      cancel: () => agent.notify("session/cancel", { sessionId: id }),
      close: () => {
        child.removeAllListeners("exit");
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

/** Opens a session only to read the agent's model list, then closes it. No message is sent, so nothing is spent. */
export async function listModels(agentId: string, settings: Settings, cwd: string): Promise<Models> {
  const session = await startSession({
    agentId, settings, cwd, resumeId: null, mcpServers: [],
    onUpdate: () => {},
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    onExit: () => {},
  });
  session.close();
  return session.models ?? { options: [], current: null };
}
