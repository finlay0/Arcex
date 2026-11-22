// Projects, threads and their timelines. Clients only see what this module emits.
import { createSpeech } from "./speech.ts";
import { createAttachments } from "./attachments.ts";
import { mentionLinks, searchFiles } from "./mentions.ts";
import { contentOf, questionsOf, summaryOf } from "./questions.ts";
import { createDirectory } from "./directory.ts";
import { listEditors, openIn } from "./editors.ts";
import { createProcesses } from "./processes.ts";
import { createTerminals } from "./terminals.ts";
import { listHooks, listSkills, toggleHook, toggleSkill } from "./skills.ts";
import { branchInfo, checkoutPullRequest, createPullRequest, listPullRequests, publishState, push } from "./github.ts";
import { claudeNotes, personalMemory, savePersonalMemory } from "./memory.ts";
import { readCodexLimit } from "./codexLimits.ts";
import { cleanWhen, nextRun, removeTask, saveTask, type Launch } from "./schedules.ts";
import { openCodeSeesImages } from "./modelInputs.ts";
import { cleanConnector, connectorServers, MAX_CONNECTORS, testConnector } from "./connectors.ts";
import { bringIn, copyChanges, copyDiff, createCopy, removeCopy } from "./worktrees.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { open, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { About, AgentTask, AskOption, Attachment, EventMessage, Item, Method, Project, Requests, Schedule, Settings, Thread, ThreadState, UsageLimit } from "@arcex/contracts";
import { BUILTIN, SignInNeeded, agentList, listModels, signIn, startSession, type AgentSession, type Models } from "./agents.ts";
import type { Db, ThreadRow } from "./db.ts";
import * as git from "./git.ts";
import { openTerminal, providerStatus } from "./providers.ts";
import { TOOLBOX } from "./toolbox.ts";
import { createAccountClient } from "./account.ts";

/** The public Arcex research library. Search needs no key. */
const RESEARCH_MCP = "https://api.arcex.dev/public/mcp";

type Step = Extract<Item, { kind: "step" }>;
type Ask = Extract<Item, { kind: "ask" }>;
type QuestionItem = Extract<Item, { kind: "question" }>;
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
  steps: Map<string, { item: Step; kind: string; title: string; agent?: boolean }>;
  /** Notes for the agent summarising older messages, by the agent's compaction id. */
  compactions: Map<string, Item & { kind: "note" }>;
  asks: Map<string, { item: Ask; resolve(response: acp.RequestPermissionResponse): void }>;
  /** The agent's questions waiting on the user, with the form they came in. */
  questions: Map<string, { item: QuestionItem; schema: Parameters<typeof questionsOf>[0]; resolve(response: acp.CreateElicitationResponse): void }>;
  /** Told to the agent with the next message, after the user undoes a turn. */
  undoNote?: string;
  /** The thread's folders changed during a turn, so the next message reopens the session with them. */
  reopen?: boolean;
  /** Background work the agent reported, by its task id. */
  tasks?: Map<string, AgentTask>;
};

/** Checks the extra folders a thread may use: up to five absolute, existing folders, other than the project itself. */
function foldersFrom(value: unknown, projectCwd: string): string[] {
  if (!Array.isArray(value) || value.length > 5) throw new Error("a thread can use at most five extra folders");
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > 1000 || !path.isAbsolute(entry)) throw new Error("folders need their full path");
    const folder = path.resolve(entry);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`${folder} isn't a folder`);
    const key = process.platform === "win32" ? folder.toLowerCase() : folder;
    if (key === (process.platform === "win32" ? path.resolve(projectCwd).toLowerCase() : path.resolve(projectCwd))) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    folders.push(folder);
  }
  return folders;
}


/** A message's text. It may be empty only when files are attached. */
function message(value: unknown, attachments: Attachment[]): string {
  if (attachments.length && (value === undefined || value === null || (typeof value === "string" && !value.trim()))) return "";
  return text(value, "message", 20_000);
}

/**
 * Whether a failure was the agent's plan running out. Returns when it resets as the agent wrote it ("" when it didn't
 * say), or null when this was some other failure.
 */
/** "OpenCode/Big Pickle" reads as "Big Pickle". */
const shortModel = (name: string) => name.replace(/^[^/]{1,40}\/\s*(?=\S)/, "");

function usageLimit(text: string): string | null {
  if (!/usage limit|rate limit|quota|out of (credits|usage)|limit reached|hit your (usage )?limit/i.test(text)) return null;
  const at = /(?:try again|resets?|available again)\s+(?:at|in|on)\s+([^.\n"\\]{1,40})/i.exec(text);
  return at ? at[1]!.trim() : "";
}

/** Mode values that mean the agent acts without asking: Claude "bypassPermissions", Codex "agent-full-access", Gemini "yolo". */
const FULL_ACCESS = /bypass|full|yolo|autopilot/i;
/** A plan-only mode, named "plan" or ending in "#plan" (GitHub Copilot names modes by URL). */
const PLAN_MODE = /(^|[#/:])plan$/i;
/** Modes that hold the agent back: planning only, reading only, or asking first. */
const NARROW_MODE = /plan|read|ask|manual|default|accept|review/i;

/**
 * The choices on an approval card. For a plan, only going ahead in full access or keeping on planning are offered,
 * since Arcex has no approval modes to go ahead into.
 */
function planOptions(isPlan: boolean, options: acp.PermissionOption[]): AskOption[] {
  const all = options.map((option) => ({ id: option.optionId, name: option.name, kind: option.kind }));
  if (!isPlan || !all.some((option) => FULL_ACCESS.test(option.id))) return all;
  return all
    .filter((option) => FULL_ACCESS.test(option.id) || option.kind.startsWith("reject"))
    .map((option) => (!FULL_ACCESS.test(option.id) ? option : { ...option, name: /clear/i.test(option.id) ? "Yes, start fresh with just the plan" : "Yes, go ahead" }));
}

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
  if (/suggest_side_thread/.test(title)) return "Suggested a side thread";
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
  extras: { browser?: BrowserBridge; connectorEnv?(): { name: string; value: string }[]; launch?: Launch } = {},
) {
  let settings = db.settings();
  const speech = createSpeech(about.dataDir, (state) => emit({ event: "speech", speech: state }));
  const terminals = createTerminals({
    data: (id, data) => emit({ event: "terminal", id, data }),
    exit: (id, code) => emit({ event: "terminalExit", id, code }),
  });
  const processes = createProcesses({
    emit: (info) => emit({ event: "process", process: info }),
    // The first address a script prints becomes the project's preview, unless the user already chose one.
    onUrl(projectId, url) {
      const project = projects.get(projectId);
      if (!project || project.previewUrl) return;
      project.previewUrl = url;
      db.saveProject(project);
      emit({ event: "project", project });
    },
  });
  const files = createAttachments(about.dataDir);
  const directory = createDirectory(about.dataDir);
  const projects = new Map<string, Project>(db.projects().map((p) => [p.id, p]));
  const threads = new Map<string, ThreadRow>(db.threads().map((t) => [t.id, t]));
  const lives = new Map<string, Live>();
  /** Side questions being answered, by id: a throwaway copy of a thread's conversation. */
  const asides = new Map<string, { threadId: string; session: AgentSession | null; stop: AbortController }>();
  const changingModels = new Set<string>();
  /** Model lists, read once per agent while the engine runs. */
  const modelCache = new Map<string, Models>();
  // Arcex's own Git index per thread, for snapshots of the project before and after each turn.
  const snapshotsDir = path.join(about.dataDir, "snapshots");
  mkdirSync(snapshotsDir, { recursive: true });
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
      if (!/^[\w.-]{1,80}$/.test(key) || typeof choice !== "string" || !/^[\w.:/#-]{1,120}$/.test(choice)) throw new Error("invalid setting");
      return [key, choice];
    }));
  };

  /**
   * Arcex always runs agents with full access (Finlay, November 21, 2026): no approval modes. The one other mode kept
   * is planning first, where the agent offers one. Returns the mode value to use, or null when the agent has no modes.
   */
  function modeFor(session: AgentSession, wanted: string | undefined): { id: string; value: string } | null {
    const mode = session.choices.find((entry) => entry.category === "mode");
    if (!mode) return null;
    const plan = mode.values.find((entry) => PLAN_MODE.test(entry.value));
    if (wanted && plan && PLAN_MODE.test(wanted)) return { id: mode.id, value: plan.value };
    // No mode named for full access (OpenCode has "build" and "plan"): take the first that is not a narrower one.
    const full = mode.values.find((entry) => FULL_ACCESS.test(entry.value))
      ?? mode.values.find((entry) => !NARROW_MODE.test(entry.value))
      ?? mode.values[0];
    return full ? { id: mode.id, value: full.value } : null;
  }

  /** Puts the thread's picked settings into the agent session, one by one. The mode is always full access or plan. */
  async function applyChoices(thread: ThreadRow, session: AgentSession, picked: Record<string, string>, enforceMode = true) {
    const mode = session.choices.find((entry) => entry.category === "mode");
    const wanted = { ...picked };
    if (mode && (enforceMode || mode.id in wanted)) {
      const target = modeFor(session, wanted[mode.id]);
      if (target) wanted[mode.id] = target.value;
      if (target && thread.choices[mode.id] !== target.value) thread.choices = { ...thread.choices, [mode.id]: target.value };
    }
    // Some agents keep full access as its own switch (GitHub Copilot's "allow_all"). It is always on.
    if (enforceMode) {
      for (const permission of session.choices.filter((entry) => entry.category === "permissions" && entry.values.length === 2)) {
        const on = permission.values.find((entry) => !/^(off|false|no|ask|default|disabled?)$/i.test(entry.value));
        if (on) wanted[permission.id] = on.value;
      }
    }
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
    const mode = session.choices.find((entry) => entry.category === "mode");
    if (mode?.current && mode.current !== thread.choices[mode.id]) {
      // Entering plan mode is followed. Anything else (leaving a plan into a narrower mode) goes back to full access.
      const target = modeFor(session, mode.current);
      if (target && target.value !== mode.current) void session.setChoice(mode.id, target.value).catch(() => {});
      thread.choices = { ...thread.choices, [mode.id]: target?.value ?? mode.current };
      changed = true;
    }
    if (changed) {
      db.saveThread(thread);
      emit({ event: "thread", thread: publicThread(thread) });
    }
  }

  // Plan limits by agent, as agents report them during turns. Account-wide, so every thread of that agent shares one.
  const limits = new Map<string, UsageLimit>();
  // Codex doesn't report its limits over ACP, so Arcex asks Codex for them: after a Codex turn, and when they're stale.
  let codexAsking: Promise<void> | null = null;
  const refreshCodexLimit = (olderThan = 0) => {
    const known = limits.get("codex");
    if (codexAsking || (known && Date.now() - known.at < olderThan)) return;
    codexAsking = readCodexLimit()
      .then((limit) => {
        if (!limit) return;
        limits.set("codex", limit);
        emit({ event: "limit", agentId: "codex", limit });
      })
      .catch(() => {})
      .finally(() => (codexAsking = null));
  };
  const limitOf = (raw: unknown): UsageLimit | null => {
    if (!raw || typeof raw !== "object") return null;
    const info = raw as { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown; utilization?: unknown };
    const status = info.status === "rejected" ? "reached" : info.status === "allowed_warning" ? "warning" : info.status === "allowed" ? "ok" : null;
    if (!status) return null;
    const kind = String(info.rateLimitType ?? "");
    const resets = typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt) ? info.resetsAt : null;
    const used = typeof info.utilization === "number" && Number.isFinite(info.utilization) ? Math.min(1, Math.max(0, info.utilization > 1 ? info.utilization / 100 : info.utilization)) : null;
    return {
      status,
      window: kind === "five_hour" ? "five_hour" : kind.startsWith("seven_day") ? "weekly" : "other",
      used,
      // Seconds since 1970 from Claude; a value that big is already milliseconds.
      resetsAt: resets === null ? null : resets < 1e12 ? resets * 1000 : resets,
      at: Date.now(),
    };
  };
  const publicThread = ({ sessionId: _sessionId, worktree, carry: _carry, named: _named, ...thread }: ThreadRow): Thread => ({
    ...thread,
    copy: worktree ? { path: worktree.path } : null,
    steering: lives.get(thread.id)?.session?.steering === true,
    ...(thread.folders.length && lives.get(thread.id)?.session?.folders === false ? { foldersSupported: false } : {}),
    ...(lives.get(thread.id)?.tasks?.size ? { tasks: [...lives.get(thread.id)!.tasks!.values()].sort((a, b) => b.startedAt - a.startedAt) } : {}),
  });
  const liveOf = (id: string): Live => {
    let live = lives.get(id);
    if (!live) lives.set(id, (live = { session: null, turn: null, turnFailure: null, say: null, think: null, plan: null, steps: new Map(), compactions: new Map(), asks: new Map(), questions: new Map() }));
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

  /** The folder a thread's agent works in: its separate copy, or the project folder. */
  const where = (thread: ThreadRow, project: Project) => thread.worktree?.path ?? project.cwd;

  function filesOf(cwd: string, update: { locations?: acp.ToolCallLocation[] | null; content?: acp.ToolCallContent[] | null }) {
    const found = [
      ...(update.locations ?? []).map((location) => location.path),
      ...(update.content ?? []).flatMap((content) => (content.type === "diff" ? [content.path] : [])),
    ];
    return [...new Set(found.map((file) => path.relative(cwd, file) || file))];
  }

  function onUpdate(thread: ThreadRow, project: Project, update: acp.SessionUpdate) {
    const live = lives.get(thread.id);
    if (live && onTaskUpdate(thread, live, update as unknown as Record<string, unknown>)) return;
    if (update.sessionUpdate === "usage_update") {
      const limit = limitOf((update as { _meta?: Record<string, unknown> })._meta?.["_claude/rateLimit"]);
      if (limit) {
        limits.set(thread.provider, limit);
        emit({ event: "limit", agentId: thread.provider, limit });
      }
      // Kept in memory only: it changes every turn and comes back with the next one.
      const { used, size } = update;
      if (!live || !Number.isFinite(used) || !Number.isFinite(size) || size <= 0 || used < 0) return;
      thread.context = { used: Math.round(used), size: Math.round(size) };
      emit({ event: "thread", thread: publicThread(thread) });
      return;
    }
    if (!live?.turn) return;
    if (update.sessionUpdate === "compaction_update") {
      // The agent summarises older messages when its context fills up, or when asked with /compact.
      const id = String(update.compactionId).slice(0, 200);
      let note = live.compactions.get(id);
      if (!note) {
        if (live.compactions.size > 50) live.compactions.clear();
        live.compactions.set(id, (note = { id: randomUUID(), kind: "note", text: "" }));
      }
      const error = typeof update.error === "string" ? update.error.slice(0, 300) : "";
      note.text = update.status === "completed" ? "Summarised older messages to free up the agent's memory. Details from early in the thread may need repeating."
        : update.status === "failed" ? `Couldn't summarise older messages${error ? `: ${error}` : "."}`
        : update.status === "cancelled" ? "Stopped summarising older messages."
        : "Summarising older messages to free up the agent's memory…";
      endSay(thread);
      put(thread, { ...note });
      return;
    }
    if (update.sessionUpdate === "notice") {
      const title = String(update.title ?? "").trim().slice(0, 200);
      const description = String(update.description ?? "").trim().slice(0, 600);
      if (!title && !description) return;
      endSay(thread);
      put(thread, { id: randomUUID(), kind: "note", text: [title, description].filter(Boolean).join(": ") });
      return;
    }
    // Work a subagent does inside an Agent or Task call is tagged with that call's id (Claude's adapter).
    const claudeMeta = (update as { _meta?: { claudeCode?: { parentToolUseId?: unknown; toolName?: unknown } } })._meta?.claudeCode;
    const parentCall = claudeMeta?.parentToolUseId;
    const parentStep = typeof parentCall === "string" ? live.steps.get(parentCall) : undefined;
    // A subagent's own words and reasoning are its working notes. Its result reaches the main agent, which says what matters.
    if (parentStep && (update.sessionUpdate === "agent_thought_chunk" || update.sessionUpdate === "agent_message_chunk")) return;
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
      const files = filesOf(where(thread, project), update);
      if (files.length) step.item.files = [...new Set([...step.item.files, ...files])];
      if (update.status === "completed") step.item.status = "done";
      else if (update.status === "failed") step.item.status = "failed";
      step.item.detail = step.title.slice(0, 2000);
      readContent(step.item, update.content);
      step.item.label = describe(step.kind, step.title, step.item.files);
      step.item.tool = /browser_[a-z]+/.test(step.title) ? "browser" : step.kind;
      // Claude's Agent and Task calls start a subagent. Its own steps fold under this one.
      if (claudeMeta?.toolName === "Agent" || claudeMeta?.toolName === "Task") step.agent = true;
      if (step.agent) {
        step.item.tool = "agent";
        step.item.label = step.title ? `Subagent: ${step.title.slice(0, 200)}` : "Ran a subagent";
      }
      if (parentStep && parentStep !== step) {
        step.item.parent = parentStep.item.id;
        if (!parentStep.agent) {
          parentStep.agent = true;
          parentStep.item.tool = "agent";
          parentStep.item.label = parentStep.title ? `Subagent: ${parentStep.title.slice(0, 200)}` : "Ran a subagent";
          put(thread, parentStep.item);
        }
      }
      put(thread, step.item);
    } else if (update.sessionUpdate === "available_commands_update" && live.session) {
      const commands = live.session.commands;
      const cached = modelCache.get(thread.provider);
      if (cached) cached.commands = commands;
      emit({ event: "commands", agentId: thread.provider, commands });
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

  /** Whether the thread still has an approval or a question waiting on the user. */
  const waiting = (threadId: string) => {
    const live = lives.get(threadId);
    return !!live && (live.asks.size > 0 || live.questions.size > 0);
  };

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
          : describe(call.kind ?? "other", call.title ?? "", filesOf(where(thread, project), call)).replace(/^(Changed|Ran|Removed|Moved|Looked at)/, (verb) =>
            ({ Changed: "Change", Ran: "Run", Removed: "Remove", Moved: "Move", "Looked at": "Look at" })[verb] ?? verb,
          ),
        detail: (call.title ?? "").slice(0, 2000),
        body: body?.slice(0, 20_000),
        options: planOptions(plan !== null, request.options),
        answer: null,
      };
      live.asks.set(item.id, { item, resolve });
      put(thread, item);
      setState(thread, "needs_you");
    });
  }

  /** An agent's questions, as a card the user answers. Only form questions are asked; others are declined. */
  function onElicitation(thread: ThreadRow, request: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
    const live = lives.get(thread.id);
    if (!live?.turn || live.turn.signal.aborted) return Promise.resolve({ action: "cancel" });
    if (request.mode !== "form" || !("requestedSchema" in request)) return Promise.resolve({ action: "decline" });
    const schema = request.requestedSchema as Parameters<typeof questionsOf>[0];
    const questions = questionsOf(schema);
    if (!questions.length) return Promise.resolve({ action: "decline" });
    return new Promise((resolve) => {
      endSay(thread);
      const item: QuestionItem = { id: randomUUID(), kind: "question", title: String(request.message ?? "").slice(0, 2000) || "A question for you", questions, answer: null };
      live.questions.set(item.id, { item, schema, resolve });
      put(thread, item);
      setState(thread, "needs_you");
    });
  }

  /**
   * Ends a thread's separate copy. The agent's session was opened in the copy, so the next message starts a fresh one
   * in the project folder with a recap of the conversation.
   */
  async function leaveCopy(thread: ThreadRow, project: Project, note: string, what: string) {
    const copy = thread.worktree;
    if (!copy) return;
    const live = liveOf(thread.id);
    closeSession(live);
    await removeCopy(project.cwd, copy);
    thread.worktree = null;
    const recap = db.items(thread.id)
      .map((entry) => entry.kind === "user" ? `User: ${entry.text}` : entry.kind === "say" ? `You: ${entry.text}` : "")
      .filter(Boolean)
      .join("\n\n");
    thread.carry = `(Note from Arcex: you were working in a separate copy of the project. Its changes were ${what}, and you now work in the project folder, ${project.cwd}. You are starting fresh, so here is the conversation so far, most recent last.)\n\n${recap.length > 12000 ? `…${recap.slice(-12000)}` : recap}`;
    thread.sessionId = null;
    thread.context = undefined;
    db.saveThread(thread);
    put(thread, { id: randomUUID(), kind: "note", text: note });
    emit({ event: "thread", thread: publicThread(thread) });
  }

  function stopAside(id: string) {
    const aside = asides.get(id);
    if (!aside) return;
    asides.delete(id);
    aside.stop.abort(new Error("stopped"));
    aside.session?.close();
    emit({ event: "aside", threadId: aside.threadId, asideId: id, text: "", state: "stopped" });
  }

  function closeSession(live: Live) {
    const session = live.session;
    live.session = null;
    session?.close();
    // Background work ends with the agent's process.
    const running = [...(live.tasks?.values() ?? [])].filter((task) => task.state === "running");
    for (const task of running) Object.assign(task, { state: "stopped", endedAt: Date.now(), canStop: false });
    const threadId = [...lives.entries()].find(([, entry]) => entry === live)?.[0];
    const thread = threadId ? threads.get(threadId) : undefined;
    if (running.length && thread) emit({ event: "thread", thread: publicThread(thread) });
  }

  /** Claude's async task updates (the AIR extension): background work starting, changing and ending. */
  function onTaskUpdate(thread: ThreadRow, live: Live, update: Record<string, unknown>): boolean {
    const kind = update.sessionUpdate;
    if (kind !== "async_task_spawned" && kind !== "async_task_progress" && kind !== "async_task_state_update") return false;
    const id = String(update.asyncTaskId ?? "").slice(0, 200);
    if (!id) return true;
    live.tasks ??= new Map();
    let task = live.tasks.get(id);
    if (!task) {
      // Only the newest 50 are kept; finished ones go first.
      if (live.tasks.size >= 50) {
        const oldest = [...live.tasks.values()].filter((entry) => entry.state !== "running").sort((a, b) => a.startedAt - b.startedAt)[0];
        if (!oldest) return true;
        live.tasks.delete(oldest.id);
      }
      task = { id, name: "", description: "", kind: "", state: "running", startedAt: Date.now(), endedAt: null, canStop: false, summary: "" };
      live.tasks.set(id, task);
    }
    const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
    if (text(update.name, 200)) task.name = text(update.name, 200);
    if (text(update.description, 600)) task.description = text(update.description, 600);
    if (text(update.taskType, 40)) task.kind = text(update.taskType, 40);
    if (typeof update.canStop === "boolean") task.canStop = update.canStop;
    if (kind === "async_task_state_update") {
      const state = update.state;
      if (state === "completed" || state === "failed" || state === "stopped") {
        task.state = state;
        task.endedAt = Date.now();
        task.canStop = false;
      } else if (state === "running") task.state = "running";
      if (text(update.summary, 600)) task.summary = text(update.summary, 600);
    }
    emit({ event: "thread", thread: publicThread(thread) });
    return true;
  }

  function dismissAsks(thread: ThreadRow, live: Live, answer: string, save = true) {
    for (const { item, resolve } of live.asks.values()) {
      if (save) put(thread, { ...item, answer });
      resolve({ outcome: { outcome: "cancelled" } });
    }
    live.asks.clear();
    for (const { item, resolve } of live.questions.values()) {
      if (save) put(thread, { ...item, answer: answer || "Request closed" });
      resolve({ action: "cancel" });
    }
    live.questions.clear();
  }

  async function ensureSession(thread: ThreadRow, project: Project, live: Live, signal: AbortSignal): Promise<AgentSession> {
    if (live.session && live.reopen) closeSession(live);
    live.reopen = false;
    if (live.session) return live.session;
    const session = await startSession({
      agentId: thread.provider,
      settings,
      cwd: where(thread, project),
      folders: thread.folders.filter((folder) => existsSync(folder)),
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
            { name: "ARCEX_THREAD_ID", value: thread.id },
            ...(extras.connectorEnv?.() ?? []),
          ],
        },
        ...(settings.research ? [{ type: "http" as const, name: "arcex-research", url: RESEARCH_MCP, headers: [] }] : []),
        ...connectorServers(settings.connectors, project.id),
      ],
      onUpdate: (update) => onUpdate(thread, project, update),
      onPermission: (request) => onPermission(thread, project, request),
      onElicitation: (request) => onElicitation(thread, request),
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

  async function run(thread: ThreadRow, prompt: string, attached: Attachment[] = []) {
    const project = projectOf(thread.projectId);
    const live = liveOf(thread.id);
    const turn = new AbortController();
    live.turn = turn;
    live.turnFailure = null;
    live.plan = null;
    const started = Date.now();
    setState(thread, live.session ? "working" : "starting");
    put(thread, attached.length ? { id: randomUUID(), kind: "user", text: prompt, attachments: attached } : { id: randomUUID(), kind: "user", text: prompt });
    let outcome: ThreadState = "idle";
    const snapshotFile = path.join(snapshotsDir, `${thread.id}.index`);
    let before: string | null = null;
    try {
      before = await git.snapshot(where(thread, project), snapshotFile);
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
      const images = attached.filter((file) => file.image).length;
      // OpenCode reaches many models and says per agent that it takes images; whether this model sees them, it says
      // only in its own model list.
      const blind = images > 0 && (!session.promptCapabilities?.image || (thread.provider === "opencode" && (await openCodeSeesImages(thread.model?.value ?? session.models?.current)) === false));
      if (blind) {
        const model = thread.model ? shortModel(thread.model.name) : nameOf(thread.provider);
        const one = images === 1;
        put(thread, { id: randomUUID(), kind: "note", text: `${model} can't see images, so ${one ? "the image was" : "the images were"} sent as ${one ? "a file" : "files"} it may not open. Choose a model that sees images to have ${one ? "it" : "them"} looked at.` });
      }
      // Files the message mentions with "@" go along as links the agent can open.
      const undoNote = [thread.carry, live.undoNote].filter(Boolean).join("\n\n");
      live.undoNote = undefined;
      if (thread.carry) {
        thread.carry = null;
        db.saveThread(thread);
      }
      const result = await session.prompt([...(undoNote ? [{ type: "text" as const, text: undoNote }] : []), ...files.blocks(prompt, attached, session.promptCapabilities), ...mentionLinks(where(thread, project), prompt, session.promptCapabilities)]);
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
        // A usage limit often arrives as a bare "Internal error", with the real reason in the error's data or in what
        // the agent just said. Look at all of it.
        const data = error && typeof error === "object" && "data" in error ? JSON.stringify((error as { data: unknown }).data ?? "") : "";
        const said = `${message} ${data} ${live.say?.text ?? ""}`;
        const limit = usageLimit(said);
        const friendly = limit !== null
          ? `${nameOf(thread.provider)} has reached its usage limit${limit ? ` until ${limit}` : ""}. Try again then, or switch to another agent or model for this thread.`
          : error instanceof SignInNeeded || /auth|sign.in required/i.test(message)
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
    live.steps.clear();
    // The snapshots show everything the turn changed, including what its commands did. Without Git, list the edits
    // the agent reported.
    const after = before ? await git.snapshot(where(thread, project), snapshotFile) : null;
    if (!threads.has(thread.id)) return;
    const turnChanges = before && after ? await git.turnChanges(where(thread, project), before, after).catch(() => null) : null;
    if (turnChanges && before && after) {
      if (turnChanges.length) put(thread, { id: randomUUID(), kind: "result", files: turnChanges.map((change) => change.path), changes: turnChanges, snapshots: { before, after } });
    } else if (changed.size) put(thread, { id: randomUUID(), kind: "result", files: [...changed] });
    const ended = (live.turnFailure ?? outcome) as ThreadState;
    const endings: Partial<Record<ThreadState, "stopped" | "failed" | "interrupted">> = { stopped: "stopped", failed: "failed", interrupted: "interrupted" };
    put(thread, { id: randomUUID(), kind: "end", seconds: Math.round((Date.now() - started) / 1000), outcome: endings[ended] ?? "done" });
    setState(thread, ended);
    tellParent(thread, ended);
    if (thread.provider === "codex") refreshCodexLimit();
    if (ended === "idle" && !thread.queued.length) void wrapTurn(thread, project);
    // The next waiting message goes out only after a clean finish. After a stop or a failure the user decides.
    if (ended === "idle" && thread.queued.length && threads.has(thread.id)) {
      const [next, ...rest] = thread.queued;
      thread.queued = rest;
      db.saveThread(thread);
      void run(thread, next!.text, next!.attachments);
    }
  }

  /**
   * Asks the thread's agent something in a fork of its session, so the thread itself is untouched. The fork is read only:
   * plan mode where the agent has one, every permission refused. Resolves with the reply's text.
   */
  async function askFork(thread: ThreadRow, project: Project, prompt: string, stop: AbortController, onText?: (text: string) => void, onSession?: (session: AgentSession) => void): Promise<string> {
    let answer = "";
    const session = await startSession({
      agentId: thread.provider,
      settings,
      cwd: where(thread, project),
      folders: thread.folders.filter((folder) => existsSync(folder)),
      resumeId: null,
      forkOf: thread.sessionId!,
      signal: stop.signal,
      mcpServers: [],
      onUpdate: (update) => {
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text" || answer.length > 40_000) return;
        answer += update.content.text;
        onText?.(answer);
      },
      onPermission: async (request) => {
        const reject = request.options.find((option) => option.kind === "reject_once") ?? request.options.find((option) => option.kind.startsWith("reject"));
        return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
      },
      onElicitation: async () => ({ action: "cancel" }),
      onExit: () => {},
    });
    onSession?.(session);
    try {
      if (stop.signal.aborted) throw stop.signal.reason;
      const mode = session.choices.find((choice) => choice.category === "mode");
      const plan = mode?.values.find((value) => /plan|read/i.test(value.value) || /plan|read/i.test(value.name));
      if (mode && plan && mode.current !== plan.value) await session.setChoice(mode.id, plan.value).catch(() => {});
      if (thread.model && session.models && thread.model.value !== session.models.current) await session.setModel(thread.model.value).catch(() => {});
      await session.prompt([{ type: "text", text: prompt }]);
      return answer;
    } finally {
      session.close();
    }
  }

  // Schedules. With a Windows task, Windows starts the run (through this engine when it's open); without one, this
  // engine runs them while it's open.
  const schedules = new Map(db.schedules().map((schedule) => [schedule.id, schedule]));
  const scheduleList = () => [...schedules.values()].sort((a, b) => a.createdAt - b.createdAt);
  const emitSchedules = () => {
    const list = scheduleList();
    emit({ event: "schedules", schedules: list });
    return list;
  };
  /** Starts a schedule's prompt as a new thread. Skipped while its last run is still going. */
  async function runSchedule(id: string, byHand = false): Promise<Thread> {
    const schedule = schedules.get(id);
    if (!schedule) throw new Error("that schedule is gone");
    const project = projectOf(schedule.projectId);
    const previous = schedule.lastRun?.threadId ? threads.get(schedule.lastRun.threadId) : undefined;
    const now = Date.now();
    schedule.nextRun = schedule.on ? nextRun(schedule.when, now, schedule.createdAt) : null;
    if (previous && busyState(previous)) {
      schedule.lastRun = { at: now, threadId: previous.id, skipped: "the last run was still going" };
      db.saveSchedule(schedule);
      emitSchedules();
      if (byHand) throw new Error("its last run is still going");
      return publicThread(previous);
    }
    const created = await handlers["thread.create"]({ projectId: project.id, provider: schedule.provider, model: schedule.model, choices: {}, text: schedule.prompt });
    const thread = threadOf(created.id);
    thread.title = schedule.name;
    thread.named = true;
    db.saveThread(thread);
    put(thread, { id: randomUUID(), kind: "note", text: byHand ? `Started by hand from the schedule “${schedule.name}”.` : `A scheduled run of “${schedule.name}”.` });
    emit({ event: "thread", thread: publicThread(thread) });
    schedule.lastRun = { at: now, threadId: thread.id };
    db.saveSchedule(schedule);
    emitSchedules();
    return publicThread(thread);
  }
  // Schedules without a Windows task are due by this clock.
  const scheduleClock = setInterval(() => {
    const now = Date.now();
    for (const schedule of schedules.values()) {
      if (!schedule.on || schedule.background === "task" || !schedule.nextRun || schedule.nextRun > now || !projects.has(schedule.projectId)) continue;
      void runSchedule(schedule.id).catch(() => {});
    }
  }, 30_000);
  scheduleClock.unref?.();

  // After-turn wrap-ups being written, by thread, and agents found not to support them (no session forks).
  const wrapping = new Map<string, AbortController>();
  const noWrap = new Set<string>();
  /**
   * The agent writes a recap of the turn and up to three messages the user might send next, and early on a title for
   * the thread. Finlay chose (November 22) to have the thread's own agent do this on the user's plan, shown in the
   * thread as written by the agent, with a switch in Settings › General.
   */
  async function wrapTurn(thread: ThreadRow, project: Project) {
    if (!settings.wrapUp || !thread.sessionId || noWrap.has(thread.provider) || wrapping.has(thread.id)) return;
    const history = db.items(thread.id);
    const turns = history.filter((entry) => entry.kind === "user").length;
    // A recap helps after work (tools, file changes), not under a short answer.
    const lastAsk = history.map((entry) => entry.kind).lastIndexOf("user");
    const worked = history.slice(lastAsk + 1).some((entry) => entry.kind === "step" || entry.kind === "result");
    const naming = !thread.named && !thread.parentId && [1, 3, 8].includes(turns);
    const stop = new AbortController();
    wrapping.set(thread.id, stop);
    const timer = setTimeout(() => stop.abort(new Error("took too long")), 90_000);
    try {
      const reply = await askFork(thread, project, `(Note from Arcex, not from the user: the turn is over. Write a short wrap-up that Arcex shows under it. Don't use any tools. Reply with only this JSON:
{${worked ? `"recap": "one or two plain sentences: what is now true, and anything left undone or unchecked, for someone who wasn't watching", ` : ""}"next": ["up to three short messages the user might send next, in their own voice, each under 12 words; none if nothing obvious"]${naming ? `, "title": "a 2 to 6 word title for this whole conversation"` : ""}})`, stop);
      const json = /\{[\s\S]*\}/.exec(reply)?.[0];
      if (!json) return;
      const parsed = JSON.parse(json) as { recap?: unknown; next?: unknown; title?: unknown };
      // The user moved on (sent another message) while this was written: it no longer belongs at the end.
      if (!threads.has(thread.id) || busyState(thread) || db.items(thread.id).filter((entry) => entry.kind === "user").length !== turns) return;
      const recap = worked && typeof parsed.recap === "string" ? parsed.recap.trim().slice(0, 600) : "";
      const next = Array.isArray(parsed.next) ? parsed.next.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()).map((entry) => entry.trim().slice(0, 140)).slice(0, 3) : [];
      if (recap || next.length) put(thread, { id: randomUUID(), kind: "wrap", recap, next, by: nameOf(thread.provider) });
      const title = typeof parsed.title === "string" ? parsed.title.replace(/^["'\s]+|["'.\s]+$/g, "").slice(0, 80) : "";
      if (naming && title && !thread.named) {
        thread.title = title;
        db.saveThread(thread);
        emit({ event: "thread", thread: publicThread(thread) });
      }
    } catch (error) {
      if (/can't answer side questions/.test(String(error))) noWrap.add(thread.provider);
    } finally {
      clearTimeout(timer);
      wrapping.delete(thread.id);
    }
  }

  /**
   * A side thread finished a turn: the parent shows a note, and its agent hears about it with the user's next message
   * there. Nothing is sent to the parent's agent on its own, so no usage is spent unseen.
   */
  function tellParent(child: ThreadRow, ended: ThreadState) {
    const parent = child.parentId ? threads.get(child.parentId) : undefined;
    if (!parent || ended === "stopped") return;
    const how = ended === "idle" ? "finished" : "stopped with a problem";
    const said = [...db.items(child.id)].reverse().find((entry) => entry.kind === "say");
    const reply = said?.kind === "say" ? said.text.trim() : "";
    const line = `(Note from Arcex: your side thread "${child.title}" ${how}.${reply ? ` Its last reply: ${reply.length > 2000 ? `${reply.slice(0, 2000)}…` : reply}` : ""})`;
    parent.carry = [parent.carry, line].filter(Boolean).join("\n\n").slice(-20000);
    db.saveThread(parent);
    put(parent, { id: randomUUID(), kind: "note", text: `Side thread “${child.title}” ${how}. Its agent's last reply goes along with your next message here.` });
  }

  /** The agent's suggestion of separate work, as a card in its thread. From the Arcex connector. */
  function suggest(threadId: unknown, rawTitle: unknown, rawPrompt: unknown): string {
    const thread = threadOf(threadId);
    const title = text(rawTitle, "title", 80);
    const prompt = text(rawPrompt, "prompt", 8000);
    const open = db.items(thread.id).filter((entry) => entry.kind === "suggest" && !entry.started && !entry.dismissed).length;
    if (open >= 3) throw new Error("three side threads are already waiting for the user. Don't suggest more until they start or dismiss one");
    put(thread, { id: randomUUID(), kind: "suggest", title, prompt, started: null });
    return "Suggested. The user can start it as a side thread from the card in this conversation, or dismiss it. Carry on with the current task.";
  }

  const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;
  const MAX_INSTRUCTIONS = 200_000;

  const busyState = (thread: ThreadRow) => thread.state === "working" || thread.state === "starting" || thread.state === "needs_you" || thread.state === "stopping";

  /** Stops a thread's agent and forgets it in memory. The caller removes it from the database. */
  function dropThread(thread: ThreadRow) {
    for (const [id, aside] of asides) if (aside.threadId === thread.id) stopAside(id);
    wrapping.get(thread.id)?.abort();
    const live = lives.get(thread.id);
    if (live) {
      clearTimeout(live.stopTimer);
      live.turn?.abort();
      dismissAsks(thread, live, "", false);
      closeSession(live);
      lives.delete(thread.id);
    }
    rmSync(path.join(snapshotsDir, `${thread.id}.index`), { force: true });
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
      if (params.terminal !== undefined) next.terminal = params.terminal === true;
      if (params.notify !== undefined) next.notify = params.notify === true;
      if (params.research !== undefined) next.research = params.research === true;
      if (params.wrapUp !== undefined) next.wrapUp = params.wrapUp === true;
      settings = next;
      db.saveSettings(settings);
      emit({ event: "settings", settings, agents: agentList(settings) });
      return settings;
    },

    "connectors.save"(params) {
      const others = settings.connectors;
      const connector = cleanConnector(params.connector, others, new Set(projects.keys()));
      const exists = others.some((other) => other.id === connector.id);
      if (!exists && others.length >= MAX_CONNECTORS) throw new Error(`that is the most connectors Arcex keeps (${MAX_CONNECTORS})`);
      settings = { ...settings, connectors: exists ? others.map((other) => (other.id === connector.id ? connector : other)) : [...others, connector] };
      db.saveSettings(settings);
      emit({ event: "settings", settings, agents: agentList(settings) });
      return settings;
    },
    "connectors.remove"(params) {
      settings = { ...settings, connectors: settings.connectors.filter((connector) => connector.id !== params.id) };
      db.saveSettings(settings);
      emit({ event: "settings", settings, agents: agentList(settings) });
      return settings;
    },
    "schedules.list": () => scheduleList(),
    async "schedules.save"(params) {
      const raw = (params.schedule ?? {}) as Partial<Schedule>;
      const before = typeof raw.id === "string" ? schedules.get(raw.id) : undefined;
      if (!before && schedules.size >= 30) throw new Error("that is the most schedules Arcex keeps (30)");
      const project = projectOf(raw.projectId ?? before?.projectId);
      const provider = String(raw.provider ?? before?.provider ?? settings.defaultProvider);
      if (!agentList(settings).some((agent) => agent.id === provider)) throw new Error("unknown agent");
      const now = Date.now();
      const when = raw.when === undefined && before ? before.when : cleanWhen(raw.when);
      const schedule: Schedule = {
        id: before?.id ?? randomUUID(),
        name: text(raw.name ?? before?.name, "name", 80),
        projectId: project.id,
        prompt: text(raw.prompt ?? before?.prompt, "prompt", 20_000),
        provider,
        model: raw.model === undefined ? (before?.model ?? settings.defaultModel) : pickedModel(raw.model),
        when,
        on: raw.on === undefined ? (before?.on ?? true) : raw.on === true,
        createdAt: before?.createdAt ?? now,
        nextRun: null,
        lastRun: before?.lastRun ?? null,
        background: "app",
      };
      // An hourly schedule counts its hours from when it was set up or last changed.
      if (!before || JSON.stringify(before.when) !== JSON.stringify(when)) schedule.createdAt = now;
      schedule.nextRun = schedule.on ? nextRun(schedule.when, now, schedule.createdAt) : null;
      if (extras.launch) {
        try {
          await saveTask(schedule, extras.launch);
          schedule.background = "task";
        } catch (error) {
          schedule.background = "failed";
          schedule.problem = `Windows couldn't set it to run while Arcex is closed (${error instanceof Error ? error.message : String(error)}). It runs while Arcex is open.`;
        }
      }
      schedules.set(schedule.id, schedule);
      db.saveSchedule(schedule);
      return emitSchedules();
    },
    async "schedules.remove"(params) {
      const schedule = schedules.get(String(params.id));
      if (schedule) {
        if (extras.launch) await removeTask(schedule.id);
        schedules.delete(schedule.id);
        db.removeSchedule(schedule.id);
      }
      return emitSchedules();
    },
    "schedules.runNow": (params) => runSchedule(String(params.id), true),

    "connectors.test": (params) => testConnector(cleanConnector(params.connector, [], new Set(projects.keys()))),

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

    "agents.directory": (params) => directory.list(params.refresh === true),

    async "agents.addFromDirectory"(params) {
      const id = text(params.id, "agent", 80);
      if (settings.agents.some((agent) => agent.directory?.id === id)) throw new Error("that agent is already added");
      if (settings.agents.length >= 20) throw new Error("that is the most agents Arcex keeps");
      const installed = await directory.install(id);
      // Settings may have changed while the download ran.
      if (settings.agents.some((agent) => agent.directory?.id === id)) return settings;
      const added = { id: `dir-${id}`, name: installed.name, command: installed.command, env: installed.env, directory: { id, version: installed.version } };
      settings = { ...settings, agents: [...settings.agents, added] };
      db.saveSettings(settings);
      emit({ event: "settings", settings, agents: agentList(settings) });
      return settings;
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

    "providers.status": () =>
      providerStatus(settings, async (agentId) => {
        // An agent that opened a session before is signed in. Otherwise open one now, which also fills the model list.
        if (modelCache.has(agentId)) return { signedIn: true, methods: [] };
        try {
          modelCache.set(agentId, await listModels(agentId, settings, about.dataDir));
          return { signedIn: true, methods: [] };
        } catch (error) {
          if (error instanceof SignInNeeded) return { signedIn: false, methods: error.methods };
          return { signedIn: null, methods: [] };
        }
      }),

    async "agents.signIn"(params) {
      const agentId = text(params.agentId, "agent", 80);
      const methodId = text(params.methodId, "sign-in", 80);
      if (!agentList(settings).some((agent) => agent.id === agentId)) throw new Error("unknown agent");
      await signIn(agentId, settings, about.dataDir, methodId);
      modelCache.delete(agentId);
      return { ok: true };
    },
    "agents.openTerminal"(params) {
      const agentId = text(params.agentId, "agent", 80);
      const builtin = BUILTIN[agentId];
      // Only Arcex's own fixed commands for built-in agents, never text from the request.
      const command = params.purpose === "providers" ? builtin?.providers : params.purpose === "signIn" ? builtin?.signIn : params.purpose === "update" ? builtin?.release?.update : undefined;
      if (!command) throw new Error("that agent has nothing to open for that");
      openTerminal(command);
      // New accounts bring new models, so ask the agent again next time.
      modelCache.delete(agentId);
      return { ok: true };
    },
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

    async "terminal.open"(params) {
      if (!settings.terminal) throw new Error("turn on the terminal in Settings first");
      const project = projectOf(params.projectId);
      const size = (value: unknown, max: number) => (Number.isInteger(value) && (value as number) > 1 && (value as number) <= max ? (value as number) : 80);
      return terminals.start(project.id, project.cwd, size(params.cols, 500), Math.min(size(params.rows, 200), 200));
    },

    "terminal.write"(params) {
      if (typeof params.data !== "string" || params.data.length > 64 * 1024) throw new Error("that is too much to type at once");
      terminals.write(text(params.id, "terminal", 80), params.data);
      return { ok: true as const };
    },

    "terminal.resize"(params) {
      const ok = (value: unknown, max: number) => Number.isInteger(value) && (value as number) > 1 && (value as number) <= max;
      if (!ok(params.cols, 500) || !ok(params.rows, 200)) throw new Error("that terminal size isn't possible");
      terminals.resize(text(params.id, "terminal", 80), params.cols, params.rows);
      return { ok: true as const };
    },

    "terminal.close"(params) {
      terminals.close(text(params.id, "terminal", 80));
      return { ok: true as const };
    },

    "project.scripts"(params) {
      return processes.scripts(projectOf(params.projectId).cwd);
    },

    "agents.limits": () => {
      refreshCodexLimit(5 * 60_000);
      return Object.fromEntries(limits);
    },
    "memory.personal": () => personalMemory(),
    async "memory.savePersonal"(params) {
      await savePersonalMemory(text(params.agent, "agent", 40), params.text);
      return { ok: true as const };
    },
    "memory.notes": (params) => claudeNotes(projectOf(params.projectId).cwd),
    "project.publishState": (params) => publishState(projectOf(params.projectId).cwd),
    "project.branch": (params) => branchInfo(projectOf(params.projectId).cwd),
    async "project.push"(params) {
      const project = projectOf(params.projectId);
      if ([...threads.values()].some((thread) => thread.projectId === project.id && busyState(thread))) throw new Error("wait for the agents in this project to finish first");
      return push(project.cwd);
    },
    async "project.createPr"(params) {
      const project = projectOf(params.projectId);
      if ([...threads.values()].some((thread) => thread.projectId === project.id && busyState(thread))) throw new Error("wait for the agents in this project to finish first");
      return createPullRequest(project.cwd);
    },
    "project.pullRequests": (params) => listPullRequests(projectOf(params.projectId).cwd),
    async "project.checkoutPr"(params) {
      const project = projectOf(params.projectId);
      if ([...threads.values()].some((thread) => thread.projectId === project.id && busyState(thread))) throw new Error("wait for the agents in this project to finish first");
      return checkoutPullRequest(project.cwd, Number(params.number));
    },

    async "project.skills"(params) {
      const { cwd } = projectOf(params.projectId);
      const [skills, hooks] = await Promise.all([listSkills(cwd), listHooks(cwd, about.dataDir)]);
      return { skills, hooks };
    },

    async "project.toggleHook"(params) {
      const { cwd } = projectOf(params.projectId);
      return { hooks: await toggleHook(cwd, about.dataDir, text(params.id, "hook", 40), params.enabled === true) };
    },
    async "project.toggleSkill"(params) {
      const { cwd } = projectOf(params.projectId);
      return { skills: await toggleSkill(cwd, text(params.path, "skill", 1000), params.enabled === true) };
    },

    "process.run"(params) {
      const project = projectOf(params.projectId);
      return processes.run(project.id, project.cwd, text(params.script, "script", 80));
    },

    "process.stop"(params) {
      processes.stop(text(params.processId, "run", 80));
      return { ok: true as const };
    },

    "process.list"() {
      return processes.list();
    },

    "process.output"(params) {
      return { text: processes.output(text(params.processId, "run", 80)) };
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
      for (const thread of [...threads.values()].filter((t) => t.projectId === project.id)) {
        if (thread.worktree) void removeCopy(project.cwd, thread.worktree).catch(() => {});
        dropThread(thread);
      }
      processes.stopProject(project.id);
      terminals.closeProject(project.id);
      db.removeProject(project.id);
      projects.delete(project.id);
      if (settings.connectors.some((connector) => connector.scope === project.id)) {
        settings = { ...settings, connectors: settings.connectors.filter((connector) => connector.scope !== project.id) };
        db.saveSettings(settings);
        emit({ event: "settings", settings, agents: agentList(settings) });
      }
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

    async "project.instructions"(params) {
      const project = projectOf(params.projectId);
      return Promise.all(INSTRUCTION_FILES.map(async (name) => ({
        name,
        text: await readFile(path.join(project.cwd, name), "utf8").then((text) => text.slice(0, MAX_INSTRUCTIONS)).catch(() => null),
      })));
    },

    async "project.saveInstructions"(params) {
      const project = projectOf(params.projectId);
      const name = INSTRUCTION_FILES.find((file) => file === params.name);
      if (!name) throw new Error("that isn't an instructions file");
      if (typeof params.text !== "string" || params.text.length > MAX_INSTRUCTIONS) throw new Error("instructions can be at most 200,000 characters");
      const text = params.text.replace(/\r\n/g, "\n");
      await writeFile(path.join(project.cwd, name), text.endsWith("\n") || !text ? text : `${text}\n`, "utf8");
      const created: string[] = [];
      // Claude reads CLAUDE.md, not AGENTS.md. A one-line import makes it follow the same rules.
      if (name === "AGENTS.md" && !existsSync(path.join(project.cwd, "CLAUDE.md"))) {
        await writeFile(path.join(project.cwd, "CLAUDE.md"), "@AGENTS.md\n", { encoding: "utf8", flag: "wx" }).then(() => created.push("CLAUDE.md")).catch(() => {});
      }
      return { created };
    },

    "project.editors"() {
      return listEditors();
    },

    async "project.openIn"(params) {
      const project = projectOf(params.projectId);
      const editor = text(params.editor, "editor", 40);
      let target = project.cwd;
      if (params.path !== undefined) {
        if (typeof params.path !== "string" || params.path.length > 1000) throw new Error("pick a file");
        // Stay inside the project folder, also through links.
        const root = await realpath(project.cwd);
        const file = await realpath(path.resolve(project.cwd, params.path)).catch(() => null);
        if (!file || (file !== root && !file.startsWith(root + path.sep))) throw new Error("that file is outside the project or gone");
        target = file;
      }
      await openIn(editor, target, target !== project.cwd && statSync(target).isFile());
      return { ok: true as const };
    },

    async "project.readFile"(params) {
      const project = projectOf(params.projectId);
      if (typeof params.path !== "string" || !params.path || params.path.length > 1000) throw new Error("pick a file");
      // Stay inside the project folder, also through links.
      const root = await realpath(project.cwd);
      const file = await realpath(path.resolve(project.cwd, params.path)).catch(() => null);
      if (!file || (file !== root && !file.startsWith(root + path.sep))) throw new Error("that file is outside the project or gone");
      const stats = statSync(file);
      if (!stats.isFile()) throw new Error("that isn't a file");
      const relative = path.relative(root, file).split(path.sep).join("/");
      const LIMIT = 1024 * 1024;
      if (stats.size > LIMIT) return { path: relative, size: stats.size, tooLarge: true };
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(stats.size);
        const { bytesRead } = await handle.read(buffer, 0, stats.size, 0);
        const bytes = buffer.subarray(0, bytesRead);
        if (bytes.subarray(0, 8000).includes(0)) return { path: relative, size: stats.size, binary: true };
        return { path: relative, size: stats.size, text: bytes.toString("utf8") };
      } finally {
        await handle.close();
      }
    },

    "project.search"(params) {
      const project = projectOf(params.projectId);
      const query = typeof params.query === "string" ? params.query.slice(0, 200) : "";
      return searchFiles(project.cwd, query);
    },

    "project.changes": (params) => git.changes(projectOf(params.projectId).cwd),
    async "project.branchChanges"(params) {
      const { cwd } = projectOf(params.projectId);
      const { base } = await branchInfo(cwd);
      return base ? git.branchChanges(cwd, base) : [];
    },
    async "project.branchDiff"(params) {
      const { cwd } = projectOf(params.projectId);
      const { base } = await branchInfo(cwd);
      if (!base) throw new Error("this branch has nothing to compare with");
      return { text: await git.branchDiff(cwd, base, text(params.path, "path", 1000)) };
    },
    async "project.saveVersion"(params) {
      const project = projectOf(params.projectId);
      // A turn still writing could leave half its work in the version.
      if ([...threads.values()].some((thread) => thread.projectId === project.id && busyState(thread))) throw new Error("wait for the agents in this project to finish first");
      const message = typeof params.message === "string" && params.message.trim() ? params.message.trim().replace(/\s+/g, " ") : "Save a version";
      return git.saveVersion(project.cwd, message);
    },
    "project.versions": (params) => git.versions(projectOf(params.projectId).cwd),
    async "project.restoreVersion"(params) {
      const project = projectOf(params.projectId);
      if ([...threads.values()].some((thread) => thread.projectId === project.id && busyState(thread))) throw new Error("wait for the agents in this project to finish first");
      return git.restoreVersion(project.cwd, text(params.id, "version", 80), path.join(snapshotsDir, `${project.id}.restore.index`));
    },
    async "thread.undoTurn"(params) {
      const thread = threadOf(params.threadId);
      if (busyState(thread)) throw new Error("wait for this thread to finish before undoing a turn");
      const item = db.items(thread.id).find((entry) => entry.id === params.itemId);
      if (item?.kind !== "result" || !item.snapshots) throw new Error("that turn has no snapshot to undo from");
      const redo = params.redo === true;
      const wasUndone = new Set(item.undone === true ? item.files : Array.isArray(item.undone) ? item.undone : []);
      if (params.path !== undefined && (typeof params.path !== "string" || !item.files.includes(params.path))) throw new Error("that file didn't change in this turn");
      // Undo the files not yet undone; redo the ones that are.
      const wanted = (params.path ? [params.path] : item.files).filter((file) => wasUndone.has(file) === redo);
      if (!wanted.length) throw new Error(redo ? "nothing here to redo" : "that's already undone");
      const project = projectOf(thread.projectId);
      const scratch = path.join(snapshotsDir, `${thread.id}.undo.index`);
      const result = await git.undoTurn(where(thread, project), item.snapshots.before, item.snapshots.after, wanted, scratch, params.force === true, redo);
      if (!result.undone.length) return result;
      if (!threads.has(thread.id)) throw new Error("thread not found");
      for (const file of result.undone) redo ? wasUndone.delete(file) : wasUndone.add(file);
      put(thread, { ...item, undone: [...wasUndone] });
      const which = result.undone.length === 1 ? result.undone[0] : `${result.undone.length} files`;
      put(thread, { id: randomUUID(), kind: "note", text: redo ? `Redid this turn's changes to ${which}.` : `Undid this turn's changes to ${which}.` });
      // The agent doesn't see the folder change, so the next message tells it.
      const list = result.undone.join(", ").slice(0, 2000);
      liveOf(thread.id).undoNote = [
        liveOf(thread.id).undoNote,
        redo ? `(Note from Arcex: the user put back your changes to ${list}.)` : `(Note from Arcex: the user undid your changes to ${list}. Those files are back the way they were before that turn.)`,
      ].filter(Boolean).join(" ").slice(0, 4000);
      return result;
    },
    async "thread.rewind"(params) {
      const thread = threadOf(params.threadId);
      if (busyState(thread)) throw new Error("wait for this thread to finish before rewinding");
      const items = db.items(thread.id);
      const at = items.findIndex((entry) => entry.id === params.itemId);
      const message = items[at];
      if (message?.kind !== "user") throw new Error("pick one of your messages to rewind to");
      const kept = items.slice(0, at);
      const later = items.slice(at);
      // Each file goes back to how it was before the earliest rewound turn touched it, and must still look the way
      // the latest turn left it (or as an undo left it).
      const plan = new Map<string, { path: string; from: string; expect: string }>();
      for (const entry of later) {
        if (entry.kind !== "result" || !entry.snapshots) continue;
        const undone = new Set(entry.undone === true ? entry.files : Array.isArray(entry.undone) ? entry.undone : []);
        for (const file of entry.files) {
          const expect = undone.has(file) ? entry.snapshots.before : entry.snapshots.after;
          const known = plan.get(file);
          plan.set(file, { path: file, from: known?.from ?? entry.snapshots.before, expect });
        }
      }
      const project = projectOf(thread.projectId);
      const result = plan.size
        ? await git.rewindFiles(where(thread, project), [...plan.values()], path.join(snapshotsDir, `${thread.id}.undo.index`), params.force === true)
        : { restored: [], changedSince: [] };
      if (result.changedSince.length && !result.restored.length) return result;
      if (!threads.has(thread.id) || busyState(thread)) throw new Error("this thread changed while rewinding");
      db.dropItemsFrom(thread.id, message.id);
      const live = liveOf(thread.id);
      closeSession(live);
      live.undoNote = undefined;
      // ACP can't trim an agent's memory, so the next message starts a fresh session that gets a short recap instead.
      const recap = kept
        .map((entry) => entry.kind === "user" ? `User: ${entry.text}` : entry.kind === "say" ? `You: ${entry.text}` : "")
        .filter(Boolean)
        .join("\n\n");
      thread.carry = recap
        ? `(Note from Arcex: the user rewound this conversation, so you are starting fresh. Here is the conversation so far, most recent last. The project files are back the way they were at this point.)\n\n${recap.length > 12000 ? `…${recap.slice(-12000)}` : recap}`
        : null;
      thread.sessionId = null;
      thread.context = undefined;
      thread.queued = [];
      db.saveThread(thread);
      setState(thread, "idle");
      emit({ event: "items", threadId: thread.id, items: kept });
      return { ...result, text: message.text, ...(message.attachments?.length ? { attachments: message.attachments } : {}) };
    },
    async "thread.turnDiff"(params) {
      const thread = threadOf(params.threadId);
      if (typeof params.path !== "string" || !params.path || params.path.length > 1000) throw new Error("invalid file path");
      const item = db.items(thread.id).find((entry) => entry.id === params.itemId);
      if (item?.kind !== "result" || !item.snapshots) throw new Error("that turn has no snapshot");
      return { text: await git.turnDiff(where(thread, projectOf(thread.projectId)), item.snapshots.before, item.snapshots.after, params.path) };
    },
    "project.diff": async (params) => {
      if (typeof params.path !== "string" || !params.path || params.path.length > 1000) throw new Error("invalid file path");
      return { text: await git.diff(projectOf(params.projectId).cwd, params.path) };
    },

    async "thread.create"(params) {
      const project = projectOf(params.projectId);
      if (!agentList(settings).some((agent) => agent.id === params.provider)) throw new Error("unknown agent");
      const model = pickedModel(params.model);
      const choices = pickedChoices(params.choices);
      const attached = files.resolve(params.attachments);
      const prompt = message(params.text, attached);
      const now = Date.now();
      const thread: ThreadRow = {
        id: randomUUID(), projectId: project.id, provider: params.provider, model, choices, queued: [], title: prompt ? titleFrom(prompt) : attached[0]!.name.slice(0, 60),
        state: "starting", archived: false, pinned: false, folders: [], sessionId: null, worktree: null, carry: null, createdAt: now, updatedAt: now,
      };
      // A separate copy is made before the thread exists, so a failure leaves nothing behind.
      if (params.separate === true) thread.worktree = await createCopy(project.cwd, path.join(about.dataDir, "copies", thread.id), thread.id);
      if (typeof params.parentId === "string") {
        const parent = threadOf(params.parentId);
        if (parent.projectId !== project.id) throw new Error("a side thread must be in the same project");
        thread.parentId = parent.id;
      }
      db.insertThread(thread);
      if (thread.worktree || thread.parentId) db.saveThread(thread);
      threads.set(thread.id, thread);
      void run(thread, prompt, attached);
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
        if (session) await applyChoices(thread, session, wanted, false);
        if (!threads.has(thread.id)) throw new Error("thread not found");
        // applyChoices already wrote the mode it really used (full access or plan) into the thread.
        const modeId = session?.choices.find((entry) => entry.category === "mode")?.id;
        thread.choices = { ...thread.choices, ...wanted, ...(modeId && thread.choices[modeId] ? { [modeId]: thread.choices[modeId]! } : {}) };
      }
      if (params.title !== undefined) {
        thread.title = title;
        thread.named = true;
      }
      if (params.archived !== undefined) thread.archived = params.archived === true;
      if (params.pinned !== undefined) thread.pinned = params.pinned === true;
      if (params.folders !== undefined) {
        const folders = foldersFrom(params.folders, projectOf(thread.projectId).cwd);
        if (folders.join("|") !== thread.folders.join("|")) {
          thread.folders = folders;
          // The agent learns its folders when its session opens, so an idle one reopens with them on the next message.
          // A running turn keeps its folders until it ends; the next message after that picks up the change.
          const live = lives.get(thread.id);
          if (live?.session && !live.turn) closeSession(live);
          else if (live?.session) live.reopen = true;
        }
      }
      db.saveThread(thread);
      emit({ event: "thread", thread: publicThread(thread) });
      return publicThread(thread);
    },

    "thread.remove"(params) {
      const thread = threadOf(params.threadId);
      if (thread.worktree) void removeCopy(projectOf(thread.projectId).cwd, thread.worktree).catch(() => {});
      dropThread(thread);
      db.removeThread(thread.id);
      emit({ event: "gone", kind: "thread", id: thread.id });
      return { ok: true };
    },

    "thread.search"(params) {
      const query = text(params.query, "search", 200).trim();
      if (query.length < 2) return [];
      const found = new Map<string, string>();
      for (const row of db.searchItems(query, 400)) {
        if (found.has(row.threadId) || !threads.has(row.threadId)) continue;
        // A short window around the first match, on one line.
        const at = row.text.toLowerCase().indexOf(query.toLowerCase());
        const start = Math.max(0, at - 40);
        const snippet = `${start > 0 ? "…" : ""}${row.text.slice(start, at + query.length + 60).replace(/\s+/g, " ").trim()}${at + query.length + 60 < row.text.length ? "…" : ""}`;
        found.set(row.threadId, snippet);
        if (found.size >= 30) break;
      }
      return [...found].map(([threadId, snippet]) => ({ threadId, snippet }));
    },

    "thread.items"(params) {
      const thread = threadOf(params.threadId);
      const items = db.items(thread.id);
      const reply = lives.get(thread.id)?.say;
      return reply ? [...items, reply] : items;
    },

    async "thread.aside"(params) {
      const thread = threadOf(params.threadId);
      const question = text(params.text, "question", 4_000).trim();
      if (!question) throw new Error("write a question first");
      if (!thread.sessionId) throw new Error("send the thread's first message before asking aside");
      for (const [id, aside] of asides) if (aside.threadId === thread.id) stopAside(id);
      const project = projectOf(thread.projectId);
      const asideId = randomUUID();
      const stop = new AbortController();
      const entry: { threadId: string; session: AgentSession | null; stop: AbortController } = { threadId: thread.id, session: null, stop };
      asides.set(asideId, entry);
      let answer = "";
      const send = (state: "working" | "done" | "failed", error?: string) =>
        emit({ event: "aside", threadId: thread.id, asideId, text: answer, state, ...(error ? { error } : {}) });
      send("working");
      void (async () => {
        try {
          const prompt = `(A side question from the user. Answer it briefly from what you already know about this conversation and project. Don't change any files or start new work; this answer won't be part of the main thread.)

${question}`;
          await askFork(thread, project, prompt, stop, (text) => {
            answer = text;
            send("working");
          }, (session) => (entry.session = session));
          if (!stop.signal.aborted) send("done");
        } catch (error) {
          if (!stop.signal.aborted) send("failed", error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300));
        } finally {
          asides.delete(asideId);
        }
      })();
      return { asideId };
    },

    async "thread.stopTask"(params) {
      const thread = threadOf(params.threadId);
      const live = lives.get(thread.id);
      const task = live?.tasks?.get(String(params.taskId));
      if (!task || task.state !== "running") return { ok: true as const };
      if (!live?.session || !task.canStop) throw new Error("this background task can't be stopped from Arcex");
      await live.session.stopTask(task.id);
      return { ok: true as const };
    },

    async "thread.side"(params) {
      const parent = threadOf(params.threadId);
      const card = typeof params.itemId === "string" ? db.items(parent.id).find((entry) => entry.id === params.itemId) : undefined;
      if (params.itemId !== undefined && (card?.kind !== "suggest" || card.dismissed)) throw new Error("that suggestion is gone");
      if (card?.kind === "suggest" && card.started) return publicThread(threadOf(card.started));
      const words = card?.kind === "suggest" ? card.prompt : text(params.text, "message", 20000);
      const start = { projectId: parent.projectId, provider: parent.provider, model: parent.model, choices: parent.choices, text: words, parentId: parent.id };
      // Side work goes in its own copy so it can't collide with the parent. A project with no saved version yet can't
      // have one, so then it shares the project folder.
      let note = "";
      const child = await Promise.resolve().then(() => handlers["thread.create"]({ ...start, separate: true })).catch(async (error: unknown) => {
        if (!/save a version/.test(String(error))) throw error;
        note = "This side thread works in the project folder, beside its parent, because the project has no saved version to copy yet.";
        return handlers["thread.create"](start);
      });
      const row = threadOf(child.id);
      if (card?.kind === "suggest") {
        row.title = card.title;
        db.saveThread(row);
        put(parent, { ...card, started: row.id });
      }
      put(row, { id: randomUUID(), kind: "note", text: note || `A side thread of “${parent.title}”.` });
      emit({ event: "thread", thread: publicThread(row) });
      return publicThread(row);
    },
    "thread.dismissSuggestion"(params) {
      const thread = threadOf(params.threadId);
      const card = db.items(thread.id).find((entry) => entry.id === params.itemId);
      if (card?.kind === "suggest" && !card.started) put(thread, { ...card, dismissed: true });
      return { ok: true as const };
    },
    async "thread.copyChanges"(params) {
      const thread = threadOf(params.threadId);
      return thread.worktree ? copyChanges(thread.worktree) : [];
    },
    async "thread.copyDiff"(params) {
      const thread = threadOf(params.threadId);
      if (!thread.worktree) throw new Error("this thread has no separate copy");
      return { text: await copyDiff(thread.worktree, text(params.path, "path", 1000)) };
    },
    async "thread.bringIn"(params) {
      const thread = threadOf(params.threadId);
      if (!thread.worktree) throw new Error("this thread has no separate copy");
      if (busyState(thread)) throw new Error("wait for this thread to finish before bringing its changes in");
      const project = projectOf(thread.projectId);
      const result = await bringIn(project.cwd, thread.worktree);
      await leaveCopy(thread, project, result.files.length
        ? `Brought ${result.files.length === 1 ? "1 changed file" : `${result.files.length} changed files`} into the project folder as unsaved changes.${result.overlaps.length ? ` ${result.overlaps.join(", ")} also changed in the project folder meanwhile, so both versions are marked in ${result.overlaps.length === 1 ? "it" : "them"}.` : ""} This thread now works in the project folder.`
        : "The separate copy had no changes to bring in. This thread now works in the project folder.", "brought into the project folder");
      return result;
    },
    async "thread.discardCopy"(params) {
      const thread = threadOf(params.threadId);
      if (!thread.worktree) return { ok: true as const };
      if (busyState(thread)) throw new Error("wait for this thread to finish first");
      await leaveCopy(thread, projectOf(thread.projectId), "Discarded the separate copy and its changes. This thread now works in the project folder.", "discarded");
      return { ok: true as const };
    },

    "thread.asideStop"(params) {
      stopAside(String(params.asideId));
      return { ok: true as const };
    },

    async "thread.prompt"(params) {
      const thread = threadOf(params.threadId);
      const live = lives.get(thread.id);
      const session = live?.session;
      // Steering adds the message to the turn under way, the way typing into a running Claude Code or Codex session does.
      if (params.steer === true && session?.steering && live?.turn && !live.turn.signal.aborted && (thread.state === "working" || thread.state === "needs_you")) {
        const attached = files.resolve(params.attachments);
        const text = message(params.text, attached);
        const project = projectOf(thread.projectId);
        const outcome = await session.steer([...files.blocks(text, attached, session.promptCapabilities), ...mentionLinks(where(thread, project), text, session.promptCapabilities)]).catch(() => "later" as const);
        if (outcome === "steered" && lives.get(thread.id)?.session === session) {
          // The reply so far ends here, so what the agent says next shows after the new message.
          endSay(thread);
          put(thread, attached.length ? { id: randomUUID(), kind: "user", text, attachments: attached } : { id: randomUUID(), kind: "user", text });
          db.clearSentDraft(thread.projectId, thread.id, params.text);
          return { ok: true, steered: true };
        }
      }
      if (busyState(thread) && (params.queue === true || params.steer === true)) {
        if (thread.queued.length >= 10) throw new Error("ten messages are already waiting. Remove one first");
        const attached = files.resolve(params.attachments);
        thread.queued = [...thread.queued, { text: message(params.text, attached), attachments: attached }];
        db.saveThread(thread);
        db.clearSentDraft(thread.projectId, thread.id, params.text);
        emit({ event: "thread", thread: publicThread(thread) });
        return { ok: true, queued: true };
      }
      if (busyState(thread)) throw new Error("this thread is still working");
      if (changingModels.has(thread.id)) throw new Error("wait for the model to finish switching");
      const attached = files.resolve(params.attachments);
      void run(thread, message(params.text, attached), attached);
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
      return removed;
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

    "attachment.add": (params) => files.add(params),

    "ask.answer"(params) {
      const thread = threadOf(params.threadId);
      const pending = liveOf(thread.id).asks.get(String(params.itemId));
      if (!pending) throw new Error("that request is no longer waiting");
      const option = params.optionId === null ? null : pending.item.options.find((o) => o.id === params.optionId);
      if (option === undefined) throw new Error("unknown choice");
      liveOf(thread.id).asks.delete(pending.item.id);
      pending.item.answer = option ? option.name : "Not now";
      put(thread, pending.item);
      setState(thread, waiting(thread.id) ? "needs_you" : "working");
      pending.resolve({ outcome: option ? { outcome: "selected", optionId: option.id } : { outcome: "cancelled" } });
      return { ok: true };
    },

    "question.answer"(params) {
      const thread = threadOf(params.threadId);
      const live = liveOf(thread.id);
      const pending = live.questions.get(String(params.itemId));
      if (!pending) throw new Error("that question is no longer waiting");
      const answers = params.answers && typeof params.answers === "object" && !Array.isArray(params.answers) ? params.answers : null;
      const content = answers ? contentOf(pending.schema, answers) : null;
      live.questions.delete(pending.item.id);
      pending.item.answer = content && Object.keys(content).length ? summaryOf(pending.item.questions, content) : "Skipped";
      put(thread, pending.item);
      setState(thread, waiting(thread.id) ? "needs_you" : "working");
      // Skipping declines the form: Claude reads that as "the user skipped" and carries on.
      pending.resolve(content && Object.keys(content).length ? { action: "accept", content } : { action: "decline" });
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
    suggest,
    runSchedule: (id: string) => runSchedule(id),
    /** True while any thread is working or a wrap-up is being written; a scheduled run waits for this before exiting. */
    busy: () => [...threads.values()].some(busyState) || wrapping.size > 0,
    /** An agent's icon from the directory, as SVG text, or null. */
    agentIcon: (id: string) => directory.icon(id),
    /** A stored image for a thumbnail, or null. */
    attachmentImage: (id: string) => files.image(id),
    handle: (method: string, params: unknown): Promise<unknown> => {
      const handler = (handlers as Record<string, ((params: never) => unknown) | undefined>)[method];
      if (!Object.hasOwn(handlers, method) || !handler) return Promise.reject(new Error("unknown request"));
      return Promise.resolve().then(() => handler((params ?? {}) as never));
    },
    close() {
      clearInterval(scheduleClock);
      speech.close();
      processes.close();
      terminals.closeAll();
      for (const live of lives.values()) {
        clearTimeout(live.stopTimer);
        live.turn?.abort();
        closeSession(live);
      }
    },
  };
}
