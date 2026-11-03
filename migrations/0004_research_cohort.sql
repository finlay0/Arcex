CREATE TABLE research_profiles (
 product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
 maker_name TEXT NOT NULL, ownership_source_url TEXT NOT NULL,
 ownership_evidence TEXT NOT NULL, size_status TEXT NOT NULL CHECK(size_status IN ('solo','small_team','unverified')),
 current_size_evidence TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','excluded')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX research_review ON research_profiles(status,updated_at);
