import { useEffect, useState, type ReactNode } from "react";
import type { About, Agent, Project, ProviderStatus, Settings as Prefs, Thread } from "@arcex/contracts";
import { Icon, ago, nameOf, plural } from "./shared.tsx";
import { call } from "./store.ts";

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
              <p className="sdesc">Your name is used inside the app on this computer. Arcex has no accounts, so nothing here is sent anywhere.</p>
              <div className="card who">
                <span className="avatar big">{initials(settings.name)}</span>
                <div>
                  <b>{settings.name || "No name yet"}</b>
                  <p>This computer</p>
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
                <Row title="Research library" hint="Lets your agents search Arcex's library of real products, their onboarding and pricing, when you ask. Searches go to arcex.dev.">
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
                  ["Find a thread", "Ctrl K"],
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
                <Row title="Usage" hint={`${plural(props.projects.length, "project")} and ${plural(props.threads.length, "thread")} on this computer.`}><span /></Row>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Agents({ agents, recheck, fail }: { agents: Agent[]; recheck(): void; fail(error: unknown): void }) {
  const [status, setStatus] = useState<ProviderStatus[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
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
        const ready = state?.installed && state.signedIn !== false;
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
                  {!agent.builtin ? "Added by you" : !state.installed ? "Not installed" : state.signedIn === false ? "Sign in needed" : state.signedIn === true ? "Ready" : "Installed"}
                </span>
              )}
              {!agent.builtin && <Confirm label="Remove" sure="Remove agent" run={() => call("agents.remove", { agentId: agent.id }).catch(fail)} />}
            </Row>
            {state && agent.builtin && state.installed && state.signedIn === false && state.signInCommand && (
              <Row title="Sign in" hint="Run this in a terminal, finish in your browser, then check again.">
                <button
                  className="btn mono"
                  onClick={() => {
                    void navigator.clipboard.writeText(state.signInCommand);
                    setCopied(agent.id);
                  }}
                >
                  {copied === agent.id ? "Copied" : state.signInCommand}
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

      <h2 className="sub2">Add an agent</h2>
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
