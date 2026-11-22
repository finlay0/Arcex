import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderStatus, Thread } from "@arcex/contracts";
import type { Choice } from "./ModelPicker.tsx";
import { SettingsView, initials, type Section } from "./Settings.tsx";
import { Icon, Menu, Resizer, ago, busy, dotClass, nameOf, prefs, setAgents, stateLabel, type Actions } from "./shared.tsx";
import sprite from "./sprite.svg?raw";
import { call, loadItems, reconnect, saveDraft, useStore } from "./store.ts";
import { ToolboxView } from "./Toolbox.tsx";
import { Palette, type PaletteEntry } from "./Palette.tsx";
import { OPEN_FILE } from "./md.tsx";
import { Conversation, NewProject, OPEN_PREVIEW, Panel, REVIEW_PROMPT, type PanelTab } from "./views.tsx";

/** What the main column is showing. */
type Screen =
  | { kind: "thread"; threadId: string | null }
  | { kind: "new-project" }
  | { kind: "toolbox" }
  | { kind: "settings"; section: Section };

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const remembered = (key: string) => localStorage.getItem(key);


/** The Update button of a development build: quiet until there is newer code, then rebuilds and restarts onto it. */
function UpdateButton({ fail }: { fail: (error: unknown) => void }) {
  const desktop = window.arcex;
  const [info, setInfo] = useState<{ behind: number; changed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!desktop?.checkForUpdate) return;
    const check = () => void desktop.checkForUpdate?.().then(setInfo).catch(() => {});
    check();
    const timer = setInterval(check, 120_000);
    window.addEventListener("focus", check);
    return () => (clearInterval(timer), window.removeEventListener("focus", check));
  }, [desktop]);
  const ready = !!info && (info.behind > 0 || info.changed);
  if (!desktop?.update || !ready) return null;
  const hint = info.behind > 0
    ? `${info.behind} new ${info.behind === 1 ? "change" : "changes"} on GitHub. Arcex rebuilds and restarts onto them.`
    : "The code changed since Arcex started. Arcex rebuilds and restarts onto it.";
  const update = async () => {
    setBusy(true);
    try {
      const result = await desktop.update!();
      // Show the error and the last few lines of what went wrong, so it can be pasted to an agent to fix.
      if (result.error) fail(new Error(result.detail ? [result.error, "", ...result.detail.trim().split(/\r?\n/).slice(-6)].join("\n") : result.error));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="updatebar">
      <button className="update" title={hint} disabled={busy} onClick={() => void update()}>
        <span className="dot ok" />
        <span className="fill">{busy ? "Updating Arcex…" : "Update ready"}</span>
        {!busy && <span className="go">Restart</span>}
      </button>
    </div>
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
  // "Open preview" in a turn shows the project's running app in the side panel.
  useEffect(() => {
    const show = () => {
      setPanel(true);
      setTab("browser");
    };
    window.addEventListener(OPEN_PREVIEW, show);
    return () => window.removeEventListener(OPEN_PREVIEW, show);
  }, []);
  // A file named in a reply opens in the side panel's file viewer.
  const [openFile, setOpenFile] = useState<{ path: string; line: number | null; nonce: number } | null>(null);
  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as CustomEvent<{ path: string; line: number | null }>).detail;
      if (!detail?.path) return;
      setPanel(true);
      setTab("details");
      setOpenFile({ path: detail.path, line: detail.line, nonce: Date.now() });
    };
    window.addEventListener(OPEN_FILE, show);
    return () => window.removeEventListener(OPEN_FILE, show);
  }, []);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [status, setStatus] = useState<ProviderStatus[] | null>(null);
  // The last agent, model and options picked for a new thread, kept across restarts like the other apps do.
  const [choice, setChoiceState] = useState<Choice | null>(() => {
    try {
      const saved = JSON.parse(remembered("arcex:choice") ?? "null") as Choice | null;
      return saved && typeof saved.agentId === "string" ? saved : null;
    } catch {
      return null;
    }
  });
  const setChoice = (next: Choice) => {
    setChoiceState(next);
    try {
      localStorage.setItem("arcex:choice", JSON.stringify(next));
    } catch {
      // Not saved; the pick still applies until the app closes.
    }
  };
  // Text placed in the new-thread box by another screen, such as the toolbox.
  const [seed, setSeed] = useState("");
  const [unassignedDraft, setUnassignedDraft] = useState("");

  const overlay = screen.kind === "settings" || screen.kind === "toolbox";
  // When an agent uses the browser of the project on screen, show it so the user can watch.
  useEffect(() => {
    if (!store.browse || store.browse.projectId !== projectId) return;
    setPanel(true);
    setTab("browser");
  }, [store.browse]);
  /** Moves to a screen, remembering where to come back to from Settings or the Toolbox. */
  const setScreen = (next: Screen) => {
    if (screen.kind === "thread" || screen.kind === "new-project") setLast(screen);
    setScreenRaw(next);
  };
  const back = () => setScreenRaw(last);

  const live = useMemo(() => store.threads.filter((t) => !t.archived), [store.threads]);
  const thread = screen.kind === "thread" ? live.find((t) => t.id === screen.threadId) ?? null : null;
  const project = store.projects.find((p) => p.id === (thread?.projectId ?? projectId)) ?? null;
  // When each thread was last looked at. A thread that moved on since, while the user was elsewhere, shows a dot.
  const [seen, setSeen] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(remembered("arcex:seen") ?? "null") ?? {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    // The first time, everything already there counts as read.
    if (remembered("arcex:seen") === null && store.threads.length) {
      setSeen(Object.fromEntries(store.threads.map((t) => [t.id, t.updatedAt])));
    }
  }, [store.threads.length > 0]);
  useEffect(() => {
    if (thread && (seen[thread.id] ?? 0) < thread.updatedAt) setSeen((current) => ({ ...current, [thread.id]: thread.updatedAt }));
  }, [thread?.id, thread?.updatedAt]);
  useEffect(() => {
    try {
      const known = new Set(store.threads.map((t) => t.id));
      if (store.threads.length) localStorage.setItem("arcex:seen", JSON.stringify(Object.fromEntries(Object.entries(seen).filter(([id]) => known.has(id)))));
    } catch {
      // Not saved; dots may come back after a restart.
    }
  }, [seen]);
  const unread = (t: Thread) => t.id !== thread?.id && !busy(t) && t.state !== "needs_you" && t.updatedAt > (seen[t.id] ?? Infinity);
  const threads = useMemo(() => live.filter((t) => t.projectId === project?.id), [live, project?.id]);
  const view: Screen = store.projects.length === 0 && screen.kind === "thread" ? { kind: "new-project" } : screen;
  const panelOpen = panel ?? settings?.showDetails ?? true;
  const preferred = status?.find((agent) => agent.id === settings?.defaultProvider);
  const alternative = preferred && (!preferred.installed || preferred.signedIn === false)
    ? status?.find((agent) => agent.installed && agent.signedIn === true)
    : undefined;
  const picked: Choice = choice && store.agents.some((agent) => agent.id === choice.agentId)
    ? choice
    : { agentId: alternative?.id ?? settings?.defaultProvider ?? "claude", model: alternative ? null : settings?.defaultModel ?? null };

  setAgents(store.agents);
  if (settings) prefs.sendWith = settings.sendWith;

  // Theme, including following the system setting.
  const [systemIsDark, setSystemIsDark] = useState(systemDark.matches);
  useEffect(() => {
    const onChange = () => setSystemIsDark(systemDark.matches);
    systemDark.addEventListener("change", onChange);
    return () => systemDark.removeEventListener("change", onChange);
  }, []);
  const theme = settings?.theme === "system" ? (systemIsDark ? "dark" : "light") : settings?.theme ?? "dark";
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.arcex?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (project) localStorage.setItem("arcex:project", project.id);
  }, [project?.id]);
  useEffect(() => localStorage.setItem("arcex:expanded", JSON.stringify([...expanded])), [expanded]);
  useEffect(() => {
    for (const t of threads) void loadItems(t.id).catch(() => {});
  }, [threads, store.status]);
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
  const screenRef = useRef(setScreen);
  screenRef.current = setScreen;
  const terminalOn = useRef(false);
  terminalOn.current = settings?.terminal ?? false;
  const detailsDefault = useRef(settings?.showDetails ?? true);
  detailsDefault.current = settings?.showDetails ?? true;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && overlayRef.current && !document.querySelector(".mpop, .menu, .palette")) return backRef.current();
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.key === "b") setSidebar((open) => !open);
      else if (event.key === "j") setPanel((open) => !(open ?? detailsDefault.current));
      else if (event.key === "n") screenRef.current({ kind: "thread", threadId: null });
      else if (event.key === ",") screenRef.current({ kind: "settings", section: "general" });
      else if (event.key === "k") setPalette((open) => !open);
      else if (event.key === "`" && terminalOn.current) {
        setPanel(true);
        setTab("terminal");
      }
      else return;
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
      const wasBusy = before === "working" || before === "starting" || before === "needs_you" || before === "stopping";
      const body = t.state === "needs_you" ? "Needs your OK to continue" : t.state === "idle" && wasBusy ? "Finished" : t.state === "failed" || t.state === "interrupted" ? stateLabel(t) : null;
      if (body && "Notification" in window && Notification.permission === "granted") new Notification(t.title, { body });
    }
  }, [store.threads, settings?.notify]);

  const fail = (error: unknown) => setToast(error instanceof Error ? error.message : String(error));
  const actions: Actions = {
    fail,
    prompt: (id, text, attachments) => call("thread.prompt", { threadId: id, text, attachments }),
    cancel: (id) => call("thread.cancel", { threadId: id }).catch(fail),
    answer: (id, itemId, optionId) => call("ask.answer", { threadId: id, itemId, optionId }).catch(fail),
  };
  const openThread = (t: Thread) => {
    setProjectId(t.projectId);
    setExpanded((open) => new Set(open).add(t.projectId));
    setScreen({ kind: "thread", threadId: t.id });
  };
  const newThreadIn = (id: string | null) => {
    if (id) pickProject(id);
    setScreen({ kind: "thread", threadId: null });
  };
  const pickProject = (id: string) => {
    if (unassignedDraft) {
      const existing = store.drafts[id];
      if (existing && existing.length + unassignedDraft.length + 2 > 20_000) {
        fail("This project already has a long draft. Send or clear it before moving the other draft here.");
        return;
      }
      saveDraft({ projectId: id }, [existing, unassignedDraft].filter(Boolean).join("\n\n"));
      setUnassignedDraft("");
    }
    setProjectId(id);
  };
  const startThread = async (text: string, attachments: string[] = []) => {
    if (!project) throw new Error("Choose a project for this thread.");
    const created = await call("thread.create", { projectId: project.id, provider: picked.agentId, model: picked.model, choices: picked.choices ?? {}, text, attachments });
    void call("settings.set", { defaultProvider: picked.agentId, defaultModel: picked.model }).catch(() => {});
    setSeed("");
    setExpanded((open) => new Set(open).add(project.id));
    setScreen({ kind: "thread", threadId: created.id });
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

  // Everything Ctrl+K can reach. Threads waiting on the user come first, so one place lists them all.
  const projectName = (id: string) => store.projects.find((p) => p.id === id)?.name ?? "";
  const threadEntry = (t: Thread, group: string, hint?: string): PaletteEntry => ({
    id: `thread:${t.id}`,
    group,
    label: t.title,
    hint: hint ?? [projectName(t.projectId), stateLabel(t)].filter(Boolean).join(" · "),
    icon: "chat",
    run: () => openThread(t),
  });
  const paletteEntries = (): PaletteEntry[] => {
    const byRecent = [...live].sort((a, b) => b.updatedAt - a.updatedAt);
    const waiting = byRecent.filter((t) => t.state === "needs_you");
    const settingsAt = (section: Section, label: string, icon = "gear"): PaletteEntry => ({ id: `settings:${section}`, group: "Settings", label, icon, run: () => setScreen({ kind: "settings", section }) });
    return [
      ...waiting.map((t) => threadEntry(t, "Needs you")),
      { id: "new-thread", group: "Actions", label: "New thread", icon: "plus", keys: "Ctrl N", run: () => newThreadIn(project?.id ?? null) },
      { id: "new-project", group: "Actions", label: "New project", icon: "folder", run: () => setScreen({ kind: "new-project" }) },
      ...(project ? [{ id: "review", group: "Actions", label: `Review unsaved changes in ${project.name}`, icon: "search", run: () => void startThread(REVIEW_PROMPT).catch(fail) }] : []),
      { id: "sidebar", group: "Actions", label: sidebar ? "Hide sidebar" : "Show sidebar", icon: "sidebar", keys: "Ctrl B", run: () => setSidebar(!sidebar) },
      ...(project ? [
        { id: "details", group: "Actions", label: panelOpen && tab === "details" ? "Hide details panel" : "Show details panel", icon: "panel", keys: "Ctrl J", run: () => { setPanel(!(panelOpen && tab === "details")); setTab("details"); } },
        { id: "browser", group: "Actions", label: "Show the project's browser", icon: "globe", run: () => { setPanel(true); setTab("browser"); } },
        ...(settings?.terminal ? [{ id: "terminal", group: "Actions", label: "Show the terminal", icon: "code", keys: "Ctrl `", run: () => { setPanel(true); setTab("terminal"); } }] : []),
      ] : []),
      { id: "toolbox", group: "Actions", label: "Open the toolbox", icon: "box", run: () => setScreen({ kind: "toolbox" }) },
      ...(["dark", "light", "system"] as const).filter((value) => value !== settings?.theme).map((value) => ({
        id: `theme:${value}`, group: "Actions", label: value === "system" ? "Match the system theme" : `Switch to ${value} theme`, icon: value === "light" ? "sun" : "moon",
        run: () => void call("settings.set", { theme: value }).catch(fail),
      })),
      ...byRecent.filter((t) => t.state !== "needs_you").map((t) => threadEntry(t, "Threads")),
      ...store.projects.map((p) => ({ id: `project:${p.id}`, group: "Projects", label: p.name, hint: "New thread here", icon: "folder", run: () => newThreadIn(p.id) })),
      settingsAt("general", "General settings", "gear"),
      settingsAt("agents", "Agents and sign-in", "layers"),
      settingsAt("appearance", "Appearance", "sun"),
      settingsAt("projects", "Projects and instructions for agents", "folder"),
      settingsAt("archived", "Archived threads", "box"),
      settingsAt("shortcuts", "Keyboard shortcuts", "sliders"),
      settingsAt("profile", "Profile and account", "chat"),
      settingsAt("about", "About Arcex", "spark"),
    ];
  };

  // A dropped engine is reconnected on its own. A brief drop shows a small note; only a long one asks for attention.
  const connectionNotice = store.status === "lost"
    ? <div className="connection problem" role="status"><span className="dot needs" />Still reconnecting to the Arcex engine. Your work is saved. <button className="btn" onClick={() => void reconnect().catch(fail)}>Try now</button></div>
    : store.status === "reconnecting" ? <div className="connection" role="status"><span className="dot working" />Reconnecting…</div> : null;
  if (!settings || !store.about) return <div className="lost">{store.status === "lost" ? connectionNotice : <span className="starting" role="status">Starting Arcex…</span>}{toast && <p role="alert">{toast}</p>}</div>;

  const showPanel = panelOpen && !!project && view.kind === "thread";
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
          <button className="row" onClick={() => setPalette(true)}>
            <Icon name="search" /> Search <kbd>Ctrl K</kbd>
          </button>
        </nav>
        <div className="tree">
          <div className="label heading">
            Projects
            <button className="icon" aria-label="New project" title="New project" onClick={() => setScreen({ kind: "new-project" })}>
              <Icon name="plus" />
            </button>
          </div>
          {store.projects.length === 0 && <div className="none flat">Start your first project to see it here.</div>}
          {store.projects.map((p) => {
            const all = live.filter((t) => t.projectId === p.id).sort((a, b) => b.updatedAt - a.updatedAt);
            const mine = needle ? all.filter((t) => t.title.toLowerCase().includes(needle)) : all;
            if (needle && mine.length === 0) return null;
            const open = Boolean(needle) || expanded.has(p.id);
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
                  <button className="icon padd" aria-label={`New thread in ${p.name}`} title={`New thread in ${p.name}`} onClick={() => newThreadIn(p.id)}>
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
                    const dot = dotClass(t) ?? (unread(t) ? "dot unread" : null);
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
                      <div key={t.id} className="row thread" aria-current={t.id === thread?.id}>
                        <button className="thread-select" aria-current={t.id === thread?.id} title={stateLabel(t) || t.title} onClick={() => openThread(t)}>
                          <Icon name="chat" />
                          <span className={dot === "dot unread" ? "trunc unread" : "trunc"}>{t.title}</span>
                          {dot ? <span className={dot} aria-label={stateLabel(t) || "New activity"} role="img" /> : <span className="when">{ago(t.updatedAt)}</span>}
                        </button>
                        <Menu label={`Options for ${t.title}`} items={threadMenu(t)} />
                      </div>
                    );
                  })}
              </div>
            );
          })}
          {needle && !live.some((t) => t.title.toLowerCase().includes(needle)) && <div className="none flat">No thread matches "{query}".</div>}
        </div>
        <UpdateButton fail={fail} />
        <Resizer name="side-w" edge="right" min={220} max={() => Math.min(460, window.innerWidth - 640)} label="Resize the sidebar" />
        <div className="foot">
          <button className="row profile" title="Profile and settings" onClick={() => setScreen({ kind: "settings", section: "profile" })}>
            <span className="avatar">{initials(settings.name)}</span>
            <span className="trunc">{settings.name.trim() || "Your profile"}</span>
            <Icon name="gear" />
          </button>
        </div>
      </aside>

      <section className="main">
        <header className="top">
          <button className="icon" aria-pressed={sidebar} aria-label={sidebar ? "Hide sidebar" : "Show sidebar"} title={sidebar ? "Hide sidebar" : "Show sidebar"} onClick={() => setSidebar(!sidebar)}>
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
          {thread && stateLabel(thread) && <span className="tag live" role="status">{stateLabel(thread)}</span>}
          {thread && (
            <span className="tag">
              {nameOf(thread.provider)}
            </span>
          )}
          {project && view.kind === "thread" && (
            <>
              <button
                className="icon"
                aria-pressed={panelOpen && tab === "browser"}
                aria-label="Browser"
                title="Browser"
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
                title="Details"
                onClick={() => {
                  setPanel(!(panelOpen && tab === "details"));
                  setTab("details");
                }}
              >
                <Icon name="panel" />
              </button>
            </>
          )}
        </header>
        <div className="body">
          <div className="stage">
          {connectionNotice}

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
              setSeed(`Explain what ${tool.name} would add to this project, what I would need to sign up for, and the trade-offs. Wait for my approval before setting it up.`);
              setScreen({ kind: "thread", threadId: null });
            }}
          />
        ) : view.kind === "new-project" ? (
          <NewProject
            ready={store.status === "ready"}
            agents={store.agents}
            choice={picked}
            setChoice={setChoice}
            manageAgents={() => setScreen({ kind: "settings", section: "agents" })}
            fail={fail}
            start={async (p, text) => {
              setExpanded((open) => new Set(open).add(p.id));
              setProjectId(p.id);
              if (!text) return newThreadIn(p.id);
              const created = await call("thread.create", { projectId: p.id, provider: picked.agentId, model: picked.model, choices: picked.choices ?? {}, text });
              void call("settings.set", { defaultProvider: picked.agentId, defaultModel: picked.model }).catch(() => {});
              setScreen({ kind: "thread", threadId: created.id });
            }}
          />
        ) : (
          <Conversation
            key={thread?.id ?? `new:${project?.id ?? ""}`}
            seed={thread ? "" : seed}
            consumeSeed={() => setSeed("")}
            projects={store.projects}
            project={project}
            thread={thread}
            items={thread ? store.items[thread.id] ?? [] : []}
            agents={store.agents}
            status={status}
            choice={picked}
            setChoice={setChoice}
            pickProject={pickProject}
            newProject={() => setScreen({ kind: "new-project" })}
            manageAgents={() => setScreen({ kind: "settings", section: "agents" })}
            actions={actions}
            start={startThread}
            name={settings.name}
            drafts={store.drafts}
            unassignedDraft={unassignedDraft}
            setUnassignedDraft={setUnassignedDraft}
            connected={store.status === "ready"}
          />
        )}
          </div>
          {showPanel && project && (
            <Panel key={project.id} project={project} threads={threads} items={store.items} connected={store.status === "ready"} tab={tab} setTab={setTab} open={openThread} review={() => void startThread(REVIEW_PROMPT).catch(fail)} openFile={openFile} terminal={settings.terminal} fail={fail} close={() => setPanel(false)} />
          )}
        </div>
      </section>

      {palette && (
        <Palette
          entries={paletteEntries()}
          threadEntry={(id, snippet) => {
            const t = live.find((entry) => entry.id === id);
            return t ? threadEntry(t, "In messages", snippet) : null;
          }}
          close={() => setPalette(false)}
        />
      )}
      {toast && <div className="toast" role="alert">{toast}</div>}
    </div>
  );
}
