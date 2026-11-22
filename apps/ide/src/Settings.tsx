import { useEffect, useState, type ReactNode } from "react";
import type { About, Agent, DirectoryAgent, InstructionFile, Project, ProviderStatus, Settings as Prefs, Thread } from "@arcex/contracts";
import { Icon, ago, nameOf, plural } from "./shared.tsx";
import { call } from "./store.ts";
import { Account } from "./Account.tsx";
import { forgetModels } from "./ModelPicker.tsx";

export type Section = "profile" | "general" | "appearance" | "agents" | "projects" | "archived" | "shortcuts" | "about";
const SECTIONS: [Section, string][] = [
  ["profile", "Profile"],
  ["general", "General"],
  ["appearance", "Appearance"],
  ["agents", "Agents"],
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
                <Row title="Research library" hint="New agent sessions can search the library at arcex.dev when you ask. Already running sessions keep their current access.">
                  <Switch on={settings.research} onChange={(research) => set({ research })} label="Research library" />
                </Row>
                <Row title="Notify me" hint="When a thread finishes or needs your OK while Arcex is in the background.">
                  <Switch
                    on={settings.notify}
                    label="Notify me"
                    onChange={(notify) => {
                      if (notify && "Notification" in window && Notification.permission === "default") void Notification.requestPermission();
                      void set({ notify });
                    }}
                  />
                </Row>
              </div>
            </>
          )}

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
                {[
                  ["New thread", "Ctrl N"],
                  ["Show or hide the sidebar", "Ctrl B"],
                  ["Show or hide the details panel", "Ctrl J"],
                  ["Search threads, messages, settings and actions", "Ctrl K"],
                  ["Settings", "Ctrl ,"],
                  ["Back from Settings or the Toolbox", "Esc"],
                  ["Send a message", settings.sendWith === "enter" ? "Enter" : "Ctrl Enter"],
                  ["New line in a message", settings.sendWith === "enter" ? "Shift Enter" : "Enter"],
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
                <Row title="Voice dictation" hint="Runs on this computer, so what you say stays here. Speech model: NVIDIA Parakeet TDT-CTC 110M (CC BY 4.0), run with transcribe.cpp (MIT)."><span className="mono">Parakeet 110M</span></Row>
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
