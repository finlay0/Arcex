CREATE TABLE pricing_snapshots (
 id TEXT PRIMARY KEY,
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 evidence_ids TEXT NOT NULL CHECK(json_valid(evidence_ids)),
 offers TEXT NOT NULL CHECK(json_valid(offers)),
 observed_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 created_at TEXT NOT NULL
);
CREATE INDEX pricing_snapshots_product ON pricing_snapshots(product_id,status,observed_at);
