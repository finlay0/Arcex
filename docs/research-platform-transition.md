# Research platform transition

Finlay's November 5, 2026 decision pauses Arcex research in ChatGPT Work for roughly the next month and requests Cursor Automations/Grok Bot onboarding. This changes the worker provider, not the database or product scope. There is no automatic switch back after a month. One-off computer use in this Codex chat still uses GPT-6.1 Terra Medium.

Finlay subsequently increased the upfront target to1,000strong source-backed Radar products and requested frequent bootstrap work. This supersedes the earlier300 target and the idea of starting with one daily model run. The target is not1,000raw leads or1,000full teardowns. Browser depth remains separately scoped to the initial10breakdowns.

## Observed current state

- The native Arcex daily Work schedule is paused. Both existing research chats show completed responses and idle composers. The superseded local Arcex automation is PAUSED, and GitHub's HTTP source workflow is disabled_manually. Production COLLECTION_ENABLED is false.
- 175 candidates have completed the final text-review/import pass: 164 in scope, eight held, three references. These are private Signals Only drafts, not tested apps or full breakdowns. None is accepted or published.
- Batch08's original result and two corrected rows are saved privately but not imported. Source/roster review caught a repeated-row error before any batch08 writes. Remaining09-14 inputs use batch-unique keys. Do not rerun finished batches or restore the old ChatGPT tasks to finish this.
- The inspected unified account shows Premium,1%weeklyincludedusage andzero prepaid/credit usage. The additional-usage limit has now been saved at0; the dashboard says Additional usage disabled, and auto top-up remains off. No account merge, purchase or subscription change was performed.
- Both Cursor automations are saved and Inactive, with no repository, memories removed and the authenticated Collector attached. Source Review is Composer2.5/Fastoff; Browser Research is Grok4.7Medium/Fastoff. Disabled09:00AST schedules are placeholders, not active maintenance and not verified DST-aware schedules. The first source pilot completed in24seconds with actual policy/product-read tool steps and two reported identity matches. Exact output export and browser-to-draft persistence still need verification.
- Customer GitHub sign-in and an authenticated /api/v1/me succeeded after the approved callback save and Worker2dfb839d-e622-4cb7-8d3b-55d09ffaa65a deployment. The existing private Collector connection also read the cohort after deployment.

## Recommended first configuration

Prefer Cursor Automations for both roles if the actual account/editor supports the included models and stops without paid usage. This is an implementation recommendation, pending pilots, not measured model-quality proof.

| Role | Initial candidate | Bound |
| --- | --- | --- |
| Source review | Composer2.5, standard speed | At most25 assigned source rows; no browsing; proposals with batch-unique keys |
| Browser research | Grok4.7, Medium, standard speed | One claimed source/product; at most5 navigations/eight minutes; private evidence/checkpoint |

Cursor allows model selection and no-repository automations with MCP. Use the existing private Collector over HTTP OAuth at https://arcex-api.peak-era-avern.workers.dev/mcp, not public/mcp. Keep repository access, GitHub/Slack posting tools and automation memory off. Read current context and the database every run. Do not export credentials into a VM or prompts. [Automations](https://cursor.com/docs/cloud-agent/automations), [HTTP MCP capabilities](https://cursor.com/docs/cloud-agent/capabilities).

Composer2.5 standard lists0.50USD/M input and2.50USD/M output tokens; Grok4.7 standard lists2USD/M input and6USD/M output. They draw from eligible included Cursor-model usage. Fast variants cost more. These published rates are not a per-task quote or permission to buy additional usage. On the inspected new Premium model, third-party models use prepaid credit rather than the included pool, so do not default to Claude/GPT/Gemini even where their nominal token rate is lower. [Models and pricing](https://cursor.com/docs/models-and-pricing), [Composer2.5](https://cursor.com/docs/models/cursor-composer-2-5).

Grok Bot is the fallback for browser work if a bounded pilot shows persistent authenticated sessions are necessary. It retains a shared cloud computer and supports routines, but model selection is automatic and the underlying model is not exposed. We cannot configure a cheap/strong model split inside Bot. Its usage can share a pool with Cursor; treat the accounts as possibly coupled until verified. [Bot overview](https://docs.x.ai/grok-bot/overview), [Bot model and billing FAQ](https://docs.x.ai/grok-bot/faq).

## Exact onboarding sequence

1. Verify the actual Cursor account's plan, included model choices and no-overage behavior. Keep auto top-up/on-demand off, buy no credit, and configure a zero additional-usage limit if the provider permits it. A limit that can be exceeded by an in-flight run is not a hard zero-spend guarantee.
2. Prepare the existing Collector's HTTP OAuth connection in Cursor. Obtain any runtime-required specific access-grant confirmation immediately before authorizing. This grants private research/draft tools, never publication or billing. Stop if authentication fails; no token-in-prompt or unrelated server fallback.
3. Prepare two disabled/draft automations from the adjacent prompt files, with no repository and memories off. Do not create duplicate schedules, activate them, merge accounts or buy an upgrade. Verify models in the real picker; do not infer availability from documentation.
4. Run one operator-assigned read-only source pilot and one bounded browser pilot using existing products. Verify actual database/source membership, screenshot bytes where relevant, checkpoints and included-only usage. Do not add a benchmark suite or restart broad discovery.
5. Resume the amended1,000-product/10-breakdown finish plan on the chosen platform. Initial candidate breadth should use bounded code/HTTP and text batches; browser effort goes to flows and ambiguous records. Batch08 correction must be merged/validated before import. Review remains required before acceptance/publication. Raise the old bootstrap attempt limits only deliberately after pilots, retain one browser claim at a time, and stop at included provider usage. Frequent scheduled model wakeups without an assigned batch or eligible job are not useful work.
6. Only after upfront review, set the selected replacement schedule to09:00America/Halifax. Confirm native timezone support and DST behavior; do not silently substitute fixed UTC or launch extra model runs to compensate. Keep old schedules paused. If the editor cannot meet the schedule/budget requirement, leave it disabled and report the exact blocker.

## Preserved pending work

ArcX Pro is the user-selected name, with monthly base prices11.99CAD in Canada and11.99USD elsewhere. Stripe supports one recurring price with manual currency options. The new catalog configuration, matching backend/display contract and regional sandbox verification are still pending; the earlier12USD sandbox checkout proves only the previous fixture. No live payments or tax service was activated. [Stripe manual multi-currency prices](https://docs.stripe.com/products-prices/manage-prices#multi-currency-prices).

The synthetic sandbox subscription still needs cancellation after the prior browser runtime stop. Its app sessions are deleted. Preserve that fact; do not call cleanup complete or delete its user while provider webhooks may still arrive.
