CREATE TABLE product_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reviewed','declined')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id,domain)
);
CREATE INDEX product_requests_queue ON product_requests(status,domain,created_at);
CREATE INDEX product_requests_owner ON product_requests(user_id,status,created_at);
