CREATE TABLE identities_google (
 provider TEXT NOT NULL CHECK(provider IN ('github','x','google','development')),
 provider_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(provider,provider_id)
);
INSERT INTO identities_google SELECT * FROM identities;
DROP TABLE identities;
ALTER TABLE identities_google RENAME TO identities;
ALTER TABLE oauth_states ADD COLUMN return_to TEXT NOT NULL DEFAULT '/';
