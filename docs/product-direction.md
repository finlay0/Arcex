# Arcex product direction

This distills the November 2026 full strategic discussion, interpreted with Finlay's later direct instructions. The early "direction unresolved" section is historical; it does not reverse the later decision to build Arcex or revive the retired ADE. No product UI is in this implementation scope.

## Product and audience

Arcex combines ongoing AI/web product landscape intelligence with a practical library of acquisition, onboarding, activation and monetization patterns. The audience is AI-native builders, internet entrepreneurs and agencies. A tracked product does not have to be vibe-coded, AI-built, newly launched or a mobile app. Small independent products are a useful priority, not a substitute for product relevance and useful evidence.

Radar answers what exists, how it is positioned and what distribution activity we observe. Vault connects that acquisition evidence to actual post-login flows, paywall/credit states and proposed agent implementation blueprints. The product database is the core asset. Arena and Ship can support the creator loop when they have real content; they do not replace the intelligence product or require more day-one interface work.

Discovery uses complementary founder/product-launch, distribution and ecosystem lanes. A directory listing, AI label or one ad is a lead, not qualification. The current seeded cohort is provisional. Current company size may be unknown; do not label unknown scale "verified small." Coding method is optional background, never a gate.

## Value and limits of the evidence

Preserved, structured observations and earlier flow versions make repeated use valuable. The asset is the maintained coverage and its practical interpretation, not a promise that competitors cannot collect similar information.

Ad longevity is observed distribution, not proof of profit, spend, conversion or uninterrupted delivery. A creator link is not automatically sponsorship. Client-side tags do not reveal private databases or models. A blueprint is a proposed implementation from observed behavior, not recovered proprietary source code. Demand, retention, sponsorship income and the dataset's commercial defensibility remain hypotheses to validate.

## Coverage levels

Decision, November 4, 2026: the catalog has two levels. Signals-only products (the goal is 300+) show public ads, creators, pricing and growth, which are cheap to collect and need almost no storage. Fully captured products (the best 50 to 125 within the current 50 MB quota) add the screen walkthrough and blueprint. Signals-only pages are open without sign-in and don't use the daily limit. People can request a full breakdown of any signals-only product.

## Access and business model

**Decision, November 5, 2026: the paid tier is named Pro, not Insider.** Everyone who joins the waitlist before launch gets their first year of Pro free. Price and limits are unchanged by this decision; the app, API and Stripe still use the Insider name until they are renamed.

**Decision, November 4, 2026: free core with an optional $12/mo Insider upsell.** Growth is the priority, so the core stays free and generous. Free accounts get 10 apps and 10 blueprint exports a day, and reopening an app they've already opened that day is free. Insider removes those daily caps and adds collections and Request X-Ray priority. This takes precedence over the pricing and quota proposals below.

The latest explicit preference in the supplied discussion is a public Radar list with free sign-in when opening a full Vault entry. This supersedes earlier suggestions to expose the whole Vault publicly or gate only a later flow step. Actual UI implementation is excluded here.

Useful free participation supports the creator/community distribution loop. Disclosed stack partners, affiliates, sponsorships and an optional Insider layer are complementary monetization paths. Account identity data depends on provider permissions; one sign-in does not automatically provide verified email plus both X and GitHub identities.

Exact quotas and pricing are unresolved. The assistant proposed five Vaults/day and three free MCP pulls/week, then alternated between 25 monthly Pro pulls and unlimited Pro/MCP access. Treat those as conflicting proposals, not settled production rules. Agent payments are an eventual desired capability, not a live feature or permission to activate paid services.

## The honeypot and anti-copying discussion

The literal honeypot proposal is a hidden canary link/row intended to reveal indiscriminate scraping. It is separate from the free-product acquisition funnel. It is an optional detection signal, not foolproof evidence that a visitor is stealing data. Do not automatically shadow-ban an account/IP solely because it requested a canary URL.

The baseline is server-side access and usage policy, lightweight public summaries, authenticated full-detail access, private capture delivery, scoped agent requests and continuously maintained evidence. A private bucket alone does not prevent copying images served through a public API. Signed URLs, watermarks or a honeypot cannot make already viewed data impossible to copy. Avoid constructing an elaborate anti-bot system before there is real usage to defend.

## Current implementation gaps

- The sign-in gate, 10-a-day app limit and signed image links are enforced on the server. No research product is currently published.
- There's no revenue model. The API stores manually entered ranges with a method version, sourced inputs, assumptions, evidence IDs and history, returns null without them, and doesn't call them computed estimates. Ad longevity is never a dollar input. Changes are reviewed drafts before they publish. Detection covers observed public pages only.
- Activity figures compare distinct ads and creators across comparably collected weeks. They aren't product or business growth, and they stay null without comparable collection.
- Consumer MCP blueprint export uses free API keys, capped at 10 exports a day per account. Insider has no daily cap. The owner research collector is a separate OAuth connection and does not define consumer entitlements.
- No customer Vault/MCP allowance policy, watermarking, canary bans, PostHog instrumentation or agent micropayments is claimed live. Numerical allowances need a coherent decision; analytics needs the future product integration.
- The versioned research playbook, product-history retrieval and durable run checkpoints address collection repeatability. They do not establish that the current candidates are qualified, that all funnels were inspected or that the business is validated.

The [research playbook](../src/research-playbook.ts) and [Work bootstrap](work-bootstrap.txt) operationalize collection. The original long discussion is source context, not a document to paste into every Work run. New direct user decisions take precedence over historical assistant pitches and these summaries.
