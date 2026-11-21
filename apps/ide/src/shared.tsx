import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import type { Agent, Thread } from "@arcex/contracts";

declare global {
  interface Window {
    /** Present only inside the desktop shell. */
    arcex?: { pickFolder(): Promise<string | null>; setTheme(theme: string): void; openExternal(url: string): void; ensureEngine(): Promise<void>;
      checkForUpdate?(): Promise<{ behind: number; changed: boolean } | null>;
      update?(): Promise<{ ok?: true; error?: string; detail?: string }> };
  }
}

/** Agent names by id. App keeps this in step with the engine so any component can name an agent. */
export const agentNames = new Map<string, string>();
export const nameOf = (agentId: string) => agentNames.get(agentId) ?? "Agent";
export function setAgents(agents: Agent[]) {
  agentNames.clear();
  for (const agent of agents) agentNames.set(agent.id, agent.name);
}
export const STARTERS = [
  { icon: "code", text: "Add a new feature" },
  { icon: "flask", text: "Find and fix a bug" },
  { icon: "spark", text: "Make it look better" },
  { icon: "sliders", text: "Explain how this project works" },
];

/** The saved preferences the input helpers need. App keeps this in step with the engine. */
export const prefs: { sendWith: "enter" | "ctrl-enter" } = { sendWith: "enter" };

export type Actions = {
  fail(error: unknown): void;
  prompt(threadId: string, text: string): Promise<unknown>;
  cancel(threadId: string): Promise<unknown>;
  answer(threadId: string, itemId: string, optionId: string | null): Promise<unknown>;
};

export const Icon = ({ name }: { name: string }) => (
  <svg className="i" aria-hidden="true">
    <use href={`#${name}`} />
  </svg>
);

/** One blade of the Arcex mark, pointing up. The mark is four of them turned about the centre. */
const BLADE = "M26 11 L38 1 L67 12 L51 20 L44 45 L37 43 Z";

/**
 * The Arcex mark, alive. Its blades light up in turn while the agent thinks; while it runs a command or edits
 * a file the whole mark turns faster.
 */
export const Loader = ({ work = false }: { work?: boolean }) => (
  <svg className={work ? "loader work" : "loader"} viewBox="-2 -2 104 104" aria-hidden="true">
    <g>
      {[0, 1, 2, 3].map((index) => (
        <path key={index} d={BLADE} transform={`rotate(${index * 90} 50 50)`} style={{ "--i": index } as CSSProperties} />
      ))}
    </g>
  </svg>
);

export const busy = (thread: Thread) => thread.state === "working" || thread.state === "starting" || thread.state === "needs_you" || thread.state === "stopping";
export const stateLabel = (thread: Thread) => ({
  idle: "", starting: "Starting", working: "Working", needs_you: "Needs you",
  stopping: "Stopping…", stopped: "Stopped", interrupted: "Interrupted", failed: "Failed",
})[thread.state];
export const dotClass = (thread: Thread) =>
  thread.state === "needs_you" || thread.state === "interrupted" ? "dot needs" : busy(thread) ? "dot working" : thread.state === "failed" ? "dot failed" : null;
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "now", "5m", "3h", "2d": how long since a thread last moved. */
export function ago(time: number): string {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}

/** Sends on Enter, or on Ctrl+Enter when the user chose that. Shift+Enter always makes a new line. */
export function onEnter(send: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (prefs.sendWith === "ctrl-enter" && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    send();
  };
}

/** A textarea that grows with what is typed, up to the height its CSS allows. */
export function AutoText(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);
  return <textarea ref={ref} {...props} />;
}
