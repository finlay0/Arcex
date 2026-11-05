# Capture thumbnails

The owner runs `pnpm thumbnails 10 PRODUCT_ID` using the existing protected admin configuration. The optional product ID limits the batch; the maximum is25 captures per invocation. The command reads private originals in memory, verifies each source hash, generates a blurred WebP derivative at no more than160×100 pixels, and uploads it through the owner endpoint. Original images and secrets are not written to output files. Generation uses local code, not a model, Cloudflare Images or a paid service.

`GET /api/v1/media/thumbnails/pending?limit=10&productId=...` is owner-only. `POST /api/v1/media/:id/thumbnail` accepts the generator's single-frame lossy WebP format, at most20KB. The derivative is immutable per original; an identical repeat is unchanged. Quota reservation includes original and derivative bytes under the same50MB cap. Failed storage uploads release their reservation. Deleting the original also deletes its derivative.

Thumbnail generation does not approve evidence, captures or products. Public `GET /api/v1/media/:id/thumbnail` requires the parent asset and evidence to be approved and its product published with Full Screens coverage. Retraction is checked on every request; responses are not cached. The full original keeps its separate signed access route. A small preview is a product affordance, not a guarantee against copying or OCR.

Radar supplies `thumbnail_asset_id` and `thumbnail_url` only when an eligible generated derivative exists, preferring a paywall step where observed. Otherwise both remain null. Signals Only products do not acquire fabricated screenshot thumbnails. The frontend owns rendering.

Run generation during the owner review/import process. The daily Work collector remains draft-only; neither it nor a public API key receives new admin credentials. No thumbnail service or recurring job is provisioned.
