import { execFile } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import os from "node:os";
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

/**
 * Files the current branch changed since it grew from `base`, counted from where the two split, so work that landed on
 * the base since doesn't show. Saved versions only; unsaved changes have their own list. `base` must be a checked name.
 */
export async function branchChanges(cwd: string, base: string): Promise<Change[]> {
  const range = `refs/heads/${base}...HEAD`;
  const names = await git(cwd, ["diff", "--name-status", "-z", "--no-renames", "--relative", range, "--", "."]);
  const stats = await git(cwd, ["diff", "--numstat", "-z", "--no-renames", "--relative", range, "--", "."]);
  const counts = new Map<string, [number, number]>();
  for (const line of stats.split("\0")) {
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]+)$/.exec(line);
    if (match) counts.set(match[3]!, [Number(match[1]) || 0, Number(match[2]) || 0]);
  }
  const parts = names.split("\0");
  const result: Change[] = [];
  for (let at = 0; at + 1 < parts.length && result.length < 500; at += 2) {
    const code = parts[at]!;
    const file = parts[at + 1]!;
    if (!code || !file) continue;
    const [added, removed] = counts.get(file) ?? [0, 0];
    result.push({ path: file, status: code.startsWith("A") ? "added" : code.startsWith("D") ? "removed" : "changed", added, removed });
  }
  return result;
}

/** One file's diff across the branch. The path must be one `branchChanges` reported. */
export async function branchDiff(cwd: string, base: string, file: string): Promise<string> {
  if (!(await branchChanges(cwd, base)).some((change) => change.path === file)) throw new Error("that file has no changes on this branch");
  return (await git(cwd, ["diff", "--no-renames", "--relative", `refs/heads/${base}...HEAD`, "--", file])).slice(0, MAX_DIFF);
}

const SNAPSHOT_LIMIT = 50 * 1024 * 1024;
const TREE = /^[0-9a-f]{40,64}$/;

function gitWith(cwd: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["--literal-pathspecs", ...args], { cwd, env: { ...process.env, ...env }, maxBuffer: 8_000_000, windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim().slice(0, 250) || "Git couldn't take a snapshot.")) : resolve(stdout),
    );
  });
}

/**
 * A snapshot of the project folder as a Git tree, so a turn's changes can be shown on their own. It uses a separate
 * index file kept by Arcex, so the user's staging area, branch and history are untouched. Null when the folder isn't
 * a Git repository or holds more new, untracked data than is sensible to copy into Git's object store.
 */
export async function snapshot(cwd: string, indexFile: string): Promise<string | null> {
  try {
    const gitDir = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim();
    const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."])).split("\0").filter(Boolean);
    let size = 0;
    for (const file of untracked.slice(0, 5000)) {
      size += (await lstat(path.join(cwd, file)).catch(() => null))?.size ?? 0;
      if (size > SNAPSHOT_LIMIT) return null;
    }
    if (untracked.length > 5000) return null;
    // Start from the user's index the first time, so tracked files needn't all be read again.
    if (!existsSync(indexFile) && existsSync(path.join(gitDir, "index"))) copyFileSync(path.join(gitDir, "index"), indexFile);
    const env = { GIT_INDEX_FILE: indexFile };
    await gitWith(cwd, ["add", "-A", "--", "."], env);
    const tree = (await gitWith(cwd, ["write-tree"], env)).trim();
    return TREE.test(tree) ? tree : null;
  } catch {
    return null;
  }
}

/** Files that differ between two snapshots, relative to the project folder. */
export async function turnChanges(cwd: string, before: string, after: string): Promise<Change[]> {
  if (!TREE.test(before) || !TREE.test(after)) throw new Error("invalid snapshot");
  if (before === after) return [];
  const [names, stats] = await Promise.all([
    git(cwd, ["diff", "--name-status", "-z", "--no-renames", "--relative", before, after, "--", "."]),
    git(cwd, ["diff", "--numstat", "-z", "--no-renames", "--relative", before, after, "--", "."]),
  ]);
  const counts = new Map<string, [number, number]>();
  for (const line of stats.split("\0")) {
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]+)$/.exec(line);
    if (match) counts.set(match[3]!, [Number(match[1]) || 0, Number(match[2]) || 0]);
  }
  const parts = names.split("\0");
  const result: Change[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const code = parts[index]!;
    const file = parts[index + 1]!;
    const [added, removed] = counts.get(file) ?? [0, 0];
    result.push({ path: file, status: code === "A" ? "added" : code === "D" ? "removed" : "changed", added, removed });
  }
  return result.slice(0, 500);
}

/** One file's diff between two snapshots. The file must be one `turnChanges` reports. */
export async function turnDiff(cwd: string, before: string, after: string, file: string): Promise<string> {
  if (!(await turnChanges(cwd, before, after)).some((change) => change.path === file)) throw new Error("that file didn't change in this turn");
  return (await git(cwd, ["diff", "--no-renames", "--relative", before, after, "--", file])).slice(0, MAX_DIFF);
}

/** The object a path has in a snapshot, or null when the path isn't in it. */
async function blobIn(cwd: string, tree: string, file: string): Promise<string | null> {
  const listed = await git(cwd, ["ls-tree", "-z", tree, "--", `./${file}`]).catch(() => "");
  return /^\d+ blob ([0-9a-f]{40,64})\t/.exec(listed)?.[1] ?? null;
}

/** The object the file in the folder would have now, or null when it's gone. */
async function blobNow(cwd: string, file: string): Promise<string | null> {
  const stats = await lstat(path.join(cwd, file)).catch(() => null);
  if (!stats) return null;
  if (!stats.isFile()) return "not-a-file";
  return (await git(cwd, ["hash-object", "--", file])).trim();
}

/**
 * Puts the files a turn changed back the way they were before it. Only those files are touched. Files changed again
 * since the turn are listed and left alone unless `force` is set, so later work isn't lost by accident. Uses a scratch
 * index, so the user's staging area is untouched.
 */
export async function undoTurn(cwd: string, before: string, after: string, files: string[], scratchIndex: string, force: boolean, redo = false): Promise<{ undone: string[]; changedSince: string[] }> {
  if (!TREE.test(before) || !TREE.test(after)) throw new Error("invalid snapshot");
  const turn = new Set((await turnChanges(cwd, before, after)).map((change) => change.path));
  const targets = files.filter((file) => turn.has(file));
  // Undo goes from the turn's result back to before it. Redo goes the other way.
  const [from, to] = redo ? [before, after] : [after, before];
  const changedSince: string[] = [];
  for (const file of targets) {
    if ((await blobNow(cwd, file)) !== (await blobIn(cwd, from, file))) changedSince.push(file);
  }
  if (changedSince.length && !force) return { undone: [], changedSince };
  const env = { GIT_INDEX_FILE: scratchIndex };
  await gitWith(cwd, ["read-tree", to], env);
  const undone: string[] = [];
  try {
    for (const file of targets) {
      if (await blobIn(cwd, to, file)) {
        await gitWith(cwd, ["checkout-index", "-f", "--", file], env);
      } else {
        // The file didn't exist at that point (the turn created or deleted it), so it's removed.
        const absolute = path.join(cwd, file);
        if ((await lstat(absolute).catch(() => null))?.isFile()) await rm(absolute);
      }
      undone.push(file);
    }
  } finally {
    await rm(scratchIndex, { force: true });
  }
  return { undone, changedSince };
}

/**
 * Puts files back the way they were at an earlier point, for rewinding a conversation over several turns. Each file
 * names the snapshot to restore it from and the snapshot it should match now; a file that doesn't match was changed
 * since, and nothing happens unless `force` is set.
 */
export async function rewindFiles(cwd: string, files: { path: string; from: string; expect: string }[], scratchIndex: string, force: boolean): Promise<{ restored: string[]; changedSince: string[] }> {
  if (files.some((file) => !TREE.test(file.from) || !TREE.test(file.expect))) throw new Error("invalid snapshot");
  const changedSince: string[] = [];
  for (const file of files) {
    if ((await blobNow(cwd, file.path)) !== (await blobIn(cwd, file.expect, file.path))) changedSince.push(file.path);
  }
  if (changedSince.length && !force) return { restored: [], changedSince };
  const restored: string[] = [];
  const byTree = new Map<string, string[]>();
  for (const file of files) byTree.set(file.from, [...(byTree.get(file.from) ?? []), file.path]);
  for (const [tree, paths] of byTree) {
    const env = { GIT_INDEX_FILE: scratchIndex };
    await gitWith(cwd, ["read-tree", tree], env);
    try {
      for (const file of paths) {
        if (await blobIn(cwd, tree, file)) await gitWith(cwd, ["checkout-index", "-f", "--", file], env);
        else {
          const absolute = path.join(cwd, file);
          if ((await lstat(absolute).catch(() => null))?.isFile()) await rm(absolute);
        }
        restored.push(file);
      }
    } finally {
      await rm(scratchIndex, { force: true });
    }
  }
  return { restored, changedSince };
}

/**
 * Saves everything in the project folder as a new version (a Git commit), so the user can come back to it. It uses
 * the user's own Git name and email; on a computer where Git has none, the computer's user name stands in, so a
 * first-time user isn't stopped by Git setup.
 */
export async function saveVersion(cwd: string, message: string): Promise<{ id: string }> {
  const status = await git(cwd, ["status", "--porcelain", "-uall", "--", "."]);
  if (!status.trim()) throw new Error("there's nothing new to save");
  const configured = (await git(cwd, ["config", "user.email"], true)).trim();
  const name = (() => {
    try {
      return os.userInfo().username.replace(/[^\w .-]/g, "").slice(0, 60) || "Arcex user";
    } catch {
      return "Arcex user";
    }
  })();
  const identity = configured ? [] : ["-c", `user.name=${name}`, "-c", `user.email=${name.replace(/\s+/g, ".").toLowerCase()}@localhost`];
  await git(cwd, ["add", "-A", "--", "."]);
  await git(cwd, [...identity, "commit", "-q", "-m", message.slice(0, 500)]);
  return { id: (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim() };
}

export type Version = { id: string; message: string; time: number };

/** The project's saved versions, newest first. Empty for a folder with none yet. */
export async function versions(cwd: string): Promise<Version[]> {
  const head = (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], true)).trim();
  if (!head) return [];
  const log = await git(cwd, ["log", "-n", "30", "--format=%H%x1f%s%x1f%ct%x1e", "--", "."]);
  return log.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [id = "", message = "", time = "0"] = entry.split("\x1f");
    return { id, message: message.slice(0, 200), time: Number(time) * 1000 };
  }).filter((version) => TREE.test(version.id));
}

/**
 * Puts the project folder back the way it was in a saved version. History is kept: the difference shows as unsaved
 * changes, which the user can save as a new version. Files added since that version are removed; files Git has never
 * tracked are left alone. Uses a scratch index, so staging is untouched.
 */
export async function restoreVersion(cwd: string, id: string, scratchIndex: string): Promise<{ files: number }> {
  if (!TREE.test(id) || (await git(cwd, ["cat-file", "-t", id])).trim() !== "commit") throw new Error("that version doesn't exist");
  const added = (await git(cwd, ["diff", "--name-only", "-z", "--no-renames", "--relative", "--diff-filter=A", id, "HEAD", "--", "."])).split("\0").filter(Boolean);
  const env = { GIT_INDEX_FILE: scratchIndex };
  try {
    await gitWith(cwd, ["read-tree", id], env);
    const files = (await git(cwd, ["ls-tree", "-r", "-z", "--name-only", id, "--", "."])).split("\0").filter(Boolean);
    for (let index = 0; index < files.length; index += 200) {
      await gitWith(cwd, ["checkout-index", "-f", "--", ...files.slice(index, index + 200)], env);
    }
    for (const file of added) {
      const absolute = path.join(cwd, file);
      if ((await lstat(absolute).catch(() => null))?.isFile()) await rm(absolute);
    }
    return { files: files.length };
  } finally {
    await rm(scratchIndex, { force: true });
  }
}
