import { useEffect, useState, type ReactNode } from "react";
import type { About, Agent, AgentMemory, Connector, DirectoryAgent, HookEntry, MemoryNote, InstructionFile, Project, ProviderStatus, Settings as Prefs, SkillEntry, SpeechState, Thread } from "@arcex/contracts";
import { Icon, ago, limitText, nameOf, plural } from "./shared.tsx";
import { call, useStore } from "./store.ts";
import { Account } from "./Account.tsx";
import { forgetModels } from "./ModelPicker.tsx";

export type Section = "profile" | "general" | "appearance" | "agents" | "connectors" | "skills" | "memory" | "voice" | "notifications" | "projects" | "archived" | "shortcuts" | "about";
const SECTIONS: [Section, string][] = [
  ["profile", "Profile"],
  ["general", "General"],
  ["appearance", "Appearance"],
  ["agents", "Agents"],
  ["connectors", "Connectors"],
  ["skills", "Skills and hooks"],
  ["memory", "Memory"],
  ["voice", "Voice"],
  ["notifications", "Notifications"],
  ["projects", "Projects"],
  ["archived", "Archived threads"],
  ["shortcuts", "Shortcuts"],
  ["about", "About"],
];

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("") || "?";

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="srow">
      <div>
        <b>{title}</b>
        {hint && <p>{hint}</p>}
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

function Choice<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange(value: T): void }) {
  return (
    <div className="pick" role="group">
      {options.map(([id, label]) => (
        <button key={id} aria-pressed={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const Switch = ({ on, onChange, label }: { on: boolean; onChange(on: boolean): void; label: string }) => (
  <button className="switch" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
    <span />
  </button>
);

/** A text box that saves when you leave it or press Enter. */
function SavedField({ value, placeholder, max, save }: { value: string; placeholder?: string; max: number; save(value: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) save(draft.trim());
  };
  return (
    <input
      className="textfield"
      value={draft}
      maxLength={max}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
    />
  );
}

/**
 * The project's standing instructions for agents, edited in place. AGENTS.md is the shared file; CLAUDE.md and
 * GEMINI.md get their own tab only when the project already has them with more than an import of AGENTS.md.
 */
function Instructions({ projectId, fail }: { projectId: string; fail(error: unknown): void }) {
  const [files, setFiles] = useState<{ name: InstructionFile; text: string | null }[] | null>(null);
  const [editing, setEditing] = useState<InstructionFile | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const load = () => call("project.instructions", { projectId }).then(setFiles).catch(fail);
  useEffect(() => void load(), [projectId]);
  const own = (file: { name: InstructionFile; text: string | null }) => file.name === "AGENTS.md" || (file.text !== null && file.text.trim() !== "@AGENTS.md");
  const shown = (files ?? []).filter(own);
  const agents = files?.find((file) => file.name === "AGENTS.md");
  const open = (name: InstructionFile) => {
    setEditing(name);
    setDraft(files?.find((file) => file.name === name)?.text ?? "");
    setNote("");
  };
  const save = () => {
    if (!editing) return;
    setSaving(true);
    call("project.saveInstructions", { projectId, name: editing, text: draft })
      .then((result) => {
        setEditing(null);
        setNote(result.created.includes("CLAUDE.md") ? "Saved. Arcex also added a one-line CLAUDE.md so Claude follows these too." : "Saved.");
        return load();
      })
      .catch(fail)
      .finally(() => setSaving(false));
  };
  const hint = agents?.text?.trim()
    ? `${agents.text.trim().split(/\s+/).length} words in AGENTS.md. Every agent reads these before it starts.`
    : "Standing rules every agent follows here, like the tools you use or how to check work. Saved as AGENTS.md in the project folder.";
  return (
    <div className="instructions">
      <Row title="Instructions for agents" hint={note || hint}>
        {!editing && <button className="btn" disabled={!files} onClick={() => open("AGENTS.md")}>{agents?.text?.trim() ? "Edit" : "Write instructions"}</button>}
      </Row>
      {editing && (
        <div className="ieditor">
          {shown.length > 1 && (
            <div className="pick" role="group" aria-label="Instruction file">
              {shown.map((file) => (
                <button key={file.name} aria-pressed={editing === file.name} onClick={() => open(file.name)}>{file.name}</button>
              ))}
            </div>
          )}
          <textarea
            className="textfield"
            value={draft}
            autoFocus
            spellCheck
            maxLength={200_000}
            rows={14}
            placeholder={"For example:\n- This is a Next.js app with Tailwind.\n- Run the tests before saying a change is done.\n- Keep the design dark and simple."}
            aria-label={`Contents of ${editing}`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(null);
              if (event.key === "s" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                save();
              }
            }}
          />
          <div className="btns">
            <button className="btn primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <span className="muted">{editing === "AGENTS.md" ? "Codex and OpenCode read this directly, Claude through CLAUDE.md." : `Only ${editing === "CLAUDE.md" ? "Claude" : "Gemini"} reads ${editing}.`}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Asks once more before doing something that cannot be undone. */
function Confirm({ label, sure, run }: { label: string; sure: string; run(): void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button className={armed ? "btn danger" : "btn"} onClick={() => (armed ? run() : setArmed(true))}>
      {armed ? sure : label}
    </button>
  );
}

export function SettingsView(props: {
  section: Section;
  go(section: Section): void;
  settings: Prefs;
  about: About;
  agents: Agent[];
  projects: Project[];
  threads: Thread[];
  /** Asks the app to re-check which agents are ready, after something here may have changed it. */
  recheck(): void;
  /** The project the user was last in, so project lists start there. */
  projectId: string | null;
  /** Starts a new thread in a project with this message ready to send. */
  draft(projectId: string, text: string): void;
  /** Shows a file of a project in the side panel. */
  openFile(projectId: string, path: string): void;
  fail(error: unknown): void;
}) {
  const { settings, fail } = props;
  const set = (change: Partial<Prefs>) => call("settings.set", change).catch(fail);

  return (
    <div className="settings">
      <nav className="snav">
        {SECTIONS.map(([id, label]) => (
          <button key={id} className="row" aria-current={props.section === id} onClick={() => props.go(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="sbody">
        <div className="scol">
          {props.section === "profile" && (
            <>
              <h2>Profile</h2>
              <Account />
              <div className="card who">
                <span className="avatar big">{initials(settings.name)}</span>
                <div>
                  <b>{settings.name || "No name yet"}</b>
                  <p>Local workspace profile</p>
                </div>
              </div>
              <div className="card">
                <Row title="Name" hint="How the app greets you.">
                  <SavedField value={settings.name} placeholder="Your name" max={60} save={(name) => set({ name })} />
                </Row>
              </div>
            </>
          )}

          {props.section === "general" && (
            <>
              <h2>General</h2>
              <div className="card">
                <Row title="New threads start with" hint="The agent and model you used last. Change it from the model menu under any message box.">
                  <span className="mono">
                    {nameOf(settings.defaultProvider)} · {settings.defaultModel?.name ?? "Default model"}
                  </span>
                </Row>
                <Row title="Send messages with" hint="With Ctrl + Enter, plain Enter makes a new line.">
                  <Choice value={settings.sendWith} options={[["enter", "Enter"], ["ctrl-enter", "Ctrl + Enter"]]} onChange={(sendWith) => set({ sendWith })} />
                </Row>
                <Row title="Open the details panel at start" hint="The panel on the right with changes and the preview.">
                  <Switch on={settings.showDetails} onChange={(showDetails) => set({ showDetails })} label="Open the details panel at start" />
                </Row>
                <Row title="Terminal" hint="Adds a Terminal tab to the side panel with a shell in the project folder. Agents don't need it; it's there if you want to type commands yourself.">
                  <Switch on={settings.terminal} onChange={(terminal) => set({ terminal })} label="Terminal" />
                </Row>
                <Row title="Research library" hint="New agent sessions can search the library at arcex.dev when you ask. Already running sessions keep their current access.">
                  <Switch on={settings.research} onChange={(research) => set({ research })} label="Research library" />
                </Row>
              </div>
            </>
          )}

          {props.section === "notifications" && (
            <>
              <h2>Notifications</h2>
              <div className="card">
                <Row title="Notify me" hint="A desktop notification when a thread finishes, fails or needs your OK while Arcex is in the background.">
                  <Switch
                    on={settings.notify}
                    label="Notify me"
                    onChange={(notify) => {
                      if (notify && "Notification" in window && Notification.permission === "default") void Notification.requestPermission();
                      void set({ notify });
                    }}
                  />
                </Row>
                {settings.notify && "Notification" in window && Notification.permission === "denied" && (
                  <Row title="Blocked on this computer" hint="Windows or Arcex has notifications turned off. Turn them on in Windows Settings › System › Notifications.">
                    <span />
                  </Row>
                )}
              </div>
            </>
          )}

          {props.section === "voice" && <Voice fail={fail} />}
          {props.section === "memory" && <Memory projects={props.projects} start={props.projectId} fail={fail} />}
          {props.section === "skills" && <Skills projects={props.projects} start={props.projectId} draft={props.draft} openFile={props.openFile} fail={fail} />}

          {props.section === "appearance" && (
            <>
              <h2>Appearance</h2>
              <div className="card">
                <Row title="Theme" hint="System follows your Windows setting.">
                  <Choice value={settings.theme} options={[["light", "Light"], ["dark", "Dark"], ["system", "System"]]} onChange={(theme) => set({ theme })} />
                </Row>
              </div>
            </>
          )}

          {props.section === "agents" && <Agents agents={props.agents} recheck={props.recheck} fail={fail} />}

          {props.section === "connectors" && <Connectors connectors={settings.connectors ?? []} projects={props.projects} start={props.projectId} fail={fail} />}

          {props.section === "projects" && (
            <>
              <h2>Projects</h2>
              <p className="sdesc">Removing a project only forgets it in Arcex. The folder and every file in it stay where they are.</p>
              {props.projects.length === 0 && <p className="muted">No projects yet.</p>}
              {props.projects.map((project) => (
                <div key={project.id} className="card">
                  <Row title="Name">
                    <SavedField value={project.name} max={60} save={(name) => call("project.update", { projectId: project.id, name }).catch(fail)} />
                  </Row>
                  <Row title="What you're building" hint="Agents and the details panel show this.">
                    <SavedField value={project.goal} max={2000} save={(goal) => call("project.update", { projectId: project.id, goal }).catch(fail)} />
                  </Row>
                  <Instructions projectId={project.id} fail={fail} />
                  <Row title="Folder" hint={project.cwd}>
                    <Confirm label="Remove from Arcex" sure="Remove project and its threads" run={() => call("project.remove", { projectId: project.id }).catch(fail)} />
                  </Row>
                </div>
              ))}
            </>
          )}

          {props.section === "archived" && (
            <>
              <h2>Archived threads</h2>
              <p className="sdesc">Archived threads are hidden from the sidebar and the board. Restore one to pick it back up.</p>
              {props.threads.filter((t) => t.archived).length === 0 && <p className="muted">Nothing archived.</p>}
              <div className="card list">
                {props.threads.filter((t) => t.archived).map((thread) => (
                  <div key={thread.id} className="srow">
                    <div>
                      <b>{thread.title}</b>
                      <p>
                        {props.projects.find((p) => p.id === thread.projectId)?.name} · {nameOf(thread.provider)} · {ago(thread.updatedAt)} ago
                      </p>
                    </div>
                    <div className="control">
                      <button className="btn" onClick={() => call("thread.update", { threadId: thread.id, archived: false }).catch(fail)}>Restore</button>
                      <Confirm label="Delete" sure="Delete forever" run={() => call("thread.remove", { threadId: thread.id }).catch(fail)} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {props.section === "shortcuts" && (
            <>
              <h2>Shortcuts</h2>
              <div className="card">
                {([
                  ["New thread", "Ctrl N"],
                  ["Previous or next thread", "Alt ↑ ↓"],
                  ["Search threads, messages, settings and actions", "Ctrl K"],
                  ["Find in this thread", "Ctrl F"],
                  ["Type a message", "Ctrl L"],
                  ["Show or hide the sidebar", "Ctrl B"],
                  ["Show or hide the details panel", "Ctrl J"],
                  ...(settings.terminal ? [["Show the terminal", "Ctrl `"]] : []),
                  ["Settings", "Ctrl ,"],
                  ["This list", "Ctrl /"],
                  ["Back from Settings or the Toolbox", "Esc"],
                ] as string[][]).map(([what, keys]) => (
                  <Row key={what} title={what!}>
                    <span className="keys">{keys!.split(" ").map((key) => <kbd key={key}>{key}</kbd>)}</span>
                  </Row>
                ))}
              </div>
              <h3>In the message box</h3>
              <div className="card">
                {[
                  ["Send a message", settings.sendWith === "enter" ? "Enter" : "Ctrl Enter"],
                  ["New line in a message", settings.sendWith === "enter" ? "Shift Enter" : "Enter"],
                  ["Agent commands", "/"],
                  ["Mention a file", "@"],
                  ["Earlier messages you sent (in an empty box)", "↑ ↓"],
                  ["While the agent works: queue for after this turn", "Tab"],
                ].map(([what, keys]) => (
                  <Row key={what} title={what!}>
                    <span className="keys">{keys!.split(" ").map((key) => <kbd key={key}>{key}</kbd>)}</span>
                  </Row>
                ))}
              </div>
            </>
          )}

          {props.section === "about" && (
            <>
              <h2>About</h2>
              <div className="card">
                <Row title="Arcex" hint="An AI development environment built around what you're building."><span className="mono">{props.about.version}</span></Row>
                <Row title="Your data" hint="Projects, threads and settings are saved in this folder on your computer."><span className="mono path" title={props.about.dataDir}>{props.about.dataDir}</span></Row>
                <Row title="New projects" hint="Where Arcex creates a folder when you start from an idea."><span className="mono path" title={props.about.projectsDir}>{props.about.projectsDir}</span></Row>
                <Row title="Usage" hint={`${plural(props.projects.length, "project")} and ${plural(props.threads.length, "thread")} on this computer.`}><span /></Row>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const setupGuides: Record<string, string> = {
  claude: "https://code.claude.com/docs/en/setup",
  codex: "https://learn.chatgpt.com/docs/codex/cli",
  opencode: "https://opencode.ai/docs/",
  gemini: "https://geminicli.com/docs/get-started/",
};

/** Directory icons are one-colour SVGs, drawn as a mask so they take the text colour, like every other icon. */
const AgentMark = ({ id }: { id: string }) => {
  const url = `${import.meta.env.DEV ? "http://127.0.0.1:4517" : ""}/agent-icons/${encodeURIComponent(id)}.svg`;
  return <span className="agentmark" aria-hidden="true" style={{ WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")` }} />;
};

/** Every coding agent in the ACP registry, model makers' own first. One click adds one. */
function AgentDirectory({ added, fail }: { added: Agent[]; fail(error: unknown): void }) {
  const [list, setList] = useState<DirectoryAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    call("agents.directory", {}).then(setList).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);
  const have = new Set(added.map((agent) => agent.id));
  const words = query.toLowerCase().trim();
  const matches = (list ?? []).filter((agent) => !words || `${agent.name} ${agent.description}`.toLowerCase().includes(words));
  const shown = words || all ? matches : matches.filter((agent) => agent.featured);
  return (
    <>
      <h2 className="sub2">Add more agents</h2>
      <p className="sdesc">
        Coding agents from every major model maker, from the open Agent Client Protocol directory. Each runs as its maker's own tool and signs in with
        your own account. Programs are downloaded over a secure connection and checked before they run.
      </p>
      <div className="field dirsearch">
        <Icon name="search" />
        <input value={query} placeholder="Search agents" aria-label="Search agents" onChange={(event) => setQuery(event.target.value)} />
      </div>
      {error && <p className="sdesc">{error}</p>}
      {!list && !error && <p className="sdesc">Loading the directory…</p>}
      {list && (
        <div className="card dirlist">
          {shown.map((agent) => {
            const isAdded = have.has(`dir-${agent.id}`);
            return (
              <div key={agent.id} className="dirrow">
                <AgentMark id={agent.id} />
                <div className="dirtext">
                  <b>{agent.name}</b>
                  <span>{agent.description}</span>
                </div>
                {isAdded ? (
                  <span className="pillstate ok">Added</span>
                ) : (
                  <button
                    className="btn"
                    disabled={!agent.runs || adding !== null}
                    title={agent.runs ? undefined : "No build for this computer yet"}
                    onClick={() => {
                      setAdding(agent.id);
                      call("agents.addFromDirectory", { id: agent.id }).catch(fail).finally(() => setAdding(null));
                    }}
                  >
                    {adding === agent.id ? (agent.runs === "binary" ? "Downloading…" : "Adding…") : agent.runs ? "Add" : "Not on Windows"}
                  </button>
                )}
              </div>
            );
          })}
          {shown.length === 0 && <p className="sdesc">No agents match.</p>}
        </div>
      )}
      {list && !words && (
        <div>
          <button className="btn" onClick={() => setAll(!all)}>{all ? "Show model makers' agents only" : `Show all ${list.length} agents`}</button>
        </div>
      )}
    </>
  );
}

function Agents({ agents, recheck, fail }: { agents: Agent[]; recheck(): void; fail(error: unknown): void }) {
  const { limits } = useStore();
  const [status, setStatus] = useState<ProviderStatus[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [refreshed, setRefreshed] = useState<{ agentId: string; count: number } | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const check = () => {
    setStatus(null);
    call("providers.status", {}).then(setStatus).catch(fail);
    recheck();
  };
  useEffect(check, [agents.length]);

  const add = () => {
    if (!name.trim() || !command.trim()) return;
    call("agents.add", { name, command })
      .then(() => {
        setName("");
        setCommand("");
      })
      .catch(fail);
  };

  return (
    <>
      <h2>Agents</h2>
      <p className="sdesc">
        Agents run through their makers' own tools on this computer, using your own sign-in with each one. Arcex never sees your passwords or keys. Each
        agent brings its own list of models, which you pick from the model menu under any message box.
      </p>
      {agents.map((agent) => {
        const state = status?.find((entry) => entry.id === agent.id);
        const ready = state?.installed && state.signedIn === true;
        const setup = Object.hasOwn(setupGuides, agent.id) ? setupGuides[agent.id] : undefined;
        return (
          <div key={agent.id} className="card">
            <Row
              title={agent.name}
              hint={
                !state ? "Checking…"
                : !agent.builtin ? agent.command ?? ""
                : !state.installed ? "Not installed on this computer."
                : state.signedIn === false ? "Installed, but not signed in."
                : `Version ${state.version ?? "unknown"}`
              }
            >
              {state && (
                  <span className={ready ? "pillstate ok" : "pillstate warn"}>
                  {!agent.builtin && state.signedIn === null ? "Added by you" : !state.installed ? "Not installed" : state.signedIn === false ? "Sign in needed" : state.signedIn === true ? "Ready" : "Sign-in unchecked"}
                </span>
              )}
              {!agent.builtin && <Confirm label="Remove" sure="Remove agent" run={() => call("agents.remove", { agentId: agent.id }).catch(fail)} />}
            </Row>
            {state && setup && (!state.installed || state.signedIn === null) && (
              <Row title={!state.installed ? "Install the agent" : "Check sign-in"} hint={!state.installed ? "Follow the provider’s setup guide, then return here to check again." : "Check your sign-in using the provider’s own tool."}>
                <button className="btn" onClick={() => {
                  if (window.arcex) window.arcex.openExternal(setup);
                  else window.open(setup, "_blank", "noopener");
                }}>Open setup guide <Icon name="out" /></button>
              </Row>
            )}
            {state && state.installed && state.signedIn === false && (state.signInMethods?.length ?? 0) > 0 && (
              <Row
                title="Sign in"
                hint={signingIn === agent.id ? `Finish signing in to ${agent.name} in your browser. This updates by itself when you're done.` : `${agent.name} handles the sign-in and keeps it. Arcex never sees it.`}
              >
                {state.signInMethods!.map((method) => (
                  <button
                    key={method.id}
                    className="btn"
                    disabled={signingIn !== null}
                    onClick={() => {
                      setSigningIn(agent.id);
                      call("agents.signIn", { agentId: agent.id, methodId: method.id })
                        .then(check)
                        .catch(fail)
                        .finally(() => setSigningIn(null));
                    }}
                  >
                    {signingIn === agent.id ? "Waiting for your browser…" : method.name}
                  </button>
                ))}
              </Row>
            )}
            {state && agent.builtin && state.installed && state.signedIn === false && state.signInCommand && (
              <Row title={(state.signInMethods?.length ?? 0) > 0 ? "Or sign in from a terminal" : "Sign in"} hint="Arcex opens a terminal with the sign-in ready. Finish there or in your browser, then check again.">
                <button className="btn" onClick={() => void call("agents.openTerminal", { agentId: agent.id, purpose: "signIn" }).catch(fail)}>
                  Open a terminal
                </button>
                <button
                  className="btn mono"
                  onClick={() => {
                    void navigator.clipboard.writeText(state.signInCommand).then(() => setCopied(agent.id)).catch(fail);
                  }}
                >
                  {copied === agent.id ? "Copied" : state.signInCommand}
                </button>
              </Row>
            )}
            {limits[agent.id] && limitText(agent.name, limits[agent.id], true) && (
              <Row title="Plan limit" hint={`As ${agent.name} last reported it, during a turn ${ago(limits[agent.id]!.at)}.`}>
                <span className="limitnote">{limitText(agent.name, limits[agent.id], true)}</span>
              </Row>
            )}
            {state && state.installed && state.update && (
              <Row title={`Update to ${state.update.latest}`} hint={`You have ${state.version ?? "an older version"}. Arcex opens a terminal with ${agent.name}'s own update ready.`}>
                <button className="btn" onClick={() => void call("agents.openTerminal", { agentId: agent.id, purpose: "update" }).catch(fail)}>
                  Update {agent.name}
                </button>
                <button
                  className="btn mono"
                  onClick={() => {
                    void navigator.clipboard.writeText(state.update!.command).then(() => setCopied(`update:${agent.id}`)).catch(fail);
                  }}
                >
                  {copied === `update:${agent.id}` ? "Copied" : state.update.command}
                </button>
              </Row>
            )}
            {state && state.installed && state.providersCommand && (
              <Row
                title="Other model makers"
                hint={`Use Anthropic, OpenAI, Google, xAI and more through ${agent.name} with your own account. ${agent.name} keeps the sign-in.`}
              >
                <button className="btn" onClick={() => void call("agents.openTerminal", { agentId: agent.id, purpose: "providers" }).catch(fail)}>
                  Connect a provider
                </button>
                <button
                  className="btn"
                  disabled={refreshing === agent.id}
                  onClick={() => {
                    setRefreshing(agent.id);
                    forgetModels(agent.id);
                    call("agents.models", { agentId: agent.id, refresh: true })
                      .then((models) => setRefreshed({ agentId: agent.id, count: models.options.filter((option) => option.value !== "default").length }))
                      .catch(fail)
                      .finally(() => setRefreshing(null));
                  }}
                >
                  {refreshing === agent.id ? "Asking…" : refreshed?.agentId === agent.id ? `${plural(refreshed.count, "model")} ready` : "Refresh models"}
                </button>
              </Row>
            )}
          </div>
        );
      })}
      <div>
        <button className="btn" onClick={check}>
          <Icon name="reload" /> Check again
        </button>
      </div>

      <AgentDirectory added={agents} fail={fail} />

      <h2 className="sub2">Add an agent by hand</h2>
      <p className="sdesc">
        Any agent that speaks the Agent Client Protocol works. Give it a name and the command that starts it in that mode. Its models then appear in the
        model menu.
      </p>
      <div className="card">
        <Row title="Name">
          <input className="textfield" value={name} maxLength={40} placeholder="Goose" onChange={(event) => setName(event.target.value)} />
        </Row>
        <Row title="Command" hint="The command you would type in a terminal.">
          <input className="textfield mono" value={command} maxLength={300} placeholder="goose acp" onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => event.key === "Enter" && add()} />
        </Row>
        <Row title="">
          <button className="btn primary" disabled={!name.trim() || !command.trim()} onClick={add}>
            Add agent
          </button>
        </Row>
      </div>
    </>
  );
}

/** Voice dictation runs on this computer. This shows whether its speech model is here and fetches it on request. */
function Voice({ fail }: { fail(error: unknown): void }) {
  const live = useStore().speech;
  const [first, setFirst] = useState<SpeechState | null>(null);
  useEffect(() => {
    call("speech.status", {}).then(setFirst).catch(() => {});
  }, []);
  // Download progress arrives as events; the first answer covers the time before any.
  const speech = live ?? first;
  const megabytes = speech?.size ? `${Math.round(speech.size / 1_000_000)} MB` : "";
  const status = !speech
    ? "Checking…"
    : speech.state === "ready"
      ? "Ready"
      : speech.state === "downloading"
        ? `Fetching the speech model, ${Math.round(speech.progress * 100)}%`
        : speech.state === "failed"
          ? `Couldn't set up: ${speech.error ?? "unknown error"}`
          : `Not set up yet${megabytes ? ` (${megabytes} download)` : ""}`;
  return (
    <>
      <h2>Voice</h2>
      <div className="card">
        <Row title="Dictation" hint="Press the mic in the message box and talk. It runs on this computer, so what you say stays here and costs nothing. Enter or a second press puts the words in the box.">
          <span className="mono">{status}</span>
        </Row>
        {speech && (speech.state === "missing" || speech.state === "failed") && (
          <Row title="Set up now" hint="Fetches the speech model once, so the first press of the mic starts listening straight away.">
            <button className="btn" onClick={() => void call("speech.prepare", {}).catch(fail)}>
              {speech.state === "failed" ? "Try again" : "Set up"}
            </button>
          </Row>
        )}
        <Row title="Speech model" hint="NVIDIA Parakeet TDT-CTC 110M (CC BY 4.0), run with transcribe.cpp (MIT).">
          <span className="mono">Parakeet 110M</span>
        </Row>
      </div>
    </>
  );
}

const SKILL_PROMPT =
  "Write a skill for this project, the kind your agent loads when it's relevant. Ask me what it should do first, then put it where you load project skills from, with a short name and a description that says when to use it.";

/** The skills and hooks the project's agents load, with a switch per skill. */
function Skills(props: { projects: Project[]; start: string | null; draft(projectId: string, text: string): void; openFile(projectId: string, path: string): void; fail(error: unknown): void }) {
  const [projectId, setProjectId] = useState(props.start && props.projects.some((p) => p.id === props.start) ? props.start : (props.projects[0]?.id ?? null));
  const [found, setFound] = useState<{ skills: SkillEntry[]; hooks: HookEntry[] } | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  useEffect(() => {
    setFound(null);
    if (projectId) call("project.skills", { projectId }).then(setFound).catch(props.fail);
  }, [projectId]);
  if (!projectId) return (<><h2>Skills and hooks</h2><p className="muted">Add a project first.</p></>);
  const toggle = (skill: SkillEntry, enabled: boolean) => {
    setBusyPath(skill.path);
    call("project.toggleSkill", { projectId, path: skill.path, enabled })
      .then(({ skills }) => setFound((current) => (current ? { ...current, skills } : current)))
      .catch(props.fail)
      .finally(() => setBusyPath(null));
  };
  const group = (scope: "project" | "personal") => found?.skills.filter((skill) => skill.scope === scope) ?? [];
  const list = (skills: SkillEntry[]) =>
    skills.map((skill) => (
      <Row key={skill.path} title={skill.name} hint={`${skill.agent}${skill.description ? ` · ${skill.description}` : ""}`}>
        {skill.relative && (
          <button className="link" onClick={() => props.openFile(projectId, skill.relative!)}>
            Open
          </button>
        )}
        <Switch on={skill.enabled} onChange={(on) => busyPath !== skill.path && toggle(skill, on)} label={`${skill.name} skill`} />
      </Row>
    ));
  return (
    <>
      <h2>Skills and hooks</h2>
      <p className="sdesc">
        Skills are instructions an agent loads when they fit the task. Turning one off keeps it on disk; agents skip it until you turn it back on. New
        threads pick up changes.
      </p>
      {props.projects.length > 1 && (
        <label className="field skproj">
          <span>Project</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {props.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      )}
      {!found && <p className="muted">Looking…</p>}
      {found && (
        <>
          <h3>In this project</h3>
          <div className="card skills">
            {list(group("project"))}
            <Row title={group("project").length ? "Add another" : "No skills yet"} hint="An agent writes it with you and saves it where it loads skills from.">
              <button className="btn" onClick={() => props.draft(projectId, SKILL_PROMPT)}>Write a skill</button>
            </Row>
          </div>
          {group("personal").length > 0 && (
            <>
              <h3>Yours, in every project</h3>
              <div className="card skills">{list(group("personal"))}</div>
            </>
          )}
          <h3>Hooks</h3>
          <div className="card">
            {found.hooks.length === 0 && (
              <Row title="No hooks" hint="Hooks run a command when something happens in a session, such as after each file edit. Claude Code reads them from .claude/settings.json."><span /></Row>
            )}
            {found.hooks.map((hook, index) => (
              <Row key={`${hook.id}${index}`} title={`${hook.event}${hook.matcher ? ` · ${hook.matcher}` : ""}`} hint={`${hook.agent} · ${hook.scope === "project" ? "this project" : "every project"} · ${hook.file}${hook.off ? " · all hooks turned off in that file" : ""}${hook.enabled ? "" : " · off, kept aside by Arcex"}`}>
                <span className="mono hookrun" title={hook.run}>{hook.run}</span>
                <Switch
                  on={hook.enabled}
                  onChange={(on) => {
                    if (busyPath === hook.id) return;
                    setBusyPath(hook.id);
                    call("project.toggleHook", { projectId, id: hook.id, enabled: on })
                      .then(({ hooks }) => setFound((current) => (current ? { ...current, hooks } : current)))
                      .catch(props.fail)
                      .finally(() => setBusyPath(null));
                  }}
                  label={`${hook.event} hook`}
                />
              </Row>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** What agents carry between sessions: your personal instructions for each, and the notes Claude keeps per project. */
function Memory(props: { projects: Project[]; start: string | null; fail(error: unknown): void }) {
  const [personal, setPersonal] = useState<AgentMemory[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [projectId, setProjectId] = useState(props.start && props.projects.some((p) => p.id === props.start) ? props.start : (props.projects[0]?.id ?? null));
  const [notes, setNotes] = useState<MemoryNote[] | null>(null);
  const load = () => call("memory.personal", {}).then(setPersonal).catch(props.fail);
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    setNotes(null);
    if (projectId) call("memory.notes", { projectId }).then(setNotes).catch(() => setNotes([]));
  }, [projectId]);
  const save = () => {
    if (!editing) return;
    setSaving(true);
    call("memory.savePersonal", { agent: editing, text: draft })
      .then(() => {
        setEditing(null);
        return load();
      })
      .catch(props.fail)
      .finally(() => setSaving(false));
  };
  const project = props.projects.find((p) => p.id === projectId);
  return (
    <>
      <h2>Memory</h2>
      <p className="sdesc">What your agents carry from one session to the next. Project rules live in each project's instructions (Settings › Projects).</p>
      <h3>Your instructions, in every project</h3>
      <div className="card">
        {!personal && <p className="muted">Looking…</p>}
        {personal?.filter((entry) => entry.available).map((entry) => (
          <div key={entry.agent}>
            <Row
              title={entry.agent}
              hint={`${entry.text?.trim() ? `${entry.text.trim().split(/\s+/).length} words` : "Nothing yet"} · ${entry.path}`}
            >
              {editing !== entry.agent && (
                <button className="btn" onClick={() => { setEditing(entry.agent); setDraft(entry.text ?? ""); }}>
                  {entry.text?.trim() ? "Edit" : "Write"}
                </button>
              )}
            </Row>
            {editing === entry.agent && (
              <div className="ieditor">
                <textarea
                  className="textfield"
                  value={draft}
                  autoFocus
                  spellCheck
                  maxLength={200_000}
                  rows={12}
                  placeholder={"For example:\n- Explain changes in plain words.\n- Ask before adding a paid service."}
                  aria-label={`${entry.agent}'s instructions for every project`}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setEditing(null);
                    if (event.key === "s" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      save();
                    }
                  }}
                />
                <div className="btns">
                  <button className="btn primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
                  <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
                  <span className="muted">Only {entry.agent} reads this file, in every project.</span>
                </div>
              </div>
            )}
          </div>
        ))}
        {personal && !personal.some((entry) => entry.available) && <p className="muted">Set up an agent first; its instructions file appears here.</p>}
      </div>
      <h3>What Claude remembers{project ? ` about ${project.name}` : ""}</h3>
      {props.projects.length > 1 && (
        <label className="field skproj">
          <span>Project</span>
          <select value={projectId ?? ""} onChange={(event) => setProjectId(event.target.value)}>
            {props.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      )}
      <div className="card">
        {!notes && <p className="muted">Looking…</p>}
        {notes?.length === 0 && <p className="muted">Claude hasn't saved notes for this project. It writes them as it learns how you like to work.</p>}
        {notes?.map((note) => (
          <details key={note.name} className="memnote">
            <summary>
              <span className="trunc">{note.name.replace(/\.md$/, "")}</span>
              <span className="when">{ago(note.changed)}</span>
            </summary>
            <pre>{note.text}</pre>
          </details>
        ))}
      </div>
    </>
  );
}

type ConnectorDraft = { id?: string; name: string; scope: string; kind: "command" | "web"; command: string; url: string; pairs: string; on: boolean };
const EMPTY_CONNECTOR: ConnectorDraft = { name: "", scope: "all", kind: "command", command: "", url: "", pairs: "", on: true };

/** "NAME=value" lines for variables, "Name: value" lines for headers. */
function readPairs(text: string, kind: "command" | "web"): { name: string; value: string }[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = kind === "web" ? line.indexOf(":") : line.indexOf("=");
    if (at < 1) throw new Error(kind === "web" ? `Write each header as Name: value ("${line.slice(0, 30)}")` : `Write each variable as NAME=value ("${line.slice(0, 30)}")`);
    return { name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
  });
}
const writePairs = (list: { name: string; value: string }[] | undefined, kind: "command" | "web") =>
  (list ?? []).map((pair) => (kind === "web" ? `${pair.name}: ${pair.value}` : `${pair.name}=${pair.value}`)).join("\n");

/** MCP servers the user added. Agents get them when a session starts, in every project or in one. */
function Connectors(props: { connectors: Connector[]; projects: Project[]; start: string | null; fail(error: unknown): void }) {
  const [draft, setDraft] = useState<ConnectorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState<Record<string, { busy?: boolean; tools?: string[]; error?: string }>>({});
  const where = (scope: string) => (scope === "all" ? "Every project" : (props.projects.find((p) => p.id === scope)?.name ?? "A removed project"));
  const toConnector = (d: ConnectorDraft): Partial<Connector> => ({
    ...(d.id ? { id: d.id } : {}),
    name: d.name.trim(),
    scope: d.scope,
    on: d.on,
    kind: d.kind,
    ...(d.kind === "web" ? { url: d.url.trim(), headers: readPairs(d.pairs, "web") } : { command: d.command.trim(), env: readPairs(d.pairs, "command") }),
  });
  const test = (key: string, connector: Partial<Connector>) => {
    setTests((current) => ({ ...current, [key]: { busy: true } }));
    call("connectors.test", { connector })
      .then((result) => setTests((current) => ({ ...current, [key]: { tools: result.tools } })))
      .catch((error: unknown) => setTests((current) => ({ ...current, [key]: { error: error instanceof Error ? error.message : String(error) } })));
  };
  const save = () => {
    if (!draft) return;
    let connector: Partial<Connector>;
    try {
      connector = toConnector(draft);
    } catch (error) {
      props.fail(error);
      return;
    }
    setSaving(true);
    call("connectors.save", { connector })
      .then(() => setDraft(null))
      .catch(props.fail)
      .finally(() => setSaving(false));
  };
  const result = (key: string) => {
    const state = tests[key];
    if (!state) return null;
    if (state.busy) return <p className="ctest">Starting it…</p>;
    if (state.error) return <p className="ctest bad">{state.error}</p>;
    return <p className="ctest good">Works. {state.tools!.length ? `${plural(state.tools!.length, "tool")}: ${state.tools!.slice(0, 12).join(", ")}${state.tools!.length > 12 ? "…" : ""}` : "It offers no tools."}</p>;
  };
  return (
    <>
      <h2>Connectors</h2>
      <p className="sdesc">
        Connectors give agents more tools, such as a database, a design file or an issue tracker, through MCP servers. Each agent starts or reaches them
        itself when a thread begins, so new threads pick up changes. Keys you enter stay on this computer.
      </p>
      {(props.connectors.length > 0 || !draft) && <div className="card">
        {props.connectors.length === 0 && !draft && (
          <Row title="No connectors yet" hint="Add one with the command its instructions give, or its web address.">
            <span />
          </Row>
        )}
        {props.connectors.map((connector) => (
          <div key={connector.id} className="srow cconn">
            <div>
              <b>{connector.name}</b>
              <p>
                {where(connector.scope)}
                {(connector.kind === "web" ? connector.headers : connector.env)?.length ? ` · ${plural((connector.kind === "web" ? connector.headers : connector.env)!.length, connector.kind === "web" ? "header" : "variable")}` : ""}
                <span className="mono" title={connector.kind === "web" ? connector.url : connector.command}>{connector.kind === "web" ? connector.url : connector.command}</span>
              </p>
              {result(connector.id)}
            </div>
            <div className="control">
              <button className="link" disabled={tests[connector.id]?.busy} onClick={() => test(connector.id, connector)}>Test</button>
              <button className="link" onClick={() => setDraft({ id: connector.id, name: connector.name, scope: connector.scope, kind: connector.kind, command: connector.command ?? "", url: connector.url ?? "", pairs: writePairs(connector.kind === "web" ? connector.headers : connector.env, connector.kind), on: connector.on })}>Edit</button>
              <button className="link" onClick={() => void call("connectors.remove", { id: connector.id }).catch(props.fail)}>Remove</button>
              <Switch on={connector.on} onChange={(on) => void call("connectors.save", { connector: { ...connector, on } }).catch(props.fail)} label={`${connector.name} connector`} />
            </div>
          </div>
        ))}
        {!draft && (
          <Row title="">
            <button className="btn primary" onClick={() => setDraft({ ...EMPTY_CONNECTOR, scope: "all" })}>Add a connector</button>
          </Row>
        )}
      </div>}
      {draft && (
        <>
          <h2 className="sub2">{draft.id ? `Change ${draft.name || "connector"}` : "Add a connector"}</h2>
          <div className="card">
            <Row title="Name" hint="A short name agents see, such as github or figma.">
              <input className="textfield" value={draft.name} maxLength={40} placeholder="github" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Row>
            <Row title="How it runs">
              <Choice value={draft.kind} options={[["command", "A command"], ["web", "A web address"]]} onChange={(kind) => setDraft({ ...draft, kind })} />
            </Row>
            {draft.kind === "command" ? (
              <Row title="Command" hint="The command from the server's instructions.">
                <input className="textfield mono" value={draft.command} maxLength={2000} placeholder="npx -y @example/mcp-server" onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
              </Row>
            ) : (
              <Row title="Address" hint="The server's MCP address. Some agents can only use connectors that run as a command.">
                <input className="textfield mono" value={draft.url} maxLength={2000} placeholder="https://example.com/mcp" onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
              </Row>
            )}
            <Row title={draft.kind === "web" ? "Headers" : "Environment variables"} hint={draft.kind === "web" ? "Optional. One per line, as Name: value, such as Authorization: Bearer your-key." : "Optional. One per line, as NAME=value, such as API_KEY=your-key."}>
              <textarea className="textfield mono cpairs" value={draft.pairs} rows={3} spellCheck={false} onChange={(event) => setDraft({ ...draft, pairs: event.target.value })} />
            </Row>
            <Row title="Use in">
              <select className="textfield" value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value })}>
                <option value="all">Every project</option>
                {props.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Row>
            <div className="srow">
              <div>{result("draft")}</div>
              <div className="control">
                <button
                  className="btn"
                  disabled={tests.draft?.busy || !draft.name.trim() || !(draft.kind === "web" ? draft.url.trim() : draft.command.trim())}
                  onClick={() => {
                    try {
                      test("draft", toConnector(draft));
                    } catch (error) {
                      props.fail(error);
                    }
                  }}
                >
                  Test
                </button>
                <button className="btn" onClick={() => { setDraft(null); setTests((current) => ({ ...current, draft: undefined! })); }}>Cancel</button>
                <button className="btn primary" disabled={saving || !draft.name.trim() || !(draft.kind === "web" ? draft.url.trim() : draft.command.trim())} onClick={save}>
                  {saving ? "Saving…" : draft.id ? "Save" : "Add connector"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
