CREATE TABLE distribution_watches_next (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 platform TEXT NOT NULL CHECK(platform IN ('meta','youtube','x','google')),
 country TEXT NOT NULL, query TEXT NOT NULL, search_url TEXT NOT NULL,
 created_at TEXT NOT NULL, UNIQUE(product_id,platform,country)
);
CREATE TABLE distribution_scans_next (
 id TEXT PRIMARY KEY, watch_id TEXT NOT NULL REFERENCES distribution_watches_next(id) ON DELETE CASCADE,
 observed_at TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('observed','no_results','blocked','failed')),
 evidence_id TEXT NOT NULL REFERENCES evidence(id), notes TEXT NOT NULL,
 created_at TEXT NOT NULL, UNIQUE(watch_id,observed_at)
);
INSERT INTO distribution_watches_next SELECT * FROM distribution_watches;
INSERT INTO distribution_scans_next SELECT * FROM distribution_scans;
DROP TABLE distribution_scans;
DROP TABLE distribution_watches;
ALTER TABLE distribution_watches_next RENAME TO distribution_watches;
ALTER TABLE distribution_scans_next RENAME TO distribution_scans;
CREATE INDEX distribution_scans_watch ON distribution_scans(watch_id,observed_at);
