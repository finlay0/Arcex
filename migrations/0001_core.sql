PRAGMA foreign_keys = ON;

CREATE TABLE users (
 id TEXT PRIMARY KEY, handle TEXT NOT NULL, name TEXT NOT NULL, email TEXT,
 avatar_url TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE identities (
 provider TEXT NOT NULL CHECK(provider IN ('github','x','development')), provider_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(provider,provider_id)
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE oauth_states (
 state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE subscriptions (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 customer_id TEXT UNIQUE, subscription_id TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'inactive', price_id TEXT, period_end TEXT,
 updated_at TEXT NOT NULL
);
CREATE TABLE webhook_receipts (id TEXT PRIMARY KEY, processed_at TEXT NOT NULL);
CREATE TABLE api_keys (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL,
 revoked_at TEXT, last_used_at TEXT
);
CREATE INDEX keys_user ON api_keys(user_id);

CREATE TABLE products (
 id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
 url TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
 category TEXT NOT NULL, monetization TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX products_browse ON products(status,category,monetization,updated_at);
CREATE TABLE evidence (
 id TEXT PRIMARY KEY, product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
 source_url TEXT NOT NULL, observed_at TEXT NOT NULL, kind TEXT NOT NULL,
 content_hash TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','rejected')),
 created_at TEXT NOT NULL, UNIQUE(product_id,source_url,content_hash)
);
CREATE INDEX evidence_product ON evidence(product_id,status,observed_at);
CREATE TABLE assets (
 id TEXT PRIMARY KEY, evidence_id TEXT REFERENCES evidence(id) ON DELETE CASCADE,
 object_key TEXT UNIQUE NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL,
 sha256 TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN (0,1)),
 created_at TEXT NOT NULL
);
CREATE TABLE distribution_signals (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 evidence_id TEXT NOT NULL REFERENCES evidence(id), kind TEXT NOT NULL CHECK(kind IN ('ad_observed','creator_mention','launch','public_page')),
 external_id TEXT NOT NULL, observed_at TEXT NOT NULL, source_url TEXT NOT NULL,
 detail TEXT NOT NULL CHECK(json_valid(detail)), UNIQUE(product_id,kind,external_id,observed_at)
);
CREATE INDEX signals_product ON distribution_signals(product_id,kind,observed_at);
CREATE TABLE funnel_steps (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(position >= 0), title TEXT NOT NULL, stage TEXT NOT NULL,
 annotation TEXT NOT NULL, evidence_id TEXT NOT NULL REFERENCES evidence(id),
 asset_id TEXT REFERENCES assets(id), UNIQUE(product_id,position)
);
CREATE TABLE paywall_mechanics (
 product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
 evidence_id TEXT NOT NULL REFERENCES evidence(id), pattern TEXT NOT NULL,
 states TEXT NOT NULL CHECK(json_valid(states)), transitions TEXT NOT NULL CHECK(json_valid(transitions)),
 credit_rules TEXT NOT NULL CHECK(json_valid(credit_rules)), notes TEXT NOT NULL
);
CREATE TABLE agent_blueprints (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(version > 0), title TEXT NOT NULL,
 spec TEXT NOT NULL CHECK(json_valid(spec)),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
 created_at TEXT NOT NULL, UNIQUE(product_id,version)
);
CREATE TABLE partners (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
 relationship TEXT NOT NULL CHECK(relationship IN ('affiliate','sponsor','independent')),
 disclosure TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE blueprint_partners (
 blueprint_id TEXT NOT NULL REFERENCES agent_blueprints(id) ON DELETE CASCADE,
 partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, role TEXT NOT NULL,
 PRIMARY KEY(blueprint_id,partner_id,role)
);
CREATE TABLE arena_builds (
 id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL,
 model TEXT NOT NULL, prompt TEXT NOT NULL, repository_url TEXT, demo_url TEXT,
 benchmark TEXT NOT NULL CHECK(json_valid(benchmark)), rating REAL CHECK(rating BETWEEN 0 AND 10),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX arena_browse ON arena_builds(status,created_at);
CREATE TABLE arena_votes (
 build_id TEXT NOT NULL REFERENCES arena_builds(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, PRIMARY KEY(build_id,user_id)
);
CREATE TABLE ship_submissions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, url TEXT NOT NULL, description TEXT NOT NULL,
 stack TEXT NOT NULL CHECK(json_valid(stack)), monetization TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','reviewed')),
 review_url TEXT, reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX ship_browse ON ship_submissions(status,created_at);
CREATE INDEX ship_owner ON ship_submissions(user_id,created_at);
CREATE TABLE ship_votes (
 submission_id TEXT NOT NULL REFERENCES ship_submissions(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, PRIMARY KEY(submission_id,user_id)
);
CREATE TABLE user_saves (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, PRIMARY KEY(user_id,product_id)
);
CREATE TABLE collections (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX collections_owner ON collections(user_id);
CREATE TABLE collection_items (
 collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 PRIMARY KEY(collection_id,product_id)
);
CREATE TABLE sources (
 id TEXT PRIMARY KEY, product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
 name TEXT NOT NULL, url TEXT UNIQUE NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('public_page','rss','browser')),
 interval_hours INTEGER NOT NULL DEFAULT 24 CHECK(interval_hours BETWEEN 1 AND 720),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 next_run_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX sources_due ON sources(enabled,next_run_at);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 dedupe_key TEXT UNIQUE NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
 available_at TEXT NOT NULL, lease_token TEXT, lease_expires_at TEXT,
 result TEXT CHECK(result IS NULL OR json_valid(result)), error TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX jobs_claim ON jobs(status,available_at,lease_expires_at);
CREATE TABLE audit_events (
 id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
 detail TEXT NOT NULL CHECK(json_valid(detail)), created_at TEXT NOT NULL
);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at TEXT NOT NULL);
