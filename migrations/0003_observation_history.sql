-- Content deduplicates independently from sightings, so repeated daily observations retain their dates.
CREATE TABLE evidence_observations (
 evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
 observed_at TEXT NOT NULL, job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
 PRIMARY KEY(evidence_id,observed_at)
);
CREATE INDEX observation_dates ON evidence_observations(observed_at);
CREATE UNIQUE INDEX evidence_identity ON evidence(COALESCE(product_id,''),source_url,content_hash);
INSERT INTO evidence_observations(evidence_id,observed_at) SELECT id,observed_at FROM evidence;
ALTER TABLE subscriptions ADD COLUMN subscription_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN last_event_created INTEGER NOT NULL DEFAULT 0;
CREATE TABLE checkout_attempts (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bucket INTEGER NOT NULL, suffix TEXT NOT NULL,
 PRIMARY KEY(user_id,bucket)
);
