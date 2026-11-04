# Discovery outcomes

Product research and the discovery ledger have different jobs. Product records retain evidence and assessments for relevant candidates. The private `discovery_leads` table also keeps rejected, duplicate and ambiguous source URLs, so a new cloud chat can avoid repeating failed qualification just because a lead never became a product.

An operator imports at most25 outcomes per `POST /api/v1/admin/research/leads` call. Each includes its actual primary URL, originating directory/launch URL, proposed name, outcome, rationale, next check, observation time, source hash, captured metadata, model and policy version. The endpoint is admin-only, preserves first-recorded time and rejects an older source snapshot replacing a newer one. It does not accept or publish products.

`lookup_discovery_leads` on the private Collector MCP accepts at most10 prospective URLs. It returns previous outcomes for the URLs/domains plus any existing product IDs. The result is bounded and explicitly flags truncation. It does not grant browsing permission; browser research still needs a claimed job. Collectors have read access to this ledger, with no ledger-write tool.

Exact discovery queries and directory/feed cursors remain in durable research checkpoints. Existing product/source IDs, HTTP validators, fingerprints and claim budgets control recurring monitoring. The ledger records what was examined; it does not make model classification a verified product fact, promise market completeness, or label unknown company size as small.
