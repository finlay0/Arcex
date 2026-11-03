# Arcex operations

## Targets and protected configuration

Production Worker: `arcex-api`, account `f4fd2d7253ee80d49ffb768f4a25b132`.

Production D1: `arcex`, ID `6a7ad0ca-784e-47d5-b8ed-9c6b6400cc22`. The same binding configuration is used for local simulation; `--local` uses a separate local SQLite database. Tests use a third isolated in-memory database. Never substitute `--remote` during tests.

`.dev.vars` contains independent local admin, collector and development-session tokens. `.secrets.production.json` contains production admin and collector tokens. `.env.collector` selects the cloud API and those production credentials for command-line runners. All three files are ignored. Never print them, commit them, or include them in screenshots. `scripts/setup-production.ts` creates missing production tokens without overwriting existing ones.

Development sign-in requires all three: `ENVIRONMENT=development`, `ENABLE_DEV_AUTH=true`, and a localhost request with the development token. Production hard-disables it. Do not configure a development token in production.

## Deploy

```sh
pnpm check
pnpm db:remote
pnpm deploy:production --secrets-file .secrets.production.json
```

Deploy targets the explicit production environment. `pnpm deploy` is a pnpm built-in and is not the deployment command for this project. When only application code changes, do not reapply already applied migrations manually. Add a new ordered SQL migration. D1 migration history is checked by Wrangler.

Use `pnpm smoke` with `ARCEX_ENV_FILE=.env.collector` to verify the cloud API. This is read-only: health, public list responses, admin-denial checks, private export denial, and authenticated job listing.

Wrangler's version/deployment listing and tail commands require the same `--env production` target. Logs expose request IDs and error class, not request bodies, tokens or provider error payloads.

## Scheduling and collectors

Workers Cron runs at 10:17 UTC daily and enqueues due sources. It does not itself run a browser or language model. The Codex automation **Arcex daily collection** runs at 09:00 America/Halifax using `gpt-6.1-terra`, medium reasoning. The local automation needs this computer and Codex available. Missed local runs leave jobs in the cloud queue.

A [ChatGPT Work cloud test](https://chatgpt.com/c/6ae97dca-4130-83ea-b681-8079d37c2bb3) on November 3 verified Cloud browser capture of v0 and Lovable. GPT-6.1 Terra Medium was selected in the web UI. Its Outputs contain a JSON report and two screenshots. Curl reached the public API and verified unauthenticated admin denial; Python HTTP requests received 403/1010. This tested public cloud capture, not authenticated ingestion. Keep the local collector as the current ingestion path until Work has a protected Arcex connection; never put admin/collector tokens into a chat prompt.

For a manual cloud collection pass in PowerShell:

```powershell
$env:ARCEX_ENV_FILE = '.env.collector'
pnpm collect 10
```

Only enabled registered sources can be leased. A claim is atomic, expires after ten minutes and increments the attempt counter. Heartbeats extend it. Only the current unexpired lease token can complete/fail a job. After three failed attempts the job remains failed until an explicit admin retry. Source scheduling, evidence writes and completion use transactional D1 batches. Identical content is deduplicated; separate sightings retain their timestamps.

Public HTTP collection pins a validated public DNS address into the TLS connection, limits bodies to 1 MB, and does not follow redirects or bypass access challenges. A 403 is an observed failure, not evidence of an empty page. The initial v0 page exceeded the bound; Lovable returned 403. Their failures are retained for review.

The `rss` adapter supports ordinary RSS and Atom entries, including a YouTube channel's public Atom feed when registered as a source. It records publisher metadata as evidence, not an automatically verified sponsor relationship. The `browser` job kind is reserved for Terra-led capture; the HTTP collector never claims it. For cloud execution, run `pnpm collect` in a hosted Node runner with the same API URL and a collector token; add browser execution in a separate isolated runner if needed. No paid cloud browser service has been activated.

## Publication

Use `/openapi.json` for endpoint contracts and runtime-validated input schemas. Admin routes require the admin token. Collector credentials only allow leasing/completion and image upload, not publication or product edits.

1. Register a draft product and source.
2. Collect/import evidence drafts with a source URL, observation time and content hash.
3. Review facts and redact screenshots. Approve evidence and, separately, any stored images.
4. Attach funnel steps, a state machine and proposed blueprint versions to their evidence.
5. Publish the product and blueprint through explicit status endpoints.

Raw evidence payloads are never returned publicly. Screenshots require approved evidence, an approved asset, and a published parent product. Evidence retraction revokes asset approval and returns the product and blueprints to draft. Blueprint versions are immutable; create a new version for a changed specification.

Inspector screenshots may still include personal information in rendered text. Input masking is not a privacy guarantee. Keep raw captures in ignored `captures/` until a person has reviewed and redacted them. No automatic screenshot publication is enabled.

## OAuth activation

Create dedicated GitHub and X applications. Store `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `X_CLIENT_ID`, and `X_CLIENT_SECRET` in the production Worker's secrets. Register exact `/auth/github/callback` and `/auth/x/callback` URLs matching the configured public API origin. The future frontend and API should share the same site, either through routing on `arcex.dev` or an `api.arcex.dev` subdomain; cookies intentionally do not permit unrelated sites. No DNS routing has been changed.

The OAuth flow checks state against a short-lived HttpOnly cookie and a one-use DB record, uses PKCE, discards provider tokens, and stores opaque hashed sessions. Accounts are keyed by provider subject and are never linked automatically just because email strings match. GitHub stores only a verified primary email. X email is left null.

## Stripe activation

Use a dedicated Stripe sandbox first, a restricted API key, one Insider product with an approved monthly price/currency, and a hosted customer portal. The brief proposes $12/month; no currency has been assumed or live price created.

Configure `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET` as Worker secrets. Subscribe the endpoint `/api/v1/billing/webhook` to:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`
- `invoice.paid`, `invoice.payment_failed`
- `charge.dispute.created`, `charge.refunded`, `radar.early_fraud_warning.created`

Entitlements are derived server-side from the current subscription status, expected price, period end, and absence of a risk hold. Checkout completion alone never grants access. The signed event is verified before any provider retrieval. Delivery receipts and state changes commit together. Current provider state is retrieved to handle out-of-order events; terminal cancellation is not undone by an older event. Risk holds require an explicit admin review/clear action.

Before accepting real subscriptions, configure applicable sales-tax registrations and review Stripe Tax for the actual selling jurisdictions. Automatic tax is not enabled by this code.

## R2 and MCP activation

R2 currently returns account error 10042: enable it in Cloudflare Dashboard first. Once enabled, create a private evidence bucket, add a `MEDIA` R2 binding to production config, regenerate types, and redeploy. Do not make the bucket public. All image reads go through the publication checks in the API.

For MCP, run `pnpm build:mcp`. Configure your MCP client to launch `node packages/mcp/dist/index.js` with `ARCEX_API_URL` and, for blueprint exports, `ARCEX_API_KEY` from an active Insider account. Public tools do not send the key. The package reads no dotenv files from the consumer's repository. A signed-in session can create/list/revoke keys; an API key cannot mint more keys or create Checkout/Portal sessions. Key revocation and entitlement expiry take effect on subsequent requests.

`npm whoami` currently reports ENEEDAUTH. Verify npm login and `@arcex` namespace access, run `npm pack --dry-run` from the package, then publish only when that configuration is ready. The package contains no secrets or browser artifacts.

## Recovery and retired project

The retired checkout and its local runtime files are stored outside this repository at `C:\Users\finla\Documents\Avern.ca\90_Archive\Retired_Projects\2026-11-03\Arcex-T3-Retired`. A verified Git bundle sits beside it as `Arcex-T3-Retired.bundle`. No new code imports or depends on it. The new Git history starts independently from the retired desktop product.

For production D1 recovery, use Cloudflare's D1 Time Travel controls and validate the restored application path. A Worker rollback does not roll back D1 data. Retain protected credentials separately from Git. Account authentication and billing/R2 activation are separate from code deployment.
