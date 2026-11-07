CREATE TABLE store_listings (
 id TEXT PRIMARY KEY,
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 store TEXT NOT NULL CHECK(store IN ('app_store','google_play','chrome_web_store','firefox_addons','vscode_marketplace')),
 listing_url TEXT NOT NULL UNIQUE,
 external_id TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created_at TEXT NOT NULL,
 last_checked_at TEXT,
 failure_streak INTEGER NOT NULL DEFAULT 0 CHECK(failure_streak >= 0),
 last_error TEXT,
 UNIQUE(store,external_id)
);
CREATE INDEX store_listings_due ON store_listings(enabled,last_checked_at);
CREATE INDEX store_listings_product ON store_listings(product_id);

CREATE TABLE store_listing_snapshots (
 listing_id TEXT NOT NULL REFERENCES store_listings(id) ON DELETE CASCADE,
 observed_on TEXT NOT NULL,
 rating REAL CHECK(rating BETWEEN 0 AND 5),
 rating_count INTEGER CHECK(rating_count BETWEEN 0 AND 1000000000000),
 installs_or_users INTEGER CHECK(installs_or_users BETWEEN 0 AND 1000000000000),
 installs_label TEXT,
 price REAL CHECK(price BETWEEN 0 AND 1000000),
 currency TEXT,
 version TEXT,
 store_updated_at TEXT,
 raw_sha256 TEXT NOT NULL,
 genre TEXT,
 contains_ads INTEGER CHECK(contains_ads IN (0,1)),
 has_in_app_purchases INTEGER CHECK(has_in_app_purchases IN (0,1)),
 in_app_purchases TEXT CHECK(in_app_purchases IS NULL OR json_valid(in_app_purchases)),
 average_daily_users INTEGER CHECK(average_daily_users BETWEEN 0 AND 1000000000000),
 created_at TEXT NOT NULL,
 PRIMARY KEY(listing_id,observed_on)
);
