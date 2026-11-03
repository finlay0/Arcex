# Arcex

Backend for arcex.dev: Radar discovery, Vault evidence and commercial blueprints, Arena model experiments, Ship community submissions, and MCP access. The retired T3 Code desktop fork has been replaced. This repository contains no frontend UI.

Live API: https://arcex-api.peak-era-avern.workers.dev

- [Health](https://arcex-api.peak-era-avern.workers.dev/health)
- [OpenAPI contract](https://arcex-api.peak-era-avern.workers.dev/openapi.json)
- [Operations and account setup](docs/operations.md)
- [Brief coverage: implemented, verified and remaining](docs/brief-coverage.md)
- [MCP package](packages/mcp/README.md)

## Run locally

Node 22+ and pnpm 10.14.0:

```sh
pnpm install --frozen-lockfile
pnpm setup
pnpm db:local
pnpm dev
```

The API runs on port 8791. In another terminal, run `pnpm smoke`. Import an explicitly reviewed research manifest with `pnpm seed MANIFEST.json`; there are no hardcoded platform seeds. `pnpm collect 5` processes due registered HTTP/RSS jobs. Collector errors return a nonzero exit status and remain visible in the database.

`pnpm check` runs typechecking, backend/storage/OAuth/MCP tests and both Worker/MCP builds. Tests use isolated in-memory storage and provider fixtures; they do not contact live billing or OAuth providers.

## Data and execution

Cloudflare Workers hosts the API; D1 stores relational records and the durable collection queue. Research runs in [ChatGPT Work](https://chatgpt.com/c/6ae98035-fd98-83ea-86ec-e4c9f4937b0a), using GPT-6.1 Terra Medium and its cloud browser/computer. Local Terra browser agents configure connections only. The upfront batch comes first; the native Work daily 09:00 America/Halifax schedule is paused. The superseded local Codex automation is also paused and production `COLLECTION_ENABLED=false` prevents automatic cron enqueueing.

Private screenshots use the existing Supabase Free project (formerly Aftercode). Uploads require server credentials, a private `arcex-evidence` bucket, a 1 MB per-file bound and an atomic 50 MB application quota. At the quota uploads stop; there is no paid fallback. R2 is not activated: free allowances and budget alerts do not provide a hard zero-spend cap. Supabase Free may restrict service at its limits rather than charge overages. BOPPER is untouched.

The owner-only OAuth collector endpoint is `/mcp`, with scope `arcex:collect`. It can register independent-product candidates, read collection status, attach private captures and save evidence/funnels/blueprints as drafts. It has no publish, billing or permission tools. This is separate from the public/Insider stdio MCP package.

Meta Ad Library, Google Ads Transparency, YouTube and X distribution watches use cloud browser jobs. The collector records ad IDs, displayed states/dates, destination links, creator disclosures, short-form hooks and scan failures. Per-ad history counts distinct observed active UTC days, not continuous delivery. Engagement snapshots derive counter-change rates only from multiple observations. Keyword matches require a product-domain destination match before becoming ad/creator records. Empty or blocked searches never establish that a product has no ads. Actual sightings remain drafts until review.

An optional official YouTube Data API adapter fetches full descriptions/statistics after discovery, filters direct domain links, caches for 24 hours and caps searches at 25/day. It requires a protected server key; Work's cloud browser is the active path. SponsorBlock lookup code is disabled until commercial-use permission is established for its noncommercial database/API license.

Public endpoints expose published records and approved evidence only. Free signed-in users can export blueprints, save products, submit builds and vote. An active Insider subscription enables MCP API keys, collections, a derived public badge and stream-queue priority. Stripe webhooks reconcile subscription state, reject invalid signatures, deduplicate deliveries, and place refunds/disputes/fraud warnings into an admin review hold.

## Inspector

```sh
pnpm inspect https://target-app.tld
pnpm inspect https://target-app.tld --browser
pnpm inspect https://target-app.tld --browser --auto
pnpm extract captures/CAPTURE_DIRECTORY --prepare-only
pnpm import:teardown captures/CAPTURE_DIRECTORY PRODUCT_ID
```

The browser mode opens a visible ephemeral Playwright session. Navigate and sign in manually, enter a label for each capture, and enter `q` to finish. `--auto` additionally debounces navigation/button captures on the target domain, up to 100 steps. Client stack observations store matched provider hosts and fixed signature descriptions, without request bodies, headers, cookies or query parameters. They do not establish server implementation. No browser profiles or OAuth state are persisted. Run `pnpm exec playwright install chromium` if needed.

The extractor defaults to **GPT-6.1 Terra, medium**. `--prepare-only` produces a prompt/schema for an app run without API billing. With a protected `OPENAI_API_KEY`, extraction can instead use the Responses API with no model tools enabled. It saves structured analysis locally; import creates drafts and never publishes. Screenshots are not uploaded by this command. Browser/computer-use testing is delegated to Terra as requested.

## Current activation limits

- GitHub OAuth app and encrypted Worker secrets are configured, including exact regular and collector callbacks. X OAuth still requires a dedicated provider registration; X email is not requested or assumed available.
- Stripe has a dedicated sandbox, a $12 USD/month test fixture, hosted Portal and the required 12 webhook events. The admin readiness endpoint verifies provider configuration without returning secrets. Full hosted payment/webhook delivery remains to be verified; no live charges or live products were created. Launch currency is not decided by the sandbox fixture.
- `arcex-mcp` builds and passes a packed-install stdio handshake and live public-read test. The GitHub preview release provides an installable tarball; npm registry publication remains separate because the original scoped name is occupied.
- No customer-facing site, ten published deep teardowns, real benchmark games, or provider performance claims have been fabricated. Those require frontend work and observed content.

Evidence records distinguish observations from proposed implementation. Distinct ad-observation days do not establish continuous ad activity, ad spend, revenue or conversion. A retracted observation unpublishes its product and blueprint exports.

Cloud research reports remain provisional until source and capture review. The former large-platform fixtures are archived and their sources disabled; they are not the core small-independent-product cohort. `pnpm import:work REPORT.json CHATGPT_TASK_URL` imports a downloaded Work report as private draft evidence and explicitly records that screenshot bytes still need uploading.
