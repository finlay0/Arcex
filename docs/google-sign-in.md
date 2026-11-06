# Google sign-in

Google uses the same opaque Arcex server sessions as GitHub and X. No provider refresh/access/ID tokens are persisted. Accounts are keyed by Google subject ID, not merged by matching email addresses.

- Readiness: `GET /auth/providers` lists Google first and reports whether each provider has client credentials.
- Start: `GET /auth/google/start?returnTo=/app/example` (relative Arcex paths only).
- Production start: `https://api.arcex.dev/auth/google/start`.
- Callback: `https://api.arcex.dev/auth/google/callback`. The previously approved workers.dev callback remains registered.
- Scopes: `openid email profile`. No Gmail, Drive or offline access.
- Protected Worker credentials: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. `GOOGLE_AUTH_ORIGIN=https://api.arcex.dev` binds Google web sign-in to its same-site origin while the existing private Collector OAuth resource stays on workers.dev.
- Google Cloud project prepared separately: `arcex-sign-in`, client name `Arcex Web`. The client was created, replacement credentials transferred into encrypted Worker bindings, and a real basic-profile login plus authenticated `/api/v1/me` response passed on November4. The initially exposed generated secret was disabled before any use; its replacement was captured without disclosure and stored locally with Windows DPAPI. Google audience remains External/Testing; app branding is a separate unfinished configuration step.

The server checks browser-bound, single-use OAuth state and PKCE. It validates the Google ID token using Google's published signing keys through `jose`: RS256 signature, issuer, audience, expiry, authorized party, nonce and verified email. Provider keys are public and cached; token and profile data stay request-scoped. The identity migration preserves existing provider identities.

The frontend owns the button. It should use the start URL and provider-readiness endpoint; do not embed a client secret or exchange provider tokens in the browser. Backend code tests use signed fixtures and do not establish that the Google Cloud consent screen or live credentials are configured.

References: [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect), [Google discovery](https://accounts.google.com/.well-known/openid-configuration).

Google's basic identity scopes are exempt from the Testing allowlist/100-test-user restriction: [Manage App Audience](https://support.google.com/cloud/answer/15549945). Do not apply the warning for sensitive/restricted scopes to this basic sign-in configuration.

The custom domain is live and a real Google authorization flow followed by authenticated `/api/v1/me` passed on api.arcex.dev on November4. The frontend should use that API base with credentials included. Google starts received on workers.dev redirect before creating state, so the browser-bound cookie is created on the callback's own origin. GitHub's same-site web migration is separately configured as described below. Public launch branding/name/logo can be completed with the frontend's verified home/privacy URLs.

## GitHub same-site callback

`GITHUB_AUTH_ORIGIN=https://api.arcex.dev` makes GitHub starts and callbacks received on that exact origin use `https://api.arcex.dev/auth/github/callback`. Requests on the existing workers.dev origin keep its original callback, credentials and host-bound cookies, preserving private Collector authentication. Google behavior is unchanged. No cross-domain session token bridge or second OAuth app is needed.

The approved callback addition is saved alongside both workers.dev callbacks, with wildcards off and credentials unchanged. Worker2dfb839d-e622-4cb7-8d3b-55d09ffaa65a activated the origin fix. Actual GitHub sign-in from /auth/github/start and same-browser authenticated /api/v1/me succeeded, and the existing private Collector read after deployment also succeeded. The frontend can offer GitHub against api.arcex.dev with credentials included.
