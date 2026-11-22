import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Change } from "@arcex/contracts";

/**
 * Separate copies of a project for one thread each (Git worktrees), so threads working at once don't collide. A copy
 * starts from the project's last saved version on its own branch, kept in Arcex's data folder. Its work comes back to
 * the project folder as unsaved changes; the user never sees the branch.
 */
export type Copy = { path: string; branch: string; base: string };

const MAX_PATCH = 20_000_000;

function git(cwd: string, args: string[], input?: string): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--literal-pathspecs", ...args], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_PATCH) out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => (err = (err + chunk.toString()).slice(-4000)));
    child.on("error", (error) => resolve({ ok: false, out: "", err: (error as NodeJS.ErrnoException).code === "ENOENT" ? "Install Git to use separate copies." : error.message }));
    child.on("close", (code) => resolve({ ok: code === 0 && size <= MAX_PATCH, out, err: size > MAX_PATCH ? "the changes are too large to bring in at once" : err.trim() }));
    child.stdin.end(input ?? "");
  });
}

/** Makes a separate copy of the project at `dir`, from its last saved version, on a branch of its own. */
export async function createCopy(cwd: string, dir: string, id: string): Promise<Copy> {
  const head = await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!head.ok || !head.out.trim()) throw new Error("save a version of this project first. A separate copy starts from the last saved version");
  const base = head.out.trim();
  const branch = `arcex/${id.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "copy"}`;
  const added = await git(cwd, ["worktree", "add", "--quiet", "-b", branch, dir, base]);
  if (!added.ok) throw new Error(added.err.split(/\r?\n/).pop()?.slice(0, 300) || "Git couldn't make a separate copy");
  return { path: dir, branch, base };
}

/** Stages everything in the copy, so new files count too. The copy's index is Arcex's own. */
async function stageAll(copy: Copy): Promise<void> {
  const staged = await git(copy.path, ["add", "-A"]);
  if (!staged.ok) throw new Error(staged.err.slice(0, 300) || "Git couldn't read the copy's changes");
}

/** What the thread changed in its copy since it was made, saved or not. */
export async function copyChanges(copy: Copy): Promise<Change[]> {
  await stageAll(copy);
  const names = await git(copy.path, ["diff", "--cached", "--name-status", "-z", "--no-renames", copy.base]);
  const stats = await git(copy.path, ["diff", "--cached", "--numstat", "-z", "--no-renames", copy.base]);
  const counts = new Map<string, [number, number]>();
  for (const line of stats.out.split("\0")) {
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]+)$/.exec(line);
    if (match) counts.set(match[3]!, [Number(match[1]) || 0, Number(match[2]) || 0]);
  }
  const parts = names.out.split("\0");
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

/** One file's diff in the copy. The path must be one `copyChanges` reported. */
export async function copyDiff(copy: Copy, file: string): Promise<string> {
  if (!(await copyChanges(copy)).some((change) => change.path === file)) throw new Error("that file has no changes in this copy");
  return (await git(copy.path, ["diff", "--cached", "--no-renames", copy.base, "--", file])).out.slice(0, 200_000);
}

/**
 * Writes the copy's changes into the project folder as unsaved changes. Where the project folder changed the same
 * file meanwhile, the two are merged and overlapping lines carry both versions, marked; those files are listed.
 */
export async function bringIn(cwd: string, copy: Copy): Promise<{ files: string[]; overlaps: string[] }> {
  const changes = await copyChanges(copy);
  const root = path.resolve(cwd);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "arcex-bring-"));
  const overlaps: string[] = [];
  try {
    for (const change of changes) {
      const target = path.resolve(root, change.path);
      if (!target.startsWith(root + path.sep)) continue;
      const base = change.status === "added" ? null : await blob(copy.path, `${copy.base}:${change.path}`);
      const ours = await readFile(target).catch(() => null);
      const theirs = change.status === "removed" ? null : await readFile(path.join(copy.path, change.path)).catch(() => null);
      const same = (a: Buffer | null, b: Buffer | null) => (a === null ? b === null : b !== null && a.equals(b));
      // The project folder still has this file as the copy started from it (or already has the copy's version).
      if (same(ours, base) || same(ours, theirs)) {
        if (theirs === null) await rm(target, { force: true });
        else {
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, theirs);
        }
        continue;
      }
      // Both sides changed it. Text files are merged line by line, with both versions marked where they overlap.
      // A file one side removed, or a binary file, keeps the project's version.
      if (ours === null || theirs === null || ours.includes(0) || theirs.includes(0) || base?.includes(0)) {
        overlaps.push(change.path);
        continue;
      }
      const baseFile = path.join(scratch, "base");
      const theirsFile = path.join(scratch, "theirs");
      await writeFile(baseFile, base ?? Buffer.alloc(0));
      await writeFile(theirsFile, theirs);
      const merged = await gitBytes(cwd, ["merge-file", "-p", "-L", "project folder", "-L", "before", "-L", "this thread's copy", target, baseFile, theirsFile]);
      if (merged.code < 0 || merged.code > 127) {
        overlaps.push(change.path);
        continue;
      }
      await writeFile(target, merged.out);
      if (merged.code > 0) overlaps.push(change.path);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return { files: changes.map((change) => change.path), overlaps };
}

/** A file's bytes at a commit, or null when it didn't exist there. */
async function blob(cwd: string, spec: string): Promise<Buffer | null> {
  const result = await gitBytes(cwd, ["cat-file", "blob", spec]);
  return result.code === 0 ? result.out : null;
}

function gitBytes(cwd: string, args: string[]): Promise<{ code: number; out: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_PATCH) chunks.push(chunk);
    });
    child.on("error", () => resolve({ code: -1, out: Buffer.alloc(0) }));
    child.on("close", (code) => resolve({ code: size > MAX_PATCH ? -1 : (code ?? -1), out: Buffer.concat(chunks) }));
  });
}

/** Removes the copy and its branch. */
export async function removeCopy(cwd: string, copy: Copy): Promise<void> {
  await git(cwd, ["worktree", "remove", "--force", copy.path]);
  await rm(copy.path, { recursive: true, force: true }).catch(() => {});
  await git(cwd, ["worktree", "prune"]);
  await git(cwd, ["branch", "-D", copy.branch]);
}
