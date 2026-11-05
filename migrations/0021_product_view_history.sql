CREATE TABLE product_view_history (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  last_opened_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);
CREATE INDEX product_view_history_recent ON product_view_history(user_id, last_opened_at DESC, product_id);
