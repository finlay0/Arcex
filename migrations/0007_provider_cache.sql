CREATE TABLE provider_cache (
 cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)),
 expires_at TEXT NOT NULL
);
