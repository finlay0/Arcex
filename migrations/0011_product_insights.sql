ALTER TABLE products ADD COLUMN open_sample INTEGER NOT NULL DEFAULT 0 CHECK(open_sample IN (0,1));
ALTER TABLE products ADD COLUMN coverage_level TEXT NOT NULL DEFAULT 'signals' CHECK(coverage_level IN ('signals','full'));
ALTER TABLE products ADD COLUMN coverage_notes TEXT;
ALTER TABLE products ADD COLUMN coverage_reviewed_at TEXT;

CREATE TABLE vault_unlocks (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 day TEXT NOT NULL,
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL,
 PRIMARY KEY(user_id,day,product_id)
);

-- NULL means unknown: nothing was collected for that value. Zero means collected and none found.
CREATE TABLE product_metrics (
 product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
 observations INTEGER NOT NULL DEFAULT 0,
 step_count INTEGER NOT NULL DEFAULT 0,
 active_ads INTEGER,
 ads_delta_7d INTEGER,
 longest_ad_days INTEGER,
 creators INTEGER,
 sponsors INTEGER,
 creators_delta_7d INTEGER,
 activity_change_4w INTEGER,
 activity_weekly TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(activity_weekly)),
 first_seen TEXT,
 last_seen TEXT,
 updated_at TEXT NOT NULL
);
CREATE INDEX product_metrics_activity ON product_metrics(activity_change_4w);

CREATE TABLE metrics_refresh_state (
 id INTEGER PRIMARY KEY CHECK(id=1),
 cursor TEXT NOT NULL DEFAULT '',
 last_cycle_completed_at TEXT,
 updated_at TEXT NOT NULL
);

-- Manually entered ranges with their sources. Not a computed estimate.
CREATE TABLE revenue_ranges (
 product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
 low_usd INTEGER NOT NULL CHECK(low_usd >= 0),
 high_usd INTEGER NOT NULL,
 confidence INTEGER NOT NULL CHECK(confidence BETWEEN 1 AND 4),
 method_version TEXT NOT NULL,
 inputs TEXT NOT NULL CHECK(json_valid(inputs)),
 evidence_ids TEXT NOT NULL CHECK(json_valid(evidence_ids)),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 updated_at TEXT NOT NULL,
 CHECK(high_usd >= low_usd)
);
CREATE TABLE revenue_range_history (
 id TEXT PRIMARY KEY,
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 low_usd INTEGER NOT NULL,
 high_usd INTEGER NOT NULL,
 confidence INTEGER NOT NULL,
 method_version TEXT NOT NULL,
 inputs TEXT NOT NULL CHECK(json_valid(inputs)),
 evidence_ids TEXT NOT NULL CHECK(json_valid(evidence_ids)),
 status TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX revenue_range_history_product ON revenue_range_history(product_id,created_at);

CREATE TABLE product_changes (
 id TEXT PRIMARY KEY,
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 evidence_id TEXT NOT NULL REFERENCES evidence(id),
 kind TEXT NOT NULL CHECK(kind IN ('ads','creators','paywall','flow')),
 summary TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 created_at TEXT NOT NULL
);
CREATE INDEX product_changes_feed ON product_changes(status,observed_at);
CREATE INDEX product_changes_product ON product_changes(product_id,status,observed_at);

CREATE TABLE product_watches (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL,
 PRIMARY KEY(user_id,product_id)
);

CREATE TABLE user_products (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 url TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(user_id,url)
);

CREATE TABLE alert_settings (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 email_alerts INTEGER NOT NULL DEFAULT 0 CHECK(email_alerts IN (0,1)),
 updated_at TEXT NOT NULL
);

CREATE TABLE breakdown_requests (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL,
 PRIMARY KEY(user_id,product_id)
);
CREATE INDEX breakdown_requests_product ON breakdown_requests(product_id);
