# Google sign-in

Google uses the same opaque Arcex server sessions as GitHub and X. No provider refresh/access/ID tokens are persisted. Accounts are keyed by Google subject ID, not merged by matching email addresses.

- Readiness: `GET /auth/providers` lists Google first and reports whether each provider has client credentials.
- Start: `GET /auth/google/start?returnTo=/app/example` (relative Arcex paths only).
- Callback: `https://arcex-api.peak-era-avern.workers.dev/auth/google/callback`.
- Scopes: `openid email profile`. No Gmail, Drive or offline access.
- Protected Worker configuration: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- Google Cloud project prepared separately: `arcex-sign-in`, client name `Arcex Web`. Provider console creation, credential transfer, audience/testing settings and real customer login must be verified separately from code tests.

The server checks browser-bound, single-use OAuth state and PKCE. It validates the Google ID token using Google's published signing keys through `jose`: RS256 signature, issuer, audience, expiry, authorized party, nonce and verified email. Provider keys are public and cached; token and profile data stay request-scoped. The identity migration preserves existing provider identities.

The frontend owns the button. It should use the start URL and provider-readiness endpoint; do not embed a client secret or exchange provider tokens in the browser. Backend code tests use signed fixtures and do not establish that the Google Cloud consent screen or live credentials are configured.

References: [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect), [Google discovery](https://accounts.google.com/.well-known/openid-configuration).
