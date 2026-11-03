CREATE TABLE billing_holds (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 reason TEXT NOT NULL, event_id TEXT NOT NULL, created_at TEXT NOT NULL
);
