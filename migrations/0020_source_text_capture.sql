ALTER TABLE sources ADD COLUMN capture_mode TEXT NOT NULL DEFAULT 'metadata' CHECK(capture_mode IN ('metadata','text'));
