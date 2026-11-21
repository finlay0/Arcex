# Arcex

Arcex ADE is a Windows-first desktop workspace for building with coding agents. This repository also contains the arcex.dev platform, including Radar, Vault, Arena, Ship, and MCP access.

## Run the desktop development build

With Node 22.13 or newer and pnpm installed, run these commands from the repository root.

```powershell
pnpm install --frozen-lockfile
pnpm --filter @arcex/ide build
pnpm --filter @arcex/desktop dev
```

To work on Arcex from inside Arcex, add this repository as a project. **Update**, at the bottom of the sidebar, rebuilds the app from the current code and restarts it. If the checkout has no local edits, it pulls from GitHub first. If the new code doesn't build, the running version stays and the error is shown.

Open **Agents** in Arcex to check which providers are ready. Each provider uses its own sign-in flow. Install Git if you want the Changes panel to show working-tree diffs. See the [ADE build notes](docs/ade-plan.md) for architecture and current feature coverage.

## Platform

Live API: https://arcex-api.peak-era-avern.workers.dev

- [Health](https://arcex-api.peak-era-avern.workers.dev/health)
- [OpenAPI contract](https://arcex-api.peak-era-avern.workers.dev/openapi.json)
- [Operations and account setup](docs/operations.md)
- [Brief coverage: implemented, verified and remaining](docs/brief-coverage.md)
- [Product direction and decisions](docs/product-direction.md)
- [Repeatable Work bootstrap](docs/work-bootstrap.txt)
- [MCP package](packages/mcp/README.md)

## Web app

`pnpm --filter @arcex/web dev` serves it on port 5174 and proxies `/api` and `/auth` to the local Worker on 8791. Start that Worker with `--var APP_ORIGIN:http://localhost:5174`. To read live data instead, set `ARCEX_API_PROXY=https://api.arcex.dev`. Writes won't pass the live origin check from localhost. Production builds call `https://api.arcex.dev`, and the API only accepts `https://arcex.dev` as an origin.

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

Verification stays focused on access, evidence/publication, billing, provider failures and cost limits. Avoid duplicate implementation-shaped assertions or repeated full checks without a relevant change. The storage integration uses the standalone Storage SDK, rather than loading unused Supabase Auth, Realtime and database clients.

## Data and execution

Cloudflare Workers hosts the API; D1 stores relational records and the durable collection queue. Research runs in [ChatGPT Work](https://chatgpt.com/c/6ae98035-fd98-83ea-86ec-e4c9f4937b0a), using GPT-6.1 Terra Medium and its cloud browser/computer. Local Terra browser agents configure connections only. The upfront batch comes first; the native Work daily 09:00 America/Halifax schedule is paused. The superseded local Codex automation is also paused and production `COLLECTION_ENABLED=false` prevents automatic cron enqueueing.

Private screenshots use the existing Supabase Free project (formerly Aftercode). Uploads require server credentials, a private `arcex-evidence` bucket, a 1 MB per-file bound and an atomic 50 MB application quota. At the quota uploads stop; there is no paid fallback. R2 is not activated: free allowances and budget alerts do not provide a hard zero-spend cap. Supabase Free may restrict service at its limits rather than charge overages. BOPPER is untouched.

The owner-only OAuth collector endpoint is `/mcp`, with scope `arcex:collect`. It can register independent-product candidates, read collection status, attach private captures and save evidence/funnels/blueprints as drafts. It has no publish, billing or permission tools. This is separate from the public/Insider stdio MCP package.

Meta Ad Library, Google Ads Transparency, YouTube and X distribution watches use cloud browser jobs. The collector records ad IDs, displayed states/dates, destination links, creator disclosures, short-form hooks and scan failures. Per-ad history counts distinct observed active UTC days, not continuous delivery. Engagement snapshots derive counter-change rates only from multiple observations. Keyword matches require a product-domain destination match before becoming ad/creator records. Empty or blocked searches never establish that a product has no ads. Actual sightings remain drafts until review.

An optional official YouTube Data API adapter fetches full descriptions/statistics after discovery, filters direct domain links, caches for 24 hours and caps searches at 25/day. It requires a protected server key; Work's cloud browser is the active path. SponsorBlock lookup code is disabled until commercial-use permission is established for its noncommercial database/API license.

Public endpoints expose published records and approved evidence only. Signals-only products and one chosen open sample can be read without sign-in. For other products, signed-out viewers get an outline, or the single screen a shared link points to. Signed-in viewers open 10 captured apps a day, reopening is free, and Insider has no daily limit. Screenshots are served only through 15-minute signed links. Table metrics describe observed ad and creator activity, not product or business growth, and stay null where nothing comparable was collected. Revenue is a manually entered range with its sources, assumptions and evidence, not a computed estimate, and it can't use ad activity as an input. Revenue ranges and observed changes stay drafts until an admin publishes them. Free signed-in users can export blueprints, create MCP API keys limited to blueprint export (10 exports a day; Insider has no daily cap), save products, submit builds and vote. An active Insider subscription enables collections, a derived public badge and stream-queue priority. Stripe webhooks reconcile subscription state, reject invalid signatures, deduplicate deliveries, and place refunds/disputes/fraud warnings into an admin review hold.

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
- Anyone can connect an agent to the hosted MCP at `/public/mcp`, with no install or sign-in. Search is open, and blueprints use a free API key sent as a Bearer header. The optional `arcex` stdio package in `packages/mcp` isn't on npm.
- No customer-facing site, ten published deep teardowns, real benchmark games, or provider performance claims have been fabricated. Those require frontend work and observed content.

Evidence records distinguish observations from proposed implementation. Distinct ad-observation days do not establish continuous ad activity, ad spend, revenue or conversion. A retracted observation unpublishes its product and blueprint exports.

Cloud research reports remain provisional until source and capture review. The former large-platform fixtures are archived and their sources disabled; they are not the core small-independent-product cohort. `pnpm import:work REPORT.json CHATGPT_TASK_URL` imports a downloaded Work report as private draft evidence and explicitly records that screenshot bytes still need uploading.
