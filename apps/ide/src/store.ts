import { useSyncExternalStore } from "react";
import type { ProcessInfo, About, Agent, DraftTarget, EventMessage, Item, Method, Project, Requests, ResponseMessage, Settings, SlashCommand, SpeechState, Thread, UsageLimit } from "@arcex/contracts";

export type State = {
  /** "reconnecting" keeps the workspace on screen while the engine comes back; "lost" means it hasn't for a while. */
  status: "connecting" | "ready" | "reconnecting" | "lost";
  agents: Agent[];
  projects: Project[];
  threads: Thread[];
  settings: Settings | null;
  about: About | null;
  drafts: Record<string, string>;
  /** Timelines that have been loaded. Live items for other threads are ignored until they are loaded. */
  items: Record<string, Item[]>;
  /** The last time an agent used a project's browser, so the Browser tab can be shown. */
  browse: { projectId: string; at: number } | null;
  /** Voice dictation's model, once the client has asked about it. */
  speech: SpeechState | null;
  /** Slash commands an agent reported during a thread, newer than the list read when it was first asked. */
  commands: Record<string, SlashCommand[]>;
  /** Runs of project scripts, by run id. */
  processes: Record<string, ProcessInfo>;
  /** Plan limits agents reported, by agent id. */
  limits: Record<string, UsageLimit>;
};

let state: State = { status: "connecting", agents: [], projects: [], threads: [], settings: null, about: null, items: {}, drafts: {}, browse: null, speech: null, commands: {}, processes: {}, limits: {} };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

/** Terminal output goes straight to whoever shows it, not through the app's state. */
const terminalListeners = new Set<(message: { id: string; data?: string; exit?: number }) => void>();
export function onTerminal(listener: (message: { id: string; data?: string; exit?: number }) => void): () => void {
  terminalListeners.add(listener);
  return () => terminalListeners.delete(listener);
}

export const useStore = () =>
  useSyncExternalStore((listener) => (listeners.add(listener), () => listeners.delete(listener)), () => state);

// The engine serves the built client itself. In development the client runs on Vite and the engine on its default port.
const address = import.meta.env.DEV ? "ws://127.0.0.1:4517" : `ws://${location.host}`;
let socket: WebSocket | undefined;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const unsavedDrafts = new Map<string, DraftTarget & { text: string }>();
let nextId = 1;

export function call<M extends Method>(method: M, params: Requests[M]["params"]): Promise<Requests[M]["result"]> {
  return new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) return reject(new Error("Arcex is disconnected. Reconnect and try again."));
    const id = nextId++;
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

const upsert = <T extends { id: string }>(list: T[], value: T) =>
  list.some((entry) => entry.id === value.id) ? list.map((entry) => (entry.id === value.id ? value : entry)) : [...list, value];

// A dropped connection is retried on its own, quickly at first and then every few seconds, for as long as the app is open.
// The workspace stays on screen meanwhile. Only after a while does the user see that something is wrong.
let attempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let droppedAt = 0;
const SHOW_PROBLEM_AFTER = 8000;

function scheduleRetry() {
  clearTimeout(retryTimer);
  const delay = Math.min(250 * 2 ** attempts, 4000);
  attempts++;
  retryTimer = setTimeout(() => void retry(), delay);
}

async function retry() {
  try {
    // In the desktop app this restarts the engine if it has stopped.
    await window.arcex?.ensureEngine();
  } catch {
    // Keep trying; the socket attempt below decides what happens next.
  }
  connect();
}

function connect() {
  clearTimeout(retryTimer);
  const connection = new WebSocket(address);
  socket = connection;
  if (state.status === "ready" || state.status === "connecting") set({ status: state.settings ? "reconnecting" : "connecting" });
  const timeout = setTimeout(() => connection.close(), 8000);
  connection.onopen = async () => {
    try {
      const snapshot = await call("state.get", {});
      if (connection !== socket || connection.readyState !== WebSocket.OPEN) return;
      const drafts = { ...snapshot.drafts };
      for (const [key, draft] of unsavedDrafts) drafts[key] = draft.text;
      attempts = 0;
      droppedAt = 0;
      const runs = await call("process.list", {}).catch(() => []);
      const limits = await call("agents.limits", {}).catch(() => ({}));
      set({ ...snapshot, status: "ready", drafts, items: {}, processes: Object.fromEntries(runs.map((run) => [run.id, run])), limits });
      for (const key of unsavedDrafts.keys()) void persistDraft(key);
    } catch {
      connection.close();
    } finally {
      clearTimeout(timeout);
    }
  };
  connection.onclose = () => {
    clearTimeout(timeout);
    if (connection !== socket) return;
    for (const request of pending.values()) request.reject(new Error("Arcex is reconnecting. Try again in a moment."));
    pending.clear();
    droppedAt ||= Date.now();
    const waited = Date.now() - droppedAt;
    set({ status: waited > SHOW_PROBLEM_AFTER ? "lost" : state.settings ? "reconnecting" : "connecting" });
    scheduleRetry();
  };
  connection.onmessage = receive;
}

/** Try again now instead of waiting for the next automatic attempt. */
export async function reconnect() {
  if (state.status === "ready" || socket?.readyState === WebSocket.CONNECTING) return;
  attempts = 0;
  await retry();
}

// Coming back to the window, or the network returning, is a good moment to try straight away.
for (const signal of ["focus", "online"] as const) window.addEventListener(signal, () => void reconnect());

function receive({ data }: MessageEvent) {
  const message = JSON.parse(data as string) as ResponseMessage | EventMessage;
  if (!("event" in message)) {
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    if ("error" in message) waiting?.reject(new Error(message.error));
    else waiting?.resolve(message.result);
  } else if (message.event === "project") set({ projects: upsert(state.projects, message.project) });
  else if (message.event === "thread") {
    const known = state.threads.some((thread) => thread.id === message.thread.id);
    set({
      threads: upsert(state.threads, message.thread),
      items: known ? state.items : { ...state.items, [message.thread.id]: [] },
    });
  }
  else if (message.event === "speech") set({ speech: message.speech });
  else if (message.event === "terminal") for (const listener of terminalListeners) listener({ id: message.id, data: message.data });
  else if (message.event === "terminalExit") for (const listener of terminalListeners) listener({ id: message.id, exit: message.code });
  else if (message.event === "process") set({ processes: { ...state.processes, [message.process.id]: message.process } });
  else if (message.event === "limit") set({ limits: { ...state.limits, [message.agentId]: message.limit } });
  else if (message.event === "commands") set({ commands: { ...state.commands, [message.agentId]: message.commands } });
  else if (message.event === "browse") set({ browse: { projectId: message.projectId, at: Date.now() } });
  else if (message.event === "settings") set({ settings: message.settings, agents: message.agents });
  else if (message.event === "gone") {
    if (message.kind === "thread") set({ threads: state.threads.filter((t) => t.id !== message.id) });
    else set({ projects: state.projects.filter((p) => p.id !== message.id), threads: state.threads.filter((t) => t.projectId !== message.id) });
  } else if (message.event === "items") {
    if (state.items[message.threadId]) set({ items: { ...state.items, [message.threadId]: message.items } });
    if (loading.has(message.threadId)) loading.set(message.threadId, message.items);
  } else if (message.event === "item") {
    const loaded = state.items[message.threadId];
    if (loaded) set({ items: { ...state.items, [message.threadId]: upsert(loaded, message.item) } });
    const incoming = loading.get(message.threadId);
    if (incoming) loading.set(message.threadId, upsert(incoming, message.item));
  }
}

const loading = new Map<string, Item[]>();
export async function loadItems(threadId: string) {
  if (state.status !== "ready" || state.items[threadId] || loading.has(threadId)) return;
  loading.set(threadId, []);
  try {
    const items = await call("thread.items", { threadId });
    const live = loading.get(threadId) ?? [];
    set({ items: { ...state.items, [threadId]: live.reduce(upsert, items) } });
  } finally {
    loading.delete(threadId);
  }
}

async function persistDraft(key: string) {
  const draft = unsavedDrafts.get(key);
  if (!draft || state.status !== "ready") return;
  try {
    await call("draft.set", draft);
    if (unsavedDrafts.get(key) === draft) unsavedDrafts.delete(key);
  } catch {
    // Keep the latest draft in memory and sync it when the connection is restored.
  }
}

export function saveDraft(target: DraftTarget, value: string) {
  const key = target.threadId ?? target.projectId;
  if ((state.drafts[key] ?? "") === value) return;
  unsavedDrafts.set(key, { ...target, text: value });
  set({ drafts: { ...state.drafts, [key]: value } });
  void persistDraft(key);
}

export function clearSentDraft(target: DraftTarget, sent: string) {
  const key = target.threadId ?? target.projectId;
  if (state.drafts[key] !== sent) return;
  unsavedDrafts.delete(key);
  set({ drafts: { ...state.drafts, [key]: "" } });
}

connect();
