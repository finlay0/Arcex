// Projects, threads and their timelines. Clients only see what this module emits.
import { createSpeech } from "./speech.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { About, EventMessage, Item, Method, Project, Requests, Settings, Thread, ThreadState } from "@arcex/contracts";
import { BUILTIN, agentList, listModels, startSession, type AgentSession, type Models } from "./agents.ts";
import type { Db, ThreadRow } from "./db.ts";
import * as git from "./git.ts";
import { providerStatus } from "./providers.ts";
import { TOOLBOX } from "./toolbox.ts";
import { createAccountClient } from "./account.ts";

/** The public Arcex research library. Search needs no key. */
const RESEARCH_MCP = "https://api.arcex.dev/public/mcp";

type Step = Extract<Item, { kind: "step" }>;
type Ask = Extract<Item, { kind: "ask" }>;
type Say = Extract<Item, { kind: "say" }>;
type Think = Extract<Item, { kind: "think" }>;

/** What exists only while a thread's agent is running. */
type Live = {
  session: AgentSession | null;
  turn: AbortController | null;
  turnFailure: "failed" | "interrupted" | null;
  stopTimer?: ReturnType<typeof setTimeout>;
  say: Say | null;
  think: { item: Think; started: number } | null;
  plan: Extract<Item, { kind: "plan" }> | null;
  steps: Map<string, { item: Step; kind: string; title: string }>;
  asks: Map<string, { item: Ask; resolve(response: acp.RequestPermissionResponse): void }>;
};


function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be 1 to ${max} characters`);
  return value.trim();
}

const FILLER = new Set(["a", "an", "the", "please", "can", "you", "could", "just", "some", "my", "our", "me"]);
const CUT = new Set(["under", "in", "into", "to", "for", "so", "that", "with", "on", "from", "and", "when", "where", "which", "because", "then"]);

/** A short working name from the first message. A stopgap until the background model names threads. */
function titleFrom(prompt: string): string {
  // Drop the polite lead-in so "I want to add payments" is named for the job, not for "I want".
  const lead = /^\s*((i (want|need|would like)|i'd like)( you)?( to)?|can you|could you|please|let's|help me( to)?)\s+/i;
  const words = prompt.split(/[\n.?!]/)[0]!.replace(lead, "").replace(lead, "").replace(/[.!?,:;]+/g, " ").split(/\s+/).filter((word) => word && !FILLER.has(word.toLowerCase()));
  const kept: string[] = [];
  for (const word of words) {
    if (kept.length >= 2 && CUT.has(word.toLowerCase())) break;
    kept.push(word);
    if (kept.length === 4) break;
  }
  const title = kept.join(" ").slice(0, 34) || "New thread";
  return title[0]!.toUpperCase() + title.slice(1);
}

/** "Pulse, a workout tracker" becomes "Pulse". Otherwise the first few words. */
function nameFrom(goal: string): string {
  const lead = goal.split(/[,.:;\n]| - | – /)[0]!.trim();
  const name = lead.length >= 2 && lead.length <= 28 ? lead : titleFrom(goal);
  return name[0]!.toUpperCase() + name.slice(1);
}

/** Says what a tool call did in words a non-developer would use. The raw title stays in `detail`. */
const BROWSER_STEPS: Record<string, string> = {
  browser_open: "Opened the app in the browser",
  browser_snapshot: "Looked at the page",
  browser_click: "Clicked on the page",
  browser_type: "Typed on the page",
  browser_press: "Pressed a key on the page",
  browser_screenshot: "Took a screenshot",
  browser_console: "Checked the page for errors",
  browser_back: "Went back a page",
  browser_reload: "Reloaded the page",
};

function describe(kind: string, title: string, files: string[]): string {
  // Tools reached through a connector arrive with machine names such as mcp__arcex__search_toolbox.
  const browserStep = /browser_[a-z]+/.exec(title)?.[0];
  if (browserStep && BROWSER_STEPS[browserStep]) return BROWSER_STEPS[browserStep];
  const connector = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(title);
  if (connector) return connector[1] === "arcex" ? "Checked the Arcex toolbox" : `Used ${connector[1]!.replace(/[-_]/g, " ")}`;
  if (title === "ToolSearch") return "Looked for the right tool";
  const name = files[0] ? path.basename(files[0]) : null;
  const more = files.length > 1 ? ` and ${files.length - 1} more` : "";
  switch (kind) {
    case "read": return name ? `Looked at ${name}${more}` : "Looked through the project";
    case "edit": return name ? `Changed ${name}${more}` : "Changed a file";
    case "delete": return name ? `Removed ${name}${more}` : "Removed a file";
    case "move": return name ? `Moved ${name}` : "Moved a file";
    case "search": return "Searched the project";
    case "execute": return "Ran a command";
    case "fetch": return "Looked something up online";
    case "think": return "Thought it through";
    default: return title.length > 60 || !title ? "Worked on it" : title;
  }
}

/** The lines an edit changed: the old and new text with their shared start and end trimmed off. */
function changedLines(oldText: string, newText: string) {
  // A file's final newline doesn't start another line.
  const lines = (value: string) => (value ? value.replace(/\r?\n$/, "").split(/\r?\n/) : []);
  const before = lines(oldText);
  const after = lines(newText);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { removed: before.slice(start, before.length - end), added: after.slice(start, after.length - end) };
}

/** Keeps what a tool call showed: line counts and changed lines for edits, the end of the output for commands. */
function readContent(step: Step, content: acp.ToolCallContent[] | null | undefined) {
  if (!content?.length) return;
  let added = 0;
  let removed = 0;
  let patch = "";
  let output = "";
  for (const part of content) {
    if (part.type === "diff") {
      const lines = changedLines(part.oldText ?? "", part.newText);
      added += lines.added.length;
      removed += lines.removed.length;
      if (patch.length < 6000) patch += [...lines.removed.map((line) => "-" + line), ...lines.added.map((line) => "+" + line)].join("\n") + "\n";
    } else if (part.type === "content" && part.content.type === "text") {
      output += part.content.text;
    }
  }
  if (added || removed) {
    step.added = added;
    step.removed = removed;
    step.patch = patch.slice(0, 6000);
  }
  if (output) {
    // Agents often wrap output in a fenced block; the viewer adds its own.
    const plain = output.replace(/^```[a-z]*\n?/, "").replace(/\n?```\s*$/, "");
    step.output = plain.length > 4000 ? "…" + plain.slice(-4000) : plain;
  }
}

/** Drives the Browser tab of the desktop app. Absent when the client runs in an ordinary browser. */
export type BrowserBridge = { act(action: string, args: Record<string, unknown>): Promise<unknown> };

export function createEngine(
  db: Db, about: About, connector: { script: string; toolboxFile: string }, emit: (message: EventMessage) => void,
  account = createAccountClient(),
  extras: { browser?: BrowserBridge; connectorEnv?(): { name: string; value: string }[] } = {},
) {
  let settings = db.settings();
  const speech = createSpeech(about.dataDir, (state) => emit({ event: "speech", speech: state }));
  const projects = new Map<string, Project>(db.projects().map((p) => [p.id, p]));
  const threads = new Map<string, ThreadRow>(db.threads().map((t) => [t.id, t]));
  const lives = new Map<string, Live>();
  const changingModels = new Set<string>();
  /** Model lists, read once per agent while the engine runs. */
  const modelCache = new Map<string, Models>();
  const nameOf = (agentId: string) => agentList(settings).find((agent) => agent.id === agentId)?.name ?? "The agent";
  const pickedModel = (value: unknown): Thread["model"] => {
    if (value === null || value === undefined) return null;
    const model = value as { value?: unknown; name?: unknown };
    return { value: text(model.value, "model", 200), name: text(model.name, "model name", 200) };
  };

  /** Agent settings from a client: a few short ids and values. The agent itself checks they exist. */
  const pickedChoices = (value: unknown): Record<string, string> => {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("settings must be an object");
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 10) throw new Error("too many settings");
    return Object.fromEntries(entries.map(([key, choice]) => {
      if (!/^[\w.-]{1,80}$/.test(key) || typeof choice !== "string" || !/^[\w.:-]{1,80}$/.test(choice)) throw new Error("invalid setting");
      return [key, choice];
    }));
  };

  /** Puts the thread's picked settings into the agent session, one by one. */
  async function applyChoices(thread: ThreadRow, session: AgentSession, wanted: Record<string, string>) {
    for (const [choiceId, value] of Object.entries(wanted)) {
      const choice = session.choices.find((entry) => entry.id === choiceId);
      if (!choice || choice.current === value) continue;
      try {
        await session.setChoice(choiceId, value);
      } catch (error) {
        const name = choice.values.find((entry) => entry.value === value)?.name ?? value;
        throw new Error(`couldn't switch ${choice.name.toLowerCase()} to ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Follows the mode when the agent changes it itself, such as leaving plan mode after the user approved the plan.
   * Other settings stay as the user picked them: an agent can reset effort when its model changes, and the pick is
   * put back at the start of the next turn.
   */
  function followChoices(thread: ThreadRow, session: AgentSession) {
    let changed = false;
    for (const choiceId of Object.keys(thread.choices)) {
      const choice = session.choices.find((entry) => entry.id === choiceId);
      if (choice?.category !== "mode") continue;
      if (choice.current && choice.current !== thread.choices[choiceId]) {
        thread.choices = { ...thread.choices, [choiceId]: choice.current };
        changed = true;
      }
    }
    if (changed) {
      db.saveThread(thread);
      emit({ event: "thread", thread: publicThread(thread) });
    }
  }

  const publicThread = ({ sessionId: _sessionId, ...thread }: ThreadRow): Thread => thread;
  const liveOf = (id: string): Live => {
    let live = lives.get(id);
    if (!live) lives.set(id, (live = { session: null, turn: null, turnFailure: null, say: null, think: null, plan: null, steps: new Map(), asks: new Map() }));
    return live;
  };
  const projectOf = (id: unknown): Project => {
    const project = projects.get(String(id));
    if (!project) throw new Error("project not found");
    return project;
  };
  const threadOf = (id: unknown): ThreadRow => {
    const thread = threads.get(String(id));
    if (!thread) throw new Error("thread not found");
    return thread;
  };

  function setState(thread: ThreadRow, state: ThreadState) {
    thread.state = state;
    thread.updatedAt = Date.now();
    db.saveThread(thread);
    emit({ event: "thread", thread: publicThread(thread) });
  }

  /** Saves and broadcasts a timeline item. Streaming text is broadcast on every chunk but saved once it ends. */
  function put(thread: ThreadRow, item: Item, save = true) {
    if (save) db.saveItem(thread.id, item);
    emit({ event: "item", threadId: thread.id, item });
  }

  function endSay(thread: ThreadRow) {
    const live = liveOf(thread.id);
    if (live.say) db.saveItem(thread.id, live.say);
    live.say = null;
    if (live.think) {
      live.think.item.seconds = Math.max(1, Math.round((Date.now() - live.think.started) / 1000));
      put(thread, live.think.item);
      live.think = null;
    }
  }

  /** Paths are kept relative to the project; anything that climbs out of it (an agent's own notes) is not project work. */
  const insideProject = (file: string) => !file.startsWith("..") && !path.isAbsolute(file);

  function filesOf(project: Project, update: { locations?: acp.ToolCallLocation[] | null; content?: acp.ToolCallContent[] | null }) {
    const found = [
      ...(update.locations ?? []).map((location) => location.path),
      ...(update.content ?? []).flatMap((content) => (content.type === "diff" ? [content.path] : [])),
    ];
    return [...new Set(found.map((file) => path.relative(project.cwd, file) || file))];
  }

  function onUpdate(thread: ThreadRow, project: Project, update: acp.SessionUpdate) {
    const live = lives.get(thread.id);
    if (!live?.turn) return;
    if (update.sessionUpdate === "agent_thought_chunk") {
      if (update.content.type !== "text") return;
      if (live.say) endSay(thread);
      live.think ??= { item: { id: randomUUID(), kind: "think", text: "", seconds: null }, started: Date.now() };
      if (live.think.item.text.length < 40_000) live.think.item.text += update.content.text;
      put(thread, live.think.item, false);
    } else if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type !== "text") return;
      if (live.think) endSay(thread);
      live.say ??= { id: randomUUID(), kind: "say", text: "" };
      live.say.text += update.content.text;
      put(thread, live.say, false);
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      endSay(thread);
      let step = live.steps.get(update.toolCallId);
      if (!step) {
        step = { kind: "other", title: "", item: { id: randomUUID(), kind: "step", label: "", detail: "", status: "running", files: [] } };
        live.steps.set(update.toolCallId, step);
      }
      if (update.kind) step.kind = update.kind;
      if (update.title) step.title = update.title;
      const files = filesOf(project, update);
      if (files.length) step.item.files = [...new Set([...step.item.files, ...files])];
      if (update.status === "completed") step.item.status = "done";
      else if (update.status === "failed") step.item.status = "failed";
      step.item.detail = step.title.slice(0, 2000);
      readContent(step.item, update.content);
      step.item.label = describe(step.kind, step.title, step.item.files);
      step.item.tool = /browser_[a-z]+/.test(step.title) ? "browser" : step.kind;
      put(thread, step.item);
    } else if (update.sessionUpdate === "config_option_update" && live.session) {
      live.session.noteChoices(update);
      followChoices(thread, live.session);
    } else if (update.sessionUpdate === "current_mode_update" && live.session) {
      const mode = live.session.choices.find((entry) => entry.category === "mode");
      if (mode) mode.current = update.currentModeId;
      followChoices(thread, live.session);
    } else if (update.sessionUpdate === "plan") {
      // Agents send their whole plan each time it changes; one plan item per turn follows it.
      live.plan ??= { id: randomUUID(), kind: "plan", entries: [] };
      live.plan.entries = update.entries.slice(0, 50).map((entry) => ({
        content: String(entry.content).slice(0, 500),
        status: entry.status === "completed" || entry.status === "in_progress" ? entry.status : "pending",
      }));
      put(thread, live.plan);
    }
  }

  function onPermission(thread: ThreadRow, project: Project, request: acp.RequestPermissionRequest) {
    const live = lives.get(thread.id);
    if (!live?.turn || live.turn.signal.aborted) return Promise.resolve<acp.RequestPermissionResponse>({ outcome: { outcome: "cancelled" } });
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      endSay(thread);
      const call = request.toolCall;
      // Show what is being approved in full: the plan itself, the change to a file, or the exact command.
      const input = (call.rawInput ?? {}) as { plan?: unknown; command?: unknown };
      const plan = typeof input.plan === "string" && input.plan.trim() ? input.plan.trim() : null;
      const shown: Step = { id: "", kind: "step", label: "", detail: "", status: "running", files: [] };
      readContent(shown, call.content);
      const body = plan
        ?? (shown.patch ? "```diff\n" + shown.patch.trimEnd() + "\n```" : null)
        ?? (typeof input.command === "string" ? "```\n" + input.command + "\n```" : null)
        ?? shown.output
        ?? undefined;
      const item: Ask = {
        id: randomUUID(),
        kind: "ask",
        title: plan
          ? "Here's the plan. Go ahead?"
          : describe(call.kind ?? "other", call.title ?? "", filesOf(project, call)).replace(/^(Changed|Ran|Removed|Moved|Looked at)/, (verb) =>
            ({ Changed: "Change", Ran: "Run", Removed: "Remove", Moved: "Move", "Looked at": "Look at" })[verb] ?? verb,
          ),
        detail: (call.title ?? "").slice(0, 2000),
        body: body?.slice(0, 20_000),
        options: request.options.map((option) => ({ id: option.optionId, name: option.name, kind: option.kind })),
        answer: null,
      };
      live.asks.set(item.id, { item, resolve });
      put(thread, item);
      setState(thread, "needs_you");
    });
  }

  function closeSession(live: Live) {
    const session = live.session;
    live.session = null;
    session?.close();
  }

  function dismissAsks(thread: ThreadRow, live: Live, answer: string, save = true) {
    for (const { item, resolve } of live.asks.values()) {
      if (save) put(thread, { ...item, answer });
      resolve({ outcome: { outcome: "cancelled" } });
    }
    live.asks.clear();
  }

  async function ensureSession(thread: ThreadRow, project: Project, live: Live, signal: AbortSignal): Promise<AgentSession> {
    if (live.session) return live.session;
    const session = await startSession({
      agentId: thread.provider,
      settings,
      cwd: project.cwd,
      resumeId: thread.sessionId,
      signal,
      mcpServers: [
        {
          name: "arcex",
          command: process.execPath,
          args: [connector.script],
          env: [
            { name: "ARCEX_TOOLBOX", value: connector.toolboxFile },
            { name: "ARCEX_PROJECT_NAME", value: project.name },
            { name: "ARCEX_PROJECT_GOAL", value: project.goal },
            { name: "ARCEX_PROJECT_ID", value: project.id },
            ...(extras.connectorEnv?.() ?? []),
          ],
        },
        ...(settings.research ? [{ type: "http" as const, name: "arcex-research", url: RESEARCH_MCP, headers: [] }] : []),
      ],
      onUpdate: (update) => onUpdate(thread, project, update),
      onPermission: (request) => onPermission(thread, project, request),
      onExit: (detail) => {
        if (live.session !== session) return;
        live.session = null;
        dismissAsks(thread, live, "Agent disconnected");
        put(thread, { id: randomUUID(), kind: "error", text: detail.slice(0, 600) });
        if (live.turn) live.turnFailure = "failed";
        else setState(thread, "failed");
      },
    });
    if (signal.aborted) {
      session.close();
      signal.throwIfAborted();
    }
    live.session = session;
    if (thread.sessionId && !session.resumed) {
      put(thread, { id: randomUUID(), kind: "say", text: `${nameOf(thread.provider)} started fresh and doesn't remember the earlier messages in this thread.` });
    }
    thread.sessionId = session.sessionId;
    db.saveThread(thread);
    return session;
  }

  async function run(thread: ThreadRow, prompt: string) {
    const project = projectOf(thread.projectId);
    const live = liveOf(thread.id);
    const turn = new AbortController();
    live.turn = turn;
    live.turnFailure = null;
    live.plan = null;
    const started = Date.now();
    setState(thread, live.session ? "working" : "starting");
    put(thread, { id: randomUUID(), kind: "user", text: prompt });
    let outcome: ThreadState = "idle";
    try {
      const session = await ensureSession(thread, project, live, turn.signal);
      if (thread.model && thread.model.value !== session.models?.current) {
        try {
          await session.setModel(thread.model.value);
        } catch {
          closeSession(live);
          throw new Error(`couldn't use ${thread.model.name}. Choose another model or Default, then retry your message.`);
        }
      }
      await applyChoices(thread, session, thread.choices);
      turn.signal.throwIfAborted();
      setState(thread, "working");
      const result = await session.prompt(prompt);
      if (result.stopReason === "cancelled") outcome = "stopped";
      if (result.stopReason === "refusal" || result.stopReason === "max_tokens" || result.stopReason === "max_turn_requests") {
        const reason = result.stopReason === "refusal" ? "declined the request" : "reached a turn limit";
        throw new Error(`${reason}. Review the reply before continuing.`);
      }
    } catch (error) {
      if (!threads.has(thread.id)) return;
      if (live.turnFailure) outcome = live.turnFailure;
      else if (turn.signal.aborted) outcome = "stopped";
      else {
        outcome = "failed";
        const message = error instanceof Error ? error.message : String(error);
        const friendly = /auth|sign.in required/i.test(message)
          ? `${nameOf(thread.provider)} needs you to sign in. Open Agents to set it up, then retry your message.`
          : `${nameOf(thread.provider)} couldn't finish: ${message.slice(0, 400)}`;
        put(thread, { id: randomUUID(), kind: "error", text: friendly });
      }
    }
    if (!threads.has(thread.id)) return;
    clearTimeout(live.stopTimer);
    live.turn = null;
    dismissAsks(thread, live, "Request closed");
    endSay(thread);
    const changed = new Set<string>();
    for (const step of live.steps.values()) {
      if (step.item.status === "running") put(thread, { ...step.item, status: "interrupted" });
      if (["edit", "delete", "move"].includes(step.kind) && step.item.status === "done") step.item.files.filter(insideProject).forEach((file) => changed.add(file));
    }
    if (changed.size) put(thread, { id: randomUUID(), kind: "result", files: [...changed] });
    live.steps.clear();
    const ended = (live.turnFailure ?? outcome) as ThreadState;
    const endings: Partial<Record<ThreadState, "stopped" | "failed" | "interrupted">> = { stopped: "stopped", failed: "failed", interrupted: "interrupted" };
    put(thread, { id: randomUUID(), kind: "end", seconds: Math.round((Date.now() - started) / 1000), outcome: endings[ended] ?? "done" });
    setState(thread, ended);
    // The next waiting message goes out only after a clean finish. After a stop or a failure the user decides.
    if (ended === "idle" && thread.queued.length && threads.has(thread.id)) {
      const [next, ...rest] = thread.queued;
      thread.queued = rest;
      db.saveThread(thread);
      void run(thread, next!);
    }
  }

  const busyState = (thread: ThreadRow) => thread.state === "working" || thread.state === "starting" || thread.state === "needs_you" || thread.state === "stopping";

  /** Stops a thread's agent and forgets it in memory. The caller removes it from the database. */
  function dropThread(thread: ThreadRow) {
    const live = lives.get(thread.id);
    if (live) {
      clearTimeout(live.stopTimer);
      live.turn?.abort();
      dismissAsks(thread, live, "", false);
      closeSession(live);
      lives.delete(thread.id);
    }
    threads.delete(thread.id);
  }

  const handlers: { [M in Method]: (params: Requests[M]["params"]) => Promise<Requests[M]["result"]> | Requests[M]["result"] } = {
    "account.status": account.status,
    "account.start": account.start,
    "account.finish": account.finish,
    "account.disconnect": account.disconnect,
    "state.get": () => ({ agents: agentList(settings), projects: [...projects.values()], threads: [...threads.values()].map(publicThread), settings, about, drafts: db.drafts() }),

    "draft.set"(params) {
      const project = projectOf(params.projectId);
      const thread = params.threadId === undefined ? null : threadOf(params.threadId);
      if (thread && thread.projectId !== project.id) throw new Error("thread not found in this project");
      if (typeof params.text !== "string" || params.text.length > 20_000) throw new Error("draft is too long");
      db.saveDraft(project.id, thread?.id ?? "", params.text);
      return { ok: true };
    },

    "settings.set"(params) {
      const next: Settings = { ...settings };
      if (params.name !== undefined) next.name = String(params.name).trim().slice(0, 60);
      if (params.theme !== undefined && ["light", "dark", "system"].includes(params.theme)) next.theme = params.theme;
      if (params.defaultProvider !== undefined && agentList(settings).some((agent) => agent.id === params.defaultProvider)) next.defaultProvider = params.defaultProvider;
      if (params.defaultModel !== undefined) next.defaultModel = pickedModel(params.defaultModel);
      if (params.sendWith !== undefined && ["enter", "ctrl-enter"].includes(params.sendWith)) next.sendWith = params.sendWith;
      if (params.showDetails !== undefined) next.showDetails = params.showDetails === true;
      if (params.notify !== undefined) next.notify = params.notify === true;
      if (params.research !== undefined) next.research = params.research === true;
      settings = next;
      db.saveSettings(settings);
      emit({ event: "settings", settings, agents: agentList(settings) });
      return settings;
    },

    async "agents.models"(params) {
      const agentId = text(params.agentId, "agent", 80);
      if (!agentList(settings).some((agent) => agent.id === agentId)) throw new Error("unknown agent");
      if (params.refresh === true) modelCache.delete(agentId);
      const cached = modelCache.get(agentId);
      if (cached) return cached;
      const models = await listModels(agentId, settings, about.dataDir);
      modelCache.set(agentId, models);
      return models;
    },

    "agents.add"(params) {
      const name = text(params.name, "name", 40);
      const command = text(params.command, "command", 300);
      if (settings.agents.length >= 20) throw new Error("that is the most agents Arcex keeps");
      settings = { ...settings, agents: [...settings.agents, { id: `custom-${randomUUID().slice(0, 8)}`, name, command }] };
      db.saveSettings(settings);
      emit({ event: "settings", settings, agents: agentList(settings) });
      return settings;
    },

    "agents.remove"(params) {
      const agents = settings.agents.filter((agent) => agent.id !== params.agentId);
      const dropped = settings.defaultProvider === params.agentId;
      settings = { ...settings, agents, ...(dropped ? { defaultProvider: "claude", defaultModel: null } : {}) };
      modelCache.delete(String(params.agentId));
      db.saveSettings(settings);
      emit({ event: "settings", settings, agents: agentList(settings) });
      return settings;
    },

    "providers.status": () => providerStatus(settings),
    "toolbox.list": () => TOOLBOX,

    async "project.create"(params) {
      const goal = params.cwd !== undefined && params.goal === "" ? "" : text(params.goal, "what you're building", 2000);
      let cwd: string;
      let name: string;
      if (params.cwd !== undefined) {
        cwd = path.resolve(text(params.cwd, "folder", 1000));
        if (!path.isAbsolute(params.cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error("that folder doesn't exist");
        name = (path.basename(cwd) || cwd).slice(0, 60);
      } else {
        name = nameFrom(goal);
        const root = about.projectsDir;
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
        cwd = path.join(root, slug);
        for (let n = 2; existsSync(cwd); n++) cwd = path.join(root, `${slug}-${n}`);
        mkdirSync(cwd, { recursive: true });
        await git.initRepo(cwd).catch(() => {});
      }
      const project: Project = { id: randomUUID(), name, goal, cwd, previewUrl: null, createdAt: Date.now() };
      db.insertProject(project);
      projects.set(project.id, project);
      emit({ event: "project", project });
      return project;
    },

    "project.setPreview"(params) {
      const project = projectOf(params.projectId);
      let url: string | null = null;
      if (params.url !== null) {
        const parsed = new URL(text(params.url, "address", 500));
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("the address must start with http");
        url = parsed.href;
      }
      project.previewUrl = url;
      db.saveProject(project);
      emit({ event: "project", project });
      return project;
    },

    "project.update"(params) {
      const project = projectOf(params.projectId);
      if (params.name !== undefined) project.name = text(params.name, "name", 60);
      if (params.goal !== undefined) project.goal = text(params.goal, "what you're building", 2000);
      db.saveProject(project);
      emit({ event: "project", project });
      return project;
    },

    "project.remove"(params) {
      const project = projectOf(params.projectId);
      for (const thread of [...threads.values()].filter((t) => t.projectId === project.id)) dropThread(thread);
      db.removeProject(project.id);
      projects.delete(project.id);
      emit({ event: "gone", kind: "project", id: project.id });
      return { ok: true };
    },

    "project.files"(params) {
      const project = projectOf(params.projectId);
      const dir = path.resolve(project.cwd, typeof params.dir === "string" ? params.dir.slice(0, 1000) : "");
      // Stay inside the project folder.
      if (dir !== project.cwd && !dir.startsWith(project.cwd + path.sep)) throw new Error("that folder is outside the project");
      // Folders nobody browses by hand, and that can hold tens of thousands of entries.
      const hidden = new Set([".git", "node_modules", ".next", "dist", ".turbo", ".cache"]);
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => !hidden.has(entry.name) && (entry.isDirectory() || entry.isFile()))
        .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? ("folder" as const) : ("file" as const) }))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1))
        .slice(0, 300);
    },

    "project.changes": (params) => git.changes(projectOf(params.projectId).cwd),
    "project.diff": async (params) => {
      if (typeof params.path !== "string" || !params.path || params.path.length > 1000) throw new Error("invalid file path");
      return { text: await git.diff(projectOf(params.projectId).cwd, params.path) };
    },

    "thread.create"(params) {
      const project = projectOf(params.projectId);
      if (!agentList(settings).some((agent) => agent.id === params.provider)) throw new Error("unknown agent");
      const model = pickedModel(params.model);
      const choices = pickedChoices(params.choices);
      const prompt = text(params.text, "message", 20_000);
      const now = Date.now();
      const thread: ThreadRow = {
        id: randomUUID(), projectId: project.id, provider: params.provider, model, choices, queued: [], title: titleFrom(prompt),
        state: "starting", archived: false, sessionId: null, createdAt: now, updatedAt: now,
      };
      db.insertThread(thread);
      threads.set(thread.id, thread);
      void run(thread, prompt);
      db.clearSentDraft(project.id, "", params.text);
      return publicThread(thread);
    },

    async "thread.update"(params) {
      const thread = threadOf(params.threadId);
      const title = params.title === undefined ? thread.title : text(params.title, "name", 80);
      if (params.archived === true && busyState(thread)) throw new Error("wait for this thread to finish before archiving it");
      if (params.model !== undefined) {
        if (busyState(thread) || changingModels.has(thread.id)) throw new Error("wait for this thread to finish before changing its model");
        const model = pickedModel(params.model);
        const live = lives.get(thread.id);
        const session = live?.session;
        if (live && session && (model || thread.model)) {
          changingModels.add(thread.id);
          try {
            const selected = model?.value ?? session.defaultModel ?? (await listModels(thread.provider, settings, about.dataDir)).current;
            if (!selected) throw new Error("the agent did not report a default model");
            if (selected !== session.models?.current) await session.setModel(selected);
          } catch (error) {
            if (live.session === session) closeSession(live);
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`The agent couldn't switch models. ${message}`);
          } finally {
            changingModels.delete(thread.id);
          }
        }
        if (!threads.has(thread.id)) throw new Error("thread not found");
        thread.model = model;
      }
      if (params.choices !== undefined) {
        const wanted = pickedChoices(params.choices);
        const session = lives.get(thread.id)?.session;
        // Settings can change mid-turn too, the way switching to plan mode works while an agent runs.
        if (session) await applyChoices(thread, session, wanted);
        if (!threads.has(thread.id)) throw new Error("thread not found");
        thread.choices = { ...thread.choices, ...wanted };
      }
      if (params.title !== undefined) thread.title = title;
      if (params.archived !== undefined) thread.archived = params.archived === true;
      db.saveThread(thread);
      emit({ event: "thread", thread: publicThread(thread) });
      return publicThread(thread);
    },

    "thread.remove"(params) {
      const thread = threadOf(params.threadId);
      dropThread(thread);
      db.removeThread(thread.id);
      emit({ event: "gone", kind: "thread", id: thread.id });
      return { ok: true };
    },

    "thread.items"(params) {
      const thread = threadOf(params.threadId);
      const items = db.items(thread.id);
      const reply = lives.get(thread.id)?.say;
      return reply ? [...items, reply] : items;
    },

    "thread.prompt"(params) {
      const thread = threadOf(params.threadId);
      if (busyState(thread) && params.queue === true) {
        if (thread.queued.length >= 10) throw new Error("ten messages are already waiting. Remove one first");
        thread.queued = [...thread.queued, text(params.text, "message", 20_000)];
        db.saveThread(thread);
        db.clearSentDraft(thread.projectId, thread.id, params.text);
        emit({ event: "thread", thread: publicThread(thread) });
        return { ok: true, queued: true };
      }
      if (busyState(thread)) throw new Error("this thread is still working");
      if (changingModels.has(thread.id)) throw new Error("wait for the model to finish switching");
      void run(thread, text(params.text, "message", 20_000));
      db.clearSentDraft(thread.projectId, thread.id, params.text);
      return { ok: true };
    },

    "thread.unqueue"(params) {
      const thread = threadOf(params.threadId);
      const index = Number(params.index);
      if (!Number.isInteger(index) || index < 0 || index >= thread.queued.length) throw new Error("that message already went out");
      const removed = thread.queued[index]!;
      thread.queued = thread.queued.filter((_, at) => at !== index);
      db.saveThread(thread);
      emit({ event: "thread", thread: publicThread(thread) });
      return { text: removed };
    },

    "thread.cancel"(params) {
      const thread = threadOf(params.threadId);
      const live = lives.get(thread.id);
      if (!live?.turn || live.turn.signal.aborted) return { ok: true };
      live.turn.abort();
      setState(thread, "stopping");
      dismissAsks(thread, live, "Turn stopped");
      if (live.session) {
        void live.session.cancel().catch(() => {});
        live.stopTimer = setTimeout(() => {
          put(thread, { id: randomUUID(), kind: "error", text: "The agent did not confirm it stopped. Arcex disconnected it. Check the project for partial changes before continuing." });
          live.turnFailure = "interrupted";
          closeSession(live);
        }, 5000);
      }
      return { ok: true };
    },

    "speech.status": () => speech.status(),
    "speech.prepare": () => speech.prepare(),
    "speech.start": () => speech.start(),
    "speech.chunk": (params) => speech.chunk(params),
    "speech.finish": (params) => speech.finish(params),
    "speech.cancel": (params) => speech.cancel(params),

    "ask.answer"(params) {
      const thread = threadOf(params.threadId);
      const pending = liveOf(thread.id).asks.get(String(params.itemId));
      if (!pending) throw new Error("that request is no longer waiting");
      const option = params.optionId === null ? null : pending.item.options.find((o) => o.id === params.optionId);
      if (option === undefined) throw new Error("unknown choice");
      liveOf(thread.id).asks.delete(pending.item.id);
      pending.item.answer = option ? option.name : "Not now";
      put(thread, pending.item);
      setState(thread, liveOf(thread.id).asks.size ? "needs_you" : "working");
      pending.resolve({ outcome: option ? { outcome: "selected", optionId: option.id } : { outcome: "cancelled" } });
      return { ok: true };
    },
  };

  const BROWSER_ACTIONS = new Set(["open", "snapshot", "click", "type", "press", "screenshot", "console", "back", "reload"]);
  /** An agent's browser tool call, from the Arcex connector. It only ever reaches the project's own Browser tab. */
  async function browse(projectId: unknown, action: unknown, raw: unknown): Promise<unknown> {
    const project = projectOf(projectId);
    if (typeof action !== "string" || !BROWSER_ACTIONS.has(action)) throw new Error("unknown browser action");
    if (!extras.browser) throw new Error("The browser is only available in the Arcex desktop app.");
    const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const args: Record<string, unknown> = {};
    if (action === "open") {
      const parsed = new URL(text(input.url, "address", 2000));
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("the address must start with http or https");
      args.url = parsed.href;
      args.reload = project.previewUrl === parsed.href;
      handlers["project.setPreview"]({ projectId: project.id, url: parsed.href });
    }
    if (action === "click" || action === "type") args.ref = Number(input.ref);
    if (action === "type") {
      // Typed exactly as given: an empty string clears the field and spaces matter.
      if (typeof input.text !== "string" || input.text.length > 5000) throw new Error("text must be at most 5000 characters");
      args.text = input.text;
      args.submit = input.submit === true;
    }
    if (action === "press") args.key = text(input.key, "key", 20);
    emit({ event: "browse", projectId: project.id });
    return extras.browser.act(action, args);
  }

  return {
    browse,
    handle: (method: string, params: unknown): Promise<unknown> => {
      const handler = (handlers as Record<string, ((params: never) => unknown) | undefined>)[method];
      if (!Object.hasOwn(handlers, method) || !handler) return Promise.reject(new Error("unknown request"));
      return Promise.resolve().then(() => handler((params ?? {}) as never));
    },
    close() {
      speech.close();
      for (const live of lives.values()) {
        clearTimeout(live.stopTimer);
        live.turn?.abort();
        closeSession(live);
      }
    },
  };
}
