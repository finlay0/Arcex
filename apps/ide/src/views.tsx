import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Agent, Attachment, Change, FileEntry, Item, Project, ProviderStatus, Thread } from "@arcex/contracts";
import { AgentChoices, ModelPicker, type Choice } from "./ModelPicker.tsx";
import { Art } from "./Art.tsx";
import { Dictation } from "./Dictation.tsx";
import { useSlashMenu } from "./SlashMenu.tsx";
import { useMentionMenu } from "./MentionMenu.tsx";
import { AttachmentChip, useAttachments } from "./Attachments.tsx";
import { Md } from "./md.tsx";
import { AutoText, Icon, Loader, STARTERS, ago, busy, nameOf, onEnter, plural, prefs, stateLabel, type Actions } from "./shared.tsx";
import { call, clearSentDraft, saveDraft } from "./store.ts";

type Step = Extract<Item, { kind: "step" }>;
type Ask = Extract<Item, { kind: "ask" }>;

/* ───────── New project ───────── */

/**
 * A new project starts with its first message, just like a thread: describe it, pick the agent and model, send.
 * Arcex makes the folder (or uses the one you open) and the agent starts straight away. There is no separate setup step.
 */
export function NewProject(props: {
  ready: boolean;
  agents: Agent[];
  choice: Choice;
  setChoice(choice: Choice): void;
  manageAgents(): void;
  start(project: Project, text: string): Promise<void>;
  fail(error: unknown): void;
}) {
  const [text, setText] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const folderName = folder?.split(/[\\/]/).filter(Boolean).pop() ?? folder;

  const pick = async () => {
    try {
      const chosen = window.arcex ? await window.arcex.pickFolder() : window.prompt("Full path of the project folder");
      if (chosen) setFolder(chosen);
    } catch (error) {
      props.fail(error);
    }
  };
  const canSend = props.ready && !working && (!!folder || !!text.trim());
  const send = async () => {
    if (!canSend) return;
    setWorking(true);
    try {
      const message = text.trim();
      const project = await call("project.create", folder ? { goal: message, cwd: folder } : { goal: message });
      await props.start(project, message);
    } catch (error) {
      props.fail(error);
      setWorking(false);
    }
  };

  return (
    <div className="hero">
      <Art />
      <div className="inner">
        <img className="mark logo" src="./mark.png" alt="" />
        <h2>What are we building?</h2>
        <p className="lead">Describe it and send. Your agent starts right away.</p>
        <div className="composer">
          <AutoText
            autoFocus
            rows={2}
            value={text}
            aria-label="First message"
            maxLength={20000}
            placeholder={folder ? `What should happen in ${folderName}?` : "A fitness app where people log workouts and keep a streak"}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onEnter(send)}
          />
          <div className="tools">
            <span className="chipgroup">
              <button className="chip" onClick={pick} title={folder ?? "Work in a folder you already have"} disabled={working}>
                <Icon name="folder" /> <span className="trunc">{folder ? folderName : "Open a folder"}</span>
              </button>
              {folder && (
                <button className="icon" aria-label="Use a new folder instead" title="Use a new folder instead" onClick={() => setFolder(null)} disabled={working}>
                  <Icon name="x" />
                </button>
              )}
            </span>
            <ModelPicker agents={props.agents} nameOf={nameOf} disabled={working || !props.ready} manage={props.manageAgents} value={props.choice} onChange={props.setChoice} />
            <AgentChoices agentId={props.choice.agentId} value={props.choice.choices ?? {}} disabled={working || !props.ready}
              onChange={(id, value) => props.setChoice({ ...props.choice, choices: { ...props.choice.choices, [id]: value } })} />
            <span className="fill" />
            <button className="send" aria-label={working ? "Starting" : "Send"} title={folder && !text.trim() ? "Open this folder" : "Send"} onClick={() => void send()} disabled={!canSend}>
              <Icon name="send" />
            </button>
          </div>
        </div>
        <p className="hint">{folder ? <>Works in <span className="mono">{folder}</span> as it is.</> : <>Arcex makes a new folder for it in Arcex Projects, or open one you already have.</>}</p>
      </div>
    </div>
  );
}

/* ───────── Conversation ───────── */

/** One message from the user and everything the agent did in response, in the order it happened. */
type Plan = Extract<Item, { kind: "plan" }>;
type Turn = { id: string; user: string | null; files: Attachment[]; parts: Exclude<Item, { kind: "user" | "plan" }>[]; plan: Plan | null };

function turns(items: Item[]): Turn[] {
  const out: Turn[] = [];
  for (const item of items) {
    if (item.kind === "user" || out.length === 0) out.push({ id: item.id, user: item.kind === "user" ? item.text : null, files: item.kind === "user" ? item.attachments ?? [] : [], parts: [], plan: null });
    const turn = out[out.length - 1]!;
    if (item.kind === "plan") turn.plan = item;
    else if (item.kind !== "user") turn.parts.push(item);
  }
  return out;
}

/** What sort of work a step was. Steps saved before tools were recorded are read from their wording. */
function toolOf(step: Step): string {
  if (step.tool) return step.tool;
  if (step.detail.includes("browser_")) return "browser";
  const label = step.label;
  if (label.startsWith("Ran")) return "execute";
  if (/^(Changed|Removed|Moved)/.test(label)) return "edit";
  if (label.startsWith("Looked at") || label.startsWith("Looked through")) return "read";
  if (label.startsWith("Searched")) return "search";
  if (label.startsWith("Looked something up")) return "fetch";
  return "other";
}

/** "Ran 2 commands, edited 3 files" for a run of steps, in the order the kinds of work first happened. */
function summarize(steps: Step[]): string {
  const order: string[] = [];
  const groups = new Map<string, Step[]>();
  for (const step of steps) {
    const tool = toolOf(step);
    if (!groups.has(tool)) {
      order.push(tool);
      groups.set(tool, []);
    }
    groups.get(tool)!.push(step);
  }
  const filesIn = (list: Step[]) => new Set(list.flatMap((step) => step.files)).size || list.length;
  const phrases = order.map((tool) => {
    const list = groups.get(tool)!;
    switch (tool) {
      case "execute": return `ran ${plural(list.length, "command")}`;
      case "edit": case "delete": case "move": {
        const files = new Set(list.flatMap((step) => step.files));
        // A refused or failed edit changed nothing, so it must not read as done.
        const verb = list.every((step) => step.status === "failed") ? "couldn't edit" : "edited";
        return files.size === 1 ? `${verb} ${[...files][0]!.split(/[\\/]/).pop()}` : `${verb} ${plural(filesIn(list), "file")}`;
      }
      case "read": return `read ${plural(filesIn(list), "file")}`;
      case "search": return list.length === 1 ? "searched the project" : `searched ${list.length} times`;
      case "fetch": return list.length === 1 ? "looked something up" : `looked up ${list.length} things`;
      case "browser": return list.length === 1 ? "used the browser" : `used the browser ${list.length} times`;
      case "think": return "thought it through";
      default: {
        const only = list[0]!.label;
        return list.length === 1 ? only.charAt(0).toLowerCase() + only.slice(1) : `${list.length} other steps`;
      }
    }
  });
  const text = phrases.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A run of tool calls between two things the agent said, folded into one quiet line that opens to show each step. */
function WorkGroup({ steps, live }: { steps: Step[]; live: boolean }) {
  const failed = steps.filter((step) => step.status === "failed").length;
  const running = live && steps.some((step) => step.status === "running");
  // Only edits that went through count. A refused edit's lines never reached the file.
  const landed = steps.filter((step) => step.status !== "failed");
  const added = landed.reduce((sum, step) => sum + (step.added ?? 0), 0);
  const removed = landed.reduce((sum, step) => sum + (step.removed ?? 0), 0);
  return (
    <details className={running ? "work running" : "work"}>
      <summary>
        {running && <Loader work />}
        <span>{summarize(steps)}</span>
        {(added > 0 || removed > 0) && <span className="counts"><b>+{added}</b> <i>−{removed}</i></span>}
        {failed > 0 && <span className="bad">· {failed} failed</span>}
        <Icon name="chev" />
      </summary>
      <ul>
        {steps.map((step) => {
          const pending = step.status === "running" && live;
          const unconfirmed = (step.status === "running" && !live) || step.status === "interrupted";
          return (
            <li key={step.id} className={step.status === "failed" || unconfirmed ? "bad" : undefined}>
              {pending ? <Loader work /> : <Icon name={step.status === "done" ? "check" : "x"} />}
              <span className="what">
                {step.label}{unconfirmed ? " · Unconfirmed" : ""}
                {step.added !== undefined && step.status !== "failed" && <span className="counts"> <b>+{step.added}</b> <i>−{step.removed ?? 0}</i></span>}
              </span>
              {step.detail && step.detail !== step.label && <code title={step.detail}>{step.detail.slice(0, 160)}</code>}
              {(step.patch || step.output) && (
                <details className="peek">
                  <summary>{step.patch ? "Show the change" : "Show the output"}</summary>
                  <pre className={step.patch ? "patch" : "out"}>
                    {step.patch
                      ? step.patch.trimEnd().split("\n").map((line, at) => <span key={at} className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : undefined}>{line + "\n"}</span>)
                      : step.output}
                  </pre>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** The agent's plan as a checklist. Docked above the message box while it works, folded into the turn afterwards. */
function PlanList({ plan, docked }: { plan: Plan; docked: boolean }) {
  const done = plan.entries.filter((entry) => entry.status === "completed").length;
  const list = (
    <ol className="plan-list">
      {plan.entries.map((entry, index) => (
        <li key={index} className={entry.status}>
          {entry.status === "in_progress" ? <Loader /> : <span className="box">{entry.status === "completed" && <Icon name="check" />}</span>}
          <span>{entry.content}</span>
        </li>
      ))}
    </ol>
  );
  if (docked) {
    return (
      <div className="plan docked" aria-label="The agent's plan">
        <span className="label">Plan · {done} of {plan.entries.length}</span>
        {list}
      </div>
    );
  }
  return (
    <details className="work plan">
      <summary><span>Plan · {done} of {plan.entries.length} done</span><Icon name="chev" /></summary>
      {list}
    </details>
  );
}

type Block = { kind: "work"; id: string; steps: Step[] } | Turn["parts"][number];

const duration = (seconds: number) => (seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);

/** The agent's reasoning, folded. "Thinking" while it streams, "Thought for 12s" after. */
function ThinkRow({ item }: { item: Extract<Item, { kind: "think" }> }) {
  return (
    <details className="work think">
      <summary>
        <span>{item.seconds === null ? "Thinking" : `Thought for ${duration(item.seconds)}`}</span>
        <Icon name="chev" />
      </summary>
      <div className="thought"><Md text={item.text} /></div>
    </details>
  );
}

const ENDINGS = { done: "Worked for", stopped: "Stopped after", failed: "Stopped with a problem after", interrupted: "Interrupted after" };

/** A turn reads like the agent's own account: what it said, with the work in between folded into short lines. */
function TurnView({ thread, turn, live, actions, edit }: { thread: Thread; turn: Turn; live: boolean; actions: Actions; edit(turn: Turn): void }) {
  const blocks: Block[] = [];
  for (const part of turn.parts) {
    const last = blocks[blocks.length - 1];
    if (part.kind === "step") {
      if (last?.kind === "work") last.steps.push(part);
      else blocks.push({ kind: "work", id: part.id, steps: [part] });
    } else blocks.push(part);
  }
  const running = turn.parts.findLast((part): part is Step => part.kind === "step" && part.status === "running");
  const end = turn.parts.find((part) => part.kind === "end");
  const thinking = live && blocks.at(-1)?.kind === "think";
  return (
    <>
      {turn.files.length > 0 && (
        <ul className="attached sent" aria-label="Attached files">
          {turn.files.map((attachment) => <li key={attachment.id}><AttachmentChip attachment={attachment} /></li>)}
        </ul>
      )}
      {turn.user !== null && turn.user !== "" && <YouMessage text={turn.user} edit={() => edit(turn)} />}
      {blocks.map((block, index) => {
        if (block.kind === "work") return <WorkGroup key={block.id} steps={block.steps} live={live && index === blocks.length - 1} />;
        if (block.kind === "say") return <Reply key={block.id} text={block.text} />;
        // A question waiting on the user sits above the message box. Here it shows once it's settled.
        if (block.kind === "ask") return live && thread.state === "needs_you" && !block.answer ? null : <AskCard key={block.id} thread={thread} item={block} actions={actions} active={false} />;
        if (block.kind === "error") return <p key={block.id} className="oops">{block.text}</p>;
        if (block.kind === "note") return <p key={block.id} className="note">{block.text}</p>;
        if (block.kind === "think") return <ThinkRow key={block.id} item={block} />;
        if (block.kind === "end") return null;
        return (
          <p key={block.id} className="outcome">
            <Icon name="check" /> Changed {plural(block.files.length, "file")} <span>{block.files.map((file) => file.split(/[\\/]/).pop()).join(", ")}</span>
          </p>
        );
      })}
      {!live && turn.plan && <PlanList plan={turn.plan} docked={false} />}
      {!live && end?.kind === "end" && end.seconds >= 1 && <p className="ended">{ENDINGS[end.outcome]} {duration(end.seconds)}</p>}
      {live && thread.state !== "needs_you" && (
        <div className="live">
          <Loader work={!!running} />
          <span>{thread.state === "stopping" ? "Stopping…" : running?.label ?? (thinking ? "Thinking" : stateLabel(thread)) ?? "Working"}</span>
        </div>
      )}
    </>
  );
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
      <b>{item.title.endsWith("?") ? item.title : `${nameOf(thread.provider)} wants to ${item.title.toLowerCase()}`}</b>
      {item.body ? (
        <div className="askbody"><Md text={item.body} /></div>
      ) : (
        item.detail && item.detail !== item.title && <p title={item.detail}>{item.detail.slice(0, 160)}</p>
      )}
      <AskButtons thread={thread} item={item} actions={actions} />
    </div>
  );
}

/** The user's message, with copy and edit on hover. Edit puts it back in the message box to change and send again. */
function YouMessage({ text, edit }: { text: string; edit(): void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="you">
      <Md text={text} />
      <div className="youacts">
        <button className="icon" aria-label={copied ? "Copied" : "Copy message"} title="Copy" onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}>
          <Icon name={copied ? "check" : "copy"} />
        </button>
        <button className="icon" aria-label="Edit and send again" title="Edit and send again" onClick={edit}>
          <Icon name="edit" />
        </button>
      </div>
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
  start(text: string, attachments: string[]): Promise<void>;
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
  // Dictation finishes after a pause, so it adds to whatever the box holds by then.
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const addSpoken = (text: string) => setDraft(latestDraft.current.trim() ? `${latestDraft.current.trimEnd()} ${text}` : text);
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
  }, [props.items, away, thread?.state]);

  const agentId = thread ? thread.provider : props.choice.agentId;
  const health = props.status?.find((entry) => entry.id === agentId);
  const notReady = health && (!health.installed || health.signedIn === false);
  const queueFull = working && (thread?.queued?.length ?? 0) >= 10;
  const slash = useSlashMenu(agentId, draft, setDraft);
  const mention = useMentionMenu(project?.id ?? null, draft, setDraft);
  const files = useAttachments(draftKey ?? "", actions.fail);
  const enter = onEnter(() => void send());
  const canSend = Boolean(target && props.connected && !notReady && !queueFull && !sending && !files.uploading && (draft.trim() || files.list.length) && (!working || thread?.state !== "stopping"));

  const send = async () => {
    if (!canSend || !target || pendingSend.current) return;
    pendingSend.current = true;
    setSending(true);
    const attachments = files.list.map((attachment) => attachment.id);
    try {
      if (thread && working) await call("thread.prompt", { threadId: thread.id, text: draft, attachments, queue: true });
      else if (thread) await actions.prompt(thread.id, draft, attachments);
      else await props.start(draft, attachments);
      clearSentDraft(target, draft);
      files.clear();
      setAway(false);
    } catch (error) {
      actions.fail(error);
    } finally {
      pendingSend.current = false;
      setSending(false);
    }
  };

  const composer = (
    <div className={files.dragging ? "composer dropping" : "composer"} {...files.dropProps}>
      {slash.menu}
      {mention.menu}
      {files.chips}
      <AutoText
        autoFocus
        rows={thread ? 1 : 2}
        value={draft}
        aria-label={thread ? `Reply to ${nameOf(thread.provider)}` : "First message"}
        maxLength={20000}
        placeholder={thread ? `Reply to ${nameOf(thread.provider)}` : "Describe what you want done"}
        onChange={(event) => {
          mention.onSelect(event);
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => slash.onKeyDown(event) || mention.onKeyDown(event) || enter(event)}
        onSelect={mention.onSelect}
        onKeyUp={mention.onSelect}
        onClick={mention.onSelect}
        onPaste={files.onPaste}
      />
      <div className="tools">
        {files.button(!props.connected)}
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
        <AgentChoices
          agentId={agentId}
          value={thread ? thread.choices ?? {} : props.choice.choices ?? {}}
          disabled={sending || !props.connected}
          onChange={(id, value) => {
            if (thread) call("thread.update", { threadId: thread.id, choices: { [id]: value } }).catch(actions.fail);
            else props.setChoice({ ...props.choice, choices: { ...props.choice.choices, [id]: value } });
          }}
        />
        <span className="fill" />
        <span className="ends">
        <Dictation onText={addSpoken} fail={actions.fail} disabled={!props.connected} />
        {working ? (
          <button className="send" aria-label={thread.state === "stopping" ? "Stopping" : "Stop"} title="Stop" disabled={!props.connected || thread.state === "stopping"} onClick={() => void actions.cancel(thread.id)}>
            <Icon name="stop" />
          </button>
        ) : (
          <button className="send" aria-label={sending ? "Sending" : "Send"} title="Send" onClick={() => void send()} disabled={!canSend}>
            <Icon name="send" />
          </button>
        )}
        </span>
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
  const lastTurn = list.at(-1);
  const editTurn = (turn: Turn) => {
    files.set((current) => [...turn.files, ...current.filter((file) => !turn.files.some((sent) => sent.id === file.id))].slice(0, 10));
    setDraft([draft, turn.user ?? ""].filter((part) => part.trim()).join("\n\n"));
    document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  };
  const retry = () => {
    if (!lastTurn || sending) return;
    setSending(true);
    actions.prompt(thread.id, lastTurn.user ?? "", lastTurn.files.map((file) => file.id)).catch(actions.fail).finally(() => setSending(false));
  };
  // The question the agent is waiting on sits just above the message box, like the plan while it works.
  const pendingAsk = working && thread.state === "needs_you"
    ? list.at(-1)?.parts.findLast((part): part is Ask => part.kind === "ask" && !part.answer)
    : undefined;
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
            <TurnView key={turn.id} thread={thread} turn={turn} live={working && index === list.length - 1} actions={actions} edit={editTurn} />
          ))}
          {thread.state === "interrupted" && <p className="oops">This turn was interrupted. Check the project for partial changes before you retry.</p>}
          {thread.state === "stopped" && <p className="muted">Turn stopped. Any changes already made may still be in the project.</p>}
          {["failed", "interrupted", "stopped"].includes(thread.state) && lastTurn && (lastTurn.user || lastTurn.files.length > 0) && (
            <div className="retry">
              <button className="btn" disabled={sending || !props.connected || !!notReady} onClick={retry}><Icon name="reload" /> Try again</button>
              <button className="btn" onClick={() => editTurn(lastTurn)}><Icon name="edit" /> Edit message</button>
            </div>
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
        {working && thread.state !== "needs_you" && list.at(-1)?.plan && <PlanList plan={list.at(-1)!.plan!} docked />}
        {pendingAsk && <AskCard thread={thread} item={pendingAsk} actions={actions} active />}
        {(thread.queued?.length ?? 0) > 0 && (
          <ol className="queue" aria-label="Queued messages">
            {thread.queued.map(({ text, attachments }, index) => (
              <li key={`${index}:${text.slice(0, 40)}`}>
                <Icon name="up" />
                <span className="qtext" title={text}>{text || attachments.map((attachment) => attachment.name).join(", ")}</span>
                {attachments.length > 0 && <span className="qfiles" title={`${attachments.length} attached`}><Icon name="clip" />{attachments.length}</span>}
                <button
                  className="qbtn"
                  title="Edit"
                  aria-label="Edit queued message"
                  onClick={() =>
                    call("thread.unqueue", { threadId: thread.id, index })
                      .then((back) => {
                        files.set((current) => [...back.attachments, ...current].slice(0, 10));
                        setDraft([back.text, draft].filter((part) => part.trim()).join("\n\n"));
                      })
                      .catch(actions.fail)
                  }
                >
                  <Icon name="edit" />
                </button>
                <button className="qbtn" title="Remove" aria-label="Remove queued message" onClick={() => call("thread.unqueue", { threadId: thread.id, index }).catch(actions.fail)}>
                  <Icon name="x" />
                </button>
              </li>
            ))}
          </ol>
        )}
        {composer}
        {notice || (
          <p className="hint">
            {working
              ? queueFull ? "The queue is full. It sends as this turn finishes." : `${prefs.sendWith === "ctrl-enter" ? "Ctrl + Enter" : "Enter"} to queue · it sends when this turn finishes`
              : prefs.sendWith === "ctrl-enter" ? "Ctrl + Enter to send" : "Enter to send · Shift + Enter for a new line"}
          </p>
        )}
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
                  {busy(t) && t.state !== "needs_you" ? <Loader /> : <Icon name={t.state === "idle" ? "circlecheck" : "x"} />}
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

type DiffRow = { kind: "add" | "del" | "ctx"; old: number; new: number; text: string } | { kind: "gap" };

/** A unified diff as numbered rows. Headers are dropped; a gap marks unchanged lines left out between sections. */
function diffRows(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const unified = text.startsWith("diff --git ") || text.startsWith("--- ");
  let oldLine = 1;
  let newLine = 1;
  let inHunk = !unified;
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      if (rows.length || Number(hunk[2]) > 1) rows.push({ kind: "gap" });
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line.startsWith("+")) rows.push({ kind: "add", old: 0, new: newLine++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", old: oldLine++, new: 0, text: line.slice(1) });
    else rows.push({ kind: "ctx", old: oldLine++, new: newLine++, text: line.slice(1) });
  }
  return rows;
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
  const rows = diff && !diff.error ? diffRows(diff.text) : [];
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
                <span className="stat">{change.status === "added" ? <>{change.added > 0 && `+${change.added} `}new</> : change.status === "removed" ? <>removed {change.removed > 0 && <i>−{change.removed}</i>}</> : <>+{change.added} <i>−{change.removed}</i></>}</span>
              </button>
              {open === change.path && (
                <div className="diff">
                  {diff === null ? <div className="l ctx">Loading…</div> : diff.error ? <p className="muted">{diff.text} <button className="link" onClick={() => setAttempt(attempt + 1)}>Retry</button></p>
                    : rows.length === 0 ? <div className="l ctx">No text diff available.</div> : rows.map((row, index) =>
                    row.kind === "gap" ? <div key={index} className="l gap" aria-label="Unchanged lines skipped">⋯</div> : (
                      <div key={index} className={`l ${row.kind}`}>
                        <span className="ln" aria-hidden>{row.kind === "add" ? "" : row.old}</span>
                        <span className="ln" aria-hidden>{row.kind === "del" ? "" : row.new}</span>
                        <span className="lt">{row.text || " "}</span>
                      </div>
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
          <iframe key={nonce} name="arcex-preview" src={project.previewUrl} title="Your running app" />
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
