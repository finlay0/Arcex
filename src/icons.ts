import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./types";
import { now, later } from "./types";
import { fail, parse, sha256 } from "./lib";
import { requireAdmin, requireCollector } from "./auth";
import { id, publicUrl } from "./contracts";
import { validIcon } from "./icon-format";

// Icons are fetched by the code-only HTTP collector, never a model. A found icon is
// refreshed monthly; a site without a usable icon is retried weekly.
const OK_REFRESH_DAYS = 30,
  MISSING_RETRY_DAYS = 7;

const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));

export const iconUrl = (
  origin: string,
  productId: string,
  sha: string | null | undefined,
) =>
  sha
    ? `${origin}/api/v1/icons/${encodeURIComponent(productId)}?v=${sha.slice(0, 16)}`
    : null;

function iconResponse(data: string, cache: string) {
  return new Response(fromBase64(data), {
    headers: {
      "content-type": "image/webp",
      "cache-control": cache,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}

export const collectorIcons = new Hono<AppEnv>();
collectorIcons.use("*", requireCollector);
collectorIcons.get("/pending", async (c) => {
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(25)
    .parse(c.req.query("limit"));
  const result = await c.env.DB.prepare(
    `SELECT p.id,p.url FROM products p LEFT JOIN product_icons i ON i.product_id=p.id
     WHERE p.status!='archived' AND (i.product_id IS NULL
       OR (i.status='ok' AND i.checked_at<?) OR (i.status='missing' AND i.checked_at<?))
     ORDER BY i.checked_at IS NOT NULL,i.checked_at,p.created_at,p.id LIMIT ?`,
  )
    .bind(
      later(-OK_REFRESH_DAYS * 86400),
      later(-MISSING_RETRY_DAYS * 86400),
      limit,
    )
    .all<{ id: string; url: string }>();
  return c.json({ items: result.results, limit });
});
const iconInput = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      sourceUrl: publicUrl,
      data: z.string().max(16_400).base64(),
    })
    .strict(),
  z
    .object({ status: z.literal("missing"), reason: z.string().max(300) })
    .strict(),
]);
collectorIcons.post("/:productId", async (c) => {
  const productId = id.parse(c.req.param("productId"));
  const input = await parse(c, iconInput);
  const time = now();
  if (input.status === "missing") {
    // A temporary failure never erases a good icon; it only postpones the next check.
    const r = await c.env.DB.prepare(
      `INSERT INTO product_icons(product_id,status,reason,checked_at)
       SELECT id,'missing',?,? FROM products WHERE id=?
       ON CONFLICT(product_id) DO UPDATE SET checked_at=excluded.checked_at,
         reason=excluded.reason`,
    )
      .bind(input.reason, time, productId)
      .run();
    if (!r.meta.changes) fail(404, "Product not found");
    return c.json({ status: "missing" });
  }
  const bytes = fromBase64(input.data);
  if (!validIcon(bytes))
    fail(422, "Icon must be a single 64x64 WebP image, at most 12 KB");
  const hash = await sha256(bytes.buffer as ArrayBuffer);
  const r = await c.env.DB.prepare(
    `INSERT INTO product_icons(product_id,status,data,sha256,size,source_url,reason,checked_at)
     SELECT id,'ok',?,?,?,?,NULL,? FROM products WHERE id=?
     ON CONFLICT(product_id) DO UPDATE SET status='ok',data=excluded.data,sha256=excluded.sha256,
       size=excluded.size,source_url=excluded.source_url,reason=NULL,checked_at=excluded.checked_at`,
  )
    .bind(input.data, hash, bytes.length, input.sourceUrl, time, productId)
    .run();
  if (!r.meta.changes) fail(404, "Product not found");
  return c.json({ status: "ok", sha256: hash, size: bytes.length });
});

// Public icons exist only for published products, matching every other public read.
export const publicIcons = new Hono<AppEnv>();
publicIcons.get("/:productId", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT i.data,i.sha256 FROM product_icons i JOIN products p ON p.id=i.product_id WHERE i.product_id=? AND i.status='ok' AND p.status='published'",
  )
    .bind(id.parse(c.req.param("productId")))
    .first<{ data: string; sha256: string }>();
  if (!row) fail(404, "Icon not found");
  const versioned = c.req.query("v") === row.sha256.slice(0, 16);
  return iconResponse(
    row.data,
    versioned ? "public, max-age=31536000, immutable" : "public, max-age=3600",
  );
});

export const adminIcons = new Hono<AppEnv>();
adminIcons.get("/products/:productId/icon", requireAdmin, async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT data FROM product_icons WHERE product_id=? AND status='ok'",
  )
    .bind(id.parse(c.req.param("productId")))
    .first<{ data: string }>();
  if (!row) fail(404, "Icon not found");
  return iconResponse(row.data, "private, no-store");
});
