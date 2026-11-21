import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import type { Agent, AgentChoice, ModelOption, Settings, SlashCommand } from "@arcex/contracts";

const engineRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLAN_NOTE =
  "You are working inside Arcex, where the user sees your task list as a checklist while you work. " +
  "When a request needs three or more distinct steps, make a task list first with your task or todo tool " +
  "and keep each task's status current as you go. Skip the list for quick questions and one-step changes.";

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

export type Models = { options: ModelOption[]; current: string | null; choices: AgentChoice[]; commands: SlashCommand[] };

function commandsOf(list: acp.AvailableCommand[]): SlashCommand[] {
  return list.slice(0, 200).map((command) => ({
    name: String(command.name).replace(/^\//, "").slice(0, 80),
    description: String(command.description ?? "").slice(0, 300),
    hint: command.input && "hint" in command.input && command.input.hint ? String(command.input.hint).slice(0, 120) : null,
  })).filter((command) => command.name);
}

/** Agents describe their models as a "model" choice among the session's options. */
function modelsOf(response: { configOptions?: acp.SessionConfigOption[] | null }): (Omit<Models, "commands"> & { configId: string }) | null {
  const option = response.configOptions?.find((entry) => entry.type === "select" && (entry.category === "model" || entry.id === "model"));
  if (!option || option.type !== "select") return null;
  const flat = (option.options as unknown as ({ value?: string; name?: string; description?: string | null; options?: unknown[] })[]).flatMap(
    (entry) => (Array.isArray(entry.options) ? (entry.options as typeof option.options as unknown as { value: string; name: string; description?: string | null }[]) : [entry]),
  );
  return {
    configId: option.id,
    options: flat.filter((entry) => typeof entry.value === "string").map((entry) => ({ value: entry.value!, name: entry.name ?? entry.value!, description: entry.description ?? "" })),
    current: typeof option.currentValue === "string" ? option.currentValue : null,
    choices: [],
  };
}

const CHOICE_CATEGORIES = ["mode", "thought_level", "model_config", "collaboration_mode"];

/** The agent's settings besides its model, as it describes them. */
function choicesOf(response: { configOptions?: acp.SessionConfigOption[] | null } | null | undefined): AgentChoice[] {
  return (response?.configOptions ?? []).flatMap((option) => {
    if (option.type !== "select" || !option.category || !CHOICE_CATEGORIES.includes(option.category)) return [];
    const values = (option.options as unknown as ({ value?: string; name?: string; description?: string | null; options?: unknown[] })[])
      .flatMap((entry) => (Array.isArray(entry.options) ? (entry.options as typeof entry[]) : [entry]))
      .filter((entry) => typeof entry.value === "string")
      .map((entry) => ({ value: entry.value!, name: entry.name ?? entry.value!, description: entry.description ?? "" }));
    return [{ id: option.id, name: option.name, category: option.category, current: String(option.currentValue), values }];
  });
}

export type AgentSession = {
  sessionId: string;
  /** False when a saved conversation could not be reopened and a fresh one was started instead. */
  resumed: boolean;
  models: Omit<Models, "commands"> | null;
  defaultModel: string | null;
  setModel(value: string): Promise<void>;
  /** The agent's other settings, kept current as the agent reports changes. */
  choices: AgentChoice[];
  setChoice(id: string, value: string): Promise<void>;
  /** Takes in settings the agent changed by itself, such as leaving plan mode. */
  noteChoices(update: { configOptions?: acp.SessionConfigOption[] | null }): void;
  /** The agent's slash commands, as it last listed them. */
  commands: SlashCommand[];
  /** Waits up to `ms` for the agent's first command list. */
  commandsReady(ms: number): Promise<void>;
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
  signal?: AbortSignal;
  /** MCP servers the agent may use in this session. Web-based ones are dropped if the agent cannot reach them. */
  mcpServers: acp.McpServer[];
  onUpdate(update: acp.SessionUpdate): void;
  onPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  onExit(detail: string): void;
}): Promise<AgentSession> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("the agent took too long to start. Check its setup and try again.")), 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  try {
    return await connectSession(options, signal);
  } finally {
    clearTimeout(timer);
  }
}

async function connectSession(options: Parameters<typeof startSession>[0], signal: AbortSignal): Promise<AgentSession> {
  signal.throwIfAborted();
  const launch = launchOf(options.agentId, options.settings);
  // Claude Code leaves its task list tools off in SDK sessions unless asked. Arcex shows that list as the plan.
  const env = { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: "true" };
  const child: ChildProcess = spawn(launch.command, launch.args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: launch.shell, windowsHide: true });
  const terminate = () => {
    child.stdin?.destroy();
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    if (process.platform === "win32") {
      const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      execFile(taskkill, ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, (error) => {
        if (error && child.exitCode === null && child.signalCode === null) child.kill();
      });
    } else child.kill();
  };
  let stderrTail = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });
  const failed = new Promise<never>((_, reject) => {
    child.once("error", (error) => reject(new Error(`could not start: ${error.message}`)));
    child.once("exit", (code) => reject(new Error(`stopped before it was ready (${code}). ${stderrTail.trim().slice(-300)}`)));
  });
  failed.catch(() => {});
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const wait = <T>(request: Promise<T>) => Promise.race([request, failed, aborted]);

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );

  // Reopening a session replays its history as updates. The timeline is already saved, so those are dropped.
  let live = false;
  let commands: SlashCommand[] = [];
  let commandsArrived = () => {};
  const firstCommands = new Promise<void>((resolve) => (commandsArrived = resolve));
  const connection = acp
    .client()
    .onNotification("session/update", ({ params }) => {
      // Agents send their command list just after the session opens, before Arcex treats updates as live.
      if (params.update.sessionUpdate === "available_commands_update") {
        commands = commandsOf(params.update.availableCommands ?? []);
        commandsArrived();
      }
      if (live) options.onUpdate(params.update);
    })
    .onRequest("session/request_permission", ({ params }) => options.onPermission(params))
    .connect(stream);
  const agent = connection.agent;

  try {
    const init = await wait(
      agent.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "arcex", title: "Arcex", version: "0.1.0" },
      }),
    );
    const canHttp = init.agentCapabilities?.mcpCapabilities?.http === true;
    const mcpServers = options.mcpServers.filter((server) => !("type" in server && server.type === "http") || canHttp);

    let sessionId: string | null = null;
    let models: ReturnType<typeof modelsOf> = null;
    let choices: AgentChoice[] = [];
    if (options.resumeId && init.agentCapabilities?.loadSession) {
      try {
        const loaded = await wait(agent.request("session/load", { sessionId: options.resumeId, cwd: options.cwd, mcpServers }));
        models = modelsOf(loaded);
        choices = choicesOf(loaded);
        sessionId = options.resumeId;
      } catch {
        sessionId = null;
      }
    }
    const resumed = sessionId !== null;
    if (!sessionId) {
      signal.throwIfAborted();
      // Claude keeps its task tools behind ToolSearch, so smaller models rarely find them. Arcex shows the task list
      // as the plan above the message box, so it asks for one. Other agents ignore this field.
      const created = await wait(agent.request("session/new", { cwd: options.cwd, mcpServers, _meta: { systemPrompt: { append: PLAN_NOTE } } }));
      sessionId = created.sessionId;
      models = modelsOf(created);
      choices = choicesOf(created);
    }
    live = true;
    child.removeAllListeners("exit");
    child.once("exit", (code) => options.onExit(`The agent stopped unexpectedly (${code}). ${stderrTail}`.trim()));

    const id = sessionId;
    return {
      sessionId: id,
      resumed,
      models,
      defaultModel: resumed ? null : models?.current ?? null,
      async setModel(value) {
        if (!models) throw new Error("this agent did not report a model selector");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("the agent took too long to confirm the model")), 10_000);
          });
          const result = await Promise.race([agent.request("session/set_config_option", { sessionId: id, configId: models.configId, value }), timeout]);
          const confirmed = result && typeof result === "object" ? modelsOf(result as Parameters<typeof modelsOf>[0]) : null;
          if (confirmed?.current !== value) throw new Error("the agent did not confirm that model");
          models.current = value;
        } finally {
          clearTimeout(timer);
        }
      },
      get choices() {
        return choices;
      },
      async setChoice(choiceId, value) {
        const choice = choices.find((entry) => entry.id === choiceId);
        if (!choice || !choice.values.some((entry) => entry.value === value)) throw new Error("the agent doesn't offer that setting");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("the agent took too long to confirm the setting")), 10_000);
          });
          const result = await Promise.race([agent.request("session/set_config_option", { sessionId: id, configId: choiceId, value }), timeout]);
          const next = choicesOf(result as { configOptions?: acp.SessionConfigOption[] });
          if (next.length) choices = next;
          else choice.current = value;
        } finally {
          clearTimeout(timer);
        }
      },
      noteChoices(update) {
        const next = choicesOf(update);
        if (next.length) choices = next;
      },
      get commands() {
        return commands;
      },
      async commandsReady(ms) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([firstCommands, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
        clearTimeout(timer);
      },
      prompt: (text) => agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text }] }),
      cancel: () => agent.notify("session/cancel", { sessionId: id }),
      close: () => {
        child.removeAllListeners("exit");
        connection.close();
        terminate();
      },
    };
  } catch (error) {
    child.removeAllListeners("exit");
    connection.close();
    terminate();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
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
  await session.commandsReady(3000);
  session.close();
  return { ...(session.models ?? { options: [], current: null }), choices: session.choices, commands: session.commands };
}
