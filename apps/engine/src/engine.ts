// Projects, threads and their timelines. Clients only see what this module emits.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { EventMessage, Item, Method, Project, ProviderId, Requests, Thread, ThreadState } from "@arcex/contracts";
import { providerIds, startSession, type AgentSession } from "./agents.ts";
import type { Db, ThreadRow } from "./db.ts";
import * as git from "./git.ts";

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

const PROVIDER_NAME: Record<ProviderId, string> = { claude: "Claude", codex: "Codex" };
const SIGN_IN: Record<ProviderId, string> = { claude: "claude auth login", codex: "codex login" };

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be 1 to ${max} characters`);
  return value.trim();
}

function titleFrom(prompt: string): string {
  const line = prompt.split("\n")[0]!.replace(/[.!?]+$/, "");
  return line.length <= 46 ? line : `${line.slice(0, 46).replace(/\s+\S*$/, "")}…`;
}

function nameFrom(goal: string): string {
  const words = goal.replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
  const name = words.slice(0, 32) || "New project";
  return name[0]!.toUpperCase() + name.slice(1);
}

/** Says what a tool call did in words a non-developer would use. The raw title stays in `detail`. */
function describe(kind: string, title: string, files: string[]): string {
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

export function createEngine(db: Db, emit: (message: EventMessage) => void) {
  const projects = new Map<string, Project>(db.projects().map((p) => [p.id, p]));
  const threads = new Map<string, ThreadRow>(db.threads().map((t) => [t.id, t]));
  const lives = new Map<string, Live>();

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
    db.touchThread(thread);
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
      provider: thread.provider,
      cwd: project.cwd,
      resumeId: thread.sessionId,
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
    if (thread.sessionId && !session.resumed) {
      put(thread, { id: randomUUID(), kind: "say", text: `${PROVIDER_NAME[thread.provider]} started fresh and doesn't remember the earlier messages in this thread.` });
    }
    thread.sessionId = session.sessionId;
    db.touchThread(thread);
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
        ? `${PROVIDER_NAME[thread.provider]} isn't signed in on this computer. Open a terminal, run "${SIGN_IN[thread.provider]}", then send your message again.`
        : `${PROVIDER_NAME[thread.provider]} couldn't finish: ${message.slice(0, 400)}`;
      put(thread, { id: randomUUID(), kind: "error", text: friendly });
    }
    endSay(thread);
    for (const step of live.steps.values()) {
      if (step.item.status === "running") put(thread, { ...step.item, status: "done" });
    }
    live.steps.clear();
    if (thread.state !== "failed") setState(thread, "idle");
  }

  const handlers: { [M in Method]: (params: Requests[M]["params"]) => Promise<Requests[M]["result"]> | Requests[M]["result"] } = {
    "state.get": () => ({ providers: providerIds, projects: [...projects.values()], threads: [...threads.values()].map(publicThread) }),

    async "project.create"(params) {
      const goal = text(params.goal, "what you're building", 2000);
      let cwd: string;
      let name: string;
      if (params.cwd !== undefined) {
        cwd = path.resolve(text(params.cwd, "folder", 1000));
        if (!path.isAbsolute(params.cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error("that folder doesn't exist");
        name = path.basename(cwd);
      } else {
        name = nameFrom(goal);
        const root = path.join(os.homedir(), "Arcex Projects");
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
      db.setPreview(project.id, url);
      emit({ event: "project", project });
      return project;
    },

    "project.changes": (params) => git.changes(projectOf(params.projectId).cwd),
    "project.diff": async (params) => ({ text: await git.diff(projectOf(params.projectId).cwd, text(params.path, "path", 1000)) }),

    "thread.create"(params) {
      const project = projectOf(params.projectId);
      if (!providerIds.includes(params.provider)) throw new Error("unknown agent");
      const prompt = text(params.text, "message", 20_000);
      const now = Date.now();
      const thread: ThreadRow = {
        id: randomUUID(), projectId: project.id, provider: params.provider, title: titleFrom(prompt),
        state: "starting", sessionId: null, createdAt: now, updatedAt: now,
      };
      db.insertThread(thread);
      threads.set(thread.id, thread);
      void run(thread, prompt);
      return publicThread(thread);
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
