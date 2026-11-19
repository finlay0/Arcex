import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderStatus, Thread } from "@arcex/contracts";
import type { Choice } from "./ModelPicker.tsx";
import { SettingsView, initials, type Section } from "./Settings.tsx";
import { Icon, ago, busy, dotClass, nameOf, prefs, setAgents, stateLabel, type Actions } from "./shared.tsx";
import sprite from "./sprite.svg?raw";
import { call, loadItems, openEmpty, useStore } from "./store.ts";
import { ToolboxView } from "./Toolbox.tsx";
import { Conversation, NewProject, Panel, type PanelTab } from "./views.tsx";

/** What the main column is showing. */
type Screen =
  | { kind: "thread"; threadId: string | null }
  | { kind: "new-project" }
  | { kind: "toolbox" }
  | { kind: "settings"; section: Section };

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const remembered = (key: string) => localStorage.getItem(key);

/** A small menu that opens under its button and closes on any outside click. Risky items ask twice. */
function Menu({ label, items }: { label: string; items: { label: string; danger?: boolean; run(): void }[] }) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return setArmed(null);
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <span className="menuwrap">
      <button
        className="icon more"
        aria-label={label}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        <Icon name="dots" />
      </button>
      {open && (
        <span className="menu" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              onClick={(event) => {
                // Choosing an item must not also trigger whatever the menu sits on.
                event.stopPropagation();
                if (item.danger && armed !== item.label) return setArmed(item.label);
                setOpen(false);
                item.run();
              }}
            >
              {item.danger && armed === item.label ? "Click again to confirm" : item.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export function App() {
  const store = useStore();
  const settings = store.settings;
  // The project a new thread will go into. Never guessed: it is the one last worked in, or nothing.
  const [projectId, setProjectId] = useState<string | null>(() => remembered("arcex:project"));
  const [screen, setScreenRaw] = useState<Screen>({ kind: "thread", threadId: null });
  const [last, setLast] = useState<Screen>({ kind: "thread", threadId: null });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(JSON.parse(remembered("arcex:expanded") ?? "[]") as string[]));
  const [sidebar, setSidebar] = useState(true);
  const [panel, setPanel] = useState<boolean | null>(null);
  const [tab, setTab] = useState<PanelTab>("details");
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [status, setStatus] = useState<ProviderStatus[] | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  // Text placed in the new-thread box by another screen, such as the toolbox.
  const [seed, setSeed] = useState("");
  const search = useRef<HTMLInputElement>(null);

  const overlay = screen.kind === "settings" || screen.kind === "toolbox";
  /** Moves to a screen, remembering where to come back to from Settings or the Toolbox. */
  const setScreen = (next: Screen) => {
    if (screen.kind === "thread" || screen.kind === "new-project") setLast(screen);
    setScreenRaw(next);
  };
  const back = () => setScreenRaw(last);

  const live = useMemo(() => store.threads.filter((t) => !t.archived), [store.threads]);
  const thread = screen.kind === "thread" ? live.find((t) => t.id === screen.threadId) ?? null : null;
  const project = store.projects.find((p) => p.id === (thread?.projectId ?? projectId)) ?? null;
  const threads = useMemo(() => live.filter((t) => t.projectId === project?.id), [live, project?.id]);
  const view: Screen = store.projects.length === 0 && screen.kind === "thread" ? { kind: "new-project" } : screen;
  const panelOpen = panel ?? settings?.showDetails ?? true;
  const picked: Choice = choice ?? { agentId: settings?.defaultProvider ?? "claude", model: settings?.defaultModel ?? null };

  setAgents(store.agents);
  if (settings) prefs.sendWith = settings.sendWith;

  // Theme, including following the system setting.
  const [systemIsDark, setSystemIsDark] = useState(systemDark.matches);
  useEffect(() => {
    const onChange = () => setSystemIsDark(systemDark.matches);
    systemDark.addEventListener("change", onChange);
    return () => systemDark.removeEventListener("change", onChange);
  }, []);
  const theme = settings?.theme === "system" ? (systemIsDark ? "dark" : "light") : settings?.theme ?? "light";
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.arcex?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (project) localStorage.setItem("arcex:project", project.id);
  }, [project?.id]);
  useEffect(() => localStorage.setItem("arcex:expanded", JSON.stringify([...expanded])), [expanded]);
  useEffect(() => {
    for (const t of threads) void loadItems(t.id);
  }, [threads]);
  useEffect(() => {
    if (store.status === "ready") call("providers.status", {}).then(setStatus).catch(() => {});
  }, [store.status, store.agents.length]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && overlayRef.current && !document.querySelector(".mpop, .menu")) return backRef.current();
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.key === "b") setSidebar((open) => !open);
      else if (event.key === "j") setPanel((open) => !(open ?? true));
      else if (event.key === "n") setScreenRaw({ kind: "thread", threadId: null });
      else if (event.key === ",") setScreenRaw((current) => (current.kind === "settings" ? current : { kind: "settings", section: "general" }));
      else if (event.key === "k") {
        setSidebar(true);
        setTimeout(() => search.current?.focus());
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Tell the user when a thread finishes or needs them while they are looking elsewhere.
  const lastStates = useRef(new Map<string, Thread["state"]>());
  useEffect(() => {
    for (const t of store.threads) {
      const before = lastStates.current.get(t.id);
      lastStates.current.set(t.id, t.state);
      if (!before || before === t.state || !settings?.notify || document.hasFocus()) continue;
      const wasBusy = before === "working" || before === "starting";
      const body = t.state === "needs_you" ? "Needs your OK to continue" : t.state === "idle" && wasBusy ? "Finished" : t.state === "failed" ? "Stopped with a problem" : null;
      if (body && "Notification" in window && Notification.permission === "granted") new Notification(t.title, { body });
    }
  }, [store.threads, settings?.notify]);

  const fail = (error: unknown) => setToast(error instanceof Error ? error.message : String(error));
  const actions: Actions = {
    fail,
    prompt: (id, text) => call("thread.prompt", { threadId: id, text }).catch(fail),
    cancel: (id) => call("thread.cancel", { threadId: id }).catch(fail),
    answer: (id, itemId, optionId) => call("ask.answer", { threadId: id, itemId, optionId }).catch(fail),
  };
  const openThread = (t: Thread) => setScreen({ kind: "thread", threadId: t.id });
  const newThreadIn = (id: string | null) => {
    if (id) setProjectId(id);
    setScreen({ kind: "thread", threadId: null });
  };
  const startThread = async (text: string) => {
    if (!project) return;
    try {
      const created = await call("thread.create", { projectId: project.id, provider: picked.agentId, model: picked.model, text });
      // The next new thread starts with whatever was used last.
      void call("settings.set", { defaultProvider: picked.agentId, defaultModel: picked.model }).catch(() => {});
      openEmpty(created.id);
      setSeed("");
      setExpanded((open) => new Set(open).add(project.id));
      setScreen({ kind: "thread", threadId: created.id });
    } catch (error) {
      fail(error);
    }
  };
  const threadMenu = (t: Thread) => [
    {
      label: "Rename",
      run: () => {
        setSidebar(true);
        setExpanded((open) => new Set(open).add(t.projectId));
        setRenaming(t.id);
      },
    },
    { label: "Archive", run: () => void call("thread.update", { threadId: t.id, archived: true }).catch(fail) },
    { label: "Delete", danger: true, run: () => void call("thread.remove", { threadId: t.id }).catch(fail) },
  ];

  if (store.status === "lost") return <div className="lost">Arcex lost its connection to the engine. Close and reopen the app.</div>;
  if (!settings || !store.about) return <div className="lost" />;

  const showPanel = panelOpen && !!project && view.kind === "thread";
  const ready = status?.filter((agent) => agent.installed && agent.signedIn === true).length ?? 0;
  const title = view.kind === "toolbox" ? "Toolbox" : view.kind === "new-project" ? "New project" : view.kind === "settings" ? "Settings" : thread ? thread.title : "New thread";
  const needle = query.trim().toLowerCase();

  return (
    <div className={window.arcex ? "app desktop" : "app"}>
      <div style={{ position: "absolute", width: 0, height: 0 }} dangerouslySetInnerHTML={{ __html: sprite }} />

      <aside className={sidebar ? "sidebar" : "sidebar shut"}>
        <div className="brand">
          <img className="mark lockup" src="./lockup.png" alt="Arcex" />
        </div>
        <nav className="nav">
          <button className="newbtn" onClick={() => newThreadIn(null)}>
            <Icon name="plus" /> New thread <kbd>Ctrl N</kbd>
          </button>
          <button className="row" aria-current={view.kind === "toolbox"} onClick={() => setScreen({ kind: "toolbox" })}>
            <Icon name="box" /> Tools
          </button>
          <button className="row" aria-current={view.kind === "settings" && view.section === "agents"} onClick={() => setScreen({ kind: "settings", section: "agents" })}>
            <Icon name="layers" /> Agents
          </button>
          <button className="row" aria-current={view.kind === "settings" && view.section !== "agents"} onClick={() => setScreen({ kind: "settings", section: "general" })}>
            <Icon name="gear" /> Settings
          </button>
          <label className="row find">
            <Icon name="search" />
            <input ref={search} value={query} placeholder="Find a thread" aria-label="Find a thread" onChange={(event) => setQuery(event.target.value)} />
            {query ? (
              <button className="icon" aria-label="Clear" onClick={() => setQuery("")}>
                <Icon name="x" />
              </button>
            ) : (
              <kbd>Ctrl K</kbd>
            )}
          </label>
        </nav>
        <div className="tree">
          <div className="label heading">
            Projects
            <button className="icon" aria-label="New project" onClick={() => setScreen({ kind: "new-project" })}>
              <Icon name="plus" />
            </button>
          </div>
          {store.projects.length === 0 && <div className="none flat">Start your first project to see it here.</div>}
          {store.projects.map((p) => {
            const all = live.filter((t) => t.projectId === p.id).sort((a, b) => b.updatedAt - a.updatedAt);
            const mine = needle ? all.filter((t) => t.title.toLowerCase().includes(needle)) : all;
            if (needle && mine.length === 0) return null;
            const open = needle ? true : expanded.has(p.id) || p.id === thread?.projectId;
            const attention = all.some((t) => t.state === "needs_you") ? "dot needs" : all.some(busy) ? "dot working" : null;
            return (
              <div key={p.id} className={open ? "group open" : "group"}>
                <div className="row phead">
                  <button
                    className="ptoggle"
                    aria-expanded={open}
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (open) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      })
                    }
                  >
                    <Icon name="chev" /> <Icon name="folder" /> <span className="trunc">{p.name}</span>
                    {!open && attention && <span className={attention} />}
                    {!open && !attention && all.length > 0 && <span className="when">{all.length}</span>}
                  </button>
                  <button className="icon padd" aria-label={`New thread in ${p.name}`} onClick={() => newThreadIn(p.id)}>
                    <Icon name="plus" />
                  </button>
                </div>
                {open && mine.length === 0 && (
                  <button className="none link" onClick={() => newThreadIn(p.id)}>
                    Start the first thread
                  </button>
                )}
                {open &&
                  mine.map((t) => {
                    const dot = dotClass(t);
                    if (renaming === t.id) {
                      return (
                        <input
                          key={t.id}
                          className="rename"
                          autoFocus
                          defaultValue={t.title}
                          maxLength={80}
                          aria-label="Thread name"
                          onFocus={(event) => event.currentTarget.select()}
                          onBlur={(event) => {
                            const name = event.currentTarget.value.trim();
                            if (name && name !== t.title) call("thread.update", { threadId: t.id, title: name }).catch(fail);
                            setRenaming(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") setRenaming(null);
                          }}
                        />
                      );
                    }
                    return (
                      <div key={t.id} className="row thread" role="button" tabIndex={0} aria-current={t.id === thread?.id} title={stateLabel(t) || undefined} onClick={() => openThread(t)} onKeyDown={(event) => event.key === "Enter" && openThread(t)}>
                        <Icon name="chat" />
                        <span className="trunc">{t.title}</span>
                        {dot ? <span className={dot} /> : <span className="when">{ago(t.updatedAt)}</span>}
                        <Menu label={`Options for ${t.title}`} items={threadMenu(t)} />
                      </div>
                    );
                  })}
              </div>
            );
          })}
          {needle && !live.some((t) => t.title.toLowerCase().includes(needle)) && <div className="none flat">No thread matches "{query}".</div>}
        </div>
        <div className="foot">
          <button className="row" onClick={() => setScreen({ kind: "settings", section: "agents" })}>
            <span className={!status ? "dot working" : ready > 0 ? "dot ok" : "dot needs"} />
            {!status ? "Checking agents" : ready === 0 ? "No agent ready" : ready === 1 ? "1 agent ready" : `${ready} agents ready`}
          </button>
        </div>
      </aside>

      <section className="main">
        <header className="top">
          <button className="icon" aria-pressed={sidebar} aria-label={sidebar ? "Hide sidebar" : "Show sidebar"} onClick={() => setSidebar(!sidebar)}>
            <Icon name="sidebar" />
          </button>
          {overlay && (
            <button className="backbtn" onClick={back}>
              <Icon name="back" /> Back <kbd>Esc</kbd>
            </button>
          )}
          {project && view.kind === "thread" && (
            <>
              <span className="sub trunc">{project.name}</span>
              <span className="slash">/</span>
            </>
          )}
          <h1 className="trunc">{title}</h1>
          {thread && <Menu label="Thread options" items={threadMenu(thread)} />}
          <span className="fill" />
          {thread && busy(thread) && <span className="tag live">{stateLabel(thread)}</span>}
          {thread && (
            <span className="tag">
              {nameOf(thread.provider)}
              {thread.model ? ` · ${thread.model.name}` : ""}
            </span>
          )}
          {project && view.kind === "thread" && (
            <>
              <button
                className="icon"
                aria-pressed={panelOpen && tab === "browser"}
                aria-label="Browser"
                onClick={() => {
                  setPanel(!(panelOpen && tab === "browser"));
                  setTab("browser");
                }}
              >
                <Icon name="globe" />
              </button>
              <button
                className="icon"
                aria-pressed={panelOpen && tab === "details"}
                aria-label="Details"
                onClick={() => {
                  setPanel(!(panelOpen && tab === "details"));
                  setTab("details");
                }}
              >
                <Icon name="panel" />
              </button>
            </>
          )}
          <button className="avabtn" aria-label="Profile" onClick={() => setScreen({ kind: "settings", section: "profile" })}>
            <span className="avatar">{initials(settings.name)}</span>
          </button>
        </header>
        <div className="body">
          <div className="stage">

        {view.kind === "settings" ? (
          <SettingsView
            section={view.section}
            go={(section) => setScreenRaw({ kind: "settings", section })}
            settings={settings}
            about={store.about}
            agents={store.agents}
            projects={store.projects}
            threads={store.threads}
            recheck={() => void call("providers.status", {}).then(setStatus).catch(() => {})}
            fail={fail}
          />
        ) : view.kind === "toolbox" ? (
          <ToolboxView
            fail={fail}
            use={(tool) => {
              setSeed(`Set up ${tool.name} in this project. First tell me in plain words what it will add and anything I need to sign up for, then do it.`);
              setScreen({ kind: "thread", threadId: null });
            }}
          />
        ) : view.kind === "new-project" ? (
          <NewProject
            first={store.projects.length === 0}
            ready={store.status === "ready"}
            fail={fail}
            created={(p) => {
              setExpanded((open) => new Set(open).add(p.id));
              newThreadIn(p.id);
            }}
          />
        ) : (
          <Conversation
            key={thread?.id ?? `new:${seed}`}
            seed={thread ? "" : seed}
            projects={store.projects}
            project={project}
            thread={thread}
            items={thread ? store.items[thread.id] ?? [] : []}
            agents={store.agents}
            status={status}
            choice={picked}
            setChoice={setChoice}
            pickProject={setProjectId}
            newProject={() => setScreen({ kind: "new-project" })}
            manageAgents={() => setScreen({ kind: "settings", section: "agents" })}
            actions={actions}
            start={startThread}
            name={settings.name}
          />
        )}
          </div>
          {showPanel && project && (
            <Panel key={project.id} project={project} threads={threads} items={store.items} tab={tab} setTab={setTab} open={openThread} fail={fail} close={() => setPanel(false)} />
          )}
        </div>
      </section>

      {toast && <div className="toast" role="alert">{toast}</div>}
    </div>
  );
}
