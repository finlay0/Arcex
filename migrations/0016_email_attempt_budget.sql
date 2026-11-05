-- Budget counters have no recipient FK: account deletion cannot reopen sending capacity.
CREATE TABLE email_send_usage (
 period_key TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0)
);
-- Conservatively include any attempts that predate this accounting migration.
INSERT INTO email_send_usage SELECT 'day:'||day,sum(attempts) FROM email_outbox GROUP BY day;
INSERT INTO email_send_usage SELECT 'month:'||month,sum(attempts) FROM email_outbox GROUP BY month;
ALTER TABLE email_outbox ADD COLUMN first_attempt_at TEXT;
UPDATE email_outbox SET first_attempt_at=created_at WHERE attempts>0;
CREATE UNIQUE INDEX email_outbox_active_user ON email_outbox(user_id) WHERE user_id IS NOT NULL AND status IN ('pending','sending','uncertain');
