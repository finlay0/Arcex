# Google sign-in

Google uses the same opaque Arcex server sessions as GitHub and X. No provider refresh/access/ID tokens are persisted. Accounts are keyed by Google subject ID, not merged by matching email addresses.

- Readiness: `GET /auth/providers` lists Google first and reports whether each provider has client credentials.
- Start: `GET /auth/google/start?returnTo=/app/example` (relative Arcex paths only).
- Callback: `https://arcex-api.peak-era-avern.workers.dev/auth/google/callback`.
- Scopes: `openid email profile`. No Gmail, Drive or offline access.
- Protected Worker configuration: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- Google Cloud project prepared separately: `arcex-sign-in`, client name `Arcex Web`. The client was created, replacement credentials transferred into encrypted Worker bindings, and a real basic-profile login plus authenticated `/api/v1/me` response passed on November4. The initially exposed generated secret was disabled before any use; its replacement was captured without disclosure and stored locally with Windows DPAPI. Google audience remains External/Testing; app branding is a separate unfinished configuration step.

The server checks browser-bound, single-use OAuth state and PKCE. It validates the Google ID token using Google's published signing keys through `jose`: RS256 signature, issuer, audience, expiry, authorized party, nonce and verified email. Provider keys are public and cached; token and profile data stay request-scoped. The identity migration preserves existing provider identities.

The frontend owns the button. It should use the start URL and provider-readiness endpoint; do not embed a client secret or exchange provider tokens in the browser. Backend code tests use signed fixtures and do not establish that the Google Cloud consent screen or live credentials are configured.

References: [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect), [Google discovery](https://accounts.google.com/.well-known/openid-configuration).

Google's basic identity scopes are exempt from the Testing allowlist/100-test-user restriction: [Manage App Audience](https://support.google.com/cloud/answer/15549945). Do not apply the warning for sensitive/restricted scopes to this basic sign-in configuration.

Frontend wiring is separate: the live test ran on the API origin. Before connecting arcex.dev, use same-site API/auth routing so SameSite=Lax cookies work; do not assume cross-site requests to workers.dev carry sessions. Public launch branding/name/logo can be completed with the frontend's verified home/privacy URLs.
