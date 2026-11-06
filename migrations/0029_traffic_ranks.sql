-- Daily public popularity rank per product site (Tranco top-1M list). rank NULL means
-- the site was not in the top million that day. It is an observation, not traffic volume.
CREATE TABLE traffic_ranks (
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 source TEXT NOT NULL CHECK(source IN ('tranco')),
 observed_on TEXT NOT NULL CHECK(length(observed_on)=10),
 site TEXT NOT NULL,
 rank INTEGER CHECK(rank IS NULL OR rank BETWEEN 1 AND 1000000),
 list_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(product_id, source, observed_on)
);
CREATE INDEX traffic_ranks_day ON traffic_ranks(source, observed_on);
