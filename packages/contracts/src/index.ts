// The boundary between the Arcex engine and every client (desktop now; web and mobile later).
// Types only. The engine validates what it receives.

/** An agent's id: "claude", "codex", "opencode", "gemini", or one the user added. */
export type ProviderId = string;

/** A coding agent Arcex can start. Every agent speaks the Agent Client Protocol. */
export type Agent = { id: string; name: string; builtin: boolean; /** The command that starts it, when it is not shipped with Arcex. */ command: string | null };

/** One model an agent offers, as the agent itself describes it. */
export type ModelOption = { value: string; name: string; description: string };

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
export type ThreadState = "idle" | "starting" | "working" | "needs_you" | "stopping" | "stopped" | "interrupted" | "failed";

export type Thread = {
  id: string;
  projectId: string;
  provider: ProviderId;
  /** The model picked for this thread. Null means the agent's own default. */
  model: { value: string; name: string } | null;
  title: string;
  state: ThreadState;
  /** Archived threads are hidden from the sidebar and the board but keep their history. */
  archived: boolean;
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
      status: "running" | "done" | "failed" | "interrupted";
      files: string[];
      /** What sort of tool it was (execute, edit, read, search, fetch, browser...), for grouping. Older steps lack it. */
      tool?: string;
      /** Lines added and removed, for edits. */
      added?: number;
      removed?: number;
      /** The changed lines of an edit, each starting with "+" or "-". Bounded. */
      patch?: string;
      /** The end of what a command printed. Bounded. */
      output?: string;
    }
  /** The agent's reasoning before it acts. `seconds` is set once it stops thinking. */
  | { id: string; kind: "think"; text: string; seconds: number | null }
  /** The agent's own plan for the turn, kept up to date as it works. */
  | { id: string; kind: "plan"; entries: PlanEntry[] }
  | { id: string; kind: "ask"; title: string; detail: string; options: AskOption[]; answer: string | null }
  | { id: string; kind: "error"; text: string }
  /** Closes a turn that changed files. Paths are relative to the project folder. */
  | { id: string; kind: "result"; files: string[] }
  /** Closes every turn: how it ended and how long it took. */
  | { id: string; kind: "end"; outcome: "done" | "stopped" | "failed" | "interrupted"; seconds: number };

export type PlanEntry = { content: string; status: "pending" | "in_progress" | "completed" };

/** One entry in a project folder. */
export type FileEntry = { name: string; kind: "folder" | "file" };

export type Change = { path: string; status: "added" | "changed" | "removed"; added: number; removed: number };

/** One entry in the curated toolbox. No prices: they change too often to be trusted. */
export type Tool = { id: string; name: string; category: string; what: string; goodFor: string; tradeoffs: string; url: string };

/** Preferences saved by the engine, so every client of the same engine agrees. */
export type Settings = {
  /** The local name used in the workspace. */
  name: string;
  theme: "light" | "dark" | "system";
  defaultProvider: ProviderId;
  /** The model new threads start with, for the default agent. Null means the agent's own default. */
  defaultModel: { value: string; name: string } | null;
  /** Agents the user added: a name and the command that starts it in ACP mode. */
  agents: { id: string; name: string; command: string }[];
  sendWith: "enter" | "ctrl-enter";
  /** Open the details panel when the app starts. */
  showDetails: boolean;
  /** Tell the user when a thread finishes or needs them while the window is in the background. */
  notify: boolean;
  /** Let agents search the Arcex research library of real products. */
  research: boolean;
};

/** Whether an agent's own command-line tool is installed and signed in on this computer. */
export type ProviderStatus = {
  id: ProviderId;
  name: string;
  installed: boolean;
  /** Null when the tool is installed but did not say. */
  signedIn: boolean | null;
  version: string | null;
  /** The command the user runs in a terminal to sign in. Arcex never handles the sign-in itself. */
  signInCommand: string;
};

export type About = { version: string; dataDir: string; projectsDir: string };

export type DraftTarget = { projectId: string; threadId?: string };
export type DesktopAccount = { id: string; name: string; handle: string; pro: boolean; expiresAt: string; devicesUrl: string };
export type DesktopLink = { code: string; verificationUrl: string; expiresAt: string; interval: number };

/** Client to engine. Every request gets exactly one response with the same id. */
export type Requests = {
  "account.status": { params: Record<string, never>; result: { account: DesktopAccount | null; link?: DesktopLink } };
  "account.start": { params: Record<string, never>; result: DesktopLink };
  "account.finish": { params: Record<string, never>; result: { account: DesktopAccount | null } };
  "account.disconnect": { params: Record<string, never>; result: { ok: true } };
  "state.get": { params: Record<string, never>; result: { agents: Agent[]; projects: Project[]; threads: Thread[]; settings: Settings; about: About; drafts: Record<string, string> } };
  "draft.set": { params: DraftTarget & { text: string }; result: { ok: true } };
  "settings.set": { params: Partial<Settings>; result: Settings };
  "providers.status": { params: Record<string, never>; result: ProviderStatus[] };
  /** The models an agent offers. Reading them starts the agent briefly but sends no message. */
  "agents.models": { params: { agentId: string; refresh?: boolean }; result: { options: ModelOption[]; current: string | null } };
  "agents.add": { params: { name: string; command: string }; result: Settings };
  "agents.remove": { params: { agentId: string }; result: Settings };
  "toolbox.list": { params: Record<string, never>; result: Tool[] };
  "project.create": { params: { goal: string; cwd?: string }; result: Project };
  "project.update": { params: { projectId: string; name?: string; goal?: string }; result: Project };
  /** Forgets the project and its threads. The folder and its files are left alone. */
  "project.remove": { params: { projectId: string }; result: { ok: true } };
  "project.setPreview": { params: { projectId: string; url: string | null }; result: Project };
  /** Lists one folder of the project. `dir` is relative to the project folder; empty means the top. */
  "project.files": { params: { projectId: string; dir?: string }; result: FileEntry[] };
  "project.changes": { params: { projectId: string }; result: Change[] };
  "project.diff": { params: { projectId: string; path: string }; result: { text: string } };
  "thread.create": { params: { projectId: string; provider: ProviderId; model?: { value: string; name: string } | null; text: string }; result: Thread };
  "thread.update": { params: { threadId: string; title?: string; archived?: boolean; model?: { value: string; name: string } | null }; result: Thread };
  "thread.remove": { params: { threadId: string }; result: { ok: true } };
  "thread.items": { params: { threadId: string }; result: Item[] };
  "thread.prompt": { params: { threadId: string; text: string }; result: { ok: true } };
  "thread.cancel": { params: { threadId: string }; result: { ok: true } };
  "ask.answer": { params: { threadId: string; itemId: string; optionId: string | null }; result: { ok: true } };
  /** Voice dictation runs on this computer. The speech model downloads once, when the user first asks for it. */
  "speech.status": { params: Record<string, never>; result: SpeechState };
  "speech.prepare": { params: Record<string, never>; result: SpeechState };
  "speech.start": { params: Record<string, never>; result: { recordingId: string } };
  /** `pcm` is base64 of 16 kHz mono 16-bit little-endian samples, at most about a second per chunk. */
  "speech.chunk": { params: { recordingId: string; pcm: string }; result: { ok: true } };
  "speech.finish": { params: { recordingId: string }; result: { text: string } };
  "speech.cancel": { params: { recordingId: string }; result: { ok: true } };
};

export type SpeechState = {
  state: "missing" | "downloading" | "ready" | "failed";
  /** 0 to 1 while downloading. */
  progress: number;
  /** Download size in bytes. */
  size: number;
  model: string;
  error?: string;
};

export type Method = keyof Requests;
export type RequestMessage = { [M in Method]: { id: number; method: M; params: Requests[M]["params"] } }[Method];
export type ResponseMessage = { id: number; result: unknown } | { id: number; error: string };

/** Engine to client, unprompted. */
export type EventMessage =
  | { event: "project"; project: Project }
  | { event: "thread"; thread: Thread }
  | { event: "item"; threadId: string; item: Item }
  | { event: "settings"; settings: Settings; agents: Agent[] }
  | { event: "gone"; kind: "project" | "thread"; id: string }
  /** An agent is using the project's browser, so the client shows the Browser tab. */
  | { event: "browse"; projectId: string }
  | { event: "speech"; speech: SpeechState };
