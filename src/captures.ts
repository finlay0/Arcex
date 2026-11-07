import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./types";
import { now, later } from "./types";
import { fail, parse, rateLimit, sha256 } from "./lib";
import { requireCollector } from "./auth";
import { id, productHost, publicUrl, siteOf, timestamp } from "./contracts";
import { insertEvidence } from "./catalog";
import { storeCapture } from "./media";

// Screens are captured by a code-only headless browser on the free GitHub runner: the
// homepage and pricing page at desktop and mobile sizes, refreshed monthly so the
// product's look builds a visual history. Failed sites are retried weekly.
const REFRESH_DAYS = 30,
  RETRY_DAYS = 7,
  MAX_BYTES = 160_000;
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));

export const collectorCaptures = new Hono<AppEnv>();
collectorCaptures.use("*", requireCollector);

collectorCaptures.get("/pending", async (c) => {
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(60)
    .default(20)
    .parse(c.req.query("limit"));
  // Researched and published products first: their screens are what reviews and pages use.
  const result = await c.env.DB.prepare(
    `SELECT p.id,p.url,p.domain FROM products p
     LEFT JOIN research_profiles r ON r.product_id=p.id
     LEFT JOIN capture_checks k ON k.product_id=p.id
     WHERE p.status!='archived' AND COALESCE(r.status,'')!='excluded' AND instr(p.domain,'/')=0
       AND (k.product_id IS NULL OR (k.status='ok' AND k.checked_at<?) OR (k.status='failed' AND k.checked_at<?))
     ORDER BY k.product_id IS NOT NULL,(p.status='published') DESC,(r.deep_checked_at IS NOT NULL) DESC,p.created_at,p.id
     LIMIT ?`,
  )
    .bind(later(-REFRESH_DAYS * 86400), later(-RETRY_DAYS * 86400), limit)
    .all<{ id: string; url: string; domain: string }>();
  return c.json({ items: result.results, viewports: VIEWPORTS });
});

const captureInput = z
  .object({
    page: z.enum(["home", "pricing"]),
    viewport: z.enum(["desktop", "mobile"]),
    sourceUrl: publicUrl,
    observedAt: timestamp,
    title: z.string().max(300).default(""),
    data: z
      .string()
      .min(100)
      .max(Math.ceil((MAX_BYTES * 4) / 3) + 4),
  })
  .strict();

collectorCaptures.post("/:productId", async (c) => {
  const productId = id.parse(c.req.param("productId"));
  const input = await parse(c, captureInput);
  await rateLimit(c.env.DB, "code-captures", 4000, 86400);
  const product = await c.env.DB.prepare(
    "SELECT domain FROM products WHERE id=? AND status!='archived'",
  )
    .bind(productId)
    .first<{ domain: string }>();
  if (!product) fail(404, "Product not found");
  // Only the product's own site: a capture of another site is never stored for it.
  const host = new URL(input.sourceUrl).hostname.replace(/^www\./, "");
  if (siteOf(host) !== siteOf(productHost(product.domain)))
    fail(422, "Capture must be of the product's own site");
  if (input.observedAt < later(-3600))
    fail(422, "Capture must be uploaded within an hour");
  const bytes = fromBase64(input.data);
  if (bytes.byteLength > MAX_BYTES) fail(413, "Capture exceeds 160 KB");
  const hash = await sha256(bytes.buffer);
  const size = VIEWPORTS[input.viewport];
  const evidence = await insertEvidence(c.env.DB, {
    productId,
    sourceUrl: input.sourceUrl,
    observedAt: input.observedAt,
    kind: "screenshot",
    contentHash: hash,
    summary: `${input.page === "home" ? "Homepage" : "Pricing page"} at ${input.viewport} ${size.width}x${size.height}${input.title ? `: ${input.title.slice(0, 200)}` : ""}`,
    payload: {
      captureSource: "code",
      page: input.page,
      viewport: input.viewport,
      width: size.width,
      height: size.height,
      scope:
        "Public page captured by a headless browser without signing in. Cookie banners may be hidden. Not an authenticated or checkout view.",
    },
  });
  const evidenceId = evidence.id;
  const existing = await c.env.DB.prepare(
    "SELECT id FROM assets WHERE evidence_id=? AND sha256=?",
  )
    .bind(evidenceId, hash)
    .first<{ id: string }>();
  // The same image observed again keeps its existing file.
  const assetId = existing
    ? existing.id
    : (await storeCapture(c.env, evidenceId, "image/webp", bytes.buffer)).id;
  return c.json({ evidenceId, assetId, unchanged: !!existing }, 201);
});

const checkInput = z
  .object({
    status: z.enum(["ok", "failed"]),
    captured: z.number().int().min(0).max(8),
    reason: z.string().max(300).optional(),
  })
  .strict();

collectorCaptures.post("/:productId/check", async (c) => {
  const productId = id.parse(c.req.param("productId"));
  const input = await parse(c, checkInput);
  await c.env.DB.prepare(
    `INSERT INTO capture_checks(product_id,status,reason,captured,checked_at)
     SELECT id,?,?,?,? FROM products WHERE id=?
     ON CONFLICT(product_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,captured=excluded.captured,checked_at=excluded.checked_at`,
  )
    .bind(input.status, input.reason ?? null, input.captured, now(), productId)
    .run();
  return c.json({ recorded: true });
});
