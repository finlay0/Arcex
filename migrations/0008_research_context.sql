ALTER TABLE research_profiles ADD COLUMN discovery_json TEXT CHECK(discovery_json IS NULL OR json_valid(discovery_json));
ALTER TABLE research_profiles ADD COLUMN assessment_json TEXT CHECK(assessment_json IS NULL OR json_valid(assessment_json));
CREATE TABLE research_checkpoints (
 id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('discovery','qualification','monitoring','vault')),
 status TEXT NOT NULL CHECK(status IN ('running','partial','complete')),
 policy_version TEXT NOT NULL, state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
