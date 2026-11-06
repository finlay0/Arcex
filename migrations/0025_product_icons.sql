-- One small square brand icon per product, fetched from the product's own site by code.
-- Stored in D1 (a few KB each) so it does not consume the 50 MB private evidence allowance.
CREATE TABLE product_icons (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('ok','missing')),
  data TEXT,
  sha256 TEXT,
  size INTEGER NOT NULL DEFAULT 0 CHECK(size>=0 AND size<=12000),
  source_url TEXT,
  reason TEXT,
  checked_at TEXT NOT NULL,
  CHECK((status='ok' AND data IS NOT NULL AND sha256 IS NOT NULL AND source_url IS NOT NULL AND size>0) OR (status='missing' AND data IS NULL))
);
CREATE INDEX product_icons_checked ON product_icons(checked_at);
