import { useEffect, useMemo, useState } from "react";
import type { Item, Thread } from "@arcex/contracts";
import { nameOf } from "./shared.tsx";
import { useStore } from "./store.ts";

/**
 * Reports go to Arcex's public repository as a GitHub issue the user reviews and submits there (Finlay's choice,
 * November 22). Nothing is sent from Arcex itself. Point this at the public repository when the ADE moves to it.
 */
export const FEEDBACK_REPO = "finlay0/Arcex";
/** Opens the dialog, optionally about a thread: `detail` is its id. */
export const OPEN_FEEDBACK = "arcex:feedback";
// GitHub refuses very long addresses; the body is trimmed to stay well under its limit.
const MAX_BODY = 6000;

function platform(): string {
  const agent = navigator.userAgent;
  return /Windows/i.test(agent) ? "Windows" : /Mac OS/i.test(agent) ? "macOS" : /Linux/i.test(agent) ? "Linux" : "Unknown system";
}

/** The thread's conversation as plain lines, newest kept when it's too long. */
function transcript(items: Item[]): string {
  const lines = items.flatMap((item) => {
    if (item.kind === "user") return [`You: ${item.text}`];
    if (item.kind === "say") return [`Agent: ${item.text}`];
    if (item.kind === "error") return [`Error: ${item.text}`];
    if (item.kind === "note") return [`Note: ${item.text}`];
    if (item.kind === "step") return [`Step: ${item.label}${item.status === "failed" ? " (failed)" : ""}`];
    return [];
  });
  const text = lines.join("\n");
  return text.length > 3500 ? `…${text.slice(-3500)}` : text;
}

export function Feedback({ threadId, close }: { threadId: string | null; close(): void }) {
  const store = useStore();
  const thread: Thread | null = threadId ? store.threads.find((t) => t.id === threadId) ?? null : null;
  const [what, setWhat] = useState("");
  const [attach, setAttach] = useState(Boolean(thread));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  const conversation = useMemo(() => (thread ? transcript(store.items[thread.id] ?? []) : ""), [thread, store.items]);
  const body = [
    "**What happened**",
    what.trim() || "(Describe what you expected and what happened instead.)",
    "",
    `**Arcex** ${store.about?.version ?? "unknown version"} · ${platform()}${thread ? ` · ${nameOf(thread.provider)}${thread.model ? ` ${thread.model.name}` : ""}` : ""}`,
    ...(attach && conversation ? ["", "<details><summary>The thread</summary>", "", "```text", conversation.replaceAll("```", "'''"), "```", "</details>"] : []),
  ].join("\n").slice(0, MAX_BODY);
  const title = what.trim().split(/\r?\n/)[0]!.slice(0, 80) || "Feedback";
  const open = () => {
    const url = `https://github.com/${FEEDBACK_REPO}/issues/new?${new URLSearchParams({ title, body }).toString()}`;
    if (window.arcex?.openExternal) window.arcex.openExternal(url);
    else window.open(url, "_blank", "noopener");
    close();
  };
  return (
    <div className="palette-back" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="palette feedback" role="dialog" aria-label="Send feedback">
        <h2>Send feedback</h2>
        <p className="muted">This opens a GitHub issue for you to check and submit. Issues there are public, so leave out anything private.</p>
        <textarea
          className="textfield"
          autoFocus
          rows={5}
          value={what}
          maxLength={3000}
          placeholder="What happened? What did you expect?"
          aria-label="What happened?"
          onChange={(event) => setWhat(event.target.value)}
        />
        {thread && (
          <label className="fbattach">
            <input type="checkbox" checked={attach} onChange={(event) => setAttach(event.target.checked)} />
            <span>Include this thread's messages <span className="muted">({thread.title})</span></span>
          </label>
        )}
        <details className="fbpreview">
          <summary>What will be in the issue</summary>
          <pre>{body}</pre>
        </details>
        <div className="changeacts">
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" disabled={!what.trim()} onClick={open}>Open on GitHub</button>
        </div>
      </div>
    </div>
  );
}
