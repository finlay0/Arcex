# Cross-product libraries

Both endpoints use `limit` (1–100, default30), `offset` (0–10000), and return `{items, limit, offset, hasMore}`. Only published products and approved matching evidence are included. Filters shared by both: `product` (slug), `category`, `monetization` and `q` (product name/description). Filtering or listing does not unlock products or record account history.

## Screens

`GET /api/v1/screens` additionally accepts `stage`: landing, signup, onboarding, activation, paywall or retention. It lists actual approved images linked to approved steps on owner-reviewed Full Screens products. Missing or unapproved images and Signals Only products do not appear.

Each item has `id`, `position`, `title`, `stage`, `product` (id/slug/name/category/monetization), `locked`, `annotation`, `image_url`, and `evidence` (id/source_url/observed_at). For locked screens, annotation/image_url/evidence are null. A published open sample is accessible anonymously. Otherwise full content requires Insider or an existing unlock for that account/product today, using the same session or API-key access as product details. Opening product details is what consumes an allowance; listing never does. Image URLs use existing signed delivery and approval checks. Listing does not extend an unlock to another account or another day.

## Ads

`GET /api/v1/ads` is public and accepts `platform=meta|google` and `activity=active|inactive`. Items contain the latest approved observation per product/ad identity, its exact source/time, advertiser, creative text, destination, reported dates and product summary. Google observations may have null activity; the activity filter does not invent a current status for them. This endpoint does not create creative images when no image was captured.

Draft sightings do not replace reviewed observations. Retracting evidence removes that sighting; an earlier still-approved sighting can become the latest public observation. Product withdrawal removes its ads. State and dates are source observations at the reported time, not proof of current global activity, uninterrupted delivery, spend, conversion or revenue.

Indexed ad identity/time lookups avoid loading full history into application memory. Pagination uses one extra row for `hasMore`, with no full-history count scan or new paid service.
