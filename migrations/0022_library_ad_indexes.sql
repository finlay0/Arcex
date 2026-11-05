CREATE INDEX signals_library ON distribution_signals(kind,observed_at DESC,id DESC);
CREATE INDEX signals_identity_latest ON distribution_signals(product_id,kind,external_id,observed_at DESC,id DESC);
