import { useSyncExternalStore } from "react";
import type { EventMessage, Item, Method, Project, ProviderId, Requests, ResponseMessage, Thread } from "@arcex/contracts";

export type State = {
  status: "connecting" | "ready" | "lost";
  providers: ProviderId[];
  projects: Project[];
  threads: Thread[];
  /** Timelines that have been loaded. Live items for other threads are ignored until they are loaded. */
  items: Record<string, Item[]>;
};

let state: State = { status: "connecting", providers: [], projects: [], threads: [], items: {} };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

export const useStore = () =>
  useSyncExternalStore((listener) => (listeners.add(listener), () => listeners.delete(listener)), () => state);

// The engine serves the built client itself. In development the client runs on Vite and the engine on its default port.
const socket = new WebSocket(import.meta.env.DEV ? "ws://127.0.0.1:4517" : `ws://${location.host}`);
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let nextId = 1;

export function call<M extends Method>(method: M, params: Requests[M]["params"]): Promise<Requests[M]["result"]> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const upsert = <T extends { id: string }>(list: T[], value: T) =>
  list.some((entry) => entry.id === value.id) ? list.map((entry) => (entry.id === value.id ? value : entry)) : [...list, value];

socket.onopen = async () => set({ status: "ready", ...(await call("state.get", {})) });
socket.onclose = () => set({ status: "lost" });
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data as string) as ResponseMessage | EventMessage;
  if ("id" in message) {
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    if ("error" in message) waiting?.reject(new Error(message.error));
    else waiting?.resolve(message.result);
  } else if (message.event === "project") set({ projects: upsert(state.projects, message.project) });
  else if (message.event === "thread") set({ threads: upsert(state.threads, message.thread) });
  else if (message.event === "item") {
    const loaded = state.items[message.threadId];
    if (loaded) set({ items: { ...state.items, [message.threadId]: upsert(loaded, message.item) } });
  }
};

const loading = new Set<string>();
export async function loadItems(threadId: string) {
  if (state.items[threadId] || loading.has(threadId)) return;
  loading.add(threadId);
  const items = await call("thread.items", { threadId });
  // Keep anything that streamed in while the saved timeline was loading.
  const live = state.items[threadId] ?? [];
  set({ items: { ...state.items, [threadId]: live.reduce(upsert, items) } });
  loading.delete(threadId);
}

/** A new thread's timeline starts empty, so live items can be accepted straight away. */
export function openEmpty(threadId: string) {
  if (!state.items[threadId]) set({ items: { ...state.items, [threadId]: [] } });
}
