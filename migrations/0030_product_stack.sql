-- Technologies seen in a product's public homepage HTML by the daily code-only check.
-- removed_at is set when a later observation no longer shows the technology.
CREATE TABLE product_stack (
 product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 technology TEXT NOT NULL CHECK(length(technology) BETWEEN 1 AND 40),
 category TEXT NOT NULL CHECK(category IN ('framework','site_builder','payments','analytics','ad_pixel','support','auth','backend','marketing')),
 first_seen TEXT NOT NULL,
 last_seen TEXT NOT NULL,
 removed_at TEXT,
 PRIMARY KEY(product_id, technology)
);
