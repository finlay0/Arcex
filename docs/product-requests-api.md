# Product requests

`POST /api/v1/me/product-requests` accepts `{ "url": "https://product.com/" }` from a signed-in browser session. It records a private request for review, including products not yet in Radar. URLs use the shared public-HTTPS validator; query strings and fragments are discarded. Requests deduplicate per account and hostname, treating www and bare hostnames as the same domain. Subdomains remain distinct.

New requests return201 with `id`, `url`, `domain`, `status`, timestamps and `created:true`. Repeating a domain returns the existing request with200 and `created:false`, including when the account has reached its ten-pending-request limit. A new domain at that limit returns409 and `code:product_request_limit`.

`GET /api/v1/me/product-requests?limit=30&offset=0` returns only that account's items, pagination and `pendingLimit:10`. `published_product_slug` is provided only when the domain matches a published product. `DELETE /api/v1/me/product-requests/:id` withdraws only the caller's request. Mutations require the existing valid application Origin; API keys cannot manage requests.

Admin review: `GET /api/v1/admin/product-requests?status=pending` groups requests by domain and returns an example URL, counts and first/last requested timestamps. Insider demand is ranked first, excluding billing holds. `PATCH /api/v1/admin/product-requests/:domain` with `{ "status":"reviewed" }` or `{ "status":"declined" }` marks that domain's pending requests and writes an audit event. Reviewed requests free pending capacity but do not automatically reopen on repeat submissions.

Submission or review does not visit the URL, start an agent, create a product, accept research or publish anything. Listed-product breakdown requests retain their existing `PUT /api/v1/me/requests/:productId` route.
