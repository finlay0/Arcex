-- When a product last had a complete deep-research pass (screens, pricing, ads, creators).
ALTER TABLE research_profiles ADD COLUMN deep_checked_at TEXT;
