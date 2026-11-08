import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./types";
import { now, later } from "./types";
import { fail, parse, rateLimit, sha256 } from "./lib";
import { requireCollector } from "./auth";
import { id, productHost, publicUrl, siteOf, timestamp } from "./contracts";
import { insertEvidence } from "./catalog";
import { storeCapture } from "./media";
import { MEDIA_LIMIT_BYTES } from "./file-store";

// Screens are captured by a code-only headless browser on the free GitHub runner: the
// homepage and pricing page at desktop and mobile sizes, refreshed monthly so the
// product's look builds a visual history. Failed sites are retried weekly.
const REFRESH_DAYS = 30,
  RETRY_DAYS = 7,
  MAX_BYTES = 160_000,
  // A screen that looks the same as the last stored one is recorded as observed again
  // instead of stored twice; a fresh file is still kept at least every 180 days.
  SIMILAR_BITS = 8,
  KEEP_FILE_DAYS = 180,
  // Capture work stops well before the storage cap so other evidence still has room.
  STORAGE_STOP = 0.85;
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));

export const collectorCaptures = new Hono<AppEnv>();
collectorCaptures.use("*", requireCollector);

export const visualDistance = (a: string, b: string) => {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b),
    bits = 0;
  for (; x; x >>= 1n) bits += Number(x & 1n);
  return bits;
};

collectorCaptures.get("/pending", async (c) => {
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(60)
    .default(20)
    .parse(c.req.query("limit"));
  const used = await c.env.DB.prepare(
    "SELECT COALESCE(sum(size+thumbnail_size),0) bytes FROM assets",
  ).first<{ bytes: number }>();
  if ((used?.bytes ?? 0) > MEDIA_LIMIT_BYTES * STORAGE_STOP)
    return c.json({ items: [], viewports: VIEWPORTS, paused: "storage" });
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
    // 256-bit difference hash of a 17x16 greyscale thumbnail, from the runner.
    visualHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
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
  if (input.visualHash) {
    const last = await c.env.DB.prepare(
      `SELECT e.id,e.observed_at,json_extract(e.payload,'$.visualHash') visual,a.id asset FROM evidence e JOIN assets a ON a.evidence_id=e.id
       WHERE e.product_id=? AND e.kind='screenshot' AND json_extract(e.payload,'$.captureSource')='code'
         AND json_extract(e.payload,'$.page')=? AND json_extract(e.payload,'$.viewport')=?
       ORDER BY e.observed_at DESC LIMIT 1`,
    )
      .bind(productId, input.page, input.viewport)
      .first<{
        id: string;
        observed_at: string;
        visual: string | null;
        asset: string;
      }>();
    if (
      last?.visual &&
      last.observed_at > later(-KEEP_FILE_DAYS * 86400) &&
      visualDistance(last.visual, input.visualHash) <= SIMILAR_BITS
    ) {
      await c.env.DB.prepare(
        "INSERT INTO evidence_observations(evidence_id,observed_at) VALUES (?,?) ON CONFLICT DO NOTHING",
      )
        .bind(last.id, input.observedAt)
        .run();
      return c.json(
        { evidenceId: last.id, assetId: last.asset, unchanged: true },
        200,
      );
    }
  }
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
      ...(input.visualHash ? { visualHash: input.visualHash } : {}),
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
