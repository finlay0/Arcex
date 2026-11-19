import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Item, Project, Settings, Thread } from "@arcex/contracts";

export type ThreadRow = Thread & { sessionId: string | null };

export const DEFAULT_SETTINGS: Settings = { name: "", theme: "dark", defaultProvider: "claude", sendWith: "enter", defaultModel: null, agents: [], showDetails: true, notify: true, research: false };

export function openDb(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "arcex.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL, cwd TEXT NOT NULL,
      preview_url TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), provider TEXT NOT NULL,
      title TEXT NOT NULL, session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
      thread_id TEXT NOT NULL REFERENCES threads(id), id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (thread_id, id)
    );
    CREATE INDEX IF NOT EXISTS items_by_thread ON items (thread_id, seq);
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts (
      project_id TEXT NOT NULL REFERENCES projects(id), thread_id TEXT NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY (project_id, thread_id)
    );
  `);
  // Added after the first build. Older databases get the column here.
  const columns = db.prepare("PRAGMA table_info(threads)").all().map((row) => row.name);
  if (!columns.includes("archived")) db.exec("ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  if (!columns.includes("model")) db.exec("ALTER TABLE threads ADD COLUMN model TEXT");
  if (!columns.includes("state")) db.exec("ALTER TABLE threads ADD COLUMN state TEXT NOT NULL DEFAULT 'idle'");
  db.exec("UPDATE threads SET state = 'interrupted' WHERE state IN ('starting', 'working', 'needs_you', 'stopping')");

  const project = (row: Record<string, unknown>): Project => ({
    id: row.id as string,
    name: row.name as string,
    goal: row.goal as string,
    cwd: row.cwd as string,
    previewUrl: (row.preview_url as string | null) ?? null,
    createdAt: row.created_at as number,
  });
  const thread = (row: Record<string, unknown>): ThreadRow => ({
    id: row.id as string,
    projectId: row.project_id as string,
    provider: row.provider as Thread["provider"],
    model: row.model ? (JSON.parse(row.model as string) as Thread["model"]) : null,
    title: row.title as string,
    state: row.state as Thread["state"],
    archived: row.archived === 1,
    sessionId: (row.session_id as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  });

  const nextSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM items WHERE thread_id = ?");
  const upsertItem = db.prepare(
    "INSERT INTO items (thread_id, id, seq, json) VALUES (?, ?, ?, ?) ON CONFLICT (thread_id, id) DO UPDATE SET json = excluded.json",
  );

  return {
    close: () => db.close(),
    drafts: () => Object.fromEntries(db.prepare("SELECT * FROM drafts").all().map((row) => [row.thread_id || row.project_id, row.text as string])),
    saveDraft(projectId: string, threadId: string, text: string) {
      if (text) db.prepare("INSERT INTO drafts VALUES (?, ?, ?) ON CONFLICT(project_id, thread_id) DO UPDATE SET text = excluded.text").run(projectId, threadId, text);
      else db.prepare("DELETE FROM drafts WHERE project_id = ? AND thread_id = ?").run(projectId, threadId);
    },
    clearSentDraft(projectId: string, threadId: string, sent: string) {
      db.prepare("DELETE FROM drafts WHERE project_id = ? AND thread_id = ? AND text = ?").run(projectId, threadId, sent);
    },
    settings(): Settings {
      const row = db.prepare("SELECT json FROM settings WHERE id = 1").get();
      return { ...DEFAULT_SETTINGS, ...(row ? (JSON.parse(row.json as string) as Partial<Settings>) : {}) };
    },
    saveSettings(settings: Settings) {
      db.prepare("INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json").run(JSON.stringify(settings));
    },
    projects: () => db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all().map(project),
    insertProject(p: Project) {
      db.prepare("INSERT INTO projects (id, name, goal, cwd, preview_url, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        p.id, p.name, p.goal, p.cwd, p.previewUrl, p.createdAt,
      );
    },
    saveProject(p: Project) {
      db.prepare("UPDATE projects SET name = ?, goal = ?, preview_url = ? WHERE id = ?").run(p.name, p.goal, p.previewUrl, p.id);
    },
    removeProject(id: string) {
      db.prepare("DELETE FROM drafts WHERE project_id = ?").run(id);
      db.prepare("DELETE FROM items WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ?)").run(id);
      db.prepare("DELETE FROM threads WHERE project_id = ?").run(id);
      db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    },
    threads: () => db.prepare("SELECT * FROM threads ORDER BY created_at").all().map(thread),
    insertThread(t: ThreadRow) {
      db.prepare(
        "INSERT INTO threads (id, project_id, provider, model, title, session_id, created_at, updated_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(t.id, t.projectId, t.provider, t.model ? JSON.stringify(t.model) : null, t.title, t.sessionId, t.createdAt, t.updatedAt, t.state);
    },
    saveThread(t: ThreadRow) {
      db.prepare("UPDATE threads SET title = ?, archived = ?, model = ?, session_id = ?, updated_at = ?, state = ? WHERE id = ?").run(
        t.title, t.archived ? 1 : 0, t.model ? JSON.stringify(t.model) : null, t.sessionId, t.updatedAt, t.state, t.id,
      );
    },
    removeThread(id: string) {
      db.prepare("DELETE FROM drafts WHERE thread_id = ?").run(id);
      db.prepare("DELETE FROM items WHERE thread_id = ?").run(id);
      db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    },
    items: (threadId: string) =>
      db.prepare("SELECT json FROM items WHERE thread_id = ? ORDER BY seq").all(threadId)
        .map((row) => JSON.parse(row.json as string) as Item),
    saveItem(threadId: string, item: Item) {
      const { seq } = nextSeq.get(threadId) as { seq: number };
      upsertItem.run(threadId, item.id, seq, JSON.stringify(item));
    },
  };
}

export type Db = ReturnType<typeof openDb>;
