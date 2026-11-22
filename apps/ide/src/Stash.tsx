import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon, ago } from "./shared.tsx";

/** Drafts put aside to bring back later, newest first. Kept on this computer, shared by every message box. */
type Stashed = { text: string; at: number };
const KEY = "arcex:stash";
const MAX = 20;
const listeners = new Set<() => void>();
let stash: Stashed[] = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Stashed[];
    return Array.isArray(saved) ? saved.filter((entry) => typeof entry?.text === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
})();
function save(next: Stashed[]) {
  stash = next.slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(stash));
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** "Put aside" for the current draft, and a list to bring one back. Restoring swaps with whatever is in the box. */
export function Stash({ draft, setDraft }: { draft: string; setDraft(text: string): void }) {
  const list = useSyncExternalStore(subscribe, () => stash);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !wrap.current?.contains(event.target as Node) && setOpen(false);
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);
  useEffect(() => {
    if (!list.length) setOpen(false);
  }, [list.length]);

  const putAside = () => {
    if (!draft.trim()) return;
    save([{ text: draft, at: Date.now() }, ...stash]);
    setDraft("");
  };
  const restore = (index: number) => {
    const picked = stash[index];
    if (!picked) return;
    const rest = stash.filter((_, at) => at !== index);
    save(draft.trim() ? [{ text: draft, at: Date.now() }, ...rest] : rest);
    setDraft(picked.text);
    setOpen(false);
  };

  return (
    <span className="stash" ref={wrap}>
      {draft.trim() && (
        <button className="icon" aria-label="Put this draft aside" title="Put this draft aside" onClick={putAside}>
          <Icon name="box" />
        </button>
      )}
      {list.length > 0 && (
        <button className="stashcount" aria-expanded={open} aria-haspopup="dialog" title="Drafts put aside" onClick={() => setOpen(!open)}>
          {list.length} aside
        </button>
      )}
      {open && (
        <div className="stashpop" role="dialog" aria-label="Drafts put aside">
          <div className="label">Drafts put aside</div>
          {list.map((entry, index) => (
            <div key={`${entry.at}:${index}`} className="stashrow">
              <button className="stashtext" title="Put this back in the message box" onClick={() => restore(index)}>
                <span className="trunc">{entry.text.replace(/\s+/g, " ").slice(0, 160)}</span>
                <span className="when">{ago(entry.at)}</span>
              </button>
              <button className="icon" aria-label="Delete this draft" title="Delete" onClick={() => save(stash.filter((_, at) => at !== index))}>
                <Icon name="x" />
              </button>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
