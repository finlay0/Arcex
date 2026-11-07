-- Code-only screenshot runs (homepage and pricing, desktop and mobile). One row per
-- product records the last attempt so blocked sites are not retried every run.
CREATE TABLE capture_checks (
 product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('ok','failed')),
 reason TEXT CHECK(reason IS NULL OR length(reason)<=300),
 captured INTEGER NOT NULL DEFAULT 0,
 checked_at TEXT NOT NULL
);
