import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Project } from "@arcex/contracts";
import { call, onTerminal } from "./store.ts";

/** Monochrome terminal colours, matching the app: grey ink, no blue. Bright colours stay readable but muted. */
function themeOf(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.theme !== "light";
  return {
    background: read("--page", dark ? "#0e0e10" : "#fafafa"),
    foreground: read("--ink", dark ? "#f4f4f5" : "#111113"),
    cursor: read("--ink", dark ? "#f4f4f5" : "#111113"),
    selectionBackground: dark ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.18)",
    black: dark ? "#2a2a2e" : "#111113",
    red: dark ? "#e5a3a3" : "#a33",
    green: dark ? "#9fd6a8" : "#2a7a3a",
    yellow: dark ? "#d9cf9a" : "#7a6a1a",
    blue: dark ? "#c8c8cf" : "#44444b",
    magenta: dark ? "#c9b8d4" : "#5a4a66",
    cyan: dark ? "#b8cccc" : "#3a5555",
    white: dark ? "#d4d4d8" : "#55555c",
    brightBlack: dark ? "#6b6b73" : "#85858e",
    brightBlue: dark ? "#e4e4e7" : "#2a2a2e",
    brightCyan: dark ? "#d4e0e0" : "#2a4444",
  };
}

/** A real shell in the project folder. Shown only for people who turn it on; it keeps running while hidden. */
export function TerminalTab({ project, fail }: { project: Project; fail(error: unknown): void }) {
  const host = useRef<HTMLDivElement>(null);
  const [ended, setEnded] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    setEnded(null);
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeOf(),
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    let id: string | null = null;
    let disposed = false;
    const stop = onTerminal((message) => {
      if (message.id !== id) return;
      if (message.data !== undefined) term.write(message.data);
      if (message.exit !== undefined) setEnded(message.exit);
    });
    call("terminal.open", { projectId: project.id, cols: term.cols, rows: term.rows })
      .then((opened) => {
        if (disposed) return;
        id = opened.id;
        if (opened.buffer) term.write(opened.buffer);
        term.focus();
      })
      .catch(fail);
    const typed = term.onData((data) => id && void call("terminal.write", { id, data }).catch(() => {}));
    const resized = term.onResize(({ cols, rows }) => id && void call("terminal.resize", { id, cols, rows }).catch(() => {}));
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Hidden for a moment; fits again when shown.
      }
    });
    observer.observe(element);
    return () => {
      disposed = true;
      stop();
      typed.dispose();
      resized.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [project.id, attempt]);

  return (
    <div className="termtab">
      <div className="termhost" ref={host} />
      {ended !== null && (
        <p className="termend">
          The shell ended{ended ? ` (exit ${ended})` : ""}. <button className="link" onClick={() => setAttempt(attempt + 1)}>Start a new one</button>
        </p>
      )}
    </div>
  );
}
