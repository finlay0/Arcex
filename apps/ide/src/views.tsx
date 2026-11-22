import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { Agent, Attachment, Change, FileEntry, Item, Project, ProviderStatus, PublishState, PullRequestEntry, Requests, Thread } from "@arcex/contracts";
import { AgentChoices, ModelPicker, useAgentCommands, type Choice } from "./ModelPicker.tsx";
import { Art } from "./Art.tsx";
import { Dictation } from "./Dictation.tsx";
import { useSlashMenu } from "./SlashMenu.tsx";
import { RunOutput, Scripts } from "./Scripts.tsx";
import { FindBar } from "./Find.tsx";
import { TerminalTab } from "./TerminalTab.tsx";
import { Stash } from "./Stash.tsx";
import { Aside } from "./Aside.tsx";
import { useMentionMenu } from "./MentionMenu.tsx";
import { AttachmentChip, useAttachments } from "./Attachments.tsx";
import { Md } from "./md.tsx";
import { highlight, languageOf } from "./highlight.ts";
import { AutoText, Icon, Loader, Menu, Resizer, STARTERS, ago, limitText, busy, dotClass, nameOf, onEnter, plural, prefs, stateLabel, type Actions } from "./shared.tsx";
import { call, clearSentDraft, saveDraft, useStore } from "./store.ts";

type Step = Extract<Item, { kind: "step" }>;
type Ask = Extract<Item, { kind: "ask" }>;
type QuestionItem = Extract<Item, { kind: "question" }>;

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
      case "agent": return list.length === 1 ? "used a subagent" : `used ${list.length} subagents`;
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
function WorkGroup({ steps, live, children }: { steps: Step[]; live: boolean; children: Map<string, Step[]> }) {
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
              {step.detail && step.detail !== step.label && step.tool !== "agent" && <code title={step.detail}>{step.detail.slice(0, 160)}</code>}
              {children.has(step.id) && <SubagentSteps steps={children.get(step.id)!} live={pending} />}
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

/** What a subagent did inside one Agent or Task call: a count and its latest step, opening to the full list. */
function SubagentSteps({ steps, live }: { steps: Step[]; live: boolean }) {
  const current = live ? steps.findLast((step) => step.status === "running") : undefined;
  const failed = steps.filter((step) => step.status === "failed").length;
  return (
    <details className="peek subagent">
      <summary>
        {live && <Loader work />}
        Subagent · {plural(steps.length, "step")}{failed ? ` · ${failed} failed` : ""}
        {current && <span className="trunc"> · {current.label}</span>}
      </summary>
      <ul>
        {steps.map((step) => (
          <li key={step.id} className={step.status === "failed" ? "bad" : undefined}>
            {step.status === "running" && live ? <Loader work /> : <Icon name={step.status === "done" ? "check" : step.status === "running" ? "dots" : "x"} />}
            <span className="what">{step.label}</span>
          </li>
        ))}
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
function TurnView({ thread, turn, live, last, preview, actions, edit }: { thread: Thread; turn: Turn; live: boolean; last: boolean; preview: boolean; actions: Actions; edit(turn: Turn): void }) {
  const blocks: Block[] = [];
  // Steps a subagent took fold under the call that started it.
  const children = new Map<string, Step[]>();
  const ids = new Set(turn.parts.map((part) => part.id));
  for (const part of turn.parts) {
    if (part.kind !== "step" || !part.parent || !ids.has(part.parent)) continue;
    const list = children.get(part.parent) ?? [];
    list.push(part);
    children.set(part.parent, list);
  }
  for (const part of turn.parts) {
    const last = blocks[blocks.length - 1];
    if (part.kind === "step" && part.parent && ids.has(part.parent)) continue;
    if (part.kind === "step") {
      if (last?.kind === "work") last.steps.push(part);
      else blocks.push({ kind: "work", id: part.id, steps: [part] });
    } else blocks.push(part);
  }
  const running = turn.parts.findLast((part): part is Step => part.kind === "step" && part.status === "running");
  const runningChild = turn.parts.findLast((part): part is Step => part.kind === "step" && part.status === "running" && !!part.parent);
  const runningLabel = runningChild ? `Subagent: ${runningChild.label}` : running?.label;
  const end = turn.parts.find((part) => part.kind === "end");
  const thinking = live && blocks.at(-1)?.kind === "think";
  return (
    <>
      {turn.files.length > 0 && (
        <ul className="attached sent" aria-label="Attached files">
          {turn.files.map((attachment) => <li key={attachment.id}><AttachmentChip attachment={attachment} /></li>)}
        </ul>
      )}
      {turn.user !== null && turn.user !== "" && <YouMessage thread={thread} turn={turn} edit={edit} />}
      {blocks.map((block, index) => {
        if (block.kind === "work") return <WorkGroup key={block.id} steps={block.steps} children={children} live={live && index === blocks.length - 1} />;
        if (block.kind === "say") return <Reply key={block.id} text={block.text} />;
        // A question waiting on the user sits above the message box. Here it shows once it's settled.
        if (block.kind === "ask") return live && thread.state === "needs_you" && !block.answer ? null : <AskCard key={block.id} thread={thread} item={block} actions={actions} active={false} />;
        if (block.kind === "error") return <p key={block.id} className="oops">{block.text}</p>;
        if (block.kind === "question") return live && thread.state === "needs_you" && !block.answer ? null : <p key={block.id} className="answered">{block.title} · {block.answer ?? "Request closed"}</p>;
        if (block.kind === "note") return <p key={block.id} className="note">{block.text}</p>;
        if (block.kind === "suggest") return <SuggestCard key={block.id} thread={thread} item={block} fail={actions.fail} />;
        if (block.kind === "wrap") return <WrapUp key={block.id} thread={thread} item={block} last={last} />;
        if (block.kind === "think") return <ThinkRow key={block.id} item={block} />;
        if (block.kind === "end") return null;
        if (block.kind === "result" && block.changes && block.snapshots) return <TurnChanges key={block.id} thread={thread} item={block} last={last} preview={preview} fail={actions.fail} />;
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
          <span>{thread.state === "stopping" ? "Stopping…" : runningLabel ?? (thinking ? "Thinking" : stateLabel(thread)) ?? "Working"}</span>
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
function YouMessage({ thread, turn, edit }: { thread: Thread; turn: Turn; edit(turn: Turn): void }) {
  const text = turn.user ?? "";
  const [copied, setCopied] = useState(false);
  // Rewind asks first, then once more if files changed after the agent's turns.
  const [rewind, setRewind] = useState<{ step: "confirm" } | { step: "working" } | { step: "changedSince"; files: string[] } | { step: "error"; text: string } | null>(null);
  const go = (force: boolean) => {
    setRewind({ step: "working" });
    call("thread.rewind", { threadId: thread.id, itemId: turn.id, force })
      .then((result) => {
        if (result.text === undefined) return setRewind({ step: "changedSince", files: result.changedSince });
        setRewind(null);
        if (result.restored.length) window.dispatchEvent(new Event(FILES_CHANGED));
        edit({ ...turn, user: result.text, files: result.attachments ?? [] });
      })
      .catch((error: Error) => setRewind({ step: "error", text: error.message }));
  };
  return (
    <>
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
          <button className="icon" aria-label="Edit and send again" title="Edit and send again" onClick={() => edit(turn)}>
            <Icon name="edit" />
          </button>
          {!busy(thread) && (
            <button className="icon" aria-label="Rewind to before this message" title="Rewind to here" onClick={() => setRewind({ step: "confirm" })}>
              <Icon name="reload" />
            </button>
          )}
        </div>
      </div>
      {rewind && rewind.step !== "working" && (
        <div className="undoask rewindask">
          <p>
            {rewind.step === "confirm"
              ? "Go back to before this message? Files the agent changed from here on are put back, this message and everything after it are removed, and your message returns to the box. The agent starts fresh with a recap of the conversation before it."
              : rewind.step === "changedSince"
              ? `${rewind.files.length === 1 ? rewind.files[0] : plural(rewind.files.length, "file")} changed after the agent's last turn. Rewinding overwrites ${rewind.files.length === 1 ? "it" : "them"}, and those changes are lost.`
              : `Couldn't rewind: ${rewind.text}`}
          </p>
          <div className="btns">
            {rewind.step !== "error" && <button className="btn primary" ref={(button) => button?.scrollIntoView({ block: "center" })} onClick={() => go(rewind.step === "changedSince")}>{rewind.step === "confirm" ? "Rewind" : "Rewind anyway"}</button>}
            <button className="btn" onClick={() => setRewind(null)}>{rewind.step === "error" ? "Close" : "Cancel"}</button>
          </div>
        </div>
      )}
      {rewind?.step === "working" && <p className="note rewinding">Rewinding…</p>}
    </>
  );
}

/**
 * The agent's questions above the message box. Pick an option (or press its number), type your own answer, or skip.
 * A single one-pick question sends as soon as an option is chosen.
 */
function QuestionCard({ thread, item, fail }: { thread: Thread; item: QuestionItem; fail(error: unknown): void }) {
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const quick = item.questions.length === 1 && item.questions[0]!.kind === "one";

  const send = (answers: Record<string, string | string[]> | null) => {
    if (sending) return;
    setSending(true);
    call("question.answer", { threadId: thread.id, itemId: item.id, answers }).catch((error) => {
      setSending(false);
      fail(error);
    });
  };
  const collect = (extra?: { id: string; value: string }) => {
    const answers: Record<string, string | string[]> = {};
    for (const question of item.questions) {
      const picked = extra?.id === question.id ? [extra.value] : picks[question.id] ?? [];
      if (question.kind === "many" && picked.length) answers[question.id] = picked;
      if (question.kind === "one" && picked[0]) answers[question.id] = picked[0];
      if (question.kind === "text" && typed[question.id]?.trim()) answers[question.id] = typed[question.id]!.trim();
      if (question.otherId && typed[question.otherId]?.trim()) answers[question.otherId] = typed[question.otherId]!.trim();
    }
    return answers;
  };
  const pick = (questionId: string, value: string) => {
    const question = item.questions.find((entry) => entry.id === questionId)!;
    if (quick && !typed[question.otherId ?? ""]?.trim()) return send(collect({ id: questionId, value }));
    setPicks((current) => {
      const now = current[questionId] ?? [];
      const next = question.kind === "many" ? (now.includes(value) ? now.filter((entry) => entry !== value) : [...now, value]) : [value];
      return { ...current, [questionId]: next };
    });
  };
  const answered = Object.keys(collect()).length > 0;
  const card = useRef<HTMLDivElement>(null);
  // The card takes focus when it appears, so its number keys work straight away.
  useEffect(() => card.current?.focus({ preventScroll: true }), []);

  // Number keys pick from the first question, as in the other apps, unless the user is typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.ctrlKey || event.metaKey || event.altKey || target?.closest("input, textarea, [contenteditable]")) return;
      const index = Number(event.key) - 1;
      const first = item.questions[0];
      if (!first || first.kind === "text" || !Number.isInteger(index) || index < 0 || index >= first.options.length) return;
      event.preventDefault();
      pick(first.id, first.options[index]!.value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="ask question" ref={card} tabIndex={-1} role="group" aria-label={`${nameOf(thread.provider)} has a question`}>
      <span className="label">{nameOf(thread.provider)} has a question</span>
      {item.title && <b>{item.title}</b>}
      {item.questions.map((question, number) => (
        <fieldset key={question.id} className="qfield" disabled={sending}>
          {(question.header || question.text) && (
            <legend>
              {question.header && <span className="qhead">{question.header}</span>}
              {question.text && <span>{question.text}</span>}
            </legend>
          )}
          {question.options.length > 0 && (
            <div className="qopts" role={question.kind === "many" ? "group" : "radiogroup"}>
              {question.options.map((option, index) => {
                const on = (picks[question.id] ?? []).includes(option.value);
                return (
                  <button key={option.value} className="qopt" role={question.kind === "many" ? "checkbox" : "radio"} aria-checked={on} onClick={() => pick(question.id, option.value)}>
                    {number === 0 && index < 9 ? <kbd>{index + 1}</kbd> : <span className="qmark" aria-hidden>{question.kind === "many" ? (on ? "☑" : "☐") : on ? "●" : "○"}</span>}
                    <span className="qtext">
                      <b>{option.label}</b>
                      {option.description && <span>{option.description}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {(question.kind === "text" || question.otherId) && (
            <input
              className="textfield"
              maxLength={4000}
              placeholder={question.kind === "text" ? "Type your answer" : "Or type your own answer"}
              aria-label={question.kind === "text" ? question.header ?? question.text ?? "Answer" : "Your own answer"}
              value={typed[question.otherId ?? question.id] ?? ""}
              onChange={(event) => setTyped({ ...typed, [question.otherId ?? question.id]: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && answered) send(collect());
              }}
            />
          )}
        </fieldset>
      ))}
      <div className="btns">
        {(!quick || Object.values(typed).some((value) => value.trim())) && (
          <button className="btn primary" disabled={!answered || sending} onClick={() => send(collect())}>Send answer</button>
        )}
        <button className="btn" disabled={sending} onClick={() => send(null)}>Skip</button>
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
        title="Copy reply"
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
  /** A second agent or model a new thread's first message also goes to (main pane only). */
  compare?: Choice | null;
  setCompare?(choice: Choice | null): void;
  /** The new thread works in a separate copy of the project (main pane only). */
  separate?: boolean;
  setSeparate?(on: boolean): void;
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
  // Review comments from a diff each go on their own line.
  const addLine = useRef((_text: string) => {});
  addLine.current = (text: string) => {
    const next = latestDraft.current.trim() ? `${latestDraft.current.trimEnd()}\n${text}` : text;
    if (next.length > 20_000) return actions.fail("That comment doesn't fit in the message. Send what's there first.");
    setDraft(next);
    latestDraft.current = next;
  };
  useEffect(() => {
    // A string goes to the main pane; { text, threadId } goes to that thread's pane (split view has two).
    const onAdd = (event: Event) => {
      const detail = (event as CustomEvent<string | { text: string; threadId: string }>).detail;
      if (typeof detail === "string") {
        if (!flow.current?.closest(".pane.second")) addLine.current(detail);
      } else if (detail && detail.threadId === threadIdRef.current) addLine.current(detail.text);
    };
    window.addEventListener(ADD_TO_DRAFT, onAdd);
    return () => window.removeEventListener(ADD_TO_DRAFT, onAdd);
  }, []);
  const threadIdRef = useRef(thread?.id);
  threadIdRef.current = thread?.id;
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
  const flow = useRef<HTMLDivElement>(null);
  // Ctrl+F finds text in this thread.
  const [finding, setFinding] = useState(false);
  useEffect(() => {
    if (!thread) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "f" && !document.querySelector(".palette")) {
        // In split view only the pane the user is in answers.
        const pane = flow.current?.closest(".pane");
        const other = [...document.querySelectorAll(".pane")].find((entry) => entry !== pane && entry.contains(document.activeElement));
        if (other) return;
        event.preventDefault();
        setFinding(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [thread?.id]);
  // Up arrow in an empty box brings back earlier messages from this thread, newest first; Down goes forward again.
  const sent = useMemo(() => props.items.flatMap((item) => (item.kind === "user" && item.text.trim() ? [item.text] : [])).reverse(), [props.items]);
  const recalled = useRef(-1);
  const recall = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || !sent.length) return false;
    const box = event.currentTarget;
    const browsing = recalled.current >= 0 && draft === sent[recalled.current];
    if (event.key === "ArrowUp") {
      // Only from an empty box, or while already stepping back, and not from inside a long recalled message.
      if (!(draft === "" || browsing) || (browsing && box.value.slice(0, box.selectionStart).includes("\n"))) return false;
      if (recalled.current >= sent.length - 1 && browsing) return true;
      recalled.current = browsing ? recalled.current + 1 : 0;
    } else {
      if (!browsing) return false;
      recalled.current -= 1;
    }
    event.preventDefault();
    setDraft(recalled.current >= 0 ? sent[recalled.current]! : "");
    return true;
  };
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
  // Agents that take messages mid-turn get them straight away; Tab still queues one for after the turn.
  const steerable = working && thread?.steering === true && thread.state !== "stopping";
  const queueKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab" || event.shiftKey || !steerable || queueFull || !draft.trim()) return false;
    event.preventDefault();
    void send("queue");
    return true;
  };
  const canSend = Boolean(target && props.connected && !notReady && (!queueFull || steerable) && !sending && !files.uploading && (draft.trim() || files.list.length) && (!working || thread?.state !== "stopping"));

  const send = async (mode?: "queue") => {
    if (!canSend || !target || pendingSend.current) return;
    pendingSend.current = true;
    setSending(true);
    const attachments = files.list.map((attachment) => attachment.id);
    try {
      if (thread && working) await call("thread.prompt", { threadId: thread.id, text: draft, attachments, ...(steerable && mode !== "queue" ? { steer: true } : { queue: true }) });
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
        onKeyDown={(event) => slash.onKeyDown(event) || mention.onKeyDown(event) || recall(event) || queueKey(event) || enter(event)}
        onSelect={mention.onSelect}
        onKeyUp={mention.onSelect}
        onClick={mention.onSelect}
        onPaste={files.onPaste}
      />
      <div className="tools">
        {files.button(!props.connected)}
        <Stash draft={draft} setDraft={setDraft} />
        {thread && <Aside thread={thread} fail={actions.fail} />}
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
        {!thread && props.setSeparate && (
          <button
            className={props.separate ? "icon on" : "icon"}
            aria-pressed={!!props.separate}
            aria-label="Work in a separate copy"
            title={props.separate ? "This thread will work in a separate copy of the project, so it can't collide with other threads. Click to work in the project folder instead." : "Work in a separate copy of the project, so this thread can't collide with others working at the same time"}
            onClick={() => props.setSeparate!(!props.separate)}
          >
            <Icon name="branch" />
          </button>
        )}
        {!thread && props.setCompare && (props.compare ? (
          <span className="compare">
            <span className="vs">and</span>
            <ModelPicker
              agents={props.agents}
              nameOf={nameOf}
              lockAgent={false}
              disabled={sending || !props.connected}
              manage={props.manageAgents}
              value={props.compare}
              onChange={(choice) => props.setCompare!(choice)}
            />
            <button className="icon" aria-label="Don't compare" title="Send to one model only" onClick={() => props.setCompare!(null)}>
              <Icon name="x" />
            </button>
          </span>
        ) : (
          <button className="icon" aria-label="Compare with another model" title="Compare: send this to a second agent or model too, side by side" onClick={() => props.setCompare!({ agentId: props.choice.agentId, model: null })}>
            <Icon name="layers" />
          </button>
        ))}
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
        {thread?.context && <ContextMeter thread={thread} compact={() => void actions.prompt(thread.id, "/compact").catch(actions.fail)} />}
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
  const limit = limitText(nameOf(agentId), useStore().limits[agentId]);
  const notice = notReady ? (
    <p className="notice">
      {nameOf(agentId)} {health.installed ? "isn't signed in" : "isn't installed"} on this computer.{" "}
      <button className="link" onClick={props.manageAgents}>Set it up</button>
    </p>
  ) : limit ? (
    <p className="notice limit" role="status">{limit}</p>
  ) : null;

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
  const pendingQuestion = working && thread.state === "needs_you"
    ? list.at(-1)?.parts.findLast((part): part is QuestionItem => part.kind === "question" && !part.answer)
    : undefined;
  return (
    <div className="convo">
      {finding && <FindBar root={flow} watch={props.items} close={() => setFinding(false)} />}
      <QuoteSelection root={flow} threadId={thread.id} />
      <Minimap scroller={scroller} watch={props.items} />
      <div
        className="scroll"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 160);
        }}
      >
        <div className="flow" ref={flow}>
          {list.map((turn, index) => (
            <TurnView key={turn.id} thread={thread} turn={turn} live={working && index === list.length - 1} last={index === list.length - 1} preview={!!project?.previewUrl} actions={actions} edit={editTurn} />
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
        {!pendingAsk && pendingQuestion && <QuestionCard key={pendingQuestion.id} thread={thread} item={pendingQuestion} fail={actions.fail} />}
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
              ? steerable
                ? `${prefs.sendWith === "ctrl-enter" ? "Ctrl + Enter" : "Enter"} to send now${queueFull ? "" : " · Tab to queue for after this turn"}`
                : queueFull ? "The queue is full. It sends as this turn finishes." : `${prefs.sendWith === "ctrl-enter" ? "Ctrl + Enter" : "Enter"} to queue · it sends when this turn finishes`
              : prefs.sendWith === "ctrl-enter" ? "Ctrl + Enter to send" : "Enter to send · Shift + Enter for a new line"}
          </p>
        )}
      </div>
    </div>
  );
}

/* ───────── Right panel ───────── */

// Editors installed on this computer, read once.
let editorList: Promise<{ id: string; name: string }[]> | null = null;

/** "Open in VS Code / Cursor / File Explorer" for the project or one of its files. */
function OpenIn(props: { project: Project; path?: string; fail(error: unknown): void; compact?: boolean }) {
  const [editors, setEditors] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let stale = false;
    editorList ??= call("project.editors", {}).catch(() => {
      editorList = null;
      return [];
    });
    void editorList.then((list) => !stale && setEditors(list));
    return () => {
      stale = true;
    };
  }, []);
  if (!editors.length) return null;
  const what = props.path ? "this file" : "this project";
  return (
    <Menu
      label={`Open ${what} in another app`}
      icon="out"
      text={props.compact ? undefined : "Open in"}
      items={editors.map((editor) => ({
        label: editor.name,
        run: () => void call("project.openIn", { projectId: props.project.id, editor: editor.id, ...(props.path ? { path: props.path } : {}) }).catch(props.fail),
      }))}
    />
  );
}

export type PanelTab = "details" | "browser" | "terminal";

export function Panel(props: {
  project: Project;
  threads: Thread[];
  items: Record<string, Item[]>;
  connected: boolean;
  tab: PanelTab;
  setTab(tab: PanelTab): void;
  open(thread: Thread): void;
  /** Starts a thread that reviews the project's unsaved changes. */
  /** Starts a review thread: of the unsaved changes, or with the given prompt (a branch review). */
  review(prompt?: string): void;
  /** A file a reply asked to show, with a changing `nonce` so the same file can be asked for again. */
  openFile: { path: string; line: number | null; nonce: number } | null;
  /** The user turned on the opt-in terminal. */
  terminal: boolean;
  /** The thread on screen, if one is. */
  thread: Thread | null;
  /** Goes to a new thread in this project with `text` in its message box. */
  startDraft(text: string): void;
  fail(error: unknown): void;
  close(): void;
}) {
  const { project, threads, fail } = props;
  const recent = [...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  // Files also change outside a turn, when the user undoes one.
  const [nudged, setNudged] = useState(0);
  useEffect(() => {
    const nudge = () => setNudged((count) => count + 1);
    window.addEventListener(FILES_CHANGED, nudge);
    // Coming back to the window: the user may have changed files in another app.
    window.addEventListener("focus", nudge);
    return () => {
      window.removeEventListener(FILES_CHANGED, nudge);
      window.removeEventListener("focus", nudge);
    };
  }, []);
  const settled = `${props.connected}:${nudged}:${threads.map((t) => `${t.id}:${t.state}`).join()}`;
  const [wide, setWide] = useState(false);
  // A file opened from the Files list replaces the details until Back.
  const [viewing, setViewing] = useState<string | null>(null);
  const [viewLine, setViewLine] = useState<number | null>(null);
  // A script's output also replaces the details until Back.
  const [watching, setWatching] = useState<string | null>(null);
  useEffect(() => {
    setViewing(null);
    setWatching(null);
  }, [project.id]);
  useEffect(() => {
    if (!props.openFile) return;
    setWatching(null);
    setViewing(props.openFile.path);
    setViewLine(props.openFile.line);
  }, [props.openFile?.nonce]);
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

  const tabs: PanelTab[] = props.terminal ? ["details", "browser", "terminal"] : ["details", "browser"];
  const isWide = !!(wide || props.tab === "browser" || props.tab === "terminal" || ((viewing || watching) && props.tab === "details"));
  return (
    <aside className={isWide ? "panel wide" : "panel"}>
      <Resizer
        name={isWide ? "panel-wide-w" : "panel-w"}
        edge="left"
        min={280}
        max={() => window.innerWidth - (document.querySelector(".sidebar:not(.shut)")?.getBoundingClientRect().width ?? 0) - 440}
        label="Resize the side panel"
      />
      <div className="ptop">
        <div className="tabs" role="tablist" aria-label="Project panel" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const at = tabs.indexOf(props.tab);
          const next = event.key === "Home" ? tabs[0]! : event.key === "End" ? tabs[tabs.length - 1]! : tabs[(at + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
          props.setTab(next);
          document.getElementById(`${tabsId}-${next}`)?.focus();
        }}>
          {tabs.map((id) => (
            <button key={id} id={`${tabsId}-${id}`} role="tab" aria-controls={`${tabsId}-panel`} aria-selected={props.tab === id} tabIndex={props.tab === id ? 0 : -1} onClick={() => props.setTab(id)}>
              {id === "details" ? "Details" : id === "browser" ? "Browser" : "Terminal"}
            </button>
          ))}
        </div>
        <span className="fill" />
        {props.tab === "details" && !viewing && (
          <button className="icon" aria-pressed={wide} aria-label={wide ? "Make panel narrower" : "Make panel wider"} title={wide ? "Narrower" : "Wider"} onClick={() => setWide(!wide)}>
            <Icon name="grow" />
          </button>
        )}
        <button className="icon" aria-label="Hide panel" title="Hide panel (Ctrl J)" onClick={props.close}>
          <Icon name="x" />
        </button>
      </div>
      <div className="panel-content" id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${props.tab}`}>
      {props.tab === "terminal" && props.terminal ? (
        <TerminalTab project={project} fail={fail} />
      ) : props.tab === "browser" ? (
        <Browser project={project} found={found} fail={fail} />
      ) : (
        <>
        {viewing && <FileView project={project} path={viewing} line={viewLine} refresh={settled} back={() => { setViewing(null); setViewLine(null); }} fail={fail} />}
        {!viewing && watching && <RunOutput runId={watching} back={() => setWatching(null)} fail={fail} />}
        <div className="pbody" hidden={!!viewing || !!watching}>
          <div className="phero" title={project.cwd}>
            <Icon name="folder" />
            <b className="trunc">{project.name}</b>
            <OpenIn project={project} fail={fail} />
            <span>
              <span className={threads.some((t) => t.state === "needs_you") ? "dot needs" : threads.some(busy) ? "dot working" : "dot ok"} />
              {threads.some((t) => t.state === "needs_you") ? "Needs you" : threads.some(busy) ? `${plural(threads.filter(busy).length, "agent")} working` : "Project active"}
            </span>
          </div>
          <div className="goalcard">
            <span className="label">Building</span>
            <p>{project.goal || "Add a project goal in Settings."}</p>
          </div>
          <Scripts project={project} refresh={settled} fail={fail} show={setWatching} preview={() => props.setTab("browser")} />
          <Files project={project} refresh={settled} view={(file) => { setViewLine(null); setViewing(file); }} />
          <Changes project={project} refresh={settled} fail={fail} review={props.review} />
          <Versions project={project} refresh={settled} fail={fail} />
          <Publish project={project} refresh={settled} fail={fail} startDraft={props.startDraft} />
          <AgentTasks threads={threads} open={props.open} fail={fail} />
          {props.thread?.copy && <CopySection thread={props.thread} refresh={settled} fail={fail} />}
          {props.thread && <SideThreads thread={props.thread} threads={threads} fail={fail} />}
          {props.thread && <Folders thread={props.thread} fail={fail} />}
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
        </>
      )}
      </div>
    </aside>
  );
}

/** The project's folders and files. Folders open in place; nothing here edits anything. */
function Files({ project, refresh, view }: { project: Project; refresh: string; view(path: string): void }) {
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
          <button key={path} className="file" title={path} onClick={() => view(path)}>
            <Icon name="file" /> <span className="trunc">{entry.name}</span>
          </button>
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

/** One file, read-only, with line numbers and grey syntax tones. Esc or Back returns to the details. */
function FileView({ project, path, line: focus, refresh, back, fail }: { project: Project; path: string; line?: number | null; refresh: string; back(): void; fail(error: unknown): void }) {
  type Loaded = Requests["project.readFile"]["result"];
  const [file, setFile] = useState<Loaded | { error: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const code = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    call("project.readFile", { projectId: project.id, path })
      .then((result) => { if (current) setFile(result); })
      .catch((error: Error) => { if (current) setFile({ error: error.message }); });
    return () => { current = false; };
  }, [project.id, path, refresh]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Only when focus is in the panel (or nowhere), so Esc in a menu or the message box stays theirs.
      const target = event.target as Element | null;
      if (event.key === "Escape" && !event.defaultPrevented && (target === document.body || target?.closest?.(".panel"))) back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);
  const lines = useMemo(() => (file && "text" in file && file.text !== undefined ? highlight(file.text, languageOf(path)) : null), [file, path]);
  const name = path.split(/[\\/]/).pop() ?? path;
  // Opened from a reply that named a line: bring that line into view.
  useEffect(() => {
    if (focus && lines) code.current?.querySelector(`tr:nth-child(${focus})`)?.scrollIntoView({ block: "center" });
  }, [focus, lines]);
  return (
    <div className="fileview">
      <div className="fvtop">
        <button className="icon" aria-label="Back to project details" title="Back" onClick={back}><Icon name="back" /></button>
        <span className="fvname trunc" title={path}><b>{name}</b>{path !== name && <span className="muted"> {path.slice(0, -name.length - 1)}</span>}</span>
        <OpenIn project={project} path={path} fail={fail} compact />
        {lines && (
          <button className="icon" aria-label={copied ? "Copied" : "Copy file contents"} title="Copy" onClick={() => {
            if (file && "text" in file && file.text !== undefined) void navigator.clipboard.writeText(file.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}>
            <Icon name={copied ? "check" : "copy"} />
          </button>
        )}
      </div>
      {!file ? <p className="muted fvnote">Loading…</p>
        : "error" in file ? <p className="muted fvnote">Couldn't open this file: {file.error}</p>
        : file.tooLarge ? <p className="muted fvnote">This file is {Math.round(file.size / 1024 / 1024 * 10) / 10} MB, too large to show here.</p>
        : file.binary ? <p className="muted fvnote">This file isn't text, so it can't be shown here.</p>
        : lines && (
          <div className="fvcode" role="region" aria-label={`Contents of ${name}`} tabIndex={0} ref={code}>
            <table>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={index} className={focus === index + 1 ? "at" : undefined}>
                    <td className="ln">{index + 1}</td>
                    <td className="lt">{line.map((token, at) => token.kind === "plain" ? token.text : <span key={at} className={`tk-${token.kind}`}>{token.text}</span>)}{"\n"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

/** How full the agent's context window is: a small ring by the message box, with the numbers on hover. */
function ContextMeter({ thread, compact }: { thread: Thread; compact(): void }) {
  const context = thread.context!;
  const share = Math.min(1, context.used / context.size);
  const percent = Math.round(share * 100);
  const tokens = (count: number) => (count >= 1_000_000 ? `${Math.round(count / 100_000) / 10}M` : count >= 1000 ? `${Math.round(count / 1000)}k` : String(count));
  // Agents with a "compact" command can summarise on request; the meter offers it.
  const canCompact = useAgentCommands(thread.provider).some((command) => command.name === "compact") && !busy(thread);
  const [asking, setAsking] = useState(false);
  const label = `${percent}% of the agent's memory for this thread used (${tokens(context.used)} of ${tokens(context.size)} tokens).${percent >= 80 ? " It will start summarising older messages soon; a new thread starts clean." : ""}${canCompact ? " Click to summarise older messages now." : ""}`;
  const r = 7;
  const length = 2 * Math.PI * r;
  const ring = (
    <>
      <svg viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={r} className="track" />
        <circle cx="9" cy="9" r={r} className="fillring" strokeDasharray={`${share * length} ${length}`} transform="rotate(-90 9 9)" />
      </svg>
      {percent >= 50 && <span className="ctxpct">{percent}%</span>}
    </>
  );
  const className = percent >= 80 ? "ctxmeter high" : "ctxmeter";
  if (!canCompact) return <span className={className} role="img" aria-label={label} title={label}>{ring}</span>;
  return (
    <span className="ctxwrap">
      <button className={className} aria-label={label} title={label} aria-expanded={asking} onClick={() => setAsking(!asking)}>{ring}</button>
      {asking && (
        <div className="ctxpop" role="dialog" aria-label="Summarise older messages">
          <p>Summarise older messages now? The agent keeps a short summary and frees up memory, so early details may need repeating.</p>
          <div className="btns">
            <button className="btn primary" autoFocus onClick={() => { setAsking(false); compact(); }}>Summarise</button>
            <button className="btn" onClick={() => setAsking(false)}>Cancel</button>
          </div>
        </div>
      )}
    </span>
  );
}

/** Sent when the project's files change outside a turn, so the side panel looks again. */
const FILES_CHANGED = "arcex:files-changed";
/** Asks the app to open the side panel on the Browser tab, showing the project's running app. */
export const OPEN_PREVIEW = "arcex:open-preview";

/** "Save a version": commits the project's changes, out of sight. Says "Saved" for a moment afterwards. */
function SaveVersion({ projectId, message, fail, className = "btn" }: { projectId: string; message: string; fail(error: unknown): void; className?: string }) {
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  return (
    <button
      className={className}
      disabled={state !== "idle"}
      title="Save everything in this project as a version you can come back to"
      onClick={() => {
        setState("saving");
        call("project.saveVersion", { projectId, message })
          .then(() => {
            setState("saved");
            window.dispatchEvent(new Event(FILES_CHANGED));
            setTimeout(() => setState("idle"), 2000);
          })
          .catch((error) => {
            setState("idle");
            fail(error);
          });
      }}
    >
      {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Save a version"}
    </button>
  );
}

/**
 * Push and pull requests, shown only when the project already has a remote (people who use GitHub). Git and the
 * GitHub CLI use the user's own sign-in.
 */
function Publish({ project, refresh, fail, startDraft }: { project: Project; refresh: string; fail(error: unknown): void; startDraft(text: string): void }) {
  const [state, setState] = useState<PublishState | null>(null);
  const [doing, setDoing] = useState<"push" | "pr" | null>(null);
  const [picking, setPicking] = useState<PullRequestEntry[] | "loading" | null>(null);
  const [switching, setSwitching] = useState<number | null>(null);
  const pickPr = () => {
    if (picking) return setPicking(null);
    setPicking("loading");
    call("project.pullRequests", { projectId: project.id })
      .then(setPicking)
      .catch((error) => { setPicking(null); fail(error); });
  };
  const startOn = (number: number) => {
    setSwitching(number);
    call("project.checkoutPr", { projectId: project.id, number })
      .then((pr) => {
        setPicking(null);
        window.dispatchEvent(new Event(FILES_CHANGED));
        // The user writes what they want below; nothing goes to an agent until they send it.
        const parts = [
          `This project is now on pull request #${pr.number}, "${pr.title}"${pr.author ? ` by ${pr.author}` : ""} (branch ${pr.branch}, into ${pr.base}).`,
          pr.body.trim() ? `Its description:\n${pr.body.trim()}` : "",
          `Run \`gh pr diff ${pr.number}\` to see its changes.`,
        ];
        startDraft(`${parts.filter(Boolean).join("\n\n")}\n\n`);
      })
      .catch(fail)
      .finally(() => setSwitching(null));
  };
  useEffect(() => {
    let current = true;
    call("project.publishState", { projectId: project.id })
      .then((result) => { if (current) setState(result); })
      .catch(() => { if (current) setState(null); });
    return () => { current = false; };
  }, [project.id, refresh]);
  if (!state?.remote || !state.branch) return null;
  const act = (kind: "push" | "pr") => {
    setDoing(kind);
    call(kind === "push" ? "project.push" : "project.createPr", { projectId: project.id })
      .then(setState)
      .catch(fail)
      .finally(() => setDoing(null));
  };
  const pr = state.pr;
  const checks = pr && pr.state === "open" && pr.checks !== "none" ? ` · checks ${pr.checks}` : "";
  // After a merge or close, offer a new one only once there is new work on the branch.
  const canPr = state.gh && state.github && state.branch !== state.main && (!pr || (pr.state !== "open" && state.ahead > 0));
  return (
    <section className="sec publish">
      <header><b>{state.github ? "GitHub" : `Remote · ${state.remote}`}</b></header>
      <div className="vrow">
        <span className="trunc">
          <span className="mono">{state.branch}</span>
          {state.ahead > 0 ? ` · ${plural(state.ahead, "saved version")} not pushed` : state.upstream ? " · up to date" : " · not pushed yet"}
        </span>
        {(state.ahead > 0 || !state.upstream) && (
          <button className="btn small" disabled={doing !== null} onClick={() => act("push")}>{doing === "push" ? "Pushing…" : "Push"}</button>
        )}
      </div>
      {pr && (
        <div className="vrow">
          <span className={pr.checks === "failing" && pr.state === "open" ? "trunc bad" : "trunc"} title={pr.title}>
            Pull request #{pr.number} · {pr.state}{checks}
          </span>
          {pr.url && <button className="link" onClick={() => window.arcex?.openExternal(pr.url)}>Open</button>}
        </div>
      )}
      {canPr && (
        <div className="vrow">
          <span className="trunc muted">No open pull request for this branch</span>
          <button className="btn small" disabled={doing !== null} onClick={() => act("pr")}>{doing === "pr" ? "Opening…" : "Create pull request"}</button>
        </div>
      )}
      {state.gh && state.github && (
        <div className="vrow">
          <span className="trunc muted">Start from a pull request</span>
          <button className="link" aria-expanded={!!picking} onClick={pickPr}>{picking ? "Close" : "Choose"}</button>
        </div>
      )}
      {picking === "loading" && <p className="folderhint">Loading pull requests…</p>}
      {Array.isArray(picking) && picking.length === 0 && <p className="folderhint">No open pull requests.</p>}
      {Array.isArray(picking) &&
        picking.map((entry) => (
          <button key={entry.number} className="act" disabled={switching !== null} title={`${entry.title} · ${entry.branch}`} onClick={() => startOn(entry.number)}>
            <span className="mono">#{entry.number}</span>
            <span className="trunc">{entry.title}{entry.draft ? " (draft)" : ""}</span>
            <span className="when">{switching === entry.number ? "Switching…" : entry.author}</span>
          </button>
        ))}
    </section>
  );
}

/** How long something has run, as "45s", "3m 10s" or "1h 4m". */
function took(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** Work agents left running in the background (a dev server, a long build), across the project's threads. */
function AgentTasks({ threads, open, fail }: { threads: Thread[]; open(thread: Thread): void; fail(error: unknown): void }) {
  const [now, setNow] = useState(Date.now());
  const [all, setAll] = useState(false);
  const entries = threads
    .flatMap((thread) => (thread.tasks ?? []).map((task) => ({ thread, task })))
    .sort((a, b) => Number(b.task.state === "running") - Number(a.task.state === "running") || b.task.startedAt - a.task.startedAt);
  const running = entries.some((entry) => entry.task.state === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!entries.length) return null;
  const shown = all ? entries : entries.slice(0, 5);
  return (
    <section className="sec">
      <header><b>Background work</b></header>
      {shown.map(({ thread, task }) => (
        <div key={task.id} className="taskrow" title={[task.description, task.summary].filter(Boolean).join("\n")}>
          {task.state === "running" ? <Loader work /> : <Icon name={task.state === "completed" ? "check" : "x"} />}
          <button className="tasktext" onClick={() => open(thread)}>
            <span className="trunc">{task.name || task.description || "Background task"}</span>
            <span className="when">
              {task.state === "running" ? `Running for ${took(now - task.startedAt)}` : task.state === "completed" ? `Finished in ${took((task.endedAt ?? now) - task.startedAt)}` : task.state === "failed" ? "Failed" : "Stopped"}
              {" · "}{thread.title}
            </span>
          </button>
          {task.state === "running" && task.canStop && (
            <button className="link" onClick={() => void call("thread.stopTask", { threadId: thread.id, taskId: task.id }).catch(fail)}>Stop</button>
          )}
        </div>
      ))}
      {entries.length > 5 && <button className="link" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${entries.length}`}</button>}
    </section>
  );
}

/** The agent's wrap-up of a turn: a recap, and on the last turn, messages to pick for the message box. */
function WrapUp({ thread, item, last }: { thread: Thread; item: Extract<Item, { kind: "wrap" }>; last: boolean }) {
  const pick = last && thread.state === "idle" && item.next.length > 0;
  return (
    <div className="wrapup">
      {item.recap && <p className="wraprecap">{item.recap}</p>}
      {pick && (
        <div className="nextsteps" role="group" aria-label="Suggested next messages">
          {item.next.map((next) => (
            <button key={next} className="nextstep" title="Put this in the message box" onClick={() => window.dispatchEvent(new CustomEvent(ADD_TO_DRAFT, { detail: { text: next, threadId: thread.id } }))}>
              {next}
            </button>
          ))}
        </div>
      )}
      <span className="wrapby" title="Written by the thread's agent in a short follow-up after the turn, which uses a little of your plan. Turn wrap-ups off in Settings › General.">
        Wrap-up by {item.by}
      </span>
    </div>
  );
}

/** Opens a thread beside the one on screen. App.tsx listens. */
export const OPEN_BESIDE = "arcex:open-beside";
const openBeside = (id: string) => window.dispatchEvent(new CustomEvent(OPEN_BESIDE, { detail: id }));

/** Separate work the agent suggested. Starting it opens a side thread; until then nothing runs. */
function SuggestCard({ thread, item, fail }: { thread: Thread; item: Extract<Item, { kind: "suggest" }>; fail(error: unknown): void }) {
  const started = useStore().threads.find((t) => t.id === item.started) ?? null;
  const [busyNow, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  if (item.dismissed) return <p className="note">Dismissed a suggested side thread: {item.title}</p>;
  const start = () => {
    setBusy(true);
    call("thread.side", { threadId: thread.id, itemId: item.id })
      .then((child) => openBeside(child.id))
      .catch(fail)
      .finally(() => setBusy(false));
  };
  return (
    <div className="suggest">
      <div className="suggesthead">
        <Icon name="branch" />
        <b className="trunc">{item.title}</b>
        {started && <span className="sidestate">{started.state === "idle" ? "Finished" : stateLabel(started) || "Working"}</span>}
      </div>
      <p className={more ? "suggestprompt open" : "suggestprompt"}>{item.prompt}</p>
      {item.prompt.length > 180 && <button className="link" onClick={() => setMore(!more)}>{more ? "Show less" : "Show all"}</button>}
      <div className="changeacts">
        {item.started ? (
          started ? <button className="btn" onClick={() => openBeside(started.id)}>Open side thread</button> : <span className="folderhint">The side thread was removed.</span>
        ) : (
          <>
            <button className="btn savever" disabled={busyNow} title="Start this as a side thread beside this one, in its own copy of the project" onClick={start}>{busyNow ? "Starting…" : "Start side thread"}</button>
            <button className="btn" disabled={busyNow} onClick={() => void call("thread.dismissSuggestion", { threadId: thread.id, itemId: item.id }).catch(fail)}>Dismiss</button>
          </>
        )}
      </div>
    </div>
  );
}

/** Side threads started from this thread, with their live state, and a box to start one. On a side thread, its parent. */
function SideThreads({ thread, threads, fail }: { thread: Thread; threads: Thread[]; fail(error: unknown): void }) {
  const children = threads.filter((t) => t.parentId === thread.id && !t.archived).sort((a, b) => b.createdAt - a.createdAt);
  const parent = thread.parentId ? threads.find((t) => t.id === thread.parentId) ?? null : null;
  const [writing, setWriting] = useState(false);
  const [words, setWords] = useState("");
  const [starting, setStarting] = useState(false);
  const start = () => {
    if (!words.trim()) return;
    setStarting(true);
    call("thread.side", { threadId: thread.id, text: words.trim() })
      .then((child) => { setWords(""); setWriting(false); openBeside(child.id); })
      .catch(fail)
      .finally(() => setStarting(false));
  };
  return (
    <section className="sec">
      <header>
        <b>Side threads</b>
        {!writing && <button className="link" onClick={() => setWriting(true)}>Start one</button>}
      </header>
      {parent && (
        <button className="act" onClick={() => openBeside(parent.id)}>
          <Icon name="chat" />
          <span className="trunc">Side thread of {parent.title}</span>
        </button>
      )}
      {!children.length && !writing && !parent && <p className="folderhint">Separate work can run beside this thread, in its own copy of the project. The agent may suggest some, or start one yourself.</p>}
      {children.map((child) => {
        const dot = dotClass(child);
        return (
          <button key={child.id} className="act sidethread" title={stateLabel(child) || child.title} onClick={() => openBeside(child.id)}>
            {dot ? <span className={dot} /> : <Icon name={child.state === "idle" ? "circlecheck" : "x"} />}
            <span className="trunc">{child.title}</span>
            <span className="when">{child.state === "idle" ? "Finished" : stateLabel(child)}</span>
          </button>
        );
      })}
      {writing && (
        <div className="sidebox">
          <textarea
            value={words}
            autoFocus
            rows={3}
            placeholder="What should the side thread do?"
            aria-label="What should the side thread do?"
            onChange={(event) => setWords(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); start(); }
              if (event.key === "Escape") setWriting(false);
            }}
          />
          <div className="changeacts">
            <button className="btn savever" disabled={starting || !words.trim()} onClick={start}>{starting ? "Starting…" : "Start"}</button>
            <button className="btn" onClick={() => { setWriting(false); setWords(""); }}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Asks for a folder and lets the thread's agent work in it too. */
export async function addThreadFolder(thread: Thread, fail: (error: unknown) => void) {
  const chosen = window.arcex ? await window.arcex.pickFolder("Choose a folder this thread can also use") : window.prompt("Full path of the folder");
  if (!chosen?.trim()) return;
  await call("thread.update", { threadId: thread.id, folders: [...thread.folders, chosen.trim()] }).catch(fail);
}

/** Folders outside the project that this thread's agent may also read and write. */
function Folders({ thread, fail }: { thread: Thread; fail(error: unknown): void }) {
  const remove = (folder: string) => void call("thread.update", { threadId: thread.id, folders: thread.folders.filter((entry) => entry !== folder) }).catch(fail);
  return (
    <section className="sec">
      <header>
        <b>Other folders</b>
        {thread.folders.length < 5 && <button className="link" onClick={() => void addThreadFolder(thread, fail)}>Add a folder</button>}
      </header>
      {thread.folders.length === 0 ? (
        <p className="folderhint">{thread.copy ? "Add a folder outside the project to let the agent use it too." : "This thread works in the project folder. Add another folder to let the agent use it too."}</p>
      ) : (
        thread.folders.map((folder) => (
          <div key={folder} className="vrow" title={folder}>
            <Icon name="folder" />
            <span className="trunc">
              {folder.split(/[\\/]/).filter(Boolean).pop() ?? folder}
              <span className="when"> {folder.replace(/[\\/][^\\/]+[\\/]?$/, "")}</span>
            </span>
            <button className="icon" aria-label={`Stop using ${folder}`} title="Remove" onClick={() => remove(folder)}>
              <Icon name="x" />
            </button>
          </div>
        ))
      )}
      {thread.foldersSupported === false && <p className="folderhint">{"This agent can't use extra folders, so it only sees the project folder."}</p>}
    </section>
  );
}

/** Saved versions, newest first, each with "Go back" after a confirm. Hidden until there is one. */
function Versions({ project, refresh, fail }: { project: Project; refresh: string; fail(error: unknown): void }) {
  const [list, setList] = useState<{ id: string; message: string; time: number }[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let current = true;
    call("project.versions", { projectId: project.id })
      .then((result) => { if (current) setList(result); })
      .catch(() => { if (current) setList([]); });
    return () => { current = false; };
  }, [project.id, refresh]);
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, 5);
  return (
    <section className="sec">
      <header><b>Saved versions</b></header>
      <div className="versions">
        {shown.map((version, index) => (
          <div key={version.id} className="version">
            <div className="vrow">
              <span className="trunc" title={version.message}>{version.message}</span>
              <span className="when">{index === 0 ? "latest" : ago(version.time)}</span>
              {index > 0 && confirm !== version.id && <button className="link" onClick={() => setConfirm(version.id)}>Go back</button>}
            </div>
            {confirm === version.id && (
              <div className="undoask">
                <p>Put the project back the way it was in this version? Anything not saved as a version is replaced. Your saved versions stay.</p>
                <div className="btns">
                  <button className="btn primary" disabled={busyId !== null} onClick={() => {
                    setBusyId(version.id);
                    call("project.restoreVersion", { projectId: project.id, id: version.id })
                      .then(() => {
                        setConfirm(null);
                        window.dispatchEvent(new Event(FILES_CHANGED));
                      })
                      .catch(fail)
                      .finally(() => setBusyId(null));
                  }}>{busyId === version.id ? "Going back…" : "Go back"}</button>
                  <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        ))}
        {list.length > 5 && !all && <button className="link" onClick={() => setAll(true)}>Show all {list.length}</button>}
      </div>
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

/**
 * Adds text to a message box, such as a review comment on a diff line. `detail` is the text (for the main pane) or
 * { text, threadId } for a given thread's pane.
 */
export const ADD_TO_DRAFT = "arcex:add-to-draft";

/** A strip beside a long thread with a mark for each of your messages; a mark jumps there. */
function Minimap({ scroller, watch }: { scroller: RefObject<HTMLDivElement | null>; watch: unknown }) {
  const [marks, setMarks] = useState<{ at: number; label: string; el: HTMLElement }[]>([]);
  const [view, setView] = useState({ top: 0, size: 1 });
  const [frame, setFrame] = useState({ top: 0, height: 0 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const height = el.scrollHeight;
      const origin = el.getBoundingClientRect().top - el.scrollTop;
      setMarks(
        height > el.clientHeight * 1.5
          ? [...el.querySelectorAll<HTMLElement>(".you")].map((you) => ({
              at: (you.getBoundingClientRect().top - origin) / height,
              label: (you.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
              el: you,
            }))
          : [],
      );
      setView({ top: el.scrollTop / height, size: el.clientHeight / height });
      setFrame({ top: el.offsetTop, height: el.clientHeight });
    };
    measure();
    const onScroll = () => setView({ top: el.scrollTop / el.scrollHeight, size: el.clientHeight / el.scrollHeight });
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [watch]);
  if (marks.length < 3) return null;
  return (
    <nav className="minimap" aria-label="Jump to one of your messages" style={{ top: frame.top + 8, height: Math.max(0, frame.height - 16) }}>
      <span className="mview" style={{ top: `${view.top * 100}%`, height: `${Math.max(view.size * 100, 3)}%` }} aria-hidden />
      {marks.map((mark, index) => (
        <button
          key={index}
          className="mmark"
          style={{ top: `${mark.at * 100}%` }}
          title={mark.label}
          aria-label={`Jump to your message: ${mark.label}`}
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTo({ top: Math.max(0, mark.el.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 24), behavior: "smooth" });
          }}
        />
      ))}
    </nav>
  );
}

/** Selecting text in the agent's replies shows a Quote button that puts it in the message box as a quote. */
function QuoteSelection({ root, threadId }: { root: RefObject<HTMLElement | null>; threadId: string }) {
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(null);
  useEffect(() => {
    const update = () => {
      const selection = document.getSelection();
      const text = selection?.toString().trim() ?? "";
      const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
      const inReply = (node: Node | null | undefined) => !!node && !!root.current?.contains(node) && !!(node instanceof Element ? node : node.parentElement)?.closest(".reply");
      if (!text || !range || !inReply(selection?.anchorNode) || !inReply(selection?.focusNode)) return setAt(null);
      const box = range.getBoundingClientRect();
      // Kept inside the conversation, so a selection at its edge doesn't push the button under the sidebar.
      const area = root.current?.getBoundingClientRect();
      const x = area ? Math.min(Math.max(box.left + box.width / 2, area.left + 50), area.right - 50) : box.left + box.width / 2;
      setAt({ x, y: box.top, text: text.slice(0, 4000) });
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);
  if (!at) return null;
  return (
    <button
      className="btn small quotebtn"
      style={{ left: at.x, top: Math.max(8, at.y - 38) }}
      // Keeps the selection while pressing.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        const quoted = at.text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
        window.dispatchEvent(new CustomEvent(ADD_TO_DRAFT, { detail: { text: `${quoted}\n`, threadId } }));
        document.getSelection()?.removeAllRanges();
        setAt(null);
      }}
    >
      <Icon name="chat" /> Quote
    </button>
  );
}

/**
 * A diff as numbered rows, or why there's nothing to show. Clicking a line (or Enter on it) opens a comment box; the
 * comment goes into the message box as "`file:line` comment", so several can go to the agent in one message.
 */
function DiffLines({ diff, retry, path }: { diff: { text: string; error?: boolean } | null; retry(): void; path: string }) {
  const rows = diff && !diff.error ? diffRows(diff.text) : [];
  const [commenting, setCommenting] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [added, setAdded] = useState<Set<number>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  const lineOf = (row: Exclude<DiffRow, { kind: "gap" }>) => (row.kind === "del" ? `${path}:${row.old} (removed line)` : `${path}:${row.new}`);
  const add = (index: number) => {
    const row = rows[index];
    if (!row || row.kind === "gap" || !note.trim()) return;
    window.dispatchEvent(new CustomEvent(ADD_TO_DRAFT, { detail: `\`${lineOf(row)}\` ${note.trim()}` }));
    setAdded((current) => new Set(current).add(index));
    setCommenting(null);
    setNote("");
  };
  // Up and Down move between lines, so the keyboard reaches any line without a tab stop on each.
  const move = (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setCommenting(index);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const lines = [...(box.current?.querySelectorAll<HTMLElement>(".l.pick") ?? [])];
      const at = lines.indexOf(event.currentTarget);
      lines[at + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
    }
  };
  const firstLine = rows.findIndex((row) => row.kind !== "gap");
  return (
    <div className="diff" ref={box}>
      {diff === null ? <div className="l ctx">Loading…</div> : diff.error ? <p className="muted">{diff.text} <button className="link" onClick={retry}>Retry</button></p>
        : rows.length === 0 ? <div className="l ctx">No text diff available.</div> : rows.map((row, index) =>
        row.kind === "gap" ? <div key={index} className="l gap" aria-label="Unchanged lines skipped">⋯</div> : (
          <Fragment key={index}>
            <div
              className={`l pick ${row.kind}${added.has(index) ? " noted" : ""}`}
              role="button"
              tabIndex={index === firstLine ? 0 : -1}
              aria-label={`Comment on ${lineOf(row)}`}
              title="Comment on this line"
              onClick={() => setCommenting(commenting === index ? null : index)}
              onKeyDown={(event) => move(event, index)}
            >
              <span className="ln" aria-hidden>{row.kind === "add" ? "" : row.old}</span>
              <span className="ln" aria-hidden>{row.kind === "del" ? "" : row.new}</span>
              <span className="lt">{row.text || " "}</span>
            </div>
            {commenting === index && (
              <div className="linecomment">
                <AutoText
                  autoFocus
                  rows={2}
                  value={note}
                  maxLength={2000}
                  aria-label={`Comment on ${lineOf(row)}`}
                  placeholder="What should change here?"
                  onChange={(event) => setNote(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      add(index);
                    } else if (event.key === "Escape") {
                      event.stopPropagation();
                      setCommenting(null);
                    }
                  }}
                />
                <div className="btns">
                  <button className="btn small primary" disabled={!note.trim()} onClick={() => add(index)}>Add to message</button>
                  <button className="btn small" onClick={() => setCommenting(null)}>Cancel</button>
                </div>
              </div>
            )}
          </Fragment>
        ))}
    </div>
  );
}

function ChangeStat({ change }: { change: Change }) {
  return (
    <span className="stat">
      {change.status === "added" ? <>{change.added > 0 && `+${change.added} `}new</> : change.status === "removed" ? <><span className="rm">removed</span> {change.removed > 0 && <i>−{change.removed}</i>}</> : <>+{change.added} <i>−{change.removed}</i></>}
    </span>
  );
}

/** What one turn changed, from snapshots taken before and after it. Opens to each file's diff for that turn alone. */
function TurnChanges({ thread, item, last, preview, fail }: { thread: Thread; item: Extract<Item, { kind: "result" }>; last: boolean; preview: boolean; fail(error: unknown): void }) {
  const changes = item.changes ?? [];
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ text: string; error?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setDiff(null);
    if (!file) return;
    let current = true;
    call("thread.turnDiff", { threadId: thread.id, itemId: item.id, path: file })
      .then((result) => { if (current) setDiff(result); })
      .catch(() => { if (current) setDiff({ text: "Couldn't load this diff.", error: true }); });
    return () => { current = false; };
  }, [thread.id, item.id, file, attempt]);
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  const undoneFiles = new Set(item.undone === true ? item.files : Array.isArray(item.undone) ? item.undone : []);
  const allUndone = changes.length > 0 && changes.every((change) => undoneFiles.has(change.path));
  // Undo asks first. Redo doesn't, since it reverses the user's own undo. Either way, files changed again since are named
  // and need a second yes before they're overwritten.
  type Target = { redo: boolean; path?: string };
  const [ask, setAsk] = useState<(Target & { step: "confirm" }) | (Target & { step: "working" }) | (Target & { step: "changedSince"; files: string[] }) | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const run = (target: Target, force: boolean) => {
    setAsk({ ...target, step: "working" });
    setUndoError(null);
    call("thread.undoTurn", { threadId: thread.id, itemId: item.id, force, redo: target.redo, ...(target.path ? { path: target.path } : {}) })
      .then((result) => {
        setAsk(result.undone.length ? null : { ...target, step: "changedSince", files: result.changedSince });
        if (result.undone.length) window.dispatchEvent(new Event(FILES_CHANGED));
      })
      .catch((error: Error) => {
        setAsk(null);
        setUndoError(error.message);
      });
  };
  const start = (target: Target) => (target.redo ? run(target, false) : setAsk({ ...target, step: "confirm" }));
  const idle = !busy(thread) && (!ask || ask.step === "changedSince");
  const subject = (path?: string) => (path ? path : changes.length === 1 ? changes[0]!.path : plural(changes.length, "file"));
  const one = (path?: string) => !!path || changes.length === 1;
  return (
    <div className="turnchanges">
      <div className="tcrow">
        <button className={allUndone ? "outcome undone" : "outcome"} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={allUndone ? "reload" : "check"} /> {allUndone ? "Undid" : "Changed"} {plural(changes.length, "file")}
          <span className="stat">+{added} <i>−{removed}</i></span>
          <Icon name="chev" />
        </button>
        {idle && !allUndone && <button className="link" onClick={() => start({ redo: false })}>Undo</button>}
        {idle && undoneFiles.size > 0 && <button className="link" onClick={() => start({ redo: true })}>Redo</button>}
        {idle && last && !allUndone && !thread.copy && <SaveVersion className="link" projectId={thread.projectId} message={thread.title} fail={fail} />}
        {last && preview && !busy(thread) && <button className="link" onClick={() => window.dispatchEvent(new Event(OPEN_PREVIEW))}>Open preview</button>}
      </div>
      {ask && ask.step !== "working" && (
        <div className="undoask">
          <p>
            {ask.step === "confirm"
              ? `Put ${subject(ask.path)} back the way ${one(ask.path) ? "it was" : "they were"} before this turn?`
              : `${ask.files.length === 1 ? ask.files[0] : plural(ask.files.length, "file")} changed again after this turn. ${ask.redo ? "Redoing" : "Undoing"} overwrites ${ask.files.length === 1 ? "it" : "them"}, and those later changes are lost.`}
          </p>
          <div className="btns">
            <button className="btn primary" onClick={() => run(ask, ask.step === "changedSince")}>
              {ask.step === "confirm" ? "Undo changes" : ask.redo ? "Redo anyway" : "Undo anyway"}
            </button>
            <button className="btn" onClick={() => setAsk(null)}>Cancel</button>
          </div>
        </div>
      )}
      {ask?.step === "working" && <p className="note">{ask.redo ? "Redoing…" : "Undoing…"}</p>}
      {undoError && <p className="oops">Couldn't {undoError.includes("redo") ? "redo" : "undo"}: {undoError}</p>}
      {open && (
        <div className="files">
          {changes.map((change) => {
            const undone = undoneFiles.has(change.path);
            return (
              <div key={change.path}>
                <div className="tcfile">
                  <button className={undone ? "file undone" : "file"} aria-expanded={file === change.path} title={change.path} onClick={() => setFile(file === change.path ? null : change.path)}>
                    <Icon name="file" />
                    <span className="trunc">{change.path}</span>
                    {undone ? <span className="stat muted">undone</span> : <ChangeStat change={change} />}
                  </button>
                  {idle && changes.length > 1 && (
                    <button className="link" aria-label={`${undone ? "Redo" : "Undo"} ${change.path}`} onClick={() => start({ redo: undone, path: change.path })}>
                      {undone ? "Redo" : "Undo"}
                    </button>
                  )}
                </div>
                {file === change.path && <DiffLines diff={diff} path={change.path} retry={() => setAttempt(attempt + 1)} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** What a review thread asks for. The agent only reads; findings come back as a list the user can act on. */
/** Asks for a review of everything a branch changed since it left its base branch. */
export const branchReviewPrompt = (branch: string, base: string) =>
  [
    `Review the branch ${branch}: every change since it left ${base} (use git diff ${base}...HEAD), plus any unsaved changes.`,
    "List what's wrong, most serious first. For each finding give the file and line, what goes wrong and when, and how to fix it.",
    "Cover bugs, security problems, broken behaviour and anything likely to confuse a user. Skip style nitpicks.",
    "Don't change any files. If nothing is wrong, say so in one line.",
  ].join(" ");

export const REVIEW_PROMPT = [
  "Review the unsaved changes in this project: everything that differs from the last commit, including new files Git doesn't track yet.",
  "List what's wrong, most serious first. For each finding give the file and line, what goes wrong and when, and how to fix it.",
  "Cover bugs, security problems, broken behaviour and anything likely to confuse a user. Skip style nitpicks.",
  "Don't change any files. If nothing is wrong, say so in one line.",
].join(" ");

function Changes({ project, refresh, fail, review }: { project: Project; refresh: string; fail(error: unknown): void; review(prompt?: string): void }) {
  const [branch, setBranch] = useState<{ branch: string | null; base: string | null; ahead: number } | null>(null);
  useEffect(() => {
    let current = true;
    call("project.branch", { projectId: project.id })
      .then((result) => { if (current) setBranch(result); })
      .catch(() => { if (current) setBranch(null); });
    return () => { current = false; };
  }, [project.id, refresh]);
  const [showBranch, setShowBranch] = useState(false);
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
  return (
    <section className="sec">
      <header>
        <b>Unsaved changes</b>
        {changes && changes.length > 0 && <span className="stat">+{added} <i>−{removed}</i></span>}
      </header>
      {changes && changes.length > 0 && (
        <div className="changeacts">
          <SaveVersion projectId={project.id} message={`Save ${plural(changes.length, "changed file")}`} fail={fail} className="btn savever" />
          <button className="btn" title="Start a thread where the agent checks these changes for problems, without changing anything" onClick={() => review()}>Review changes</button>
        </div>
      )}
      {branch?.branch && branch.base && branch.ahead > 0 && (
        <div className="vrow branchrow">
          <span className="trunc" title={`On ${branch.branch}, ${plural(branch.ahead, "saved version")} beyond ${branch.base}`}>
            On <span className="mono">{branch.branch}</span> · {plural(branch.ahead, "saved version")} beyond {branch.base}
          </span>
          <button className="link" aria-expanded={showBranch} onClick={() => setShowBranch(!showBranch)}>{showBranch ? "Hide changes" : "Show changes"}</button>
          <button className="link" title={`Start a thread where the agent checks everything on ${branch.branch} since ${branch.base}, without changing anything`} onClick={() => review(branchReviewPrompt(branch.branch!, branch.base!))}>
            Review branch
          </button>
        </div>
      )}
      {showBranch && branch?.base && <BranchChanges project={project} base={branch.base} refresh={refresh} />}
      {problem ? <p className="muted">{problem} <button className="link" onClick={() => setAttempt(attempt + 1)}>Retry</button></p>
        : !changes ? <p className="muted">Looking…</p> : changes.length === 0 ? <p className="muted">No changes since the last saved version.</p> : (
        <div className="files">
          {changes.map((change) => (
            <div key={change.path}>
              <button className="file" aria-expanded={open === change.path} title={change.path} onClick={() => setOpen(open === change.path ? null : change.path)}>
                <Icon name="file" />
                <span className="trunc">{change.path.split("/").pop()}</span>
                <ChangeStat change={change} />
              </button>
              {open === change.path && <DiffLines diff={diff} path={change.path} retry={() => setAttempt(attempt + 1)} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** A thread's separate copy: what it changed, and buttons to bring that into the project folder or discard it. */
function CopySection({ thread, refresh, fail }: { thread: Thread; refresh: string; fail(error: unknown): void }) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ text: string; error?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [doing, setDoing] = useState<"bring" | "discard" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const busyNow = thread.state === "working" || thread.state === "starting" || thread.state === "needs_you" || thread.state === "stopping";
  useEffect(() => {
    let current = true;
    call("thread.copyChanges", { threadId: thread.id })
      .then((result) => { if (current) setChanges(result); })
      .catch(() => { if (current) setChanges([]); });
    return () => { current = false; };
  }, [thread.id, thread.state, refresh, attempt]);
  useEffect(() => {
    setDiff(null);
    if (!open) return;
    let current = true;
    call("thread.copyDiff", { threadId: thread.id, path: open })
      .then((result) => { if (current) setDiff(result); })
      .catch(() => { if (current) setDiff({ text: "Couldn't load this diff.", error: true }); });
    return () => { current = false; };
  }, [thread.id, open, refresh, attempt]);
  const act = (kind: "bring" | "discard") => {
    setDoing(kind);
    setConfirm(false);
    (kind === "bring" ? call("thread.bringIn", { threadId: thread.id }) : call("thread.discardCopy", { threadId: thread.id }))
      .then(() => window.dispatchEvent(new Event(FILES_CHANGED)))
      .catch(fail)
      .finally(() => setDoing(null));
  };
  const added = changes?.reduce((sum, change) => sum + change.added, 0) ?? 0;
  const removed = changes?.reduce((sum, change) => sum + change.removed, 0) ?? 0;
  return (
    <section className="sec copysec">
      <header>
        <b>Separate copy</b>
        {changes && changes.length > 0 && <span className="stat">+{added} <i>−{removed}</i></span>}
      </header>
      <p className="folderhint" title={thread.copy?.path}>This thread works in its own copy of the project, so other threads can't collide with it.</p>
      {!changes ? <p className="muted">Looking…</p> : changes.length === 0 ? <p className="folderhint">No changes in the copy yet.</p> : (
        <div className="files">
          {changes.map((change) => (
            <div key={change.path}>
              <button className="file" aria-expanded={open === change.path} title={change.path} onClick={() => setOpen(open === change.path ? null : change.path)}>
                <Icon name="file" />
                <span className="trunc">{change.path.split("/").pop()}</span>
                <ChangeStat change={change} />
              </button>
              {open === change.path && <DiffLines diff={diff} path={change.path} retry={() => setAttempt(attempt + 1)} />}
            </div>
          ))}
        </div>
      )}
      {confirm ? (
        <div className="changeacts">
          <span className="folderhint">Discard the copy and its changes?</span>
          <button className="btn danger" disabled={doing !== null} onClick={() => act("discard")}>Discard</button>
          <button className="btn" onClick={() => setConfirm(false)}>Keep</button>
        </div>
      ) : (
        <div className="changeacts">
          <button className="btn savever" disabled={busyNow || doing !== null || !changes?.length} title="Apply these changes to the project folder as unsaved changes, then remove the copy" onClick={() => act("bring")}>
            {doing === "bring" ? "Bringing in…" : "Bring changes in"}
          </button>
          <button className="btn" disabled={busyNow || doing !== null} onClick={() => setConfirm(true)}>{doing === "discard" ? "Discarding…" : "Discard copy"}</button>
        </div>
      )}
    </section>
  );
}

/** Everything the branch changed since it grew from its base, file by file, each opening to its diff. */
function BranchChanges({ project, base, refresh }: { project: Project; base: string; refresh: string }) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [problem, setProblem] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ text: string; error?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setProblem(false);
    call("project.branchChanges", { projectId: project.id })
      .then((result) => { if (current) setChanges(result); })
      .catch(() => { if (current) setProblem(true); });
    return () => { current = false; };
  }, [project.id, base, refresh, attempt]);
  useEffect(() => {
    setDiff(null);
    if (!open) return;
    let current = true;
    call("project.branchDiff", { projectId: project.id, path: open })
      .then((result) => { if (current) setDiff(result); })
      .catch(() => { if (current) setDiff({ text: "Couldn't load this diff.", error: true }); });
    return () => { current = false; };
  }, [project.id, open, refresh, attempt]);
  if (problem) return <p className="muted">{"Couldn't read the branch's changes."} <button className="link" onClick={() => setAttempt(attempt + 1)}>Retry</button></p>;
  if (!changes) return <p className="muted">Looking…</p>;
  if (!changes.length) return <p className="muted">No file differs from {base}.</p>;
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  return (
    <div className="files branchfiles" aria-label={`Changes since ${base}`}>
      <p className="branchsum">Since {base}: {plural(changes.length, "file")} <span className="stat">+{added} <i>−{removed}</i></span></p>
      {changes.map((change) => (
        <div key={change.path}>
          <button className="file" aria-expanded={open === change.path} title={change.path} onClick={() => setOpen(open === change.path ? null : change.path)}>
            <Icon name="file" />
            <span className="trunc">{change.path.split("/").pop()}</span>
            <ChangeStat change={change} />
          </button>
          {open === change.path && <DiffLines diff={diff} path={change.path} retry={() => setAttempt(attempt + 1)} />}
        </div>
      ))}
    </div>
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
