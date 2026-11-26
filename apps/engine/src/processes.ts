import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProcessInfo, ProjectScript } from "@arcex/contracts";

const OUTPUT_LIMIT = 200 * 1024;
const MAX_RUNNING = 8;
/** Script names are passed to a shell, so only plain names run. */
const SAFE_NAME = /^[\w:.@/+-]{1,80}$/;
// Common first: the ones people reach for when they want to see their app.
const FIRST = ["dev", "start", "preview", "serve", "build", "test", "lint"];

/** The package manager a project uses, from its lock file. */
function runnerOf(cwd: string): string {
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(cwd, "bun.lockb")) || existsSync(path.join(cwd, "bun.lock"))) return "bun";
  return "npm";
}

// Colour codes and other terminal controls, which mean nothing in a plain text view.
// eslint-disable-next-line no-control-regex
const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s'"`)\]]*)?/;

type Running = { info: ProcessInfo; child: ChildProcess | null; output: string; stopping: boolean };

/**
 * Runs a project's own scripts (dev server, build, tests) when the user asks, with no terminal window.
 * Output is kept, bounded, for the side panel. A local address a script prints becomes its preview.
 */
export function createProcesses(options: { emit(info: ProcessInfo): void; onUrl(projectId: string, url: string): void }) {
  const all = new Map<string, Running>();

  const publish = (run: Running) => options.emit({ ...run.info });

  async function scripts(cwd: string): Promise<{ runner: string; scripts: ProjectScript[] }> {
    const runner = runnerOf(cwd);
    const text = await readFile(path.join(cwd, "package.json"), "utf8").catch(() => null);
    if (!text) return { runner, scripts: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { runner, scripts: [] };
    }
    const found = (parsed as { scripts?: Record<string, unknown> }).scripts ?? {};
    const list = Object.entries(found)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && SAFE_NAME.test(entry[0]))
      // Lifecycle hooks run by themselves around other scripts.
      .filter(([name]) => !/^(pre|post)/.test(name) || !(name.replace(/^(pre|post)/, "") in found))
      .map(([name, command]) => ({ name, command: command.slice(0, 300) }));
    const rank = (name: string) => (FIRST.includes(name) ? FIRST.indexOf(name) : FIRST.length);
    list.sort((a, b) => rank(a.name) - rank(b.name));
    return { runner, scripts: list.slice(0, 60) };
  }

  async function run(projectId: string, cwd: string, script: string): Promise<ProcessInfo> {
    if (!SAFE_NAME.test(script)) throw new Error("that script name can't be run");
    const { runner, scripts: listed } = await scripts(cwd);
    if (!listed.some((entry) => entry.name === script)) throw new Error(`this project has no "${script}" script`);
    const already = [...all.values()].find((entry) => entry.info.projectId === projectId && entry.info.name === script && entry.info.state === "running");
    if (already) return { ...already.info };
    if ([...all.values()].filter((entry) => entry.info.state === "running").length >= MAX_RUNNING) throw new Error("stop one of the running scripts first");

    const info: ProcessInfo = { id: randomUUID(), projectId, name: script, command: `${runner} run ${script}`, state: "running", exitCode: null, startedAt: Date.now(), endedAt: null, url: null };
    // `BROWSER=none` stops dev servers opening a browser window by themselves; the preview shows it instead.
    // The installed app runs the engine with ELECTRON_RUN_AS_NODE; the user's own app (perhaps an Electron one) must not.
    const { ELECTRON_RUN_AS_NODE: _asNode, ...own } = process.env;
    const env = { ...own, BROWSER: "none", FORCE_COLOR: "0", NO_COLOR: "1" };
    const child = spawn(runner, ["run", script], { cwd, env, shell: true, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const entry: Running = { info, child, output: "", stopping: false };
    all.set(info.id, entry);
    // Only the latest runs are kept once they end.
    const ended = [...all.values()].filter((other) => other.info.state !== "running");
    for (const old of ended.slice(0, Math.max(0, ended.length - 20))) all.delete(old.info.id);

    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8").replace(CONTROL, "");
      entry.output = (entry.output + text).slice(-OUTPUT_LIMIT);
      if (!entry.info.url) {
        const match = LOCAL_URL.exec(text);
        if (match) {
          entry.info.url = match[0].replace("0.0.0.0", "localhost").replace("[::1]", "localhost").replace(/[.,]+$/, "");
          publish(entry);
          options.onUrl(projectId, entry.info.url);
        }
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (error) => {
      entry.output += `\n${error.message}\n`;
    });
    child.on("close", (code) => {
      entry.child = null;
      entry.info.exitCode = code;
      entry.info.endedAt = Date.now();
      entry.info.state = entry.stopping ? "stopped" : code === 0 ? "exited" : "failed";
      publish(entry);
    });
    publish(entry);
    return { ...info };
  }

  /** Ends the script and everything it started (a dev server's own children too). */
  function stop(id: string): void {
    const entry = all.get(id);
    if (!entry?.child?.pid || entry.info.state !== "running") return;
    entry.stopping = true;
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(entry.child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    else {
      try {
        process.kill(-entry.child.pid, "SIGTERM");
      } catch {
        entry.child.kill("SIGTERM");
      }
    }
  }

  return {
    scripts,
    run,
    stop,
    list: (projectId?: string) => [...all.values()].map((entry) => ({ ...entry.info })).filter((info) => !projectId || info.projectId === projectId),
    output(id: string): string {
      const entry = all.get(id);
      if (!entry) throw new Error("that run has gone");
      return entry.output;
    },
    stopProject(projectId: string) {
      for (const entry of all.values()) if (entry.info.projectId === projectId) stop(entry.info.id);
    },
    close() {
      for (const entry of all.values()) stop(entry.info.id);
    },
  };
}
