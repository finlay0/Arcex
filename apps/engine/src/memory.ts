import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMemory, MemoryNote } from "@arcex/contracts";

const MAX = 200_000;

/** Each agent's personal instructions file, which it reads in every project. Only these paths can be written. */
const PERSONAL: { agent: string; file: string }[] = [
  { agent: "Claude", file: path.join(".claude", "CLAUDE.md") },
  { agent: "Codex", file: path.join(".codex", "AGENTS.md") },
  { agent: "Gemini", file: path.join(".gemini", "GEMINI.md") },
];

export async function personalMemory(): Promise<AgentMemory[]> {
  const home = os.homedir();
  return Promise.all(
    PERSONAL.map(async ({ agent, file }) => ({
      agent,
      path: path.join(home, file),
      text: await readFile(path.join(home, file), "utf8").then((text) => text.slice(0, MAX)).catch(() => null),
      // An agent whose settings folder is missing isn't set up here, so there's nothing to write for it yet.
      available: existsSync(path.join(home, path.dirname(file))),
    })),
  );
}

export async function savePersonalMemory(agent: string, text: string): Promise<void> {
  const entry = PERSONAL.find((item) => item.agent === agent);
  if (!entry) throw new Error("that agent has no personal instructions file");
  if (typeof text !== "string" || text.length > MAX) throw new Error("instructions can be at most 200,000 characters");
  const target = path.join(os.homedir(), entry.file);
  await mkdir(path.dirname(target), { recursive: true });
  const clean = text.replace(/\r\n/g, "\n");
  await writeFile(target, clean.endsWith("\n") || !clean ? clean : `${clean}\n`, "utf8");
}

/**
 * Notes Claude Code saved for itself about a project (its auto memory), read only. Claude keeps them in a folder
 * named after the project path under ~/.claude/projects.
 */
export async function claudeNotes(cwd: string): Promise<MemoryNote[]> {
  const slug = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
  const root = path.join(os.homedir(), ".claude", "projects");
  let folder: string | null = null;
  try {
    folder = readdirSync(root).find((name) => name.toLowerCase() === slug.toLowerCase()) ?? null;
  } catch {
    return [];
  }
  if (!folder) return [];
  const dir = path.join(root, folder, "memory");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".md")).slice(0, 100);
  } catch {
    return [];
  }
  const notes: MemoryNote[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const text = await readFile(file, "utf8").catch(() => "");
    notes.push({ name, text: text.slice(0, 20_000), changed: statSync(file).mtimeMs });
  }
  // The index first, then newest.
  return notes.sort((a, b) => Number(b.name === "MEMORY.md") - Number(a.name === "MEMORY.md") || b.changed - a.changed);
}
