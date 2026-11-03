# Arcex

Backend for arcex.dev: Radar discovery, Vault evidence and commercial blueprints, Arena model experiments, Ship community submissions, and MCP access. The retired T3 Code desktop fork has been replaced. This repository contains no frontend UI.

Live API: https://arcex-api.peak-era-avern.workers.dev

- [Health](https://arcex-api.peak-era-avern.workers.dev/health)
- [OpenAPI contract](https://arcex-api.peak-era-avern.workers.dev/openapi.json)
- [Operations and account setup](docs/operations.md)
- [MCP package](packages/mcp/README.md)

## Run locally

Node 22+ and pnpm 10.14.0:

```sh
pnpm install --frozen-lockfile
pnpm setup
pnpm db:local
pnpm dev
```

The API runs on port 8791. In another terminal, run `pnpm smoke`, `pnpm seed`, then `pnpm collect 5`. Seed creates five **draft research candidates**, not completed teardowns. Collector errors return a nonzero exit status and remain visible in the database.

`pnpm check` runs typechecking, 19 backend/MCP tests and both Worker/MCP builds. Tests use isolated, in-memory D1/R2; they do not contact live billing or OAuth providers.

## Data and execution

Cloudflare Workers hosts the API; D1 stores relational records and the durable collection queue. Workers Cron enqueues due sources daily. A collector leases jobs, records evidence drafts, and retries bounded failures. The initial daily Codex automation uses GPT-6.1 Terra at medium reasoning on Finlay's computer. A container or other hosted runner can later run the same collector protocol without changing data ownership or publication rules.

R2 is an optional binding for reviewed screenshots. It is not enabled in the current Cloudflare account. Inspector captures remain local until that service is enabled and the captures are reviewed.

Public endpoints expose published records and approved evidence only. Free signed-in users can export blueprints, save products, submit builds and vote. An active Insider subscription enables MCP API keys, collections, a derived public badge and stream-queue priority. Stripe webhooks reconcile subscription state, reject invalid signatures, deduplicate deliveries, and place refunds/disputes/fraud warnings into an admin review hold.

## Inspector

```sh
pnpm inspect https://target-app.tld
pnpm inspect https://target-app.tld --browser
pnpm extract captures/CAPTURE_DIRECTORY --prepare-only
pnpm import:teardown captures/CAPTURE_DIRECTORY PRODUCT_ID
```

The browser mode opens a visible ephemeral Playwright session. Navigate and sign in manually, enter a label for each capture, and enter `q` to finish. It does not store browser profiles or OAuth state. Run `pnpm exec playwright install chromium` if the browser is absent.

The extractor defaults to **GPT-6.1 Terra, medium**. `--prepare-only` produces a prompt/schema for an app run without API billing. With a protected `OPENAI_API_KEY`, extraction can instead use the Responses API with no model tools enabled. It saves structured analysis locally; import creates drafts and never publishes. Screenshots are not uploaded by this command. Browser/computer-use testing is delegated to Terra as requested.

## Current activation limits

- GitHub and X OAuth code is implemented; dedicated provider app registrations and secrets are still required. X email is not requested or assumed available.
- Stripe Checkout, Portal, subscription reconciliation and risk handling are implemented and locally tested. A Stripe sandbox/price/webhook configuration is still required; the connected Stripe app currently needs reauthentication. No live charges or live products were created.
- `@arcex/mcp` builds and passes a real SDK handshake test. npm publication requires registry login and access to the namespace.
- No customer-facing site, ten published deep teardowns, real benchmark games, or provider performance claims have been fabricated. Those require frontend work and observed content.

Evidence records distinguish observations from proposed implementation. Distinct ad-observation days do not establish continuous ad activity, ad spend, revenue or conversion. A retracted observation unpublishes its product and blueprint exports.
