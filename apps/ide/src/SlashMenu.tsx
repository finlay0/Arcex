import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SlashCommand } from "@arcex/contracts";
import { useAgentCommands } from "./ModelPicker.tsx";

/**
 * The menu of an agent's slash commands, shown above the message box while the user types "/" and a name.
 * Arrow keys move, Enter or Tab picks, Escape closes. Picking puts "/name " in the box, ready for input.
 */
export function useSlashMenu(agentId: string, draft: string, setDraft: (value: string) => void) {
  const commands = useAgentCommands(agentId);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);

  const typed = /^\/(\S*)$/.exec(draft)?.[1];
  const query = typed?.toLowerCase() ?? "";
  // A name that starts with what was typed comes first, then one with a word that does, then any that contain it.
  const rank = (name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith(query)) return 0;
    if (lower.split(/[:\-_ ]/).some((word) => word.startsWith(query))) return 1;
    return lower.includes(query) ? 2 : -1;
  };
  const matches: SlashCommand[] =
    typed === undefined || dismissed === draft
      ? []
      : commands
          .map((command, index) => ({ command, index, score: rank(command.name) }))
          .filter((entry) => entry.score >= 0)
          .sort((a, b) => a.score - b.score || a.index - b.index)
          .slice(0, 50)
          .map((entry) => entry.command);
  const open = matches.length > 0;

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (command: SlashCommand) => setDraft(`/${command.name} `);

  /** Returns true when the key was for the menu, so the message box should not act on it. */
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + matches.length) % matches.length);
    } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      pick(matches[Math.min(active, matches.length - 1)]!);
    } else if (event.key === "Escape") {
      setDismissed(draft);
    } else return false;
    event.preventDefault();
    return true;
  };

  const menu = open ? (
    <ul className="slash" role="listbox" aria-label="Commands" ref={list}>
      {matches.map((command, index) => (
        <li
          key={command.name}
          data-index={index}
          role="option"
          aria-selected={index === active}
          className={index === active ? "on" : undefined}
          onMouseEnter={() => setActive(index)}
          onMouseDown={(event) => {
            event.preventDefault();
            pick(command);
          }}
        >
          <span className="cmd">/{command.name}</span>
          <span className="what">{command.description || command.hint || ""}</span>
        </li>
      ))}
    </ul>
  ) : null;

  return { menu, onKeyDown };
}
