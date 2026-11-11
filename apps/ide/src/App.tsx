import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Change, Item, Project, ProviderId, Thread } from "@arcex/contracts";
import sprite from "./sprite.svg?raw";
import { call, loadItems, openEmpty, useStore } from "./store.ts";

declare global {
  interface Window {
    /** Present only inside the desktop shell. */
    arcex?: { pickFolder(): Promise<string | null> };
  }
}

type View = "start" | "focus" | "board";
const NAMES: Record<ProviderId, string> = { claude: "Claude", codex: "Codex" };

const Icon = ({ name, size }: { name: string; size?: number }) => (
  <svg className="i" style={size ? { width: size, height: size } : undefined} aria-hidden="true">
    <use href={`#${name}`} />
  </svg>
);
const Seal = ({ provider }: { provider: ProviderId }) => (
  <span className={provider === "claude" ? "seal" : "seal b"}>{provider === "claude" ? "C" : "X"}</span>
);

/** A finished thread is only "reported": nothing has checked the work yet. */
function StateMark({ thread }: { thread: Thread }) {
  const [cls, label] =
    thread.state === "needs_you" ? ["needs", "Needs you"]
    : thread.state === "working" || thread.state === "starting" ? ["working", "Working"]
    : thread.state === "failed" ? ["blocked", "Stopped"]
    : ["reported", "Finished"];
  return <span className={`st ${cls}`}>{label}</span>;
}

const busy = (thread: Thread) => thread.state === "working" || thread.state === "starting" || thread.state === "needs_you";

function onEnter(send: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };
}

export function App() {
  const store = useStore();
  const [view, setView] = useState<View>("start");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const project = store.projects.find((p) => p.id === projectId) ?? null;
  const threads = useMemo(() => store.threads.filter((t) => t.projectId === projectId), [store.threads, projectId]);
  const shown: View | "lost" = store.status === "lost" ? "lost" : project ? view : "start";

  useEffect(() => {
    document.body.dataset.view = shown;
  }, [shown]);
  useEffect(() => {
    for (const thread of threads) void loadItems(thread.id);
  }, [threads]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const fail = (error: unknown) => setToast(error instanceof Error ? error.message : String(error));
  const open = (id: string) => {
    setProjectId(id);
    setThreadId(null);
    setView("focus");
  };
  const startThread = async (provider: ProviderId, text: string) => {
    if (!project) return;
    try {
      const thread = await call("thread.create", { projectId: project.id, provider, text });
      openEmpty(thread.id);
      void loadItems(thread.id);
      setThreadId(thread.id);
    } catch (error) {
      fail(error);
    }
  };
  const actions: Actions = {
    fail,
    startThread,
    prompt: (id, text) => call("thread.prompt", { threadId: id, text }).catch(fail),
    cancel: (id) => call("thread.cancel", { threadId: id }).catch(fail),
    answer: (id, itemId, optionId) => call("ask.answer", { threadId: id, itemId, optionId }).catch(fail),
  };

  return (
    <>
      <div style={{ position: "absolute", width: 0, height: 0 }} dangerouslySetInnerHTML={{ __html: sprite }} />
      <div className="bar">
        <div className="left">
          <img src="./mark.png" alt="Arcex" />
          {project && (
            <button className="crumb" onClick={() => setProjectId(null)}>
              {project.name} <Icon name="chev" size={13} />
            </button>
          )}
        </div>
        <div className="seg" role="group" aria-label="View">
          {(["focus", "board"] as const).map((v) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
              {v === "focus" ? "Focus" : "Board"}
            </button>
          ))}
        </div>
        <div className="right" />
      </div>

      <main className="lost">
        <p>Arcex lost its connection to the engine. Close and reopen the app.</p>
      </main>
      <Start projects={store.projects} threads={store.threads} open={open} fail={fail} ready={store.status === "ready"} />
      {project && (
        <>
          <Focus
            project={project}
            threads={threads}
            thread={threads.find((t) => t.id === threadId) ?? null}
            items={store.items}
            select={setThreadId}
            actions={actions}
          />
          <Board
            threads={threads}
            items={store.items}
            actions={actions}
            openThread={(id) => {
              setThreadId(id);
              setView("focus");
            }}
          />
        </>
      )}
      {toast && <div className="toast" role="alert">{toast}</div>}
    </>
  );
}

type Actions = {
  fail(error: unknown): void;
  startThread(provider: ProviderId, text: string): Promise<void>;
  prompt(threadId: string, text: string): Promise<unknown>;
  cancel(threadId: string): Promise<unknown>;
  answer(threadId: string, itemId: string, optionId: string | null): Promise<unknown>;
};

/* ───────── Start ───────── */

function Start(props: { projects: Project[]; threads: Thread[]; ready: boolean; open(id: string): void; fail(error: unknown): void }) {
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
      const project = await call("project.create", folder ? { goal, cwd: folder } : { goal });
      setGoal("");
      setFolder(null);
      props.open(project.id);
    } catch (error) {
      props.fail(error);
    }
    setWorking(false);
  };

  return (
    <main className="start">
      <div className="inner">
        <img src="./mark.png" alt="" />
        <h1 className="serif">What are you building?</h1>
        <p className="sub">Describe it the way you'd tell a friend. Arcex keeps track of it and puts your agents to work.</p>
        <div className="idea">
          <textarea
            autoFocus
            value={goal}
            maxLength={2000}
            placeholder="A fitness app where people log workouts and keep a streak"
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={onEnter(create)}
          />
          <div className="row">
            <button className="chiplink" onClick={pick}>
              <Icon name="folder" /> <span className="folder">{folder ?? "Continue something I've started"}</span>
            </button>
            {folder && (
              <button className="tool" aria-label="Start fresh instead" onClick={() => setFolder(null)}>
                <Icon name="x" />
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button className="round ink" aria-label="Start the project" onClick={create} disabled={working}>
              <Icon name="arrow" />
            </button>
          </div>
        </div>
        {props.projects.length > 0 && (
          <div className="recent">
            {props.projects.slice(0, 3).map((project) => {
              const mine = props.threads.filter((t) => t.projectId === project.id);
              const waiting = mine.filter((t) => t.state === "needs_you").length;
              const active = mine.filter((t) => t.state === "working" || t.state === "starting").length;
              return (
                <button key={project.id} onClick={() => props.open(project.id)}>
                  <b>{project.name}</b>
                  <small>
                    {mine.length === 0 ? "No threads yet" : `${mine.length} thread${mine.length === 1 ? "" : "s"}`}
                    {waiting ? ` · ${waiting} need${waiting === 1 ? "s" : ""} you` : active ? ` · ${active} working` : ""}
                  </small>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

/* ───────── Timeline ───────── */

type Row = { type: "item"; item: Item } | { type: "steps"; id: string; steps: Extract<Item, { kind: "step" }>[] };

/** Consecutive steps are shown as one short list. */
function rows(items: Item[]): Row[] {
  const out: Row[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.kind === "step") {
      if (last?.type === "steps") last.steps.push(item);
      else out.push({ type: "steps", id: item.id, steps: [item] });
    } else out.push({ type: "item", item });
  }
  return out;
}

function Steps({ steps }: { steps: Extract<Item, { kind: "step" }>[] }) {
  return (
    <div className="work">
      <ul>
        {steps.map((step) => (
          <li key={step.id} className={step.status === "failed" ? "bad" : undefined} title={step.detail}>
            {step.status === "running" ? <span className="spin" /> : <Icon name={step.status === "failed" ? "x" : "check"} />}
            {step.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AskCard({ thread, item, actions, compact }: { thread: Thread; item: Extract<Item, { kind: "ask" }>; actions: Actions; compact?: boolean }) {
  if (item.answer) return <p className="answered">{item.title}: you chose "{item.answer}"</p>;
  return (
    <div className="ask">
      <div className="eyebrow">Needs your OK</div>
      <b>{NAMES[thread.provider]} wants to: {item.title.toLowerCase()}</b>
      {!compact && item.detail && item.detail !== item.title && <p title={item.detail}>{item.detail.slice(0, 160)}</p>}
      {!compact && <AskButtons thread={thread} item={item} actions={actions} />}
    </div>
  );
}

function AskButtons({ thread, item, actions }: { thread: Thread; item: Extract<Item, { kind: "ask" }>; actions: Actions }) {
  return (
    <div className="row">
      {item.options.map((option) => (
        <button
          key={option.id}
          className={option.kind.startsWith("allow") ? "btn ink" : "btn line"}
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

/* ───────── Focus ───────── */

function Focus(props: {
  project: Project;
  threads: Thread[];
  thread: Thread | null;
  items: Record<string, Item[]>;
  select(id: string | null): void;
  actions: Actions;
}) {
  const { project, thread, actions } = props;
  const items = thread ? props.items[thread.id] ?? [] : [];
  const [draft, setDraft] = useState("");
  const [provider, setProvider] = useState<ProviderId>("claude");
  const [hood, setHood] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [items, thread?.id]);

  const send = () => {
    const text = draft.trim();
    if (!text || (thread && busy(thread))) return;
    setDraft("");
    if (thread) void actions.prompt(thread.id, text);
    else void actions.startThread(provider, text);
  };

  return (
    <main className="focus">
      <aside className="rail">
        <div className="eyebrow">Building</div>
        <h2 className="serif">{project.goal}</h2>
        <div className="tlist">
          <div className="head">
            <span className="eyebrow">Threads</span>
            <button className="tool" aria-label="New thread" style={{ width: 26, height: 26 }} onClick={() => props.select(null)}>
              <Icon name="plus" />
            </button>
          </div>
          {props.threads.map((t) => (
            <button key={t.id} className="trow" aria-current={t.id === thread?.id} onClick={() => props.select(t.id)}>
              <Seal provider={t.provider} />
              <b>{t.title}</b>
              <StateMark thread={t} />
            </button>
          ))}
        </div>
        <button className="hood" onClick={() => setHood(!hood)}>
          <Icon name="layers" /> Under the hood
        </button>
      </aside>

      <section className="sheet">
        <div className="thead">
          <h1 className="serif">{thread ? thread.title : "New thread"}</h1>
          <p>{thread ? `With ${NAMES[thread.provider]}` : `Works inside ${project.name}`}</p>
          {thread && (
            <span className="who">
              <Seal provider={thread.provider} /> {NAMES[thread.provider]}
            </span>
          )}
        </div>
        <div className="msgs" ref={scroller}>
          {!thread && (
            <div className="empty">
              <b>Tell an agent what to do</b>
              <span>Start as many threads as you like. Each one works on its own piece of {project.name}.</span>
            </div>
          )}
          {thread &&
            rows(items).map((row) =>
              row.type === "steps" ? <Steps key={row.id} steps={row.steps} />
              : row.item.kind === "user" ? <div key={row.item.id} className="you">{row.item.text}</div>
              : row.item.kind === "say" ? <p key={row.item.id} className="said">{row.item.text}</p>
              : row.item.kind === "ask" ? <AskCard key={row.item.id} thread={thread} item={row.item} actions={actions} />
              : row.item.kind === "error" ? <p key={row.item.id} className="said oops">{row.item.text}</p>
              : null,
            )}
        </div>
        <div className="composer">
          <textarea
            rows={1}
            value={draft}
            maxLength={20000}
            placeholder={thread ? `Tell ${NAMES[thread.provider]} what to change` : "What should this thread work on?"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onEnter(send)}
          />
          <div className="row">
            {!thread && (
              <div className="pick" role="group" aria-label="Agent">
                {(Object.keys(NAMES) as ProviderId[]).map((id) => (
                  <button key={id} aria-pressed={provider === id} onClick={() => setProvider(id)}>
                    {NAMES[id]}
                  </button>
                ))}
              </div>
            )}
            {thread && busy(thread) && (
              <span className="busy">
                <span className="st working">{thread.state === "needs_you" ? "Waiting for you" : `${NAMES[thread.provider]} is working`}</span>
                <button className="quiet" onClick={() => void actions.cancel(thread.id)}>Stop</button>
              </span>
            )}
            <span className="gap" />
            <button className="round ink" aria-label="Send" onClick={send} disabled={!!thread && busy(thread)}>
              <Icon name="up" />
            </button>
          </div>
        </div>
      </section>

      <Preview project={project} fail={actions.fail} />
      {hood && <Hood project={project} threads={props.threads} close={() => setHood(false)} fail={actions.fail} />}
    </main>
  );
}

function Preview({ project, fail }: { project: Project; fail(error: unknown): void }) {
  const [address, setAddress] = useState(project.previewUrl ?? "");
  const [nonce, setNonce] = useState(0);
  useEffect(() => setAddress(project.previewUrl ?? ""), [project.id, project.previewUrl]);

  const save = () => {
    const value = address.trim();
    const url = value === "" ? null : /^https?:\/\//.test(value) ? value : `http://${value}`;
    call("project.setPreview", { projectId: project.id, url }).catch(fail);
  };

  return (
    <section className="stage">
      <div className="pbar">
        <span className="name">{project.previewUrl && <span className="live" />}</span>
        <input
          value={address}
          placeholder="Your app's address, like localhost:3000"
          aria-label="Preview address"
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={onEnter(save)}
          onBlur={save}
        />
        <button className="tool" aria-label="Reload" onClick={() => setNonce(nonce + 1)}>
          <Icon name="reload" />
        </button>
      </div>
      {project.previewUrl ? (
        <iframe key={nonce} src={project.previewUrl} title="App preview" />
      ) : (
        <div className="empty">
          <b>Your app shows up here</b>
          <span>Once it's running, paste its address above to watch it change as the agents work.</span>
        </div>
      )}
    </section>
  );
}

function Hood({ project, threads, close, fail }: { project: Project; threads: Thread[]; close(): void; fail(error: unknown): void }) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  // Refresh whenever a thread finishes a turn.
  const settled = threads.map((t) => `${t.id}:${t.state}`).join();

  useEffect(() => {
    call("project.changes", { projectId: project.id })
      .then((list) => {
        setChanges(list);
        setSelected((current) => (list.some((c) => c.path === current) ? current : list[0]?.path ?? null));
      })
      .catch(fail);
  }, [project.id, settled]);
  useEffect(() => {
    if (!selected) return setDiff("");
    call("project.diff", { projectId: project.id, path: selected }).then((result) => setDiff(result.text)).catch(() => setDiff(""));
  }, [project.id, selected, settled]);

  const lines = diff.split("\n").filter((line) => !/^(diff --git|index |--- |\+\+\+ |new file|deleted file)/.test(line));
  return (
    <section className="hoodp" style={{ display: "grid" }} aria-label="Under the hood">
      <div className="htabs">
        <button className="tab" aria-selected="true">What changed</button>
        <span style={{ flex: 1 }} />
        <button className="tool" aria-label="Close" onClick={close}>
          <Icon name="x" />
        </button>
      </div>
      <div className="hbody">
        <div className="changes">
          {changes?.length === 0 && <div className="none">Nothing has changed since the last save point.</div>}
          {changes?.map((change) => (
            <button key={change.path} className="chg" aria-current={change.path === selected} onClick={() => setSelected(change.path)}>
              <b>{change.path.split("/").pop()}</b>
              <small>{change.status === "added" ? "New file" : change.status === "removed" ? "Removed" : change.path}</small>
              <em>
                +{change.added} <i>−{change.removed}</i>
              </em>
            </button>
          ))}
        </div>
        <div className="diff">
          {selected ? (
            lines.map((line, index) => (
              <div key={index} className={`l ${line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx"}`}>{line || " "}</div>
            ))
          ) : (
            <div className="none">Pick a file to see exactly what changed in it.</div>
          )}
        </div>
      </div>
    </section>
  );
}

/* ───────── Board ───────── */

function Board(props: { threads: Thread[]; items: Record<string, Item[]>; actions: Actions; openThread(id: string | null): void }) {
  const { threads, actions } = props;
  const [chosen, setChosen] = useState<string | null>(null);
  // The thread that needs you takes the large tile unless you picked one yourself.
  const big = threads.find((t) => t.id === chosen)?.id ?? threads.find((t) => t.state === "needs_you")?.id ?? threads[0]?.id;
  const count = (states: Thread["state"][]) => threads.filter((t) => states.includes(t.state)).length;
  const promote = (id: string) => {
    const apply = () => setChosen(id);
    if (document.startViewTransition) document.startViewTransition(apply);
    else apply();
  };

  return (
    <main className="board">
      <div className="tiles">
        {threads.length === 0 && (
          <div className="empty" style={{ gridColumn: "1 / -1", gridRow: "1 / -1" }}>
            <b>No threads yet</b>
            <span>Start one and it appears here. Every thread you run shows up side by side.</span>
          </div>
        )}
        {threads.map((thread) => (
          <Tile
            key={thread.id}
            thread={thread}
            items={props.items[thread.id] ?? []}
            big={thread.id === big}
            actions={actions}
            open={() => props.openThread(thread.id)}
            promote={() => promote(thread.id)}
          />
        ))}
      </div>
      <div className="dock">
        <div className="tally">
          {count(["needs_you"]) > 0 && <span className="st needs">{count(["needs_you"])} need you</span>}
          {count(["working", "starting"]) > 0 && <span className="st working">{count(["working", "starting"])} working</span>}
          {count(["idle"]) > 0 && <span className="st reported">{count(["idle"])} finished</span>}
        </div>
        <span />
        <button className="btn line end" onClick={() => props.openThread(null)}>
          <Icon name="plus" /> New thread
        </button>
      </div>
    </main>
  );
}

function Tile(props: { thread: Thread; items: Item[]; big: boolean; actions: Actions; open(): void; promote(): void }) {
  const { thread, actions } = props;
  const [draft, setDraft] = useState("");
  const recent = props.items.slice(props.big ? -12 : -5);
  const pendingAsk = props.items.findLast((item) => item.kind === "ask" && !item.answer) as Extract<Item, { kind: "ask" }> | undefined;
  const running = props.items.findLast((item) => item.kind === "step" && item.status === "running") as Extract<Item, { kind: "step" }> | undefined;
  const cls = ["tile", props.big && "big", thread.state === "needs_you" && "attn", thread.state === "idle" && !props.big && "rest"].filter(Boolean).join(" ");

  const send = () => {
    const text = draft.trim();
    if (!text || busy(thread)) return;
    setDraft("");
    void actions.prompt(thread.id, text);
  };
  const body: ReactNode[] = [];
  for (const item of recent) {
    if (item.kind === "user") body.push(<p key={item.id} className="q">{item.text.slice(0, 200)}</p>);
    else if (item.kind === "say") body.push(<p key={item.id} className="a">{item.text.length > 320 ? `${item.text.slice(0, 320)}…` : item.text}</p>);
    else if (item.kind === "error") body.push(<p key={item.id} className="a oops">{item.text}</p>);
    else if (item.kind === "ask" && !item.answer) body.push(<AskCard key={item.id} thread={thread} item={item} actions={actions} compact />);
  }

  return (
    <article className={cls} style={{ viewTransitionName: `tile-${thread.id}` }} onClick={props.open}>
      <header>
        <Seal provider={thread.provider} />
        <b>{thread.title}</b>
        <StateMark thread={thread} />
        <button
          className="grow"
          aria-label="Make this thread larger"
          onClick={(event) => {
            event.stopPropagation();
            props.promote();
          }}
        >
          <Icon name="grow" />
        </button>
      </header>
      <div className="body">
        {body}
        {!pendingAsk && busy(thread) && (
          <div className="now">
            <span>{running?.label ?? "Getting started"}</span>
          </div>
        )}
      </div>
      <footer onClick={(event) => event.stopPropagation()}>
        {pendingAsk ? (
          <AskButtons thread={thread} item={pendingAsk} actions={actions} />
        ) : (
          <div className="mini">
            <input
              value={draft}
              placeholder={busy(thread) ? "Working…" : "Reply or redirect"}
              disabled={busy(thread)}
              aria-label={`Reply to ${thread.title}`}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onEnter(send)}
            />
          </div>
        )}
      </footer>
    </article>
  );
}
