ALTER TABLE assets ADD COLUMN thumbnail_key TEXT;
ALTER TABLE assets ADD COLUMN thumbnail_size INTEGER NOT NULL DEFAULT 0 CHECK(thumbnail_size>=0);
ALTER TABLE assets ADD COLUMN thumbnail_sha256 TEXT;
