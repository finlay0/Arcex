import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HookEntry, SkillEntry } from "@arcex/contracts";

/** Where each agent looks for skills: folders holding one folder per skill, each with a SKILL.md. */
const PLACES: { agent: string; dir: string; scope: "project" | "personal" }[] = [
  { agent: "Claude", dir: ".claude/skills", scope: "project" },
  { agent: "Codex", dir: ".agents/skills", scope: "project" },
  { agent: "Gemini", dir: ".gemini/skills", scope: "project" },
  { agent: "OpenCode", dir: ".opencode/skills", scope: "project" },
  { agent: "OpenCode", dir: ".opencode/skill", scope: "project" },
  { agent: "Claude", dir: ".claude/skills", scope: "personal" },
  { agent: "Codex", dir: ".agents/skills", scope: "personal" },
  { agent: "Codex", dir: ".codex/skills", scope: "personal" },
  { agent: "Gemini", dir: ".gemini/skills", scope: "personal" },
  { agent: "OpenCode", dir: ".config/opencode/skills", scope: "personal" },
  { agent: "OpenCode", dir: ".config/opencode/skill", scope: "personal" },
];

/** A turned-off skill keeps its folder; only its SKILL.md is renamed, so agents skip it and turning it on restores it. */
const ON = "SKILL.md";
const OFF = "SKILL.md.off";
const MAX_SKILLS = 200;

/** The `name` and `description` from a SKILL.md's front matter. */
function frontMatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const lines = match[1]!.split(/\r?\n/);
  const field = (key: string) => {
    const at = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (at === -1) return undefined;
    let value = lines[at]!.slice(key.length + 1).trim();
    // A YAML block (">" or "|") continues on the indented lines below.
    if (/^[>|][+-]?$/.test(value)) {
      const rest: string[] = [];
      for (const line of lines.slice(at + 1)) {
        if (line.trim() && !/^\s/.test(line)) break;
        rest.push(line.trim());
      }
      value = rest.join(" ").replace(/\s+/g, " ").trim();
    }
    return value ? value.replace(/^["']|["']$/g, "").slice(0, 400) : undefined;
  };
  return { name: field("name"), description: field("description") };
}

export async function listSkills(cwd: string): Promise<SkillEntry[]> {
  const home = os.homedir();
  const found: SkillEntry[] = [];
  const seen = new Set<string>();
  for (const place of PLACES) {
    const root = path.join(place.scope === "project" ? cwd : home, place.dir);
    if (!existsSync(root) || seen.has(root.toLowerCase())) continue;
    seen.add(root.toLowerCase());
    let names: string[] = [];
    try {
      names = readdirSync(root).filter((name) => !name.startsWith("."));
    } catch {
      continue;
    }
    for (const folder of names) {
      if (found.length >= MAX_SKILLS) return found;
      const dir = path.join(root, folder);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const enabled = existsSync(path.join(dir, ON));
      if (!enabled && !existsSync(path.join(dir, OFF))) continue;
      const text = await readFile(path.join(dir, enabled ? ON : OFF), "utf8").catch(() => "");
      const meta = frontMatter(text.slice(0, 8000));
      found.push({
        path: dir,
        relative: place.scope === "project" ? path.relative(cwd, path.join(dir, enabled ? ON : OFF)).replaceAll("\\", "/") : null,
        name: meta.name || folder,
        description: meta.description ?? "",
        agent: place.agent,
        scope: place.scope,
        enabled,
      });
    }
  }
  return found;
}

/** Turns a listed skill on or off. Only folders `listSkills` reports can change. */
export async function toggleSkill(cwd: string, dir: string, enabled: boolean): Promise<SkillEntry[]> {
  const skills = await listSkills(cwd);
  const skill = skills.find((entry) => entry.path === dir);
  if (!skill) throw new Error("that skill is no longer there");
  if (skill.enabled !== enabled) {
    const [from, to] = enabled ? [OFF, ON] : [ON, OFF];
    if (existsSync(path.join(dir, to))) throw new Error(`${to} already exists in that skill's folder`);
    await rename(path.join(dir, from), path.join(dir, to));
  }
  return listSkills(cwd);
}

/** Claude Code hooks from the project's and the user's settings files, read only. */
export async function listHooks(cwd: string): Promise<HookEntry[]> {
  const files: { file: string; scope: "project" | "personal" }[] = [
    { file: path.join(cwd, ".claude", "settings.json"), scope: "project" },
    { file: path.join(cwd, ".claude", "settings.local.json"), scope: "project" },
    { file: path.join(os.homedir(), ".claude", "settings.json"), scope: "personal" },
  ];
  const hooks: HookEntry[] = [];
  for (const { file, scope } of files) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (!text) continue;
    let parsed: { hooks?: Record<string, { matcher?: string; hooks?: { type?: string; command?: string; prompt?: string }[] }[]>; disableAllHooks?: boolean };
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
          if (hooks.length >= 100) return hooks;
          hooks.push({
            event,
            matcher: typeof group.matcher === "string" ? group.matcher.slice(0, 200) : "",
            run: String(hook.command ?? hook.prompt ?? hook.type ?? "").slice(0, 400),
            agent: "Claude",
            scope,
            file: scope === "project" ? path.relative(cwd, file).replaceAll("\\", "/") : file,
            off: parsed.disableAllHooks === true,
          });
        }
      }
    }
  }
  return hooks;
}
