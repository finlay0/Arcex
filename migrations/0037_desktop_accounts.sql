CREATE TABLE desktop_links (
  device_hash TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  next_poll_at TEXT NOT NULL
);
CREATE INDEX desktop_links_expiry ON desktop_links(expires_at);
CREATE INDEX desktop_links_user ON desktop_links(user_id);

CREATE TABLE desktop_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX desktop_sessions_user ON desktop_sessions(user_id);
CREATE INDEX desktop_sessions_expiry ON desktop_sessions(expires_at);
