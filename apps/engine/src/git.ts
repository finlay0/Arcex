import { execFile } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { Change } from "@arcex/contracts";

const MAX_DIFF = 200_000;

function git(cwd: string, args: string[], allowMissing = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["--literal-pathspecs", ...args], { cwd, maxBuffer: 8_000_000, windowsHide: true }, (error, stdout, stderr) => {
      if (!error || (allowMissing && error.code === 1)) resolve(stdout);
      else if (error.code === "ENOENT") reject(new Error("Install Git to see uncommitted changes."));
      else if (/not a git repository/i.test(stderr)) reject(new Error("This folder has no Git repository yet."));
      else reject(new Error(stderr.trim().slice(0, 250) || "Git couldn't read the changes."));
    });
  });
}

export async function initRepo(cwd: string) {
  await git(cwd, ["init", "-q"]);
}

/** Uncommitted changes in the project, compared with the last commit. */
export async function changes(cwd: string): Promise<Change[]> {
  const prefix = (await git(cwd, ["rev-parse", "--show-prefix"])).replace(/\r?\n$/, "");
  const status = await git(cwd, ["status", "--porcelain=v1", "-z", "-uall", "--no-renames", "--", "."]);
  const counts = new Map<string, [number, number]>();
  const base = await diffBase(cwd);
  const stats = await git(cwd, ["diff", ...base, "--numstat", "-z", "--no-renames", "--relative", "--", "."]);
  for (const line of stats.split("\0")) {
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]+)$/.exec(line);
    if (match) counts.set(match[3]!, [Number(match[1]) || 0, Number(match[2]) || 0]);
  }
  const result: Change[] = [];
  for (const line of status.split("\0")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3 + prefix.length);
    const kind: Change["status"] = code.includes("?") || code.includes("A") ? "added" : code.includes("D") ? "removed" : "changed";
    // Git doesn't count lines in files it isn't tracking yet, so count a new file's lines here.
    const [added, removed] = counts.get(file) ?? (code === "??" && result.length < 200 ? [await lineCount(path.join(cwd, file)), 0] : [0, 0]);
    result.push({ path: file, status: kind, added, removed });
  }
  return result.slice(0, 500);
}

/** Lines in a new text file, reading at most the size a diff would show. Zero for folders, links and binary files. */
async function lineCount(file: string): Promise<number> {
  try {
    if (!(await lstat(file)).isFile()) return 0;
    const handle = await open(file, "r");
    try {
      const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(MAX_DIFF), length: MAX_DIFF });
      const content = buffer.subarray(0, bytesRead);
      if (!bytesRead || content.includes(0)) return 0;
      let lines = 0;
      for (const byte of content) if (byte === 10) lines += 1;
      return content[bytesRead - 1] === 10 ? lines : lines + 1;
    } finally {
      await handle.close();
    }
  } catch {
    return 0;
  }
}

// On a new repository, show staged changes against the empty tree.
async function diffBase(cwd: string): Promise<string[]> {
  return (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], true)).trim() ? ["HEAD"] : ["--cached"];
}

/** Diff for one changed file. The path must be one that `changes` reported, so this cannot read arbitrary files. */
export async function diff(cwd: string, file: string): Promise<string> {
  const known = (await changes(cwd)).find((change) => change.path === file);
  if (!known) throw new Error("that file has no changes");
  const tracked = await git(cwd, ["diff", ...(await diffBase(cwd)), "--relative", "--", file]);
  if (tracked || known.status !== "added") return tracked.slice(0, MAX_DIFF);
  const absolute = path.join(cwd, file);
  if (!(await lstat(absolute)).isFile()) return "";
  const handle = await open(absolute, "r");
  try {
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(MAX_DIFF), length: MAX_DIFF });
    const content = buffer.toString("utf8", 0, bytesRead);
    if (!content || content.includes("\0")) return "";
    return content.replace(/\r?\n$/, "").split("\n").map((line) => `+${line}`).join("\n");
  } finally {
    await handle.close();
  }
}
