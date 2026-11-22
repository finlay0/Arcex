import { useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "./shared.tsx";

// The CSS Custom Highlight API marks matches without changing the page's own markup.
type Highlights = { set(name: string, value: unknown): void; delete(name: string): void };
const highlights = (globalThis as { CSS?: { highlights?: Highlights } }).CSS?.highlights;
const HighlightClass = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

/** Every place `needle` appears in the text under `root`, ignoring case. */
function rangesIn(root: HTMLElement, needle: string): Range[] {
  const ranges: Range[] = [];
  if (!needle) return ranges;
  const lower = needle.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // Skip text people can't see, such as a folded section's content.
    acceptNode: (node) => (node.parentElement?.closest("details:not([open]) > :not(summary)") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node && ranges.length < 1000; node = walker.nextNode()) {
    const text = node.textContent?.toLowerCase() ?? "";
    for (let at = text.indexOf(lower); at !== -1 && ranges.length < 1000; at = text.indexOf(lower, at + lower.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + lower.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/** Ctrl+F in a thread: a small bar that marks every match and steps through them. */
export function FindBar(props: { root: RefObject<HTMLElement | null>; watch: unknown; close(): void }) {
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [ranges, setRanges] = useState<Range[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  useEffect(() => {
    const root = props.root.current;
    setRanges(root ? rangesIn(root, query.trim()) : []);
  }, [query, props.watch]);
  useEffect(() => setCurrent(0), [query]);

  const at = ranges.length ? Math.min(current, ranges.length - 1) : -1;
  useEffect(() => {
    if (!highlights || !HighlightClass) return;
    highlights.set("arcex-find", new HighlightClass(...ranges));
    if (at >= 0) {
      highlights.set("arcex-find-current", new HighlightClass(ranges[at]!));
      ranges[at]!.startContainer.parentElement?.scrollIntoView({ block: "center" });
    } else highlights.delete("arcex-find-current");
  }, [ranges, at]);
  useEffect(
    () => () => {
      highlights?.delete("arcex-find");
      highlights?.delete("arcex-find-current");
    },
    [],
  );

  const step = (by: number) => ranges.length && setCurrent((at + by + ranges.length) % ranges.length);
  return (
    <div className="findbar" role="search">
      <Icon name="search" />
      <input
        ref={input}
        value={query}
        placeholder="Find in this thread"
        aria-label="Find in this thread"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") step(event.shiftKey ? -1 : 1);
          else if (event.key === "Escape") props.close();
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
      />
      <span className="count" aria-live="polite">{query.trim() ? (ranges.length ? `${at + 1} of ${ranges.length}` : "No matches") : ""}</span>
      <button className="icon" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!ranges.length} onClick={() => step(-1)}>
        <Icon name="up" />
      </button>
      <button className="icon" aria-label="Next match" title="Next (Enter)" disabled={!ranges.length} onClick={() => step(1)}>
        <Icon name="down" />
      </button>
      <button className="icon" aria-label="Close find" title="Close (Esc)" onClick={props.close}>
        <Icon name="x" />
      </button>
    </div>
  );
}
