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

/** A script from the project's package.json, which Arcex can run on request. */
export type ProjectScript = { name: string; command: string };

/**
 * An agent's plan limit, as the agent last reported it during a turn. `used` is 0 to 1 when known; `resetsAt` is a
 * time in ms. Only agents that report limits have one (Claude does).
 */
/** Work an agent left running in the background, such as a dev server it started. Only while the engine runs. */
export type AgentTask = { id: string; name: string; description: string; kind: string; state: "running" | "completed" | "failed" | "stopped"; startedAt: number; endedAt: number | null; canStop: boolean; summary: string };
export type UsageLimit = { status: "ok" | "warning" | "reached"; window: "five_hour" | "weekly" | "other"; used: number | null; resetsAt: number | null; at: number };

/**
 * Where the project stands with its remote, for people who use GitHub. `remote` is null when there is none, and the
 * app then shows nothing. `ahead` counts saved versions not pushed yet. `gh` means the GitHub CLI is installed.
 */
export type PullRequestEntry = { number: number; title: string; branch: string; author: string; updatedAt: number; draft: boolean };
export type PublishState = {
  remote: string | null;
  branch: string | null;
  ahead: number;
  upstream: boolean;
  /** The remote's default branch, such as main. */
  main: string | null;
  pr: { number: number; url: string; state: "open" | "closed" | "merged"; title: string; checks: "none" | "running" | "passing" | "failing" } | null;
  gh: boolean;
  /** The remote is on github.com. */
  github: boolean;
};

/** An agent's personal instructions file, read in every project. `text` is null when there is none yet. */
export type AgentMemory = { agent: string; path: string; text: string | null; available: boolean };

/** A note an agent saved for itself about a project. */
export type MemoryNote = { name: string; text: string; changed: number };

/** A skill an agent can load: a folder with a SKILL.md. `relative` is set for skills inside the project. */
export type SkillEntry = { path: string; relative: string | null; name: string; description: string; agent: string; scope: "project" | "personal"; enabled: boolean };

/** One hook from an agent's settings file. `off` means that file turns all its hooks off. */
/**
 * A Claude Code hook. `off`: the whole file has hooks turned off (disableAllHooks). `enabled`: false when the user turned
 * this one off in Arcex, which keeps it aside in its data folder until it's turned back on.
 */
export type HookEntry = { id: string; event: string; matcher: string; run: string; agent: string; scope: "project" | "personal"; file: string; off: boolean; enabled: boolean };

/** One run of a project script. `url` is the local address it printed, such as a dev server's. */
export type ProcessInfo = {
  id: string;
  projectId: string;
  name: string;
  command: string;
  state: "running" | "exited" | "failed" | "stopped";
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  url: string | null;
};

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
  /** Pinned threads stay at the top of their project in the sidebar. */
  pinned: boolean;
  /** Folders outside the project the agent may also read and write in this thread. */
  folders: string[];
  /** The thread works in a separate copy of the project (a Git worktree) instead of the project folder. */
  copy?: { path: string } | null;
  /** The thread this one was started beside, as a side thread. Its state shows there. */
  parentId?: string | null;
  /** False once the thread's agent has said it can't use extra folders. */
  foldersSupported?: boolean;
  /** The thread's running agent takes messages into a turn that is under way. */
  steering?: boolean;
  /** Background work the thread's agent started, newest first. */
  tasks?: AgentTask[];
  /** How full the agent's context window is, as its last report gave it. Missing until the agent reports it. */
  context?: { used: number; size: number };
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
      /** The step of the subagent call this step ran inside, by item id. Shown folded under it. */
      parent?: string;
    }
  /** The agent's reasoning before it acts. `seconds` is set once it stops thinking. */
  | { id: string; kind: "think"; text: string; seconds: number | null }
  /** The agent's own plan for the turn, kept up to date as it works. */
  | { id: string; kind: "plan"; entries: PlanEntry[] }
  /** `body` is what the agent wants approved in full, such as its plan, as markdown. */
  | { id: string; kind: "ask"; title: string; detail: string; body?: string; options: AskOption[]; answer: string | null }
  /** The agent's own questions (ACP form elicitation), answered by picking options or typing. Null answer: still open. */
  | { id: string; kind: "question"; title: string; questions: Question[]; answer: string | null }
  | { id: string; kind: "error"; text: string }
  /** Something to know about the turn that isn't a failure, such as an image the model couldn't see. */
  | { id: string; kind: "note"; text: string }
  /** Separate work the agent suggests as a side thread. Nothing starts until the user does; `started` is that thread. */
  | { id: string; kind: "suggest"; title: string; prompt: string; started: string | null; dismissed?: boolean }
  /** The agent's wrap-up of a turn, written after it in a follow-up call: a recap and messages the user might send next. */
  | { id: string; kind: "wrap"; recap: string; next: string[]; by: string }
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
/** Files at the project's top level that agents read as standing instructions. */
export type InstructionFile = "AGENTS.md" | "CLAUDE.md" | "GEMINI.md";

export type FileEntry = { name: string; kind: "folder" | "file" };

/** A project file or folder found by "@" search. `path` is relative, with forward slashes. */
export type FileMatch = { path: string; kind: "folder" | "file" };

/**
 * One question in an agent's question card. "one" picks a single option, "many" any number, "text" is typed.
 * `otherId` is the field for typing your own answer instead of (or beside) the options.
 */
export type Question = {
  id: string;
  header?: string;
  text?: string;
  kind: "one" | "many" | "text";
  options: { value: string; label: string; description?: string }[];
  otherId?: string;
};

export type Change ={ path: string; status: "added" | "changed" | "removed"; added: number; removed: number };

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
  /** Show a terminal tab in the side panel. Off by default: most people never need one. */
  terminal: boolean;
  /** MCP servers the user added, handed to every agent session where they apply. */
  connectors: Connector[];
  /** After a turn, the thread's agent writes a recap, next steps and (early on) the title, in a small follow-up call. */
  wrapUp: boolean;
  /** The first-run welcome has been seen (or skipped). */
  welcomed: boolean;
};

/** When a schedule runs, in local time ("09:00"). `day` is 0 for Sunday to 6 for Saturday. */
export type ScheduleWhen = { kind: "daily" | "weekdays"; time: string } | { kind: "weekly"; day: number; time: string } | { kind: "hourly"; every: number };

/**
 * A prompt that runs on a schedule as a new thread. `background`: "task" when Windows runs it even with Arcex closed,
 * "app" when it runs only while Arcex is open, "failed" when the task couldn't be made (`problem` says why).
 */
export type Schedule = {
  id: string;
  name: string;
  projectId: string;
  prompt: string;
  provider: ProviderId;
  model: { value: string; name: string } | null;
  when: ScheduleWhen;
  on: boolean;
  createdAt: number;
  nextRun: number | null;
  lastRun: { at: number; threadId: string | null; skipped?: string } | null;
  background: "task" | "app" | "failed";
  problem?: string;
};

/**
 * An MCP server the user added: a command Arcex's agents start, or a web address they reach. `scope` is "all" or one
 * project's id. Environment values and headers may hold the server's own keys; they stay on this computer.
 */
export type Connector = {
  id: string;
  name: string;
  scope: "all" | string;
  on: boolean;
  kind: "command" | "web";
  command?: string;
  env?: { name: string; value: string }[];
  url?: string;
  headers?: { name: string; value: string }[];
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
  /** A newer release of the agent's own tool, when there is one, and the maker's command that installs it. */
  update?: { latest: string; command: string };
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
  /** Adds or changes a connector (matched by id), removes one, or starts one to list its tools. */
  "connectors.save": { params: { connector: Partial<Connector> }; result: Settings };
  /** Prompts that run on a schedule. Saving makes or updates the Windows task; removing deletes it. */
  "schedules.list": { params: Record<string, never>; result: Schedule[] };
  "schedules.save": { params: { schedule: Partial<Schedule> }; result: Schedule[] };
  "schedules.remove": { params: { id: string }; result: Schedule[] };
  "schedules.runNow": { params: { id: string }; result: Thread };
  "connectors.remove": { params: { id: string }; result: Settings };
  "connectors.test": { params: { connector: Partial<Connector> }; result: { tools: string[] } };
  "providers.status": { params: Record<string, never>; result: ProviderStatus[] };
  /** The models an agent offers. Reading them starts the agent briefly but sends no message. */
  "agents.models": { params: { agentId: string; refresh?: boolean }; result: { options: ModelOption[]; current: string | null; choices: AgentChoice[]; commands: SlashCommand[] } };
  /** Starts the agent's own sign-in (it may open the browser) and waits for it to finish, up to five minutes. */
  "agents.signIn": { params: { agentId: string; methodId: string }; result: { ok: true } };
  /** Opens a terminal window running a built-in agent's own sign-in, or its "connect a provider" command. */
  "agents.openTerminal": { params: { agentId: string; purpose: "signIn" | "providers" | "update" }; result: { ok: true } };
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
  /** The project's instruction files for agents. `text` is null when the file doesn't exist. */
  "project.instructions": { params: { projectId: string }; result: { name: InstructionFile; text: string | null }[] };
  /**
   * Saves one instruction file. Saving AGENTS.md when there is no CLAUDE.md also creates a CLAUDE.md that imports it,
   * so Claude follows the same rules.
   */
  "project.saveInstructions": { params: { projectId: string; name: InstructionFile; text: string }; result: { created: string[] } };
  /**
   * One project file to read in the side panel, at most 1 MB of it. `text` is missing for binary files and for files
   * too large to show.
   */
  /** Code editors found on this computer, plus the system's file manager. */
  "project.editors": { params: Record<string, never>; result: { id: string; name: string }[] };
  /** Opens the project, or one file in it, in an editor or the file manager. */
  "project.openIn": { params: { projectId: string; editor: string; path?: string }; result: { ok: true } };
  /** The project's own scripts and the package manager that runs them. */
  "project.scripts": { params: { projectId: string }; result: { runner: string; scripts: ProjectScript[] } };
  "project.publishState": { params: { projectId: string }; result: PublishState };
  /** The current branch and the branch it grew from, with how many saved versions it has beyond that. */
  "project.branch": { params: { projectId: string }; result: { branch: string | null; base: string | null; ahead: number } };
  /** Pushes saved versions to the remote with the user's own Git sign-in. */
  "project.push": { params: { projectId: string }; result: PublishState };
  /** Opens a pull request for the current branch with the GitHub CLI. */
  "project.createPr": { params: { projectId: string }; result: PublishState };
  /** The repository's open pull requests, from the GitHub CLI. */
  "project.pullRequests": { params: { projectId: string }; result: PullRequestEntry[] };
  /** Switches the project to a pull request's branch, returning its details for a new thread. */
  "project.checkoutPr": { params: { projectId: string; number: number }; result: { number: number; title: string; body: string; branch: string; base: string; author: string; url: string } };
  "memory.personal": { params: Record<string, never>; result: AgentMemory[] };
  "memory.savePersonal": { params: { agent: string; text: string }; result: { ok: true } };
  /** Notes Claude saved for itself about the project, read only. */
  "memory.notes": { params: { projectId: string }; result: MemoryNote[] };
  /** Skills and hooks the project's agents will load, from the project and the user's home folder. */
  "project.skills": { params: { projectId: string }; result: { skills: SkillEntry[]; hooks: HookEntry[] } };
  /** Turns a listed skill on or off by renaming its SKILL.md. */
  "project.toggleSkill": { params: { projectId: string; path: string; enabled: boolean }; result: { skills: SkillEntry[] } };
  "project.toggleHook": { params: { projectId: string; id: string; enabled: boolean }; result: { hooks: HookEntry[] } };
  /** Runs one script with no terminal window. Running it again while it runs returns the same run. */
  "process.run": { params: { projectId: string; script: string }; result: ProcessInfo };
  "process.stop": { params: { processId: string }; result: { ok: true } };
  "process.list": { params: Record<string, never>; result: ProcessInfo[] };
  /** Plan limits agents reported since Arcex started, by agent id. */
  "agents.limits": { params: Record<string, never>; result: Record<string, UsageLimit> };
  /** The end of what the run printed, up to 200 KB. */
  "process.output": { params: { processId: string }; result: { text: string } };
  /** Opens the project's terminal, or returns the one already open with what it has shown so far. */
  "terminal.open": { params: { projectId: string; cols: number; rows: number }; result: { id: string; buffer: string } };
  "terminal.write": { params: { id: string; data: string }; result: { ok: true } };
  "terminal.resize": { params: { id: string; cols: number; rows: number }; result: { ok: true } };
  "terminal.close": { params: { id: string }; result: { ok: true } };
  "project.readFile": { params: { projectId: string; path: string }; result: { path: string; size: number; text?: string; binary?: boolean; tooLarge?: boolean } };
  "project.search": { params: { projectId: string; query: string }; result: FileMatch[] };
  "project.changes": { params: { projectId: string }; result: Change[] };
  /** Files the current branch changed since it grew from its base, and one file's diff across the branch. */
  "project.branchChanges": { params: { projectId: string }; result: Change[] };
  "project.branchDiff": { params: { projectId: string; path: string }; result: { text: string } };
  /** Saves everything in the project folder as a version (a Git commit, kept out of sight). */
  "project.saveVersion": { params: { projectId: string; message: string }; result: { id: string } };
  /** Saved versions, newest first. */
  "project.versions": { params: { projectId: string }; result: { id: string; message: string; time: number }[] };
  /** Puts the folder back the way it was in a saved version. The difference shows as unsaved changes. */
  "project.restoreVersion": { params: { projectId: string; id: string }; result: { files: number } };
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
  /**
   * Takes the thread back to just before one of the user's messages: the files the later turns changed are put back,
   * that message and everything after it are removed, and the agent starts fresh with a recap of what came before.
   * Files changed again since are listed in `changedSince` and nothing happens, unless `force` is set.
   */
  "thread.rewind": {
    params: { threadId: string; itemId: string; force?: boolean };
    result: { changedSince: string[]; restored: string[]; text?: string; attachments?: Attachment[] };
  };
  /** Stores one attached file before it is sent. `data` is base64, at most 10 MB decoded. */
  "attachment.add": { params: { name: string; mime: string; data: string }; result: Attachment };
  /** `attachments` are ids from attachment.add. Text may be empty when there are attachments. */
  "thread.create": { params: { projectId: string; provider: ProviderId; model?: { value: string; name: string } | null; choices?: Record<string, string>; text: string; attachments?: string[]; /** Work in a separate copy of the project. */ separate?: boolean; /** Start as a side thread of this thread. */ parentId?: string }; result: Thread };
  /** Starts a side thread: from the agent's suggestion card (`itemId`), or from the user's own words (`text`). */
  "thread.side": { params: { threadId: string; itemId?: string; text?: string }; result: Thread };
  "thread.dismissSuggestion": { params: { threadId: string; itemId: string }; result: { ok: true } };
  /** What a thread changed in its separate copy, and one file's diff there. */
  "thread.copyChanges": { params: { threadId: string }; result: Change[] };
  "thread.copyDiff": { params: { threadId: string; path: string }; result: { text: string } };
  /** Brings a separate copy's changes into the project folder as unsaved changes, then removes the copy. */
  "thread.bringIn": { params: { threadId: string }; result: { files: string[]; overlaps: string[] } };
  /** Removes a separate copy without bringing its changes in. */
  "thread.discardCopy": { params: { threadId: string }; result: { ok: true } };
  "thread.update": { params: { threadId: string; title?: string; archived?: boolean; pinned?: boolean; folders?: string[]; model?: { value: string; name: string } | null; choices?: Record<string, string> }; result: Thread };
  "thread.remove": { params: { threadId: string }; result: { ok: true } };
  /** Threads whose messages contain `query`, with a snippet around the first match. */
  "thread.search": { params: { query: string }; result: { threadId: string; snippet: string }[] };
  "thread.items": { params: { threadId: string }; result: Item[] };
  /** Asks a throwaway copy of the thread's conversation a question, without touching the thread or its running turn. */
  "thread.aside": { params: { threadId: string; text: string }; result: { asideId: string } };
  /** Stops background work the thread's agent started. */
  "thread.stopTask": { params: { threadId: string; taskId: string }; result: { ok: true } };
  "thread.asideStop": { params: { asideId: string }; result: { ok: true } };
  "thread.prompt": { params: { threadId: string; text: string; attachments?: string[]; /** While the agent works, add it to the queue instead. */ queue?: boolean; /** While the agent works, add it to the running turn when the agent can take it, else queue it. */ steer?: boolean }; result: { ok: true; queued?: boolean; steered?: boolean } };
  /** Takes a message out of the queue, returning it so the client can put it back in the message box. */
  "thread.unqueue": { params: { threadId: string; index: number }; result: QueuedMessage };
  "thread.cancel": { params: { threadId: string }; result: { ok: true } };
  "ask.answer": { params: { threadId: string; itemId: string; optionId: string | null }; result: { ok: true } };
  /** Answers a question card, keyed by question (and "other") id. Null skips it. */
  "question.answer": { params: { threadId: string; itemId: string; answers: Record<string, string | string[]> | null }; result: { ok: true } };
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
  /** The thread's whole timeline, after a rewind removed part of it. */
  | { event: "items"; threadId: string; items: Item[] }
  | { event: "settings"; settings: Settings; agents: Agent[] }
  | { event: "schedules"; schedules: Schedule[] }
  | { event: "gone"; kind: "project" | "thread"; id: string }
  /** An agent is using the project's browser, so the client shows the Browser tab. */
  | { event: "browse"; projectId: string }
  | { event: "speech"; speech: SpeechState }
  | { event: "process"; process: ProcessInfo }
  | { event: "terminal"; id: string; data: string }
  | { event: "terminalExit"; id: string; code: number }
  /** An agent's slash commands changed, for example when it found a project's own skills. */
  | { event: "commands"; agentId: string; commands: SlashCommand[] }
  | { event: "limit"; agentId: string; limit: UsageLimit }
  /** A side question's answer so far. */
  | { event: "aside"; threadId: string; asideId: string; text: string; state: "working" | "done" | "failed" | "stopped"; error?: string };
