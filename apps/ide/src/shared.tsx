import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import type { Agent, Thread, UsageLimit } from "@arcex/contracts";

declare global {
  interface Window {
    /** Present only inside the desktop shell. */
    arcex?: { pickFolder(title?: string): Promise<string | null>; setTheme(theme: string): void; openExternal(url: string): void; ensureEngine(): Promise<void>;
      checkForUpdate?(): Promise<{ behind: number; changed: boolean } | null>;
      update?(): Promise<{ ok?: true; error?: string; detail?: string }>;
      pickElement?(): Promise<PickedElement | null>;
      cancelPick?(): Promise<void> };
  }
}

/** Agent names by id. App keeps this in step with the engine so any component can name an agent. */
/** What the user pointed at in the Browser tab, with their note and a PNG of that part of the page (base64). */
export type PickedElement = {
  selector: string; tag: string; text: string; html: string; note: string; url: string; title: string; image: string;
  styles: { font: string; color: string; background: string; padding: string; size: string };
};

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
  prompt(threadId: string, text: string, attachments?: string[]): Promise<unknown>;
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
/** "3:40 PM" today, else "Tue 3:40 PM". */
export function clock(time: number): string {
  const when = new Date(time);
  const sameDay = when.toDateString() === new Date().toDateString();
  return when.toLocaleString(undefined, sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** A plan limit in a sentence, or null when there is nothing worth saying. */
export function limitText(agent: string, limit: UsageLimit | undefined, always = false): string | null {
  if (!limit) return null;
  if (limit.resetsAt !== null && limit.resetsAt < Date.now()) return null;
  const window = limit.window === "five_hour" ? "5-hour" : limit.window === "weekly" ? "weekly" : "usage";
  const resets = limit.resetsAt ? clock(limit.resetsAt) : null;
  if (limit.status === "reached") return `${agent} has reached its ${window} limit${resets ? ` until ${resets}` : ""}. Switch to another agent or model, or wait.`;
  const reset = resets ? `. It resets at ${resets}` : "";
  if (limit.used !== null && (limit.status === "warning" || always)) return `${agent} has used ${Math.round(limit.used * 100)}% of its ${window} limit${reset}.`;
  if (limit.status === "warning") return `${agent} is close to its ${window} limit${reset}.`;
  if (always) return `${agent} is within its ${window} limit${reset}.`;
  return null;
}

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

/** A small menu that opens under its button and closes on any outside click. Risky items ask twice. */
export function Menu({ label, items, icon = "dots", text }: { label: string; items: { label: string; danger?: boolean; run(): void }[]; icon?: string; /** Shown beside the icon, for a menu that isn't just "more". */ text?: string }) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return setArmed(null);
    menu.current?.querySelector("button")?.focus();
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <span className="menuwrap">
      <button
        className={text ? "btn ghost more" : "icon more"}
        ref={trigger}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        <Icon name={icon} />{text}
      </button>
      {open && (
        <span className="menu" role="menu" ref={menu} onBlur={(event) => {
          if (event.relatedTarget && event.relatedTarget !== trigger.current && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }} onKeyDown={(event) => {
          const buttons = [...event.currentTarget.querySelectorAll("button")];
          const focused = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            buttons[(focused + buttons.length + (event.key === "ArrowDown" ? 1 : -1)) % buttons.length]?.focus();
          }
        }}>
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
                trigger.current?.focus();
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

/** Saved widths of the resizable columns, applied as CSS variables before the first paint. */
const WIDTHS_KEY = "arcex:widths";
const widths: Record<string, number> = (() => {
  try {
    return JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
})();
for (const [name, value] of Object.entries(widths)) if (Number.isFinite(value)) document.documentElement.style.setProperty(`--${name}`, `${value}px`);

/**
 * A thin handle on a column's edge. Drag to resize, double-click to go back to the default.
 * `edge` is the side of the column it sits on; `name` is the CSS variable (and saved key) it sets.
 */
export function Resizer({ name, edge, min, max, label }: { name: string; edge: "left" | "right"; min: number; max(): number; label: string }) {
  const set = (value: number | null) => {
    if (value === null) {
      delete widths[name];
      document.documentElement.style.removeProperty(`--${name}`);
    } else {
      widths[name] = value;
      document.documentElement.style.setProperty(`--${name}`, `${value}px`);
    }
    try {
      localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
    } catch {
      // Only this session keeps the width.
    }
  };
  const clamp = (value: number) => Math.round(Math.min(Math.max(value, min), Math.max(min, max())));
  return (
    <div
      className={`resizer ${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label}. Double-click to reset.`}
      tabIndex={0}
      onDoubleClick={() => set(null)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const column = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width;
        const grow = (event.key === "ArrowRight") === (edge === "right");
        set(clamp(column + (grow ? 16 : -16)));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        const start = event.clientX;
        const startWidth = (handle.parentElement as HTMLElement).getBoundingClientRect().width;
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add("resizing");
        const move = (next: PointerEvent) => set(clamp(startWidth + (edge === "right" ? next.clientX - start : start - next.clientX)));
        const up = () => {
          document.body.classList.remove("resizing");
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      }}
    />
  );
}
