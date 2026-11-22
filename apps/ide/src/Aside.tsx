import { useEffect, useRef, useState } from "react";
import type { Thread } from "@arcex/contracts";
import { Md } from "./md.tsx";
import { Icon, Loader } from "./shared.tsx";
import { call } from "./store.ts";

/** The engine's side-question updates, passed on by the store. */
export const ASIDE_EVENT = "arcex:aside";
type AsideUpdate = { threadId: string; asideId: string; text: string; state: "working" | "done" | "failed" | "stopped"; error?: string };

/**
 * "Ask aside": a quick question to a throwaway copy of the thread's conversation. The thread, its history and any
 * running turn stay as they are, and the answer is gone once the box closes.
 */
export function Aside({ thread, fail }: { thread: Thread; fail(error: unknown): void }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [answer, setAnswer] = useState<AsideUpdate | null>(null);
  const asideId = useRef<string | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onUpdate = (event: Event) => {
      const update = (event as CustomEvent<AsideUpdate>).detail;
      if (update.threadId !== thread.id || (asideId.current && update.asideId !== asideId.current)) return;
      asideId.current = update.asideId;
      if (update.state === "stopped") return;
      setAnswer(update);
    };
    window.addEventListener(ASIDE_EVENT, onUpdate);
    return () => window.removeEventListener(ASIDE_EVENT, onUpdate);
  }, [thread.id]);

  const stop = () => {
    if (asideId.current && answer?.state === "working") void call("thread.asideStop", { asideId: asideId.current }).catch(() => {});
  };
  const close = () => {
    stop();
    setOpen(false);
  };
  // Leaving the thread ends its side question.
  useEffect(() => () => {
    if (asideId.current) void call("thread.asideStop", { asideId: asideId.current }).catch(() => {});
  }, [thread.id]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (event: MouseEvent) => !wrap.current?.contains(event.target as Node) && answer?.state !== "working" && setOpen(false);
    window.addEventListener("mousedown", outside);
    return () => window.removeEventListener("mousedown", outside);
  }, [open, answer?.state]);

  const ask = () => {
    const text = question.trim();
    if (!text) return;
    stop();
    asideId.current = null;
    setAsked(text);
    setQuestion("");
    setAnswer({ threadId: thread.id, asideId: "", text: "", state: "working" });
    call("thread.aside", { threadId: thread.id, text })
      .then((result) => { asideId.current ??= result.asideId; })
      .catch((error) => {
        setAnswer(null);
        fail(error);
      });
  };

  return (
    <span className="aside" ref={wrap}>
      <button className="icon" aria-label="Ask aside" title="Ask aside: a quick question that doesn't interrupt the thread" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <Icon name="chat" />
      </button>
      {open && (
        <div
          className="asidepop"
          role="dialog"
          aria-label="Ask aside"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="label">Ask aside · doesn't interrupt or join the thread</div>
          {answer && (
            <div className="asideanswer">
              <p className="asideq">{asked}</p>
              {answer.text ? <Md text={answer.text} /> : answer.state === "working" ? <p className="asidewait"><Loader /> Thinking…</p> : null}
              {answer.state === "failed" && <p className="asideerr">{answer.error ? `Couldn't answer: ${answer.error}` : "Couldn't answer."}</p>}
              {answer.state === "working" && (
                <button className="link" onClick={stop}>Stop</button>
              )}
            </div>
          )}
          <div className="asideask">
            <textarea
              ref={input}
              rows={2}
              value={question}
              maxLength={4000}
              placeholder={answer ? "Ask something else" : "Ask a quick question about this thread"}
              aria-label="Side question"
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  ask();
                }
              }}
            />
            <button className="btn small" disabled={!question.trim()} onClick={ask}>Ask</button>
          </div>
        </div>
      )}
    </span>
  );
}
