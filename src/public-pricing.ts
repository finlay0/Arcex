import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./types";
import { now } from "./types";
import { id, publicUrl, timestamp } from "./contracts";
import { requireAdmin } from "./auth";
import { audit, decode, fail, page, parse } from "./lib";
import { verbatim } from "./verbatim";

export const publicPricingInput = z
  .object({
    evidenceIds: z.array(id).min(1).max(10),
    observedAt: timestamp,
    offers: z
      .array(
        z
          .object({
            name: verbatim("Offer name", "the pricing evidence summary", 120, 1),
            displayedPrice: verbatim("displayedPrice", "the pricing evidence summary", 500, 1)
              .describe("The price exactly as the page shows it, with nothing added: billing toggles and observations go in the evidence summary."),
            amount: z
              .string()
              .regex(/^\d{1,10}(?:\.\d{1,6})?$/)
              .nullable()
              .default(null),
            currency: z
              .string()
              .regex(/^[A-Z]{3}$/)
              .nullable()
              .default(null),
            interval: z
              .enum(["month", "year", "one_time", "usage", "free", "unknown"])
              .default("unknown"),
            limits: z
              .array(verbatim("Each limit", "the pricing evidence summary", 500, 1))
              .max(10)
              .default([])
              .describe("Plan limits as the page words them, one per item, without added labels."),
            sourceUrl: publicUrl,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export const PUBLISHED_PRICING = `pr.status='published' AND NOT EXISTS(SELECT 1 FROM json_each(pr.evidence_ids) j LEFT JOIN evidence pe ON pe.id=j.value AND pe.product_id=pr.product_id AND pe.status='approved' WHERE pe.id IS NULL)`;
export const PUBLIC_PRICING_SELECT = `SELECT pr.id,pr.offers,pr.evidence_ids,pr.observed_at FROM pricing_snapshots pr WHERE pr.product_id=? AND ${PUBLISHED_PRICING} ORDER BY pr.observed_at DESC,pr.created_at DESC,pr.id DESC`;
export function pricingResponse(row: Record<string, unknown> | undefined) {
  return row
    ? {
        ...row,
        offers: decode(row.offers as string),
        evidence_ids: decode(row.evidence_ids as string),
        meaning:
          "Observed public offers at the source timestamp. Unknown currency remains null; no currency conversion or verified purchase.",
      }
    : null;
}
/** Latest published pricing offers for the product aliased `p`, for list views. */
export const LATEST_PRICING_OFFERS = `(SELECT pr.offers FROM pricing_snapshots pr WHERE pr.product_id=p.id AND ${PUBLISHED_PRICING} ORDER BY pr.observed_at DESC,pr.created_at DESC,pr.id DESC LIMIT 1)`;

type StoredOffer = z.infer<typeof publicPricingInput>["offers"][number];
export type PricingSummary = {
  freePlan: boolean;
  /** The cheapest paid monthly or yearly plan, as the page displays it. */
  entry: {
    name: string;
    displayedPrice: string;
    monthlyAmount: number;
    currency: string | null;
  } | null;
  usageBased: boolean;
  customTier: boolean;
};

/**
 * Summarises observed offers without currency conversion: the entry plan is only
 * compared against plans in the same stated currency (or the same unstated one).
 */
export function pricingSummary(offers: StoredOffer[]): PricingSummary {
  const amount = (o: StoredOffer) => (o.amount === null ? null : Number(o.amount));
  const recurring = offers
    .filter((o) => (o.interval === "month" || o.interval === "year") && (amount(o) ?? 0) > 0)
    .map((o) => ({
      offer: o,
      monthly: o.interval === "year" ? amount(o)! / 12 : amount(o)!,
    }));
  const currency = recurring[0]?.offer.currency ?? null;
  const cheapest = recurring
    .filter((r) => r.offer.currency === currency)
    .sort((a, b) => a.monthly - b.monthly)[0];
  return {
    freePlan: offers.some((o) => o.interval === "free" || amount(o) === 0),
    entry: cheapest
      ? {
          name: cheapest.offer.name,
          displayedPrice: cheapest.offer.displayedPrice,
          monthlyAmount: Math.round(cheapest.monthly * 100) / 100,
          currency,
        }
      : null,
    usageBased: offers.some((o) => o.interval === "usage"),
    customTier: offers.some(
      (o) => o.amount === null && (o.interval === "unknown" || o.interval === "month" || o.interval === "year"),
    ),
  };
}

export const publicPricing = new Hono<AppEnv>();
publicPricing.get("/pricing/:slug", async (c) => {
  const product = await c.env.DB.prepare(
    "SELECT id FROM products WHERE slug=? AND status='published'",
  )
    .bind(c.req.param("slug"))
    .first<{ id: string }>();
  if (!product) fail(404, "Product not found");
  const { limit, offset } = page(c);
  const rows = await c.env.DB.prepare(
    PUBLIC_PRICING_SELECT + " LIMIT ? OFFSET ?",
  )
    .bind(product.id, limit, offset)
    .all<Record<string, unknown>>();
  return c.json({ items: rows.results.map(pricingResponse), limit, offset });
});
export const adminPublicPricing = new Hono<AppEnv>();
adminPublicPricing.use("*", requireAdmin);
adminPublicPricing.post("/products/:id/public-pricing", async (c) => {
  const input = await parse(c, publicPricingInput),
    productId = c.req.param("id");
  const evidenceIds = [...new Set(input.evidenceIds)],
    places = evidenceIds.map(() => "?").join(",");
  const evidence = await c.env.DB.prepare(
    `SELECT id,source_url FROM evidence WHERE product_id=? AND id IN (${places})`,
  )
    .bind(productId, ...evidenceIds)
    .all<{ id: string; source_url: string }>();
  if (evidence.results.length !== evidenceIds.length)
    fail(422, "Pricing evidence must belong to this product");
  const urls = new Set(evidence.results.map((e) => e.source_url));
  if (input.offers.some((o) => !urls.has(o.sourceUrl)))
    fail(422, "Every offer source must match linked evidence");
  if (
    !(await c.env.DB.prepare(
      `SELECT 1 FROM evidence_observations o JOIN evidence e ON e.id=o.evidence_id WHERE e.product_id=? AND e.id IN (${places}) AND o.observed_at=? LIMIT 1`,
    )
      .bind(productId, ...evidenceIds, input.observedAt)
      .first())
  )
    fail(422, "Pricing time must match an actual linked source observation");
  const snapshotId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO pricing_snapshots(id,product_id,evidence_ids,offers,observed_at,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(
      snapshotId,
      productId,
      JSON.stringify(evidenceIds),
      JSON.stringify(input.offers),
      input.observedAt,
      now(),
    )
    .run();
  await audit(c.env.DB, "admin", "pricing.draft", snapshotId, { productId });
  return c.json({ id: snapshotId, status: "draft" }, 201);
});
adminPublicPricing.put("/pricing/:id/status", async (c) => {
  const { status } = await parse(
    c,
    z.object({ status: z.enum(["draft", "published"]) }).strict(),
  );
  const row = await c.env.DB.prepare(
    "SELECT product_id,evidence_ids FROM pricing_snapshots WHERE id=?",
  )
    .bind(c.req.param("id"))
    .first<{ product_id: string; evidence_ids: string }>();
  if (!row) fail(404, "Pricing snapshot not found");
  if (status === "published") {
    const approved = await c.env.DB.prepare(
      "SELECT count(*) n FROM json_each(?) j JOIN evidence e ON e.id=j.value AND e.product_id=? AND e.status='approved'",
    )
      .bind(row.evidence_ids, row.product_id)
      .first<{ n: number }>();
    if (approved!.n !== decode<string[]>(row.evidence_ids).length)
      fail(409, "Approve all pricing source evidence before publishing");
  }
  await c.env.DB.prepare("UPDATE pricing_snapshots SET status=? WHERE id=?")
    .bind(status, c.req.param("id"))
    .run();
  await audit(c.env.DB, "admin", "pricing.status", c.req.param("id"), {
    status,
  });
  return c.json({ ok: true });
});
