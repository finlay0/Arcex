// "@" mentions: finding project files by a few typed letters, and turning mentions in a message into file links.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import type { FileMatch } from "@arcex/contracts";

/** Folders nobody mentions, and that can hold tens of thousands of entries. */
const SKIP = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo", ".cache", ".venv", "venv", "__pycache__", "target", "coverage", ".wrangler", ".svelte-kit", ".nuxt", "out"]);
const MAX_ENTRIES = 20_000;
const FRESH_MS = 15_000;

type Index = { at: number; entries: FileMatch[] };
const indexes = new Map<string, Index>();

/** Every file and folder in the project, relative with forward slashes. Kept briefly, since the user types a letter at a time. */
function indexOf(cwd: string): FileMatch[] {
  const cached = indexes.get(cwd);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.entries;
  const entries: FileMatch[] = [];
  const queue = [""];
  // Breadth first, so a huge project still lists its top folders.
  while (queue.length && entries.length < MAX_ENTRIES) {
    const dir = queue.shift()!;
    let listed;
    try {
      listed = readdirSync(path.join(cwd, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of listed) {
      if (entries.length >= MAX_ENTRIES) break;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        entries.push({ path: rel, kind: "folder" });
        queue.push(rel);
      } else if (entry.isFile()) entries.push({ path: rel, kind: "file" });
    }
  }
  indexes.set(cwd, { at: Date.now(), entries });
  return entries;
}

/**
 * How well `query` matches `file`, higher is better, or -1. Letters must appear in order. Matches in the file's own
 * name, at the start of a word, and in a row count most; shorter paths win ties.
 */
function score(query: string, file: string): number {
  const lower = file.toLowerCase();
  const nameAt = lower.lastIndexOf("/") + 1;
  if (!query) return 1000 - file.length;
  const whole = lower.indexOf(query);
  if (whole >= 0) return 5000 + (whole >= nameAt ? 3000 : 0) + (whole === nameAt ? 1000 : 0) - file.length;
  let total = 0;
  let from = 0;
  let last = -2;
  for (const letter of query) {
    const at = lower.indexOf(letter, from);
    if (at < 0) return -1;
    if (at === last + 1) total += 15;
    if (at === 0 || "/-_. ".includes(lower[at - 1]!)) total += 10;
    if (at >= nameAt) total += 5;
    last = at;
    from = at + 1;
  }
  return total - file.length / 10;
}

export function searchFiles(cwd: string, query: string, limit = 30): FileMatch[] {
  const wanted = query.toLowerCase().replace(/\\/g, "/").replace(/\s+/g, "");
  return indexOf(cwd)
    .map((entry) => ({ entry, score: score(wanted, entry.path) }))
    .filter((match) => match.score >= 0)
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit)
    .map((match) => match.entry);
}

/** `@path` or `@"path with spaces"`, at the start or after a space. */
const MENTION = /(?:^|\s)@(?:"([^"\n]{1,500})"|([^\s"]{1,500}))/g;

/** Mentioned text files up to this size go in whole, the way Claude Code includes them. */
const INLINE = 256 * 1024;

/**
 * The project files and folders a message mentions: small text files in full when the agent accepts embedded files,
 * everything else as a link it can open. Anything missing or outside the project is left as text.
 */
export function mentionLinks(cwd: string, text: string, caps?: { embeddedContext?: boolean }): acp.ContentBlock[] {
  const seen = new Set<string>();
  const links: acp.ContentBlock[] = [];
  for (const match of text.matchAll(MENTION)) {
    const raw = (match[1] ?? match[2]!.replace(/[.,;:!?)\]]+$/, "")).replace(/\\/g, "/");
    const full = path.resolve(cwd, raw);
    if ((full !== cwd && !full.startsWith(cwd + path.sep)) || seen.has(full) || !existsSync(full)) continue;
    seen.add(full);
    const stats = statSync(full);
    const uri = pathToFileURL(full).href;
    if (stats.isFile() && caps?.embeddedContext && stats.size <= INLINE) {
      const bytes = readFileSync(full);
      const body = bytes.includes(0) ? null : bytes.toString("utf8");
      if (body !== null && !body.includes("\uFFFD")) {
        links.push({ type: "resource", resource: { uri, mimeType: "text/plain", text: body } });
        if (links.length >= 20) break;
        continue;
      }
    }
    links.push({ type: "resource_link", uri, name: path.relative(cwd, full).replace(/\\/g, "/") || path.basename(full), ...(stats.isFile() ? { size: stats.size } : {}) });
    if (links.length >= 20) break;
  }
  return links;
}
