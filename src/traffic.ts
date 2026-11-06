import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./types";
import { now } from "./types";
import { parse } from "./lib";
import { requireCollector } from "./auth";
import { id, productHost, SHARED_HOSTING, siteOf } from "./contracts";

// Free daily popularity signal from the Tranco top-1M list (tranco-list.eu), fetched
// by the code-only HTTP collector. One row per product per day builds the chart history.
export const TRAFFIC_MEANING =
  "Daily rank of the product's site in the Tranco top-million list (tranco-list.eu), which combines several public popularity sources over 30 days. A lower number is more popular; no rank means outside the top million. It is a popularity tier, not visitor counts or revenue.";
const HISTORY_DAYS = 180;

export const trafficTier = (rank: number | null) =>
  rank === null
    ? "outside top 1M"
    : rank <= 1000
      ? "top 1K"
      : rank <= 10000
        ? "top 10K"
        : rank <= 100000
          ? "top 100K"
          : "top 1M";

/** Store listings and shared hosting have no site of their own to rank. */
export const rankableSite = (domain: string) =>
  domain.includes("/") || SHARED_HOSTING.test(productHost(domain))
    ? null
    : siteOf(domain);

const today = () => now().slice(0, 10);

export const collectorTraffic = new Hono<AppEnv>();
collectorTraffic.use("*", requireCollector);
collectorTraffic.get("/pending", async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT p.id,p.domain FROM products p
     WHERE p.status!='archived'
       AND NOT EXISTS(SELECT 1 FROM research_profiles r WHERE r.product_id=p.id AND r.status='excluded')
       AND NOT EXISTS(SELECT 1 FROM traffic_ranks t WHERE t.product_id=p.id AND t.source='tranco' AND t.observed_on=?)
     ORDER BY p.created_at,p.id LIMIT 3000`,
  )
    .bind(today())
    .all<{ id: string; domain: string }>();
  const items = result.results.flatMap((p) => {
    const site = rankableSite(p.domain);
    return site ? [{ productId: p.id, site }] : [];
  });
  return c.json({ observedOn: today(), items });
});

const ranksInput = z
  .object({
    listId: z.string().regex(/^[A-Z0-9]{3,12}$/),
    observedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    ranks: z
      .array(
        z
          .object({
            productId: id,
            site: z.string().min(3).max(253),
            rank: z.number().int().min(1).max(1_000_000).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
collectorTraffic.post("/ranks", async (c) => {
  const input = await parse(c, ranksInput);
  if (input.observedOn !== today())
    return c.json({ error: "Ranks are recorded for today only" }, 409);
  const time = now();
  const results = await c.env.DB.batch(
    input.ranks.map((r) =>
      c.env.DB.prepare(
        // Only an existing, non-archived product whose own site matches is recorded.
        `INSERT INTO traffic_ranks(product_id,source,observed_on,site,rank,list_id,created_at)
         SELECT p.id,'tranco',?,?,?,?,? FROM products p WHERE p.id=? AND p.status!='archived'
         ON CONFLICT(product_id,source,observed_on) DO UPDATE SET rank=excluded.rank,list_id=excluded.list_id,site=excluded.site`,
      ).bind(input.observedOn, r.site, r.rank, input.listId, time, r.productId),
    ),
  );
  return c.json({
    recorded: results.reduce((n, r) => n + (r.meta.changes ?? 0), 0),
  });
});

/** Public traffic block for a product page (callers check publication). */
export async function productTraffic(db: D1Database, productId: string) {
  const rows = await db
    .prepare(
      "SELECT observed_on,rank FROM traffic_ranks WHERE product_id=? AND source='tranco' ORDER BY observed_on DESC LIMIT ?",
    )
    .bind(productId, HISTORY_DAYS)
    .all<{ observed_on: string; rank: number | null }>();
  if (!rows.results.length) return null;
  const history = rows.results.reverse();
  const latest = history.at(-1)!;
  return {
    source: "tranco",
    meaning: TRAFFIC_MEANING,
    latest: {
      observedOn: latest.observed_on,
      rank: latest.rank,
      tier: trafficTier(latest.rank),
    },
    history,
  };
}
