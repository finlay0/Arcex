import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Item, Project, Thread } from "@arcex/contracts";

export type ThreadRow = Thread & { sessionId: string | null };

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
  `);

  const project = (row: Record<string, unknown>): Project => ({
    id: row.id as string,
    name: row.name as string,
    goal: row.goal as string,
    cwd: row.cwd as string,
    previewUrl: (row.preview_url as string | null) ?? null,
    createdAt: row.created_at as number,
  });
  // Nothing is running when the engine starts, so every saved thread comes back idle.
  const thread = (row: Record<string, unknown>): ThreadRow => ({
    id: row.id as string,
    projectId: row.project_id as string,
    provider: row.provider as Thread["provider"],
    title: row.title as string,
    state: "idle",
    sessionId: (row.session_id as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  });

  const nextSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM items WHERE thread_id = ?");
  const upsertItem = db.prepare(
    "INSERT INTO items (thread_id, id, seq, json) VALUES (?, ?, ?, ?) ON CONFLICT (thread_id, id) DO UPDATE SET json = excluded.json",
  );

  return {
    projects: () => db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all().map(project),
    insertProject(p: Project) {
      db.prepare("INSERT INTO projects (id, name, goal, cwd, preview_url, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        p.id, p.name, p.goal, p.cwd, p.previewUrl, p.createdAt,
      );
    },
    setPreview(id: string, url: string | null) {
      db.prepare("UPDATE projects SET preview_url = ? WHERE id = ?").run(url, id);
    },
    threads: () => db.prepare("SELECT * FROM threads ORDER BY created_at").all().map(thread),
    insertThread(t: ThreadRow) {
      db.prepare(
        "INSERT INTO threads (id, project_id, provider, title, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(t.id, t.projectId, t.provider, t.title, t.sessionId, t.createdAt, t.updatedAt);
    },
    touchThread(t: ThreadRow) {
      db.prepare("UPDATE threads SET session_id = ?, updated_at = ? WHERE id = ?").run(t.sessionId, t.updatedAt, t.id);
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
