import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { UsageLimit } from "@arcex/contracts";
import { vendorCli } from "./vendorCli.ts";

/**
 * Codex's plan limits, asked of Codex itself. Its ACP adapter only shows them inside the text of its /status command,
 * so Arcex starts Codex's own app server for a moment and reads them the way the adapter does. Codex uses its own
 * sign-in; Arcex sees only the percentages and reset times. No model is called.
 */

type Window = { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null } | null;
type Snapshot = { primary?: Window; secondary?: Window; rateLimitReachedType?: string | null };

/** The Codex build the adapter runs, so the limits are for the same sign-in. */
function codexScript(): string | null {
  try {
    const adapter = createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp/package.json");
    return createRequire(adapter).resolve("@openai/codex/bin/codex.js");
  } catch {
    return null;
  }
}

/** The tighter of Codex's windows (five hours and weekly), as Arcex shows limits. Null when Codex can't say. */
export async function readCodexLimit(): Promise<UsageLimit | null> {
  const script = codexScript();
  // Installed, Arcex has no Codex of its own and asks the user's (an npm shim needs the shell to start on Windows).
  const own = script ? null : await vendorCli("codex");
  if (!script && !own) return null;
  return new Promise((resolve) => {
    const child = script
      ? spawn(process.execPath, [script, "app-server"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] })
      : spawn(/\s/.test(own!) ? `"${own}"` : own!, ["app-server"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], shell: /\.cmd$/i.test(own!) });
    let buffer = "";
    let done = false;
    const finish = (limit: UsageLimit | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      setTimeout(() => child.kill(), 2000).unref();
      resolve(limit);
    };
    const timer = setTimeout(() => finish(null), 20_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout.on("data", (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-200_000);
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message: { id?: number; result?: { rateLimits?: Snapshot } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (message.id === 2) finish(limitFrom(message.result?.rateLimits));
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "arcex", title: "Arcex", version: "0.1.0" } } });
  });
}

function limitFrom(snapshot: Snapshot | undefined): UsageLimit | null {
  if (!snapshot) return null;
  const windows = [snapshot.primary, snapshot.secondary].filter((entry): entry is NonNullable<Window> => !!entry && typeof entry.usedPercent === "number");
  if (!windows.length) return null;
  const tightest = windows.reduce((a, b) => ((b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a));
  const used = Math.min(1, Math.max(0, (tightest.usedPercent ?? 0) / 100));
  const minutes = tightest.windowDurationMins ?? 0;
  return {
    status: snapshot.rateLimitReachedType || used >= 1 ? "reached" : used >= 0.8 ? "warning" : "ok",
    window: minutes === 300 ? "five_hour" : minutes >= 7 * 24 * 60 - 60 && minutes <= 7 * 24 * 60 + 60 ? "weekly" : "other",
    used,
    resetsAt: typeof tightest.resetsAt === "number" ? tightest.resetsAt * 1000 : null,
    at: Date.now(),
  };
}
