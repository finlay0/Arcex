import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, Change, Item, Project, ProviderStatus, Thread } from "@arcex/contracts";
import { ModelPicker, type Choice } from "./ModelPicker.tsx";
import { Md } from "./md.tsx";
import { AutoText, Icon, STARTERS, busy, nameOf, onEnter, plural, prefs, type Actions } from "./shared.tsx";
import { call } from "./store.ts";

type Step = Extract<Item, { kind: "step" }>;
type Ask = Extract<Item, { kind: "ask" }>;

/* ───────── New project ───────── */

export function NewProject(props: { first: boolean; ready: boolean; created(project: Project): void; fail(error: unknown): void }) {
  const [goal, setGoal] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const pick = async () => {
    const chosen = window.arcex ? await window.arcex.pickFolder() : window.prompt("Full path of the project folder");
    if (chosen) setFolder(chosen);
  };
  const create = async () => {
    if (!goal.trim() || working || !props.ready) return;
    setWorking(true);
    try {
      props.created(await call("project.create", folder ? { goal, cwd: folder } : { goal }));
    } catch (error) {
      props.fail(error);
    }
    setWorking(false);
  };

  return (
    <div className="hero">
      <div className="inner">
        <h2>What are you building?</h2>
        <p className="lead">
          {props.first ? "Describe it the way you'd tell a friend. Arcex sets up the project and puts your agents to work." : "Describe the new project in a sentence or two."}
        </p>
        <div className="composer">
          <AutoText
            autoFocus
            value={goal}
            maxLength={2000}
            placeholder="A fitness app where people log workouts and keep a streak"
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={onEnter(create)}
          />
          <div className="tools">
            <button className="chip" onClick={pick} title={folder ?? undefined}>
              <Icon name="folder" /> <span className="trunc">{folder ?? "Use a folder I already have"}</span>
            </button>
            {folder && (
              <button className="icon" aria-label="Start with a new folder instead" onClick={() => setFolder(null)}>
                <Icon name="x" />
              </button>
            )}
            <span className="fill" />
            <button className="send" aria-label="Create project" onClick={create} disabled={working || !goal.trim()}>
              <Icon name="up" />
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

function AskCard({ thread, item, actions }: { thread: Thread; item: Ask; actions: Actions }) {
  if (item.answer) return <p className="answered">{item.title}: you chose "{item.answer}"</p>;
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
        : part.kind === "ask" ? <AskCard key={part.id} thread={thread} item={part} actions={actions} />
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
          <span>{running?.label ?? "Getting started"}</span>
        </div>
      )}
      {!live && turn.steps.length > 0 && (
        <details className="how">
          <summary>{plural(turn.steps.length, "step")}</summary>
          <ul>
            {turn.steps.map((step) => (
              <li key={step.id} className={step.status === "failed" ? "bad" : undefined} title={step.detail}>
                <Icon name={step.status === "failed" ? "x" : "check"} /> {step.label}
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
}) {
  const { project, thread, actions } = props;
  const list = useMemo(() => turns(props.items), [props.items]);
  const [draft, setDraft] = useState(props.seed);
  const [away, setAway] = useState(false);
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

  const send = () => {
    const text = draft.trim();
    if (!text || working) return;
    if (thread) {
      setDraft("");
      setAway(false);
      void actions.prompt(thread.id, text);
    } else if (project) {
      setDraft("");
      void props.start(text);
    }
  };

  const composer = (
    <div className="composer">
      <AutoText
        autoFocus
        rows={thread ? 1 : 2}
        value={draft}
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
          disabled={working}
          manage={props.manageAgents}
          value={thread ? { agentId: thread.provider, model: thread.model } : props.choice}
          onChange={(choice) => {
            if (thread) call("thread.update", { threadId: thread.id, model: choice.model }).catch(actions.fail);
            else props.setChoice(choice);
          }}
        />
        <span className="fill" />
        {working ? (
          <button className="send" aria-label="Stop" onClick={() => void actions.cancel(thread.id)}>
            <Icon name="stop" />
          </button>
        ) : (
          <button className="send" aria-label="Send" onClick={send} disabled={!draft.trim() || (!thread && !project)}>
            <Icon name="up" />
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
        <div className="inner">
          <h2>What should happen next{props.name ? `, ${props.name.split(" ")[0]}` : ""}?</h2>
          <p className="lead">
            {project ? `A thread is one agent working on one piece of ${project.name}. Run several at once.` : "Pick the project this thread belongs to, then say what you want done."}
          </p>
          {composer}
          {notice}
          <div className="starters">
            {STARTERS.map((text) => (
              <button key={text} className="starter" onClick={() => setDraft(text)}>
                {text}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }
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
  tab: PanelTab;
  setTab(tab: PanelTab): void;
  fail(error: unknown): void;
  close(): void;
}) {
  const { project, threads, fail } = props;
  const [wide, setWide] = useState(false);
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
        <div className="tabs" role="tablist">
          {(["details", "browser"] as const).map((id) => (
            <button key={id} role="tab" aria-selected={props.tab === id} onClick={() => props.setTab(id)}>
              {id === "details" ? "Details" : "Browser"}
              {id === "browser" && project.previewUrl && <span className="pulse" />}
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
      {props.tab === "browser" ? (
        <Browser project={project} found={found} fail={fail} />
      ) : (
        <div className="pbody">
          <section className="sec">
            <header><span className="label">Building</span></header>
            <p className="goal">{project.goal}</p>
            <div className="kv" title={project.cwd}>
              <Icon name="folder" /> <span className="trunc">{project.cwd}</span>
            </div>
            <div className="kv">
              <Icon name="edit" />
              <span>
                {threads.length === 0 ? "No threads yet" : plural(threads.length, "thread")}
                {threads.some(busy) && ` · ${threads.filter(busy).length} working`}
              </span>
            </div>
          </section>
          <Changes project={project} threads={threads} fail={fail} />
          {!project.previewUrl && found.length > 0 && (
            <section className="sec">
              <header><span className="label">Running app</span></header>
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
    </aside>
  );
}

function Changes({ project, threads, fail }: { project: Project; threads: Thread[]; fail(error: unknown): void }) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  // Refresh whenever a thread finishes a turn.
  const settled = threads.map((t) => `${t.id}:${t.state}`).join();

  useEffect(() => {
    call("project.changes", { projectId: project.id }).then(setChanges).catch(fail);
  }, [project.id, settled]);
  useEffect(() => {
    setDiff(null);
    if (open) call("project.diff", { projectId: project.id, path: open }).then((result) => setDiff(result.text)).catch(() => setDiff(""));
  }, [project.id, open, settled]);

  const added = changes?.reduce((sum, change) => sum + change.added, 0) ?? 0;
  const removed = changes?.reduce((sum, change) => sum + change.removed, 0) ?? 0;
  const lines = (diff ?? "").split("\n").filter((line) => !/^(diff --git|index |--- |\+\+\+ |new file|deleted file|@@ )/.test(line));
  return (
    <section className="sec">
      <header>
        <span className="label">Changes</span>
        {changes && changes.length > 0 && <span className="stat">+{added} <i>−{removed}</i></span>}
      </header>
      {!changes ? <p className="muted">Looking…</p> : changes.length === 0 ? <p className="muted">Nothing has changed since the last save point.</p> : (
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
                  {diff === null ? <div className="l ctx">Loading…</div> : lines.map((line, index) => (
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
          {project.previewUrl && <span className="pulse" />}
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
      {project.previewUrl ? (
        <div className={phone ? "bstage phone" : "bstage"}>
          <iframe key={nonce} src={project.previewUrl} title="Your running app" />
        </div>
      ) : (
        <div className="bempty">
          <b>See your app while you build it</b>
          <p>When an agent starts your app, its address shows up here. You can also type one above.</p>
          {found.map((url) => (
            <button key={url} className="btn" onClick={() => go(url)}>
              Open {url.replace(/^https?:\/\//, "")}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
