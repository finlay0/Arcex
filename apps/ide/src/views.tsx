import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Agent, Change, FileEntry, Item, Project, ProviderStatus, Thread } from "@arcex/contracts";
import { ModelPicker, type Choice } from "./ModelPicker.tsx";
import { Art } from "./Art.tsx";
import { Md } from "./md.tsx";
import { AutoText, Icon, STARTERS, ago, busy, nameOf, onEnter, plural, prefs, stateLabel, type Actions } from "./shared.tsx";
import { call, clearSentDraft, saveDraft } from "./store.ts";

type Step = Extract<Item, { kind: "step" }>;
type Ask = Extract<Item, { kind: "ask" }>;

/* ───────── New project ───────── */

export function NewProject(props: { ready: boolean; created(project: Project): void; fail(error: unknown): void }) {
  const [goal, setGoal] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const pick = async () => {
    try {
      const chosen = window.arcex ? await window.arcex.pickFolder() : window.prompt("Full path of the project folder");
      if (chosen) setFolder(chosen);
    } catch (error) {
      props.fail(error);
    }
  };
  const create = async () => {
    if ((!folder && !goal.trim()) || working || !props.ready) return;
    setWorking(true);
    try {
      props.created(await call("project.create", folder ? { goal: goal.trim(), cwd: folder } : { goal }));
    } catch (error) {
      props.fail(error);
    }
    setWorking(false);
  };

  return (
    <div className="hero">
      <Art />
      <div className="inner">
        <img className="mark logo" src="./mark.png" alt="" />
        <h2>{folder ? "Open an existing project" : "What are we building?"}</h2>
        <p className="lead">
          {folder ? "Use the folder as it is. You can add a project goal now or later."
            : "Describe your idea. Arcex creates a folder in Arcex Projects, then lets you review your first message before sending."}
        </p>
        <div className="composer">
          <AutoText
            autoFocus
            value={goal}
            aria-label={folder ? "Project goal (optional)" : "Project idea"}
            maxLength={2000}
            placeholder={folder ? "What are you building? (optional)" : "A fitness app where people log workouts and keep a streak"}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={onEnter(create)}
          />
          <div className="tools">
            <button className="chip" onClick={pick} title={folder ?? undefined} disabled={working}>
              <Icon name="folder" /> <span className="trunc">{folder ?? "Open a folder"}</span>
            </button>
            {folder && (
              <button className="icon" aria-label="Start with a new folder instead" onClick={() => setFolder(null)}>
                <Icon name="x" />
              </button>
            )}
            <span className="fill" />
            <button className="btn primary" onClick={create} disabled={!props.ready || working || (!folder && !goal.trim())}>
              {working ? "Opening…" : folder ? "Open project" : "Create project"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────── Conversation ───────── */

/** One message from the user and everything the agent did in response. */
type Turn = { id: string; user: string | null; parts: Exclude<Item, { kind: "user" | "step" }>[]; steps: Step[] };

function turns(items: Item[]): Turn[] {
  const out: Turn[] = [];
  for (const item of items) {
    if (item.kind === "user" || out.length === 0) out.push({ id: item.id, user: item.kind === "user" ? item.text : null, parts: [], steps: [] });
    const turn = out[out.length - 1]!;
    if (item.kind === "step") turn.steps.push(item);
    else if (item.kind !== "user") turn.parts.push(item);
  }
  return out;
}

function AskButtons({ thread, item, actions }: { thread: Thread; item: Ask; actions: Actions }) {
  return (
    <div className="btns">
      {item.options.map((option) => (
        <button
          key={option.id}
          className={option.kind.startsWith("allow") ? "btn primary" : "btn"}
          onClick={(event) => {
            event.stopPropagation();
            void actions.answer(thread.id, item.id, option.id);
          }}
        >
          {option.name}
        </button>
      ))}
    </div>
  );
}

function AskCard({ thread, item, actions, active }: { thread: Thread; item: Ask; actions: Actions; active: boolean }) {
  if (item.answer || !active) return <p className="answered">{item.title} · {item.answer ?? "Request closed"}</p>;
  return (
    <div className="ask">
      <span className="label">Needs your OK</span>
      <b>{nameOf(thread.provider)} wants to {item.title.toLowerCase()}</b>
      {item.detail && item.detail !== item.title && <p title={item.detail}>{item.detail.slice(0, 160)}</p>}
      <AskButtons thread={thread} item={item} actions={actions} />
    </div>
  );
}

/** An agent reply, with a copy button that appears on hover. */
function Reply({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="reply">
      <Md text={text} />
      <button
        className="icon copy"
        aria-label={copied ? "Copied" : "Copy reply"}
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </div>
  );
}

/** The answer comes first. How the agent got there is folded away underneath. */
function TurnView({ thread, turn, live, actions }: { thread: Thread; turn: Turn; live: boolean; actions: Actions }) {
  const running = turn.steps.findLast((step) => step.status === "running") ?? turn.steps[turn.steps.length - 1];
  return (
    <>
      {turn.user !== null && <div className="you"><Md text={turn.user} /></div>}
      {turn.parts.map((part) =>
        part.kind === "say" ? <Reply key={part.id} text={part.text} />
        : part.kind === "ask" ? <AskCard key={part.id} thread={thread} item={part} actions={actions} active={live && thread.state === "needs_you"} />
        : part.kind === "error" ? <p key={part.id} className="oops">{part.text}</p>
        : (
          <p key={part.id} className="outcome">
            <Icon name="check" /> Changed {plural(part.files.length, "file")} <span>{part.files.map((file) => file.split(/[\\/]/).pop()).join(", ")}</span>
          </p>
        ),
      )}
      {live && thread.state !== "needs_you" && (
        <div className="live">
          <span className="dot working" />
          <span>{thread.state === "stopping" ? "Stopping…" : running?.label ?? stateLabel(thread)}</span>
        </div>
      )}
      {!live && turn.steps.length > 0 && (
        <details className="how">
          <summary>{plural(turn.steps.length, "step")}</summary>
          <ul>
            {turn.steps.map((step) => (
              <li key={step.id} className={step.status !== "done" ? "bad" : undefined} title={step.detail}>
                <Icon name={step.status === "done" ? "check" : "x"} /> {step.label}{step.status === "running" || step.status === "interrupted" ? " · Unconfirmed" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** A small dropdown for choosing which project a new thread belongs to. */
function ProjectPicker({ projects, project, pick, create }: { projects: Project[]; project: Project | null; pick(id: string): void; create(): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <span className="mpick" ref={root}>
      <button className={project ? "mbtn" : "mbtn unset"} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="folder" />
        <b>{project ? project.name : "Choose a project"}</b>
        <Icon name="down" />
      </button>
      {open && (
        <div className="mpop narrow" role="menu">
          <div className="mmodels">
            <div className="mhead"><span className="label">Work in</span></div>
            <div className="mlist">
              {projects.map((p) => (
                <button
                  key={p.id}
                  className="mrow"
                  role="menuitem"
                  aria-current={p.id === project?.id}
                  onClick={() => {
                    pick(p.id);
                    setOpen(false);
                  }}
                >
                  <b>{p.name}</b>
                  <span className="trunc">{p.goal}</span>
                </button>
              ))}
              <button className="mrow" role="menuitem" onClick={create}>
                <b>New project…</b>
              </button>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}

export function Conversation(props: {
  projects: Project[];
  project: Project | null;
  thread: Thread | null;
  items: Item[];
  agents: Agent[];
  status: ProviderStatus[] | null;
  choice: Choice;
  setChoice(choice: Choice): void;
  pickProject(id: string): void;
  newProject(): void;
  manageAgents(): void;
  actions: Actions;
  start(text: string): Promise<void>;
  name: string;
  seed: string;
  consumeSeed(): void;
  drafts: Record<string, string>;
  unassignedDraft: string;
  setUnassignedDraft(value: string): void;
  connected: boolean;
}) {
  const { project, thread, actions } = props;
  const list = useMemo(() => turns(props.items), [props.items]);
  const target = project ? { projectId: project.id, threadId: thread?.id } : null;
  const draftKey = thread?.id ?? project?.id;
  const draft = draftKey ? props.drafts[draftKey] ?? "" : props.unassignedDraft;
  const setDraft = (value: string) => target ? saveDraft(target, value) : props.setUnassignedDraft(value);
  useEffect(() => {
    if (target && props.seed) {
      const seeded = [draft, props.seed].filter(Boolean).join("\n\n");
      if (seeded.length <= 20_000) saveDraft(target, seeded);
      else actions.fail("The tool request didn't fit in this draft. Shorten the draft and try again.");
      props.consumeSeed();
    }
  }, [draftKey, props.seed]);
  const [away, setAway] = useState(false);
  const [sending, setSending] = useState(false);
  const pendingSend = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const working = !!thread && busy(thread);

  // Follow new output unless the user has scrolled up to read something.
  useEffect(() => {
    const el = scroller.current;
    if (el && !away) el.scrollTo({ top: el.scrollHeight });
  }, [props.items, away]);

  const agentId = thread ? thread.provider : props.choice.agentId;
  const health = props.status?.find((entry) => entry.id === agentId);
  const notReady = health && (!health.installed || health.signedIn === false);
  const canSend = Boolean(target && props.connected && !notReady && !working && !sending && draft.trim());

  const send = async () => {
    if (!canSend || !target || pendingSend.current) return;
    pendingSend.current = true;
    setSending(true);
    try {
      if (thread) await actions.prompt(thread.id, draft);
      else await props.start(draft);
      clearSentDraft(target, draft);
      setAway(false);
    } catch (error) {
      actions.fail(error);
    } finally {
      pendingSend.current = false;
      setSending(false);
    }
  };

  const composer = (
    <div className="composer">
      <AutoText
        autoFocus
        rows={thread ? 1 : 2}
        value={draft}
        aria-label={thread ? `Reply to ${nameOf(thread.provider)}` : "First message"}
        maxLength={20000}
        placeholder={thread ? `Reply to ${nameOf(thread.provider)}` : "Describe what you want done"}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onEnter(send)}
      />
      <div className="tools">
        {!thread && <ProjectPicker projects={props.projects} project={project} pick={props.pickProject} create={props.newProject} />}
        <ModelPicker
          agents={props.agents}
          nameOf={nameOf}
          lockAgent={!!thread}
          disabled={working || sending || !props.connected}
          manage={props.manageAgents}
          value={thread ? { agentId: thread.provider, model: thread.model } : props.choice}
          onChange={(choice) => {
            if (thread) call("thread.update", { threadId: thread.id, model: choice.model }).catch(actions.fail);
            else props.setChoice(choice);
          }}
        />
        <span className="fill" />
        {working ? (
          <button className="send" aria-label={thread.state === "stopping" ? "Stopping" : "Stop"} title="Stop" disabled={!props.connected || thread.state === "stopping"} onClick={() => void actions.cancel(thread.id)}>
            <Icon name="stop" />
          </button>
        ) : (
          <button className="send" aria-label={sending ? "Sending" : "Send"} title="Send" onClick={() => void send()} disabled={!canSend}>
            <Icon name="send" />
          </button>
        )}
      </div>
    </div>
  );
  const notice = notReady && (
    <p className="notice">
      {nameOf(agentId)} {health.installed ? "isn't signed in" : "isn't installed"} on this computer.{" "}
      <button className="link" onClick={props.manageAgents}>Set it up</button>
    </p>
  );

  if (!thread) {
    return (
      <div className="hero">
        <Art />
        <div className="inner">
          <img className="mark logo" src="./mark.png" alt="" />
          <h2>What should happen next{props.name ? `, ${props.name.split(" ")[0]}` : ""}?</h2>
          <p className="lead">
            {project ? `A thread is one agent working on one piece of ${project.name}. Run several at once.` : "Pick the project this thread belongs to, then say what you want done."}
          </p>
          {composer}
          {notice}
          <div className="starters">
            {STARTERS.map((starter) => (
              <button key={starter.text} className="starter" onClick={() => setDraft(starter.text)}>
                <Icon name={starter.icon} /> {starter.text}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }
  const lastPrompt = list.at(-1)?.user;
  return (
    <div className="convo">
      <div
        className="scroll"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 160);
        }}
      >
        <div className="flow">
          {list.map((turn, index) => (
            <TurnView key={turn.id} thread={thread} turn={turn} live={working && index === list.length - 1} actions={actions} />
          ))}
          {thread.state === "interrupted" && <p className="oops">This turn was interrupted. Check the project for partial changes before you retry.</p>}
          {thread.state === "stopped" && <p className="muted">Turn stopped. Any changes already made may still be in the project.</p>}
          {(thread.state === "failed" || thread.state === "interrupted") && lastPrompt && !draft && (
            <button className="btn" onClick={() => setDraft(lastPrompt)}>Copy last message into composer</button>
          )}
        </div>
      </div>
      <div className="dockbar">
        {away && (
          <button
            className="latest"
            onClick={() => {
              setAway(false);
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
            }}
          >
            <Icon name="down" /> Latest
          </button>
        )}
        {composer}
        {notice || <p className="hint">{prefs.sendWith === "ctrl-enter" ? "Ctrl + Enter to send" : "Enter to send · Shift + Enter for a new line"}</p>}
      </div>
    </div>
  );
}

/* ───────── Right panel ───────── */

export type PanelTab = "details" | "browser";

export function Panel(props: {
  project: Project;
  threads: Thread[];
  items: Record<string, Item[]>;
  connected: boolean;
  tab: PanelTab;
  setTab(tab: PanelTab): void;
  open(thread: Thread): void;
  fail(error: unknown): void;
  close(): void;
}) {
  const { project, threads, fail } = props;
  const recent = [...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  const settled = `${props.connected}:${threads.map((t) => `${t.id}:${t.state}`).join()}`;
  const [wide, setWide] = useState(false);
  const tabsId = useId();
  // Addresses the agents mentioned while working, newest first, offered as one-click previews.
  const found = useMemo(() => {
    const urls: string[] = [];
    for (const thread of threads) {
      for (const item of props.items[thread.id] ?? []) {
        const text = item.kind === "say" ? item.text : item.kind === "step" ? item.detail : "";
        for (const match of text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s`"')\]]*)?/g)) urls.push(match[0].replace(/[.,]+$/, ""));
      }
    }
    return [...new Set(urls.reverse())].slice(0, 4);
  }, [threads, props.items]);

  return (
    <aside className={wide || props.tab === "browser" ? "panel wide" : "panel"}>
      <div className="ptop">
        <div className="tabs" role="tablist" aria-label="Project panel" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "details" : event.key === "End" ? "browser" : props.tab === "details" ? "browser" : "details";
          props.setTab(next);
          document.getElementById(`${tabsId}-${next}`)?.focus();
        }}>
          {(["details", "browser"] as const).map((id) => (
            <button key={id} id={`${tabsId}-${id}`} role="tab" aria-controls={`${tabsId}-panel`} aria-selected={props.tab === id} tabIndex={props.tab === id ? 0 : -1} onClick={() => props.setTab(id)}>
              {id === "details" ? "Details" : "Browser"}
            </button>
          ))}
        </div>
        <span className="fill" />
        {props.tab === "details" && (
          <button className="icon" aria-pressed={wide} aria-label={wide ? "Make panel narrower" : "Make panel wider"} onClick={() => setWide(!wide)}>
            <Icon name="grow" />
          </button>
        )}
        <button className="icon" aria-label="Hide panel" onClick={props.close}>
          <Icon name="x" />
        </button>
      </div>
      <div className="panel-content" id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${props.tab}`}>
      {props.tab === "browser" ? (
        <Browser project={project} found={found} fail={fail} />
      ) : (
        <div className="pbody">
          <div className="phero" title={project.cwd}>
            <Icon name="folder" />
            <b className="trunc">{project.name}</b>
            <span>
              <span className={threads.some((t) => t.state === "needs_you") ? "dot needs" : threads.some(busy) ? "dot working" : "dot ok"} />
              {threads.some((t) => t.state === "needs_you") ? "Needs you" : threads.some(busy) ? `${plural(threads.filter(busy).length, "agent")} working` : "Project active"}
            </span>
          </div>
          <div className="goalcard">
            <span className="label">Building</span>
            <p>{project.goal || "Add a project goal in Settings."}</p>
          </div>
          <Files project={project} refresh={settled} />
          <Changes project={project} refresh={settled} />
          {recent.length > 0 && (
            <section className="sec">
              <header><b>Recent activity</b></header>
              {recent.map((t) => (
                <button key={t.id} className="act" onClick={() => props.open(t)}>
                  {busy(t) && t.state !== "needs_you" ? <span className="spin" /> : <Icon name={t.state === "idle" ? "circlecheck" : "x"} />}
                  <span className="trunc">{t.title}</span>
                  <span className="when">{stateLabel(t) || ago(t.updatedAt)}</span>
                </button>
              ))}
            </section>
          )}
          {!project.previewUrl && found.length > 0 && (
            <section className="sec">
              <header><b>Running app</b></header>
              <button
                className="btn"
                onClick={() => {
                  call("project.setPreview", { projectId: project.id, url: found[0]! }).catch(fail);
                  props.setTab("browser");
                }}
              >
                Open {found[0]!.replace(/^https?:\/\//, "")} in the browser tab
              </button>
            </section>
          )}
        </div>
      )}
      </div>
    </aside>
  );
}

/** The project's folders and files. Folders open in place; nothing here edits anything. */
function Files({ project, refresh }: { project: Project; refresh: string }) {
  const [entries, setEntries] = useState<Record<string, FileEntry[] | string>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const load = (dir: string) =>
    call("project.files", { projectId: project.id, dir })
      .then((list) => setEntries((current) => ({ ...current, [dir]: list })))
      .catch(() => setEntries((current) => ({ ...current, [dir]: "Couldn't read this folder." })));

  // Reload what is showing whenever a thread finishes a turn, since agents add and remove files.
  useEffect(() => {
    void load("");
    for (const dir of open) void load(dir);
  }, [project.id, refresh]);

  const toggle = (dir: string) => {
    const next = new Set(open);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      void load(dir);
    }
    setOpen(next);
  };
  const list = (dir: string): React.ReactNode => {
    const result = entries[dir];
    if (result === undefined) return <p className="muted">Loading…</p>;
    if (typeof result === "string") return <p className="muted">{result} <button className="link" onClick={() => void load(dir)}>Retry</button></p>;
    if (!result.length) return <p className="muted">This folder is empty.</p>;
    return result.map((entry) => {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.kind === "file") {
        return (
          <div key={path} className="file" title={path}>
            <Icon name="file" /> <span className="trunc">{entry.name}</span>
          </div>
        );
      }
      return (
        <div key={path}>
          <button className="file" aria-expanded={open.has(path)} onClick={() => toggle(path)}>
            <svg className="i chev" aria-hidden="true"><use href="#chev" /></svg>
            <Icon name="folder" /> <span className="trunc">{entry.name}</span>
          </button>
          {open.has(path) && <div className="nest">{list(path)}</div>}
        </div>
      );
    });
  };

  return (
    <section className="sec">
      <header><b>Files</b></header>
      <div className="files">{list("")}</div>
    </section>
  );
}

function Changes({ project, refresh }: { project: Project; refresh: string }) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ text: string; error?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setProblem(null);
    call("project.changes", { projectId: project.id })
      .then((result) => { if (current) setChanges(result); })
      .catch((error: Error) => {
        if (current) {
          setChanges(null);
          setProblem(error.message);
        }
      });
    return () => { current = false; };
  }, [project.id, refresh, attempt]);
  useEffect(() => {
    setDiff(null);
    if (!open) return;
    let current = true;
    call("project.diff", { projectId: project.id, path: open })
      .then((result) => { if (current) setDiff(result); })
      .catch(() => { if (current) setDiff({ text: "Couldn't load this diff.", error: true }); });
    return () => { current = false; };
  }, [project.id, open, refresh, attempt]);

  const added = changes?.reduce((sum, change) => sum + change.added, 0) ?? 0;
  const removed = changes?.reduce((sum, change) => sum + change.removed, 0) ?? 0;
  const lines = diff?.text.startsWith("diff --git ")
    ? diff.text.slice(diff.text.indexOf("\n@@ ") < 0 ? diff.text.length : diff.text.indexOf("\n@@ ") + 1).split("\n").filter((line) => !line.startsWith("@@ "))
    : diff?.text.split("\n") ?? [];
  return (
    <section className="sec">
      <header>
        <b>Uncommitted changes</b>
        {changes && changes.length > 0 && <span className="stat">+{added} <i>−{removed}</i></span>}
      </header>
      {problem ? <p className="muted">{problem} <button className="link" onClick={() => setAttempt(attempt + 1)}>Retry</button></p>
        : !changes ? <p className="muted">Looking…</p> : changes.length === 0 ? <p className="muted">No uncommitted changes in this folder.</p> : (
        <div className="files">
          {changes.map((change) => (
            <div key={change.path}>
              <button className="file" aria-expanded={open === change.path} title={change.path} onClick={() => setOpen(open === change.path ? null : change.path)}>
                <Icon name="file" />
                <span className="trunc">{change.path.split("/").pop()}</span>
                <span className="stat">{change.status === "added" ? "new" : change.status === "removed" ? "removed" : <>+{change.added} <i>−{change.removed}</i></>}</span>
              </button>
              {open === change.path && (
                <div className="diff">
                  {diff === null ? <div className="l ctx">Loading…</div> : diff.error ? <p className="muted">{diff.text} <button className="link" onClick={() => setAttempt(attempt + 1)}>Retry</button></p>
                    : !lines.some(Boolean) ? <div className="l ctx">No text diff available.</div> : lines.map((line, index) => (
                    <div key={index} className={`l ${line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx"}`}>{line || " "}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Shows the user's running app next to the conversation. */
function Browser({ project, found, fail }: { project: Project; found: string[]; fail(error: unknown): void }) {
  const [address, setAddress] = useState(project.previewUrl ?? "");
  const [nonce, setNonce] = useState(0);
  const [phone, setPhone] = useState(false);
  useEffect(() => setAddress(project.previewUrl ?? ""), [project.previewUrl]);

  const go = (value: string) => {
    const trimmed = value.trim();
    const url = trimmed === "" ? null : /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
    if (url !== project.previewUrl) call("project.setPreview", { projectId: project.id, url }).catch(fail);
    else setNonce((n) => n + 1);
  };
  const outside = () => {
    if (!project.previewUrl) return;
    if (window.arcex) window.arcex.openExternal(project.previewUrl);
    else window.open(project.previewUrl, "_blank", "noopener");
  };

  return (
    <div className="browser">
      <div className="btools">
        <button className="icon" aria-label="Reload" disabled={!project.previewUrl} onClick={() => setNonce(nonce + 1)}>
          <Icon name="reload" />
        </button>
        <label className="field">
          <input
            value={address}
            placeholder="Address of your running app, like localhost:3000"
            aria-label="Address of your running app"
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && go(address)}
          />
        </label>
        <button className="icon" aria-pressed={phone} aria-label="Phone size" disabled={!project.previewUrl} onClick={() => setPhone(!phone)}>
          <Icon name="phone" />
        </button>
        <button className="icon" aria-label="Open in your own browser" disabled={!project.previewUrl} onClick={outside}>
          <Icon name="out" />
        </button>
      </div>
      {project.previewUrl && (
        <p className="preview-help">If the preview is blank, check that the app is running or <button className="link" onClick={outside}>open it in your browser</button>.</p>
      )}
      {project.previewUrl ? (
        <div className={phone ? "bstage phone" : "bstage"}>
          <iframe key={nonce} src={project.previewUrl} title="Your running app" />
        </div>
      ) : (
        <div className="bempty">
          <b>See your app while you build it</b>
          <p>When an agent starts your app, its address shows up here. You can also type one above.</p>
        </div>
      )}
      {found.some((url) => url !== project.previewUrl) && <div className="preview-links" aria-label="Suggested preview addresses">
        {found.filter((url) => url !== project.previewUrl).map((url) => (
          <button key={url} className="btn" onClick={() => go(url)}>Open {url.replace(/^https?:\/\//, "")}</button>
        ))}
      </div>}
    </div>
  );
}
