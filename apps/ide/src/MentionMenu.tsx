import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import type { FileMatch } from "@arcex/contracts";
import { call } from "./store.ts";
import { Icon } from "./shared.tsx";

/** The "@word" being typed just before the caret, if any. */
function tokenAt(draft: string, caret: number): { start: number; query: string } | null {
  const before = draft.slice(0, caret);
  const match = /(^|\s)@("?)([^\s@"]*)$/.exec(before);
  if (!match) return null;
  return { start: before.length - match[0].length + match[1]!.length, query: match[3]! };
}

/** How a path goes into the message. Paths with spaces are quoted, the way the agents read them. */
const mentionOf = (match: FileMatch) => `@${/\s/.test(match.path) ? `"${match.path}"` : match.path}${match.kind === "folder" ? "/" : ""} `;

/**
 * The project file picker shown above the message box while the user types "@" and a few letters.
 * Arrow keys move, Enter or Tab picks, Escape closes. Picking puts "@path " in the box at the caret.
 */
export function useMentionMenu(projectId: string | null, draft: string, setDraft: (value: string) => void) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [matches, setMatches] = useState<FileMatch[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);

  const token = projectId ? tokenAt(draft, Math.min(caret, draft.length)) : null;
  const key = token ? `${token.start}:${token.query}` : null;
  const open = !!token && dismissed !== key && matches.length > 0;

  useEffect(() => {
    if (!token || !projectId || dismissed === key) return setMatches([]);
    let current = true;
    // A short pause, so fast typing sends one search, not one per letter.
    const timer = setTimeout(() => {
      call("project.search", { projectId, query: token.query })
        .then((found) => current && setMatches(found))
        .catch(() => current && setMatches([]));
    }, token.query ? 80 : 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [projectId, key, dismissed]);

  useEffect(() => setActive(0), [key]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (match: FileMatch) => {
    if (!token) return;
    const end = Math.min(caret, draft.length);
    const inserted = mentionOf(match);
    const next = draft.slice(0, token.start) + inserted + draft.slice(end).replace(/^\S*/, (rest) => (rest.startsWith("@") ? rest : ""));
    const at = token.start + inserted.length;
    setDraft(next);
    setCaret(at);
    setDismissed(null);
    setMatches([]);
    requestAnimationFrame(() => box.current?.setSelectionRange(at, at));
  };

  /** Keeps track of the caret. Wire to the message box's onSelect. */
  const onSelect = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    box.current = event.currentTarget;
    setCaret(event.currentTarget.selectionStart);
  };

  /** Returns true when the key was for the menu, so the message box should not act on it. */
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + matches.length) % matches.length);
    } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      pick(matches[Math.min(active, matches.length - 1)]!);
    } else if (event.key === "Escape") {
      setDismissed(key);
    } else return false;
    event.preventDefault();
    return true;
  };

  const menu = open ? (
    <ul className="slash files" role="listbox" aria-label="Project files" ref={list}>
      {matches.map((match, index) => {
        const cut = match.path.lastIndexOf("/") + 1;
        return (
          <li
            key={match.path}
            data-index={index}
            role="option"
            aria-selected={index === active}
            className={index === active ? "on" : undefined}
            onMouseEnter={() => setActive(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              pick(match);
            }}
          >
            <Icon name={match.kind === "folder" ? "folder" : "file"} />
            <span className="cmd">{match.path.slice(cut)}</span>
            <span className="what">{match.path.slice(0, Math.max(0, cut - 1))}</span>
          </li>
        );
      })}
    </ul>
  ) : null;

  return { menu, onKeyDown, onSelect };
}
