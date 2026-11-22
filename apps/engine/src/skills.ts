import { existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

type Hook = Record<string, unknown> & { type?: string; command?: string; prompt?: string };
type Group = { matcher?: string; hooks?: Hook[] };
type SettingsFile = { hooks?: Record<string, Group[]>; disableAllHooks?: boolean } & Record<string, unknown>;
/** A hook the user turned off: where it lived and the hook itself, ready to go back. */
type Parked = { id: string; file: string; event: string; matcher: string; hook: Hook };

function hookFiles(cwd: string): { file: string; scope: "project" | "personal" }[] {
  return [
    { file: path.join(cwd, ".claude", "settings.json"), scope: "project" },
    { file: path.join(cwd, ".claude", "settings.local.json"), scope: "project" },
    { file: path.join(os.homedir(), ".claude", "settings.json"), scope: "personal" },
  ];
}

const hookId = (file: string, event: string, matcher: string, hook: Hook) =>
  createHash("sha256").update(JSON.stringify([path.resolve(file).toLowerCase(), event, matcher, hook])).digest("hex").slice(0, 16);

async function readSettings(file: string): Promise<SettingsFile | null> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SettingsFile) : null;
  } catch {
    return null;
  }
}

const parkedFile = (dataDir: string) => path.join(dataDir, "hooks-off.json");
async function readParked(dataDir: string): Promise<Parked[]> {
  const text = await readFile(parkedFile(dataDir), "utf8").catch(() => "[]");
  try {
    const list = JSON.parse(text) as unknown;
    return Array.isArray(list) ? (list as Parked[]) : [];
  } catch {
    return [];
  }
}
async function writeParked(dataDir: string, list: Parked[]) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(parkedFile(dataDir), JSON.stringify(list, null, 2));
}

/** Claude Code hooks from the project's and the user's settings files, with the ones turned off in Arcex. */
export async function listHooks(cwd: string, dataDir: string): Promise<HookEntry[]> {
  const parked = await readParked(dataDir);
  const hooks: HookEntry[] = [];
  for (const { file, scope } of hookFiles(cwd)) {
    const parsed = await readSettings(file);
    const shown = scope === "project" ? path.relative(cwd, file).replaceAll("\\", "/") : file;
    const entry = (event: string, matcher: string, hook: Hook, enabled: boolean, id: string): HookEntry => ({
      id,
      event,
      matcher: matcher.slice(0, 200),
      run: String(hook.command ?? hook.prompt ?? hook.type ?? "").slice(0, 400),
      agent: "Claude",
      scope,
      file: shown,
      off: parsed?.disableAllHooks === true,
      enabled,
    });
    for (const [event, groups] of Object.entries(parsed?.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const matcher = typeof group?.matcher === "string" ? group.matcher : "";
        for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
          if (hooks.length >= 100) return hooks;
          if (hook && typeof hook === "object") hooks.push(entry(event, matcher, hook, true, hookId(file, event, matcher, hook)));
        }
      }
    }
    for (const kept of parked) {
      if (hooks.length < 100 && path.resolve(kept.file).toLowerCase() === path.resolve(file).toLowerCase()) hooks.push(entry(kept.event, kept.matcher, kept.hook, false, kept.id));
    }
  }
  return hooks;
}

/**
 * Turns one hook off by taking it out of its settings file (kept aside in Arcex's data folder), or back on by putting it
 * back under its event and matcher. Claude Code has no switch for a single hook, so this is how one stays off.
 */
export async function toggleHook(cwd: string, dataDir: string, id: string, enabled: boolean): Promise<HookEntry[]> {
  const parked = await readParked(dataDir);
  const files = hookFiles(cwd).map((entry) => entry.file);
  if (enabled) {
    const kept = parked.find((entry) => entry.id === id && files.some((file) => path.resolve(file).toLowerCase() === path.resolve(entry.file).toLowerCase()));
    if (!kept) return listHooks(cwd, dataDir);
    const parsed = (await readSettings(kept.file)) ?? {};
    const hooks = (parsed.hooks && typeof parsed.hooks === "object" ? parsed.hooks : {}) as Record<string, Group[]>;
    const groups = Array.isArray(hooks[kept.event]) ? hooks[kept.event]! : [];
    const group = groups.find((entry) => (entry?.matcher ?? "") === kept.matcher);
    if (group) group.hooks = [...(Array.isArray(group.hooks) ? group.hooks : []), kept.hook];
    else groups.push({ ...(kept.matcher ? { matcher: kept.matcher } : {}), hooks: [kept.hook] });
    hooks[kept.event] = groups;
    parsed.hooks = hooks;
    await mkdir(path.dirname(kept.file), { recursive: true });
    await writeFile(kept.file, `${JSON.stringify(parsed, null, 2)}\n`);
    await writeParked(dataDir, parked.filter((entry) => entry !== kept));
    return listHooks(cwd, dataDir);
  }
  for (const file of files) {
    const parsed = await readSettings(file);
    for (const [event, groups] of Object.entries(parsed?.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const matcher = typeof group?.matcher === "string" ? group.matcher : "";
        const list = Array.isArray(group?.hooks) ? group.hooks : [];
        const at = list.findIndex((hook) => hook && typeof hook === "object" && hookId(file, event, matcher, hook) === id);
        if (at < 0) continue;
        const [hook] = list.splice(at, 1);
        // Park it first, so a failed write to the settings file can't lose it.
        await writeParked(dataDir, [...parked, { id, file: path.resolve(file), event, matcher, hook: hook! }]);
        const remaining = groups.filter((entry) => !Array.isArray(entry?.hooks) || entry.hooks.length > 0);
        if (remaining.length) parsed!.hooks![event] = remaining;
        else delete parsed!.hooks![event];
        if (!Object.keys(parsed!.hooks!).length) delete parsed!.hooks;
        await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`);
        return listHooks(cwd, dataDir);
      }
    }
  }
  throw new Error("that hook changed in its settings file. Look again and retry");
}
