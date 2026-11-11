// The boundary between the Arcex engine and every client (desktop now; web and mobile later).
// Types only. The engine validates what it receives.

export type ProviderId = "claude" | "codex";

export type Project = {
  id: string;
  name: string;
  /** What the user said they are building, in their words. */
  goal: string;
  cwd: string;
  previewUrl: string | null;
  createdAt: number;
};

/** `needs_you` means an agent is waiting on an approval. */
export type ThreadState = "idle" | "starting" | "working" | "needs_you" | "failed";

export type Thread = {
  id: string;
  projectId: string;
  provider: ProviderId;
  title: string;
  state: ThreadState;
  createdAt: number;
  updatedAt: number;
};

export type AskOption = { id: string; name: string; kind: string };

/** One entry in a thread's timeline. Items are upserted by id, so a step or a reply can grow in place. */
export type Item =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "say"; text: string }
  | {
      id: string;
      kind: "step";
      /** Plain-language description for the main view. */
      label: string;
      /** What the agent actually ran or touched, for the under-the-hood view. */
      detail: string;
      status: "running" | "done" | "failed";
      files: string[];
    }
  | { id: string; kind: "ask"; title: string; detail: string; options: AskOption[]; answer: string | null }
  | { id: string; kind: "error"; text: string };

export type Change = { path: string; status: "added" | "changed" | "removed"; added: number; removed: number };

/** Client to engine. Every request gets exactly one response with the same id. */
export type Requests = {
  "state.get": { params: Record<string, never>; result: { providers: ProviderId[]; projects: Project[]; threads: Thread[] } };
  "project.create": { params: { goal: string; cwd?: string }; result: Project };
  "project.setPreview": { params: { projectId: string; url: string | null }; result: Project };
  "project.changes": { params: { projectId: string }; result: Change[] };
  "project.diff": { params: { projectId: string; path: string }; result: { text: string } };
  "thread.create": { params: { projectId: string; provider: ProviderId; text: string }; result: Thread };
  "thread.items": { params: { threadId: string }; result: Item[] };
  "thread.prompt": { params: { threadId: string; text: string }; result: { ok: true } };
  "thread.cancel": { params: { threadId: string }; result: { ok: true } };
  "ask.answer": { params: { threadId: string; itemId: string; optionId: string | null }; result: { ok: true } };
};

export type Method = keyof Requests;
export type RequestMessage = { [M in Method]: { id: number; method: M; params: Requests[M]["params"] } }[Method];
export type ResponseMessage = { id: number; result: unknown } | { id: number; error: string };

/** Engine to client, unprompted. */
export type EventMessage =
  | { event: "project"; project: Project }
  | { event: "thread"; thread: Thread }
  | { event: "item"; threadId: string; item: Item };
