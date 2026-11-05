# Account product history

Successful product-detail opens from a signed-in browser session remember that product. Signals-only pages, open samples and Insider opens are included; anonymous previews, rejected daily-limit opens and API-key calls are not recorded. Reopening updates the same row. The account retains its 100 most recent products across days and devices.

Use `GET /api/v1/me/history?limit=30&offset=0` with the existing session cookie. Response: `{ items, retainedLimit: 100, limit, offset }`. Each item has `id`, `slug`, `name`, `description`, `category`, `monetization`, `coverage_level` and `last_opened_at`. Newest opens come first. Products that are no longer published disappear from results. The response contains no screenshots or private evidence and does not unlock or reopen any product.

`DELETE /api/v1/me/history/:productId` removes one item. `DELETE /api/v1/me/history` clears the account history. Both require the session and valid application Origin. Reading or clearing history does not change today's app allowance, saved products or tracking settings. A later successful open records the product again.

This API does not import older browser-local history, infer old visits from daily unlock records, or add frontend UI.
