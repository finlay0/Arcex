-- One-time upload links so a cloud worker sends capture files directly, never through model output.
CREATE TABLE capture_uploads (
  token_hash TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK(content_type IN ('image/png','image/jpeg','image/webp')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX capture_uploads_expiry ON capture_uploads(expires_at);
