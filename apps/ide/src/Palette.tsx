import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./shared.tsx";
import { call } from "./store.ts";

/** One thing the palette can do: open a thread, run an action, jump to a setting. */
export type PaletteEntry = { id: string; group: string; label: string; hint?: string; icon: string; keys?: string; run(): void };

// Lower is better. -1 means no match. Same order as the slash menu: the start, then a word start, then anywhere.
function score(text: string, query: string): number {
  const lower = text.toLowerCase();
  if (!query) return 0;
  if (lower.startsWith(query)) return 0;
  if (lower.split(/[\s:/\-_.]+/).some((word) => word.startsWith(query))) return 1;
  if (lower.includes(query)) return 2;
  // Every typed letter in order, for quick abbreviations like "nt" for New thread.
  let at = 0;
  for (const char of lower) if (char === query[at]) at++;
  return at === query.length ? 3 : -1;
}

/**
 * Ctrl+K: one box to find any thread (by title or by what was said in it), project, setting or action.
 * Arrows move, Enter runs, Esc closes.
 */
export function Palette(props: { entries: PaletteEntry[]; threadEntry(threadId: string, snippet: string): PaletteEntry | null; close(): void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [said, setSaid] = useState<{ threadId: string; snippet: string }[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();

  // Messages are searched in the engine, a moment after typing stops.
  useEffect(() => {
    if (needle.length < 2) return setSaid([]);
    let stale = false;
    const timer = setTimeout(() => {
      call("thread.search", { query: needle })
        .then((found) => !stale && setSaid(found))
        .catch(() => !stale && setSaid([]));
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [needle]);

  const shown = useMemo(() => {
    // Groups keep the order they were given in; matches are ranked inside each group.
    const groups = [...new Set(props.entries.map((entry) => entry.group))];
    const ranked = props.entries
      .map((entry, index) => ({ entry, index, rank: Math.min(...[entry.label, entry.hint ?? ""].map((text, field) => { const s = score(text, needle); return s < 0 ? 99 : s + field * 4; })) }))
      .filter((row) => row.rank < 99)
      .sort((a, b) => groups.indexOf(a.entry.group) - groups.indexOf(b.entry.group) || a.rank - b.rank || a.index - b.index)
      .map((row) => row.entry);
    const titled = new Set(ranked.map((entry) => entry.id));
    const fromMessages = needle.length < 2 ? [] : said
      .filter((row) => !titled.has(`thread:${row.threadId}`))
      .map((row) => props.threadEntry(row.threadId, row.snippet))
      .filter((entry): entry is PaletteEntry => !!entry)
      .map((entry) => ({ ...entry, id: `said:${entry.id}`, group: "In messages" }));
    return [...ranked, ...fromMessages].slice(0, 80);
  }, [props.entries, needle, said]);

  useEffect(() => setActive(0), [needle]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    props.close();
    entry.run();
  };

  let lastGroup = "";
  return (
    <div className="palette-back" onMouseDown={(event) => event.target === event.currentTarget && props.close()}>
      <div className="palette" role="dialog" aria-label="Search and commands">
        <label className="pfind">
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            placeholder="Search threads, projects, settings and actions"
            aria-label="Search threads, projects, settings and actions"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[active] ? `pal-${active}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const step = event.key === "ArrowDown" ? 1 : -1;
                if (shown.length) setActive((index) => (index + step + shown.length) % shown.length);
              } else if (event.key === "Enter") run(shown[active]);
              else if (event.key === "Escape") props.close();
              else return;
              event.preventDefault();
              event.stopPropagation();
            }}
          />
          <kbd>Esc</kbd>
        </label>
        <div className="plist" id="palette-list" role="listbox" ref={list}>
          {shown.length === 0 && <p className="muted pnone">Nothing matches "{query}".</p>}
          {shown.map((entry, index) => {
            const heading = entry.group !== lastGroup ? entry.group : null;
            lastGroup = entry.group;
            return (
              <div key={entry.id}>
                {heading && <div className="pgroup">{heading}</div>}
                <div
                  id={`pal-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? "pitem on" : "pitem"}
                  onMouseMove={() => index !== active && setActive(index)}
                  onClick={() => run(entry)}
                >
                  <Icon name={entry.icon} />
                  <span className="plabel trunc">{entry.label}</span>
                  {entry.hint && <span className="phint trunc">{entry.hint}</span>}
                  {entry.keys && <kbd>{entry.keys}</kbd>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
