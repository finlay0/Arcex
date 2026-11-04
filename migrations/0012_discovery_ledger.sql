-- Keeps rejected and ambiguous leads out of repeated discovery work as well as accepted products.
CREATE TABLE discovery_leads (
 source_url TEXT PRIMARY KEY,
 domain TEXT NOT NULL,
 discovery_source TEXT NOT NULL,
 proposed_name TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('candidate','reference','out_of_scope','duplicate_or_feature','unclear')),
 rationale TEXT NOT NULL,
 next_check TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 primary_metadata TEXT NOT NULL CHECK(json_valid(primary_metadata)),
 model TEXT NOT NULL,
 policy_version TEXT NOT NULL,
 first_recorded_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX discovery_leads_domain ON discovery_leads(domain,updated_at);
