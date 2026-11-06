-- Cloud workers take short leases on research work so frequent runs never collide.
ALTER TABLE research_profiles ADD COLUMN work_lease_until TEXT;
ALTER TABLE research_profiles ADD COLUMN review_hold_until TEXT;
CREATE INDEX research_profiles_queue ON research_profiles(status, work_lease_until);
