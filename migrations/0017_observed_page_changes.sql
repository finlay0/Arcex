-- A source retains its baseline even after terminal jobs are pruned.
ALTER TABLE sources ADD COLUMN last_evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL;

CREATE TABLE product_changes_next (
 id TEXT PRIMARY KEY,
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 evidence_id TEXT NOT NULL REFERENCES evidence(id),
 kind TEXT NOT NULL CHECK(kind IN ('ads','creators','paywall','flow','public_page')),
 summary TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 created_at TEXT NOT NULL,
 published_at TEXT,
 previous_evidence_id TEXT REFERENCES evidence(id),
 source_id TEXT REFERENCES sources(id) ON DELETE SET NULL
);
INSERT INTO product_changes_next(id,product_id,evidence_id,kind,summary,observed_at,status,created_at,published_at)
 SELECT id,product_id,evidence_id,kind,summary,observed_at,status,created_at,published_at FROM product_changes;
DROP TABLE product_changes;
ALTER TABLE product_changes_next RENAME TO product_changes;
CREATE INDEX product_changes_feed ON product_changes(status,observed_at);
CREATE INDEX product_changes_product ON product_changes(product_id,status,observed_at);
CREATE INDEX product_changes_published ON product_changes(product_id,status,published_at,id);
