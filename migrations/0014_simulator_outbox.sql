-- A provider simulator reservation has no customer identity. Preserve prior delivery receipts.
ALTER TABLE email_outbox RENAME TO email_outbox_previous;
CREATE TABLE email_outbox (
 id TEXT PRIMARY KEY,
 user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
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
 provider_id TEXT
 ,UNIQUE(user_id,day)
);
INSERT INTO email_outbox SELECT * FROM email_outbox_previous;
DROP TABLE email_outbox_previous;
CREATE INDEX email_outbox_due ON email_outbox(status,available_at);
CREATE INDEX email_outbox_day ON email_outbox(day);
CREATE INDEX email_outbox_month ON email_outbox(month);
