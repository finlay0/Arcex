// Projects, threads and their timelines. Clients only see what this module emits.
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

/** The public Arcex research library. Search needs no key. */
const RESEARCH_MCP = "https://api.arcex.dev/public/mcp";

type Step = Extract<Item, { kind: "step" }>;
type Ask = Extract<Item, { kind: "ask" }>;
type Say = Extract<Item, { kind: "say" }>;

/** What exists only while a thread's agent is running. */
type Live = {
  session: AgentSession | null;
  say: Say | null;
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
function describe(kind: string, title: string, files: string[]): string {
  // Tools reached through a connector arrive with machine names such as mcp__arcex__search_toolbox.
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

export function createEngine(db: Db, about: About, connector: { script: string; toolboxFile: string }, emit: (message: EventMessage) => void) {
  let settings = db.settings();
  const projects = new Map<string, Project>(db.projects().map((p) => [p.id, p]));
  const threads = new Map<string, ThreadRow>(db.threads().map((t) => [t.id, t]));
  const lives = new Map<string, Live>();
  /** Model lists, read once per agent while the engine runs. */
  const modelCache = new Map<string, Models>();
  const nameOf = (agentId: string) => agentList(settings).find((agent) => agent.id === agentId)?.name ?? "The agent";
  const pickedModel = (value: unknown): Thread["model"] => {
    if (value === null || value === undefined) return null;
    const model = value as { value?: unknown; name?: unknown };
    return { value: text(model.value, "model", 200), name: text(model.name, "model name", 200) };
  };

  const publicThread = ({ sessionId: _sessionId, ...thread }: ThreadRow): Thread => thread;
  const liveOf = (id: string): Live => {
    let live = lives.get(id);
    if (!live) lives.set(id, (live = { session: null, say: null, steps: new Map(), asks: new Map() }));
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
  }

  function filesOf(project: Project, update: { locations?: acp.ToolCallLocation[] | null; content?: acp.ToolCallContent[] | null }) {
    const found = [
      ...(update.locations ?? []).map((location) => location.path),
      ...(update.content ?? []).flatMap((content) => (content.type === "diff" ? [content.path] : [])),
    ];
    return [...new Set(found.map((file) => path.relative(project.cwd, file) || file))];
  }

  function onUpdate(thread: ThreadRow, project: Project, update: acp.SessionUpdate) {
    const live = liveOf(thread.id);
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type !== "text") return;
      live.say ??= { id: randomUUID(), kind: "say", text: "" };
      live.say.text += update.content.text;
      put(thread, live.say, false);
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      endSay(thread);
      let step = live.steps.get(update.toolCallId);
      if (!step) {
        step = { kind: "other", title: "", item: { id: update.toolCallId, kind: "step", label: "", detail: "", status: "running", files: [] } };
        live.steps.set(update.toolCallId, step);
      }
      if (update.kind) step.kind = update.kind;
      if (update.title) step.title = update.title;
      const files = filesOf(project, update);
      if (files.length) step.item.files = [...new Set([...step.item.files, ...files])];
      if (update.status === "completed") step.item.status = "done";
      else if (update.status === "failed") step.item.status = "failed";
      step.item.detail = step.title.slice(0, 2000);
      step.item.label = describe(step.kind, step.title, step.item.files);
      put(thread, step.item);
    }
  }

  function onPermission(thread: ThreadRow, project: Project, request: acp.RequestPermissionRequest) {
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      endSay(thread);
      const call = request.toolCall;
      const item: Ask = {
        id: randomUUID(),
        kind: "ask",
        title: describe(call.kind ?? "other", call.title ?? "", filesOf(project, call)).replace(/^(Changed|Ran|Removed|Moved|Looked at)/, (verb) =>
          ({ Changed: "Change", Ran: "Run", Removed: "Remove", Moved: "Move", "Looked at": "Look at" })[verb] ?? verb,
        ),
        detail: (call.title ?? "").slice(0, 2000),
        options: request.options.map((option) => ({ id: option.optionId, name: option.name, kind: option.kind })),
        answer: null,
      };
      liveOf(thread.id).asks.set(item.id, { item, resolve });
      put(thread, item);
      setState(thread, "needs_you");
    });
  }

  async function ensureSession(thread: ThreadRow, project: Project): Promise<AgentSession> {
    const live = liveOf(thread.id);
    if (live.session) return live.session;
    const session = await startSession({
      agentId: thread.provider,
      settings,
      cwd: project.cwd,
      resumeId: thread.sessionId,
      mcpServers: [
        {
          name: "arcex",
          command: process.execPath,
          args: [connector.script],
          env: [
            { name: "ARCEX_TOOLBOX", value: connector.toolboxFile },
            { name: "ARCEX_PROJECT_NAME", value: project.name },
            { name: "ARCEX_PROJECT_GOAL", value: project.goal },
          ],
        },
        ...(settings.research ? [{ type: "http" as const, name: "arcex-research", url: RESEARCH_MCP, headers: [] }] : []),
      ],
      onUpdate: (update) => onUpdate(thread, project, update),
      onPermission: (request) => onPermission(thread, project, request),
      onExit: (detail) => {
        if (live.session !== session) return;
        live.session = null;
        put(thread, { id: randomUUID(), kind: "error", text: detail.slice(0, 600) });
        setState(thread, "failed");
      },
    });
    live.session = session;
    if (session.models) modelCache.set(thread.provider, session.models);
    // A model the agent no longer offers is ignored, and the thread runs on the agent's default.
    if (thread.model && thread.model.value !== session.models?.current) await session.setModel(thread.model.value).catch(() => {});
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
    put(thread, { id: randomUUID(), kind: "user", text: prompt });
    setState(thread, live.session ? "working" : "starting");
    try {
      const session = await ensureSession(thread, project);
      setState(thread, "working");
      await session.prompt(prompt);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      const friendly = /auth/i.test(message)
        ? `${nameOf(thread.provider)} isn't signed in on this computer. ${BUILTIN[thread.provider] ? `Open a terminal, run "${BUILTIN[thread.provider]!.signIn}", then send your message again.` : "Sign in with its own tool, then send your message again."}`
        : `${nameOf(thread.provider)} couldn't finish: ${message.slice(0, 400)}`;
      put(thread, { id: randomUUID(), kind: "error", text: friendly });
    }
    if (!threads.has(thread.id)) return;
    endSay(thread);
    const changed = new Set<string>();
    for (const step of live.steps.values()) {
      if (step.item.status === "running") put(thread, { ...step.item, status: "done" });
      if (["edit", "delete", "move"].includes(step.kind) && step.item.status !== "failed") step.item.files.forEach((file) => changed.add(file));
    }
    if (changed.size) put(thread, { id: randomUUID(), kind: "result", files: [...changed] });
    live.steps.clear();
    if (thread.state !== "failed") setState(thread, "idle");
  }

  const busyState = (thread: ThreadRow) => thread.state === "working" || thread.state === "starting" || thread.state === "needs_you";

  /** Stops a thread's agent and forgets it in memory. The caller removes it from the database. */
  function dropThread(thread: ThreadRow) {
    const live = lives.get(thread.id);
    if (live) {
      const session = live.session;
      live.session = null;
      for (const ask of live.asks.values()) ask.resolve({ outcome: { outcome: "cancelled" } });
      session?.close();
      lives.delete(thread.id);
    }
    threads.delete(thread.id);
  }

  const handlers: { [M in Method]: (params: Requests[M]["params"]) => Promise<Requests[M]["result"]> | Requests[M]["result"] } = {
    "state.get": () => ({ agents: agentList(settings), projects: [...projects.values()], threads: [...threads.values()].map(publicThread), settings, about }),

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
      const goal = text(params.goal, "what you're building", 2000);
      let cwd: string;
      let name: string;
      if (params.cwd !== undefined) {
        cwd = path.resolve(text(params.cwd, "folder", 1000));
        if (!path.isAbsolute(params.cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error("that folder doesn't exist");
        name = nameFrom(goal);
      } else {
        name = nameFrom(goal);
        const root = about.projectsDir;
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
        cwd = path.join(root, slug);
        for (let n = 2; existsSync(cwd); n++) cwd = path.join(root, `${slug}-${n}`);
        mkdirSync(cwd, { recursive: true });
      }
      if (!existsSync(path.join(cwd, ".git"))) await git.initRepo(cwd);
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
    "project.diff": async (params) => ({ text: await git.diff(projectOf(params.projectId).cwd, text(params.path, "path", 1000)) }),

    "thread.create"(params) {
      const project = projectOf(params.projectId);
      if (!agentList(settings).some((agent) => agent.id === params.provider)) throw new Error("unknown agent");
      const model = pickedModel(params.model);
      const prompt = text(params.text, "message", 20_000);
      const now = Date.now();
      const thread: ThreadRow = {
        id: randomUUID(), projectId: project.id, provider: params.provider, model, title: titleFrom(prompt),
        state: "starting", archived: false, sessionId: null, createdAt: now, updatedAt: now,
      };
      db.insertThread(thread);
      threads.set(thread.id, thread);
      void run(thread, prompt);
      return publicThread(thread);
    },

    async "thread.update"(params) {
      const thread = threadOf(params.threadId);
      if (params.title !== undefined) thread.title = text(params.title, "name", 80);
      if (params.model !== undefined) {
        if (busyState(thread)) throw new Error("wait for this thread to finish before changing its model");
        thread.model = pickedModel(params.model);
        if (thread.model) await lives.get(thread.id)?.session?.setModel(thread.model.value);
      }
      if (params.archived !== undefined) {
        if (params.archived === true && busyState(thread)) throw new Error("wait for this thread to finish before archiving it");
        thread.archived = params.archived === true;
      }
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

    "thread.items": (params) => db.items(threadOf(params.threadId).id),

    "thread.prompt"(params) {
      const thread = threadOf(params.threadId);
      if (thread.state === "working" || thread.state === "starting" || thread.state === "needs_you") throw new Error("this thread is still working");
      void run(thread, text(params.text, "message", 20_000));
      return { ok: true };
    },

    async "thread.cancel"(params) {
      await lives.get(threadOf(params.threadId).id)?.session?.cancel();
      return { ok: true };
    },

    "ask.answer"(params) {
      const thread = threadOf(params.threadId);
      const pending = liveOf(thread.id).asks.get(String(params.itemId));
      if (!pending) throw new Error("that request is no longer waiting");
      const option = params.optionId === null ? null : pending.item.options.find((o) => o.id === params.optionId);
      if (option === undefined) throw new Error("unknown choice");
      liveOf(thread.id).asks.delete(pending.item.id);
      pending.item.answer = option ? option.name : "Not now";
      put(thread, pending.item);
      setState(thread, "working");
      pending.resolve({ outcome: option ? { outcome: "selected", optionId: option.id } : { outcome: "cancelled" } });
      return { ok: true };
    },
  };

  return {
    handle: (method: string, params: unknown): Promise<unknown> => {
      const handler = (handlers as Record<string, ((params: never) => unknown) | undefined>)[method];
      if (!Object.hasOwn(handlers, method) || !handler) return Promise.reject(new Error("unknown request"));
      return Promise.resolve().then(() => handler((params ?? {}) as never));
    },
    close() {
      for (const live of lives.values()) live.session?.close();
    },
  };
}
