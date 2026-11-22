import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IPty } from "@lydell/node-pty";

const BUFFER = 100 * 1024;
const MAX_TERMINALS = 6;

/** The user's shell: PowerShell 7 when installed, else Windows PowerShell; the login shell elsewhere. */
function shellOf(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const pwsh = [process.env.ProgramFiles && path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")].find((file) => file && existsSync(file));
    return { file: pwsh ?? "powershell.exe", args: ["-NoLogo"] };
  }
  return { file: process.env.SHELL || "/bin/bash", args: ["-l"] };
}

type Open = { id: string; projectId: string; pty: IPty; buffer: string; pending: string; timer: ReturnType<typeof setTimeout> | null };

/**
 * One real shell per project, for people who choose to see it. Windows runs it through ConPTY, so no console window
 * opens. Output is batched to the client and the end of it is kept, so reopening the panel shows what was there.
 */
export function createTerminals(options: { data(id: string, data: string): void; exit(id: string, code: number): void }) {
  const open = new Map<string, Open>();
  let loaded: typeof import("@lydell/node-pty") | null = null;

  const flush = (term: Open) => {
    term.timer = null;
    if (!term.pending) return;
    options.data(term.id, term.pending);
    term.pending = "";
  };

  async function start(projectId: string, cwd: string, cols: number, rows: number): Promise<{ id: string; buffer: string }> {
    const existing = [...open.values()].find((term) => term.projectId === projectId);
    if (existing) {
      existing.pty.resize(cols, rows);
      return { id: existing.id, buffer: existing.buffer };
    }
    if (open.size >= MAX_TERMINALS) throw new Error("close another project's terminal first");
    // Loaded on first use, so people who never open a terminal never load it.
    loaded ??= await import("@lydell/node-pty");
    const shell = shellOf();
    const pty = loaded.spawn(shell.file, shell.args, { name: "xterm-256color", cols, rows, cwd, env: { ...process.env, TERM: "xterm-256color" } as Record<string, string> });
    const term: Open = { id: randomUUID(), projectId, pty, buffer: "", pending: "", timer: null };
    open.set(term.id, term);
    pty.onData((data) => {
      term.buffer = (term.buffer + data).slice(-BUFFER);
      term.pending += data;
      term.timer ??= setTimeout(() => flush(term), 16);
    });
    pty.onExit(({ exitCode }) => {
      flush(term);
      open.delete(term.id);
      options.exit(term.id, exitCode);
    });
    return { id: term.id, buffer: "" };
  }

  const get = (id: string) => {
    const term = open.get(id);
    if (!term) throw new Error("that terminal has closed");
    return term;
  };

  return {
    start,
    write(id: string, data: string) {
      get(id).pty.write(data);
    },
    resize(id: string, cols: number, rows: number) {
      get(id).pty.resize(cols, rows);
    },
    close(id: string) {
      open.get(id)?.pty.kill();
    },
    closeProject(projectId: string) {
      for (const term of open.values()) if (term.projectId === projectId) term.pty.kill();
    },
    closeAll() {
      for (const term of open.values()) term.pty.kill();
    },
  };
}
