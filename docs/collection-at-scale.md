# Collection at 10,000 products

Status: backend queue safeguards implemented; recurring collection remains paused. This is not a claim of live 10,000-product coverage.

## Work allocation

```mermaid
flowchart LR
  A[Shared launch and creator feeds] --> B[Code: fetch, normalize, deduplicate]
  C[Saved product sources on individual schedules] --> B
  B --> D[Unchanged: record last checked, stop]
  B --> E[New evidence: private draft]
  E --> F[Luna: bounded text qualification]
  F --> G[Selected visual or ambiguous work]
  H[Separate discovery allowance] --> G
  G --> I[Terra Medium in ChatGPT Work cloud]
  I --> J[Evidence, scans and durable checkpoints]
  J --> K[Owner review before publication]
```

A product is an identity, not one daily browser task. Its landing page, pricing, advertiser, creator mentions and authenticated funnel have different sources and freshness. Sources are unique by URL and collection kind: the same page may have a cheap HTTP check and a separate browser investigation, without duplicating the same kind per product. Each retains its own validator, baseline, schedule and claims. Shared feeds are still registered once per URL/kind. Shared channel ingestion and matching many product domains is the next provider optimization; the current YouTube adapter still performs bounded per-product searches. No broad cross-product fan-out is being claimed as implemented.

Work uses the database rather than chat memory. `research_context` returns the versioned playbook, current allowances, checkpoints and a paginated directory. `afterProductId` follows `nextProductCursor`. Directory order does not assign work. Before browser research, Work must `claim_capture_job`, read the returned source/product history, then complete/fail and checkpoint. Existing native prompts fetch this updated playbook at run start.

## Implemented limits

| Lane | Default attempts per UTC day | Concurrent leases | Maximum queued/running jobs |
| --- | ---: | ---: | ---: |
| Code HTTP/RSS | 1,000 | 4 | 900 |
| Terra browser monitoring | 12 | 1 | 80 |
| Discovery / upfront qualification | 3 | 1 | 20 |

These are conservative ceilings, not throughput promises. Claims and debits commit in one D1 transaction. Retries and reclaimed expired leases spend another attempt; completed work does not refund usage. Allowances reset at 00:00 UTC. Queues are selected oldest-due first, with at most 200 HTTP, 12 browser and 3 discovery additions per enqueue call. Unselected sources keep their overdue position. One source cannot accumulate multiple unfinished jobs. Separate queue space and allowances protect discovery from maintenance.

An admin can change the ceilings through `PATCH /api/v1/admin/collection/policy/{lane}` with `dailyLimit` and `concurrencyLimit`; zero pauses a lane. `GET /api/v1/admin/collection/status` reports usage, backlog and source check coverage. Claims recheck eligibility: archived products and unaccepted research cannot enter routine monitoring. An explicitly admin-prepared discovery source can investigate a pending product. Collectors cannot approve products or raise limits.

The HTTP runner (`pnpm collect <1-100>`) sends stored ETag/Last-Modified validators. A 304 or identical normalized evidence fingerprint updates source freshness without duplicating evidence or involving a model. Last checked and last changed are separate. Metadata hashes ignore changing server headers. After each three unchanged public-page checks, the interval doubles, up to eight times its configured base and at most 720 hours; a detected change restores the base. This checks HTML metadata, not all page content or an authenticated paywall. RSS retains its base cadence and reads at most 20 entries per response.

Blocked sources can be disabled for review through `fail_capture_job(blocked=true)`; 401/403 HTTP responses do this automatically. Other errors have bounded retries and source cooldowns. Terminal job history older than 30 days is pruned in bounded batches; source freshness and evidence remain. Daily usage is retained for 35 days. Raw screenshots are not silently deleted.

These application limits do not meter ChatGPT tokens or stop an agent from navigating outside its instructions. The saved playbook bounds each claimed investigation to five navigations/eight minutes. Account-level credits/overage settings must separately remain disabled for a strict spending boundary. There is no paid model/API fallback in this change.

## A realistic 10,000-product schedule

Illustrative capacity planning, not a cohort assignment or freshness guarantee:

| Cohort | Products | Public sources per product | Cadence | Average checks/day |
| --- | ---: | ---: | --- | ---: |
| Hot | 100 | 2 | Daily | 200 |
| Warm | 900 | 2 | Weekly | 257 |
| Long tail | 9,000 | 1 | Every 30 days | 300 |
| Total | 10,000 | | | About 757 |

Stagger due dates when importing a cohort. That leaves roughly 243 of the default 1,000 HTTP attempts for retries and shared feeds, before other provider/runtime constraints. The existing Worker timer can enqueue every twenty minutes when collection is enabled. The cloud HTTP runner described below can drain fifty jobs each hour; actual throughput still depends on source latency, failures, the job timeout and account-wide service limits. Recurring collection remains disabled.

## Cloud HTTP execution

`.github/workflows/collect-http.yml` runs the existing Node collector on a standard GitHub-hosted Linux runner in the public canonical repository. It adds no Worker, browser service or paid API. The workflow skips private repositories before allocating a runner, has read-only repository permissions, pins its setup actions and persists no checkout credential, dependency cache or artifact. Logs contain job IDs, counts and error codes; raw response bodies, private source metadata and credentials remain outside the logs. The encrypted repository secret `ARCEX_HTTP_COLLECTOR_TOKEN` supplies collector access, not admin or billing access.

The hourly schedule is prepared at minute17 and the workflow itself stays disabled pending upfront review. After review, enable the workflow and `COLLECTION_ENABLED`; a scheduled run independently checks the backend flag before claiming anything. It handles at most50 source attempts, stays inside the database's shared daily/concurrent allowances, and stops after25 minutes. Concurrency prevents overlapping workflow runs. Interrupted leases expire and retries consume another claim. A standard runner in a public repo is free; this is not permission to switch repository visibility or choose larger runners. No paid fallback is configured. GitHub can delay/drop scheduled runs and disables inactive public-repo schedules after60 days, so this is not a guaranteed freshness SLA.

For a supervised upfront run, temporarily enable the workflow, dispatch it with `mode=upfront` and a1–100 `limit`, then disable it again. `mode=status` only verifies private connectivity and the collection flag. An upfront dispatch is explicit manual work and can run while recurring collection is paused. It still uses the same source eligibility, claims, attempt budgets, HTTP/DNS protections and draft-only completion. Keep both ChatGPT Work's09:00 Halifax task and the old local automation paused; browser research remains actual Terra Medium Work execution.

References: [GitHub Actions public-runner billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [schedule limits](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [enable/disable a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).

Twelve browser source visits per day cannot refresh all ads, creator mentions and authenticated funnels across 10,000 products daily. Terra needs selection: important changes, priority products, rotating samples and deliberately selected deep teardowns. Each source retains its actual check time; missing coverage stays unknown/stale. No blanket daily-fresh claim.

## Model choice and costs

Official documentation checked November 4, 2026 lists GPT-6 Luna (not an established GPT-6.1 Luna here). Standard Work credit rates per million tokens are Luna 2.5 input / 12.5 output, versus GPT-6.1 Terra 25 / 125. The nominal input/output ratio is ten to one; retries, reasoning and task length change actual cost per useful result. Included subscription allowances are not determined by these rates alone. Work and Codex share usage.

Implemented workflow: code first; actual Luna Medium Work tasks classify supplied primary text; Terra Medium handles visual/browser work and uncertain cases. The18-record pilot found real naming/source ambiguities and preserved unknown company size. Follow-up batches are25 records, with self-contained instructions/source context and persisted JSON outputs. The existing Work chat keeps its selected model; the operator can submit/read through the desktop connector without browser setup for every batch. These are supervised initial qualification runs, not a paid API model router. No observed per-task cost ratio is claimed, and the saved recurring browser task remains Terra and paused.

- [OpenAI model roles](https://learn.chatgpt.com/docs/models)
- [OpenAI Work pricing and shared usage](https://learn.chatgpt.com/docs/pricing)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/): Free includes 5 million rows read and 100,000 written per day. Indexed writes count too; ceilings are account-wide, not a private allowance for Arcex.
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/): Free database maximum 500 MB, and 50 queries per Worker invocation. Queue completion bulk-inserts at most 30 REST evidence items (20 through the browser MCP), so evidence writes do not consume two statements per item.
- [YouTube quota](https://developers.google.com/youtube/data/getting-started#quota-usage): default 100 search calls/day and 10,000 other units/day. The current adapter uses lower application limits and caching; it cannot search 10,000 products daily.

The existing private evidence budget is 50 MB. Even one 200 KB capture for each of 10,000 products would need about 2 GB. A complete visual archive at that scale does not fit today's storage budget. Keep a selected Vault cohort and stop uploads at the cap; expansion needs an explicit later storage/budget decision. R2 remains disabled.

## Verification

A Miniflare test with 10,000 HTTP sources plus 32 browser/discovery sources verifies bounded enqueueing, preserved overdue work, atomic claim budgets, independent discovery allowance, blocked-source disable, and unchanged completion without new evidence. The same test covers private before/after metadata comparisons, retraction and a maximum-size bulk completion within the query budget. This exercises SQLite/runtime behavior, not live browser reliability or production throughput. Existing access, publication, billing and collector coverage remains. A real example.com fetch previously produced a draft, and its second conditional request returned 304 without another evidence record. No expensive browser run is needed to test these database invariants.
