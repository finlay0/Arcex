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
pnpm deploy:production
```

Deploy targets the explicit production environment and preserves dashboard-managed provider secrets. Do not overwrite those secrets with a partial or blank secrets file. `pnpm deploy` is a pnpm built-in and is not the deployment command for this project. When only application code changes, do not reapply already applied migrations manually. Add a new ordered SQL migration. D1 migration history is checked by Wrangler.

Use `pnpm smoke` with `ARCEX_ENV_FILE=.env.collector` to verify the cloud API. This is read-only: health, public list responses, admin-denial checks, private export denial, and authenticated job listing.

Wrangler's version/deployment listing and tail commands require the same `--env production` target. Logs expose request IDs and error class, not request bodies, tokens or provider error payloads.

## Scheduling and collectors

The production cron trigger is configured at 10:17 UTC, but `COLLECTION_ENABLED=false` makes it a no-op. Manual enqueueing remains available. The superseded local Codex automation **Arcex daily collection** is paused. Do not reactivate it for production research.

The [actual ChatGPT Work cloud task](https://chatgpt.com/c/6ae98035-fd98-83ea-86ec-e4c9f4937b0a) uses GPT-6.1 Terra Medium and Work's own cloud computer/browser. Its native daily 09:00 America/Halifax schedule is paused while bounded upfront research batches run. A local Terra agent configures accounts in Brave; it does not substitute for cloud research. Real candidate/evidence writes and private screenshot uploads have been reconciled against the API. A successful upload is distinct from editorial review or a completed post-login teardown.

Work's private **Arcex Collector** connection uses OAuth at `/mcp` with scope `arcex:collect`; never paste admin/collector tokens into a task prompt. The Worker supports CIMD and dynamic client registration, browser-bound consent, PKCE, owner-only GitHub sign-in, one-hour access tokens, rotating refresh grants, and admin grant revocation. Exact GitHub callbacks are `/auth/github/callback` and `/auth/github/callback/mcp`. Wildcards are disabled.

Collector tools can read private research, register small independent candidates with ownership evidence, save draft observations/funnels/paywalls/blueprints, upload unapproved captures and lease browser jobs. No tool publishes, changes permissions or manages billing. Major-platform fixtures (Cursor, Lovable, Bolt, v0, Replit) are archived and their sources disabled. Candidate team-size and ownership claims require review rather than treating discovery as qualification.

### Durable Work research context

Use [work-bootstrap.txt](work-bootstrap.txt) as the saved task prompt. Each run calls `research_context` to retrieve the current versioned [playbook](../src/research-playbook.ts), cohort and database checkpoints. The long strategic conversation and previous chat memory are not authoritative run state. The playbook is bundled with the Worker, so cloud Work can retrieve it without access to the local repository or a separate paid service.

`read_product_research` returns bounded prior evidence, capture references, qualification, watches, recent scans and funnel versions. `read_capture` retrieves an existing private image through the owner connection. `save_research_checkpoint` persists actual product/evidence IDs, queries, findings and the next action. A fresh chat resumes with `research_context(resumeRunId=...)`.

`save_research_assessment` records source-linked audience relevance and company scale as a draft assessment. AI coding provenance is not an eligibility requirement. Unknown workforce remains unknown; it is not proof of a tiny company. Only an admin may accept a source-reviewed candidate. Routine queue enqueueing excludes pending/excluded research profiles; qualification runs can investigate them explicitly. Existing candidates remain leads until reviewed. This avoids silently turning the initial discovery list into a verified monitoring cohort.

For a manual cloud collection pass in PowerShell:

```powershell
$env:ARCEX_ENV_FILE = '.env.collector'
pnpm collect 10
```

Only enabled registered sources can be leased. A claim is atomic, expires after ten minutes and increments the attempt counter. Heartbeats extend it. Only the current unexpired lease token can complete/fail a job. After three failed attempts the job remains failed until an explicit admin retry. Source scheduling, evidence writes and completion use transactional D1 batches. Identical content is deduplicated; separate sightings retain their timestamps.

Public HTTP collection pins a validated public DNS address into the TLS connection, limits bodies to 1 MB, and does not follow redirects or bypass access challenges. A 403 is an observed failure, not evidence of an empty page. The initial v0 page exceeded the bound; Lovable returned 403. Their failures are retained for review.

The `rss` adapter supports ordinary RSS and Atom entries, including a YouTube channel's public Atom feed when registered as a source. It records publisher metadata as evidence, not an automatically verified sponsor relationship. The `browser` job kind is reserved for Terra-led capture; the HTTP collector never claims it. For cloud execution, run `pnpm collect` in a hosted Node runner with the same API URL and a collector token; add browser execution in a separate isolated runner if needed. No paid cloud browser service has been activated.

## Publication

### Distribution watches

`POST /api/v1/admin/distribution/watches` registers an idempotent product/platform/country watch for Meta, Google, YouTube or X and a corresponding browser source. `GET /api/v1/admin/distribution` lists exact search URLs, scan outcomes, per-ad history and engagement-counter changes. Initial production coverage had 48 Meta/YouTube/X watches; Google adds a fourth platform. Configured watches do not establish completed scans.

Work tools `register_distribution_watch`, `record_distribution_scan`, `record_meta_ad`, `record_creator_mention` and `distribution_status` use the same validated backend routes. A Meta ad needs its exact Library ID, advertiser, filter country, displayed state, source hash/time and observed destination matching the product domain. Creator sponsorship/affiliate labels require an actual disclosure quote. Search-result keyword similarity alone is insufficient.

Record blocked, failed and empty scans with evidence from the exact watch URL. None of those outcomes marks ads inactive. Per-ad counts use distinct UTC dates of observed active states; reported ad start dates and gaps do not establish continuous delivery. Public summaries require approved evidence and a published parent. `GET /api/v1/distribution/{slug}` never exposes private watchlists or drafts.

The official Meta API is not activated and does not provide unrestricted worldwide commercial-ad coverage. Use the Work cloud browser for public Ad Library checks; do not silently substitute paid scrapers or bypass login/CAPTCHA challenges. [Official scope and access requirements](https://www.facebook.com/ads/library/api/).

`record_google_ad` stores transparency creative IDs and reported dates, without inferring bid keywords or conversions. `record_short_form` stores an exact Shorts/TikTok/Reels/X source, observed hook and visible counters. `record_launch_snapshot` stores source-backed numeric counters; one observation yields no velocity, and gaps are not interpolated. Public summaries require approved evidence and a published product.

Radar supports `minObservedAdDays` (1–3650), requiring that a single ad has enough distinct approved active-sighting dates. Dates from different ads do not accumulate toward one ad's threshold. Creator coverage reports distinct observed mentions and explicitly disclosed sponsored items/creators within 60 days of observation, not publication dates or evidence of an ongoing contract.

The optional `collect_youtube_mentions` adapter requires server-only `YOUTUBE_API_KEY`. It performs one bounded `search.list` request (20 results max) and one `videos.list` request for full descriptions/statistics. Only direct product-domain links create draft creator-mention records, always with placement unknown. Shortened links need browser review. Results cache for 24 hours; failed/auth-denied responses remain errors and are not cached as empty results. The application caps search calls at 25/UTC day and video metadata calls at 1,000/UTC day, below the provider's current defaults. [Current quota structure](https://developers.google.com/youtube/data/getting-started) separates 100 daily search calls from 10,000 units for other endpoints; the pasted brief's old search-unit arithmetic is not used. No paid API or quota expansion was activated.

`lookup_sponsorblock` is implemented but disabled unless `SPONSORBLOCK_LICENSE_APPROVED=true` is explicitly configured after permission for Arcex's commercial use. Its [database/API license](https://github.com/ajayyy/SponsorBlock/wiki/Database-and-API-License) is CC BY-NC-SA 4.0, not unrestricted commercial reuse. The adapter caches bounded per-video community segments, includes attribution, and never attributes a segment to a product without separate observation. No SponsorBlock data has been imported into production.

Use `/openapi.json` for endpoint contracts and runtime-validated input schemas. Admin routes require the admin token. Collector credentials only allow leasing/completion and image upload, not publication or product edits.

1. Register a draft product and source.
2. Collect/import evidence drafts with a source URL, observation time and content hash.
3. Review facts and redact screenshots. Approve evidence and, separately, any stored images.
4. Attach funnel steps, a state machine and proposed blueprint versions to their evidence.
5. Publish the product and blueprint through explicit status endpoints.

Raw evidence payloads are never returned publicly. Screenshots require approved evidence, an approved asset, and a published parent product. Evidence retraction revokes asset approval and returns the product and blueprints to draft. Blueprint versions are immutable; create a new version for a changed specification.

Inspector screenshots may still include personal information in rendered text. Input masking is not a privacy guarantee. Keep raw captures in ignored `captures/` until a person has reviewed and redacted them. No automatic screenshot publication is enabled.

## OAuth activation

The dedicated GitHub app and `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` Worker secrets are configured. Both exact callbacks above are registered. X still needs its dedicated app and `X_CLIENT_ID` / `X_CLIENT_SECRET`, with exact `/auth/x/callback` matching the API origin. The future frontend and API should share the same site, either through routing on `arcex.dev` or an `api.arcex.dev` subdomain; cookies intentionally do not permit unrelated sites. No DNS routing has been changed.

The OAuth flow checks state against a short-lived HttpOnly cookie and a one-use DB record, uses PKCE, discards provider tokens, and stores opaque hashed sessions. Accounts are keyed by provider subject and are never linked automatically just because email strings match. GitHub stores only a verified primary email. X email is left null.

## Stripe activation

An isolated Arcex Stripe sandbox is configured with an active $12 USD/month **test fixture**, hosted portal (payment updates and end-of-period cancellation), and all 12 webhook events below. Nothing was copied from live and no live products or charges were created. The fixture does not decide launch currency. `/api/v1/admin/billing/readiness` reads provider configuration and reports nonsecret flags; full hosted Checkout and signed webhook delivery still require sandbox end-to-end verification.

Configure `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET` as Worker secrets. Subscribe the endpoint `/api/v1/billing/webhook` to:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`
- `invoice.paid`, `invoice.payment_failed`
- `charge.dispute.created`, `charge.refunded`, `radar.early_fraud_warning.created`

Entitlements are derived server-side from the current subscription status, expected price, period end, and absence of a risk hold. Checkout completion alone never grants access. The signed event is verified before any provider retrieval. Delivery receipts and state changes commit together. Current provider state is retrieved to handle out-of-order events; terminal cancellation is not undone by an older event. Risk holds require an explicit admin review/clear action.

Before accepting real subscriptions, configure applicable sales-tax registrations and review Stripe Tax for the actual selling jurisdictions. Automatic tax is not enabled by this code.

## Private storage and MCP

R2 must remain disabled: the user requires zero surprise charges, and R2 allowances/budget alerts are not a provider-enforced zero-spend cap. Use the existing Supabase **Free** project `xieyxgwdfczyorfkrmbe` (formerly Aftercode), now authorized for repurposing as Arcex. BOPPER is unrelated and must remain untouched. Do not upgrade the organization/project plan. [Supabase Free does not charge overages](https://supabase.com/docs/guides/platform/cost-control); service restrictions may apply at limits.

The production URL is pinned in `wrangler.jsonc`; dedicated server-only `SUPABASE_STORAGE_KEY` is encrypted in the Worker. The existing project was renamed Arcex, and private bucket `arcex-evidence` is live. Never expose the secret key to a client or chat. The admin-only `POST /api/v1/media/storage/setup` creates the private bucket with a 1 MB file limit and PNG/JPEG/WebP allowlist, preserving other buckets and tables. It refuses an existing public bucket. `GET /api/v1/media/storage/status` reports readiness and application usage. A real generated-image upload, authenticated exact-hash read, public denial and deletion passed; actual Work research images are now being uploaded as unapproved assets.

During setup a browser redaction error exposed the old default secret key. A dedicated `arcex_worker_storage` replacement was installed, verified, and the exposed default secret was irreversibly revoked. The public/publishable key is separate. Never reuse the revoked credential or print new credential values in tool outputs.

Uploads atomically reserve D1 asset bytes before storage writes and stop at 50,000,000 total bytes; failed uploads release the reservation. There is no paid fallback or automatic plan upgrade. Unapproved files can only be fetched through authenticated admin `GET /api/v1/media/{id}/review`; public image access still requires approved asset/evidence and a published parent. The optional R2 adapter exists for isolated tests, not production activation. Supabase Storage is separate from the D1 relational database.

For MCP, run `pnpm build:mcp`. Configure your MCP client to launch `node packages/mcp/dist/index.js` with `ARCEX_API_URL` and, for blueprint exports, `ARCEX_API_KEY` from an active Insider account. Public tools do not send the key. The package reads no dotenv files from the consumer's repository. A signed-in session can create/list/revoke keys; an API key cannot mint more keys or create Checkout/Portal sessions. Key revocation and entitlement expiry take effect on subsequent requests.

The stdio package is named `arcex-mcp` because `@arcex/mcp` belongs to another publisher. Its [GitHub preview release](https://github.com/finlay0/Arcex/releases/tag/v0.1.0) provides `arcex-mcp-0.1.0.tgz` and checksums; [client configuration](../packages/mcp/README.md) installs it through `npx --package` without npm publication. A fresh local installation of the exact tarball passed a real stdio handshake, live public search and missing-Insider-key denial. npm registry publication is separate; the HTTP Work collector does not depend on it. The package includes only README, package metadata and the built entrypoint, with pinned SDK/Zod dependencies.

## Recovery and retired project

The retired checkout and its local runtime files are stored outside this repository at `C:\Users\finla\Documents\Avern.ca\90_Archive\Retired_Projects\2026-11-03\Arcex-T3-Retired`. A verified Git bundle sits beside it as `Arcex-T3-Retired.bundle`. No new code imports or depends on it. The new Git history starts independently from the retired desktop product.

For production D1 recovery, use Cloudflare's D1 Time Travel controls and validate the restored application path. A Worker rollback does not roll back D1 data. Retain protected credentials separately from Git. Account authentication, actual screenshot persistence, actual hosted payment delivery, and code deployment require separate verification.
