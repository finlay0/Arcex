import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Change } from "@arcex/contracts";

const MAX_DIFF = 200_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 8_000_000, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout));
  });
}

export async function initRepo(cwd: string) {
  await git(cwd, ["init", "-q"]);
}

/** Uncommitted changes in the project, compared with the last commit. */
export async function changes(cwd: string): Promise<Change[]> {
  const status = await git(cwd, ["status", "--porcelain=v1", "-uall", "--no-renames"]);
  const counts = new Map<string, [number, number]>();
  for (const line of (await git(cwd, ["diff", "HEAD", "--numstat", "--no-renames"])).split("\n")) {
    const [added, removed, file] = line.split("\t");
    if (file) counts.set(file, [Number(added) || 0, Number(removed) || 0]);
  }
  const result: Change[] = [];
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3).replace(/^"|"$/g, "");
    const [added, removed] = counts.get(file) ?? [0, 0];
    const kind: Change["status"] = code.includes("?") || code.includes("A") ? "added" : code.includes("D") ? "removed" : "changed";
    result.push({ path: file, status: kind, added, removed });
  }
  return result.slice(0, 500);
}

/** Diff for one changed file. The path must be one that `changes` reported, so this cannot read arbitrary files. */
export async function diff(cwd: string, file: string): Promise<string> {
  const known = (await changes(cwd)).find((change) => change.path === file);
  if (!known) throw new Error("that file has no changes");
  if (known.status === "added") {
    const tracked = await git(cwd, ["diff", "HEAD", "--", file]);
    if (tracked) return tracked.slice(0, MAX_DIFF);
    const text = await readFile(path.join(cwd, file), "utf8").catch(() => "");
    return text.slice(0, MAX_DIFF).split("\n").map((line) => `+${line}`).join("\n");
  }
  return (await git(cwd, ["diff", "HEAD", "--", file])).slice(0, MAX_DIFF);
}
