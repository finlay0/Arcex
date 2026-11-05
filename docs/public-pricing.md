# Public offers and pricing history

Public pricing is separate from authenticated paywall behavior. `POST /api/v1/admin/products/:id/public-pricing` or private Collector `save_public_pricing` saves an immutable draft snapshot: linked evidence IDs, actual observation time, and observed offers. Each offer has its source URL, name, literal displayed price, optional decimal amount/currency, interval and stated limits. The source URL/time must match linked evidence for the same product.

An ambiguous dollar symbol does not establish USD. Currency remains null unless the primary material states it. Amounts are decimal strings rather than assumed cents; no conversion, tax calculation, purchase verification or revenue inference is performed. Free, one-time, usage-based and unknown intervals are distinct from monthly/yearly offers.

An admin explicitly publishes a snapshot through `PUT /api/v1/admin/pricing/:id/status`; every referenced source must be approved. Retraction removes public visibility immediately. The latest approved published observation appears as `publicPricing` on product details, including public Signals Only pages without spending a full-app allowance. `GET /api/v1/pricing/:slug` returns paginated reviewed history for published products. Without a reviewed snapshot, publicPricing is null.

Source evidence and pricing snapshots retain earlier versions. A new snapshot does not rewrite an older offer. The observation timestamp is material: the API reports what the page displayed then, not a promise of a currently purchasable offer or an inspected checkout flow.
