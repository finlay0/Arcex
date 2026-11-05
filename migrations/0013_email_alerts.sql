ALTER TABLE product_changes ADD COLUMN published_at TEXT;
CREATE INDEX product_changes_published ON product_changes(product_id,status,published_at,id);
ALTER TABLE alert_settings ADD COLUMN last_change_at TEXT;
ALTER TABLE alert_settings ADD COLUMN last_change_id TEXT;
ALTER TABLE alert_settings ADD COLUMN last_sent_at TEXT;
CREATE TABLE email_outbox (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 day TEXT NOT NULL,
 month TEXT NOT NULL,
 envelope TEXT NOT NULL CHECK(json_valid(envelope)),
 change_ids TEXT NOT NULL CHECK(json_valid(change_ids)),
 cursor_at TEXT NOT NULL,
 cursor_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','cancelled','uncertain')),
 attempts INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 available_at TEXT NOT NULL,
 lease_until TEXT,
 lease_token TEXT,
 last_error TEXT,
 provider_id TEXT,
 UNIQUE(user_id,day)
);
CREATE INDEX email_outbox_due ON email_outbox(status,available_at);
CREATE INDEX email_outbox_day ON email_outbox(day);
CREATE INDEX email_outbox_month ON email_outbox(month);
