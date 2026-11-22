// The boundary between the Arcex engine and every client (desktop now; web and mobile later).
// Types only. The engine validates what it receives.

/** An agent's id: "claude", "codex", "opencode", "gemini", or one the user added. */
export type ProviderId = string;

/** A coding agent Arcex can start. Every agent speaks the Agent Client Protocol. */
export type Agent = { id: string; name: string; builtin: boolean; /** The command that starts it, when it is not shipped with Arcex. */ command: string | null };

/** One model an agent offers, as the agent itself describes it. */
export type ModelOption = { value: string; name: string; description: string };

/**
 * A setting the agent offers besides its model, such as how much it asks before acting ("mode"), how hard it
 * thinks ("thought_level"), fast mode ("model_config") or planning first ("collaboration_mode").
 */
/** A slash command the agent offers, such as /review. `hint` describes what to type after it, when it takes input. */
export type SlashCommand = { name: string; description: string; hint: string | null };

export type AgentChoice = { id: string; name: string; category: string; current: string; values: ModelOption[] };

/** A file the user attached to a message. The engine keeps a copy; images are served at `/attachments/<id>` for thumbnails. */
export type Attachment = { id: string; name: string; mime: string; size: number; image: boolean };

/** A message waiting for the current turn to finish. */
export type QueuedMessage = { text: string; attachments: Attachment[] };

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
  /** The thread's agent settings by choice id, such as { mode: "acceptEdits", effort: "high" }. Missing means the agent's default. */
  choices: Record<string, string>;
  /** Messages the user sent while the agent was working. The first goes out when the turn finishes. */
  queued: QueuedMessage[];
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
  | { id: string; kind: "user"; text: string; attachments?: Attachment[] }
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
  /** `body` is what the agent wants approved in full, such as its plan, as markdown. */
  | { id: string; kind: "ask"; title: string; detail: string; body?: string; options: AskOption[]; answer: string | null }
  | { id: string; kind: "error"; text: string }
  /** Something to know about the turn that isn't a failure, such as an image the model couldn't see. */
  | { id: string; kind: "note"; text: string }
  /** Closes a turn that changed files. Paths are relative to the project folder. */
  | {
      id: string;
      kind: "result";
      files: string[];
      /** What this turn changed, from snapshots of the folder taken before and after it. Absent for Git-less folders. */
      changes?: Change[];
      snapshots?: { before: string; after: string };
      /** Files whose changes from this turn the user has undone (and not redone). `true` from older builds means all. */
      undone?: string[] | boolean;
    }
  /** Closes every turn: how it ended and how long it took. */
  | { id: string; kind: "end"; outcome: "done" | "stopped" | "failed" | "interrupted"; seconds: number };

export type PlanEntry = { content: string; status: "pending" | "in_progress" | "completed" };

/** One entry in a project folder. */
export type FileEntry = { name: string; kind: "folder" | "file" };

/** A project file or folder found by "@" search. `path` is relative, with forward slashes. */
export type FileMatch = { path: string; kind: "folder" | "file" };

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
  agents: AddedAgent[];
  sendWith: "enter" | "ctrl-enter";
  /** Open the details panel when the app starts. */
  showDetails: boolean;
  /** Tell the user when a thread finishes or needs them while the window is in the background. */
  notify: boolean;
  /** Let agents search the Arcex research library of real products. */
  research: boolean;
};

/** An agent the user added: by hand with its command, or from the agent directory. */
export type AddedAgent = {
  id: string;
  name: string;
  command: string;
  /** Extra environment the agent needs, from its directory entry. */
  env?: Record<string, string>;
  /** Set when it came from the agent directory: its id there and the version added. */
  directory?: { id: string; version: string };
};

/** One agent in the ACP registry, the directory of coding agents that speak the Agent Client Protocol. */
export type DirectoryAgent = {
  id: string;
  name: string;
  description: string;
  version: string;
  website: string | null;
  /** A model maker's own agent, shown first. */
  featured: boolean;
  /** How it runs on this computer, or null when it has no build for it. */
  runs: "npx" | "uvx" | "binary" | null;
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
  /** Sign-ins the agent can start itself, such as "Log in with Google". Arcex starts them; the agent keeps what it gets. */
  signInMethods?: { id: string; name: string }[];
  /** For agents that reach many model makers (OpenCode): the command that connects another maker's account. */
  providersCommand?: string;
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
  "agents.models": { params: { agentId: string; refresh?: boolean }; result: { options: ModelOption[]; current: string | null; choices: AgentChoice[]; commands: SlashCommand[] } };
  /** Starts the agent's own sign-in (it may open the browser) and waits for it to finish, up to five minutes. */
  "agents.signIn": { params: { agentId: string; methodId: string }; result: { ok: true } };
  /** Opens a terminal window running a built-in agent's own sign-in, or its "connect a provider" command. */
  "agents.openTerminal": { params: { agentId: string; purpose: "signIn" | "providers" }; result: { ok: true } };
  /** The ACP registry of agents, read at most daily. Icons are served at `/agent-icons/<id>.svg`. */
  "agents.directory": { params: { refresh?: boolean }; result: DirectoryAgent[] };
  /** Adds an agent from the directory, downloading it first when it ships as a program. */
  "agents.addFromDirectory": { params: { id: string }; result: Settings };
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
  /** Finds project files and folders by a few letters of their path, best first. Empty query lists the top ones. */
  "project.search": { params: { projectId: string; query: string }; result: FileMatch[] };
  "project.changes": { params: { projectId: string }; result: Change[] };
  "project.diff": { params: { projectId: string; path: string }; result: { text: string } };
  /** One file's diff within one turn, from that turn's result. */
  "thread.turnDiff": { params: { threadId: string; itemId: string; path: string }; result: { text: string } };
  /**
   * Puts the files one turn changed back the way they were before it. Files changed again since are listed in
   * `changedSince` and nothing is undone, unless `force` is set.
   */
  "thread.undoTurn": {
    /** `path` limits it to one of the turn's files. `redo` puts undone changes back. */
    params: { threadId: string; itemId: string; force?: boolean; path?: string; redo?: boolean };
    result: { undone: string[]; changedSince: string[] };
  };
  /** Stores one attached file before it is sent. `data` is base64, at most 10 MB decoded. */
  "attachment.add": { params: { name: string; mime: string; data: string }; result: Attachment };
  /** `attachments` are ids from attachment.add. Text may be empty when there are attachments. */
  "thread.create": { params: { projectId: string; provider: ProviderId; model?: { value: string; name: string } | null; choices?: Record<string, string>; text: string; attachments?: string[] }; result: Thread };
  "thread.update": { params: { threadId: string; title?: string; archived?: boolean; model?: { value: string; name: string } | null; choices?: Record<string, string> }; result: Thread };
  "thread.remove": { params: { threadId: string }; result: { ok: true } };
  "thread.items": { params: { threadId: string }; result: Item[] };
  "thread.prompt": { params: { threadId: string; text: string; attachments?: string[]; /** While the agent works, add it to the queue instead. */ queue?: boolean }; result: { ok: true; queued?: boolean } };
  /** Takes a message out of the queue, returning it so the client can put it back in the message box. */
  "thread.unqueue": { params: { threadId: string; index: number }; result: QueuedMessage };
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
  | { event: "speech"; speech: SpeechState }
  /** An agent's slash commands changed, for example when it found a project's own skills. */
  | { event: "commands"; agentId: string; commands: SlashCommand[] };
