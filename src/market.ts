import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./types";
import { category } from "./contracts";
import { TRAFFIC_MEANING, trafficTier } from "./traffic";

// Cross-market views over published products only. Every figure is an aggregate of public
// observations (site popularity rank, detected client-side technology, public store
// counters): none is revenue, visitor counts or proof of growth.

const CACHE_SECONDS = 3600;
const SMALL_SAMPLE = 20;
const OUTSIDE_TOP = 1_000_001;

/** Answers repeat reads from the edge cache so public traffic stays inside D1 Free reads. */
async function cached<T>(key: string, build: () => Promise<T>) {
  const cache =
    typeof caches === "undefined"
      ? undefined
      : (caches as unknown as { default: Cache }).default;
  const request = new Request("https://market-cache.arcex.internal/" + key);
  const hit = await cache?.match(request);
  if (hit) return (await hit.json()) as T;
  const value = await build();
  await cache?.put(
    request,
    Response.json(value, {
      headers: { "cache-control": `max-age=${CACHE_SECONDS}` },
    }),
  );
  return value;
}

const scopeInput = z.object({ category: category.optional() });
const scopeSql = (cat?: string) => (cat ? " AND p.category=?" : "");
const scopeArgs = (cat?: string) => (cat ? [cat] : []);

export async function marketOverview(db: D1Database, cat?: string) {
  const where = "p.status='published'" + scopeSql(cat);
  const [mix, ranks, stack, stores] = await db.batch([
    db
      .prepare(
        `SELECT p.category,p.monetization,count(*) n FROM products p WHERE ${where} GROUP BY 1,2`,
      )
      .bind(...scopeArgs(cat)),
    db
      .prepare(
        `SELECT t.rank FROM traffic_ranks t JOIN products p ON p.id=t.product_id
         WHERE ${where} AND t.source='tranco'
           AND t.observed_on=(SELECT max(observed_on) FROM traffic_ranks WHERE source='tranco' AND product_id=t.product_id)`,
      )
      .bind(...scopeArgs(cat)),
    db
      .prepare(
        `SELECT s.technology,s.category,count(*) n FROM product_stack s JOIN products p ON p.id=s.product_id
         WHERE ${where} AND s.removed_at IS NULL GROUP BY 1,2 ORDER BY n DESC,s.technology LIMIT 40`,
      )
      .bind(...scopeArgs(cat)),
    db
      .prepare(
        `SELECT s.store,count(DISTINCT s.product_id) n FROM store_listings s JOIN products p ON p.id=s.product_id
         WHERE ${where} AND s.enabled=1 GROUP BY 1 ORDER BY n DESC`,
      )
      .bind(...scopeArgs(cat)),
  ]);
  const mixRows = mix.results as {
    category: string;
    monetization: string;
    n: number;
  }[];
  const products = mixRows.reduce((sum, row) => sum + row.n, 0);
  const tally = (key: "category" | "monetization") =>
    Object.entries(
      mixRows.reduce<Record<string, number>>((acc, row) => {
        acc[row[key]] = (acc[row[key]] ?? 0) + row.n;
        return acc;
      }, {}),
    )
      .map(([value, n]) => ({ value, products: n, share: n / products }))
      .sort((a, b) => b.products - a.products);
  const rankRows = ranks.results as { rank: number | null }[];
  const tiers = rankRows.reduce<Record<string, number>>((acc, row) => {
    const tier = trafficTier(row.rank);
    acc[tier] = (acc[tier] ?? 0) + 1;
    return acc;
  }, {});
  return {
    scope: { category: cat ?? null, products },
    note:
      products < SMALL_SAMPLE
        ? "Small sample: shares can move a lot as products are added."
        : null,
    categories: tally("category"),
    monetization: tally("monetization"),
    traffic: {
      meaning: TRAFFIC_MEANING,
      ranked: rankRows.length,
      tiers: Object.entries(tiers).map(([tier, n]) => ({
        tier,
        products: n,
        share: n / Math.max(rankRows.length, 1),
      })),
    },
    stack: {
      meaning:
        "Technologies detected in each product's public homepage code. Tools loaded later through a tag manager may be missed.",
      items: (
        stack.results as { technology: string; category: string; n: number }[]
      ).map((row) => ({
        technology: row.technology,
        category: row.category,
        products: row.n,
        share: row.n / Math.max(products, 1),
      })),
    },
    stores: stores.results as { store: string; n: number }[],
  };
}

const moversInput = z.object({
  metric: z.enum(["traffic", "store_ratings"]).default("traffic"),
  window: z.coerce
    .number()
    .int()
    .refine((n) => n === 7 || n === 30, "Window is 7 or 30 days")
    .default(30),
  direction: z.enum(["up", "down"]).default("up"),
  category: category.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
type MoversInput = z.infer<typeof moversInput>;

const daysBefore = (day: string, days: number) =>
  new Date(Date.parse(day + "T00:00:00Z") - days * 86_400_000)
    .toISOString()
    .slice(0, 10);

export async function marketMovers(db: D1Database, input: MoversInput) {
  const where = "p.status='published'" + scopeSql(input.category);
  if (input.metric === "traffic") {
    const latest = await db
      .prepare(
        "SELECT max(observed_on) day,min(observed_on) first FROM traffic_ranks WHERE source='tranco'",
      )
      .first<{ day: string | null; first: string | null }>();
    const base = {
      metric: input.metric,
      window: input.window,
      meaning:
        "Change in Tranco top-million rank between the latest day and the day nearest the window start. Climbing rank means more relative web popularity, not more visitors or revenue. Entering the list counts from just outside the top million.",
      historyStartsOn: latest?.first ?? null,
    };
    if (!latest?.day) return { ...base, until: null, since: null, items: [] };
    const target = daysBefore(latest.day, input.window);
    // The comparison day is the latest observation on or before the window start, at most a week older.
    const rows = await db
      .prepare(
        `SELECT p.slug,p.name,p.category,n.rank now_rank,o.rank then_rank,o.observed_on then_on
         FROM traffic_ranks n JOIN products p ON p.id=n.product_id
         JOIN traffic_ranks o ON o.product_id=n.product_id AND o.source='tranco'
           AND o.observed_on=(SELECT max(observed_on) FROM traffic_ranks WHERE source='tranco' AND product_id=n.product_id AND observed_on<=? AND observed_on>=?)
         WHERE n.source='tranco' AND n.observed_on=? AND ${where}
           AND NOT (n.rank IS NULL AND o.rank IS NULL)`,
      )
      .bind(
        target,
        daysBefore(target, 7),
        latest.day,
        ...scopeArgs(input.category),
      )
      .all<{
        slug: string;
        name: string;
        category: string;
        now_rank: number | null;
        then_rank: number | null;
        then_on: string;
      }>();
    const items = rows.results
      .map((row) => ({
        slug: row.slug,
        name: row.name,
        category: row.category,
        rankNow: row.now_rank,
        rankThen: row.then_rank,
        comparedOn: row.then_on,
        // Positive is a climb: an order-of-magnitude move is 1.0.
        change:
          Math.round(
            Math.log10(
              (row.then_rank ?? OUTSIDE_TOP) / (row.now_rank ?? OUTSIDE_TOP),
            ) * 1000,
          ) / 1000,
        tierNow: trafficTier(row.now_rank),
      }))
      .filter((item) =>
        input.direction === "up" ? item.change > 0 : item.change < 0,
      )
      .sort((a, b) =>
        input.direction === "up" ? b.change - a.change : a.change - b.change,
      )
      .slice(0, input.limit);
    return { ...base, until: latest.day, since: target, items };
  }
  const rows = await db
    .prepare(
      `SELECT p.slug,p.name,p.category,l.store,
         (SELECT rating_count FROM store_listing_snapshots WHERE listing_id=l.id ORDER BY observed_on DESC LIMIT 1) now_count,
         (SELECT observed_on FROM store_listing_snapshots WHERE listing_id=l.id ORDER BY observed_on DESC LIMIT 1) now_on,
         (SELECT rating_count FROM store_listing_snapshots WHERE listing_id=l.id AND observed_on<=date('now',?) ORDER BY observed_on DESC LIMIT 1) then_count,
         (SELECT observed_on FROM store_listing_snapshots WHERE listing_id=l.id AND observed_on<=date('now',?) ORDER BY observed_on DESC LIMIT 1) then_on
       FROM store_listings l JOIN products p ON p.id=l.product_id
       WHERE l.enabled=1 AND ${where} LIMIT 2000`,
    )
    .bind(
      `-${input.window} days`,
      `-${input.window} days`,
      ...scopeArgs(input.category),
    )
    .all<{
      slug: string;
      name: string;
      category: string;
      store: string;
      now_count: number | null;
      now_on: string | null;
      then_count: number | null;
      then_on: string | null;
    }>();
  const items = rows.results
    .filter(
      (row) =>
        row.now_count !== null &&
        row.then_count !== null &&
        row.then_on! >= daysBefore(row.now_on!, input.window + 7),
    )
    .map((row) => ({
      slug: row.slug,
      name: row.name,
      category: row.category,
      store: row.store,
      ratingsNow: row.now_count!,
      ratingsThen: row.then_count!,
      comparedOn: row.then_on,
      added: row.now_count! - row.then_count!,
      growth:
        row.then_count! > 0
          ? Math.round(
              ((row.now_count! - row.then_count!) / row.then_count!) * 1000,
            ) / 1000
          : null,
    }))
    .filter((item) =>
      input.direction === "up" ? item.added > 0 : item.added < 0,
    )
    .sort((a, b) =>
      input.direction === "up" ? b.added - a.added : a.added - b.added,
    )
    .slice(0, input.limit);
  return {
    metric: input.metric,
    window: input.window,
    meaning:
      "Ratings added on public store listings over the window. Ratings counts are a public engagement counter, not downloads, users or revenue.",
    items,
  };
}

export const market = new Hono<AppEnv>();

market.get("/market/overview", async (c) => {
  const { category: cat } = scopeInput.parse({
    category: c.req.query("category") || undefined,
  });
  return c.json(
    await cached("overview/" + (cat ?? "all"), () =>
      marketOverview(c.env.DB, cat),
    ),
  );
});

market.get("/market/movers", async (c) => {
  const input = moversInput.parse({
    metric: c.req.query("metric") || undefined,
    window: c.req.query("window") || undefined,
    direction: c.req.query("direction") || undefined,
    category: c.req.query("category") || undefined,
    limit: c.req.query("limit") || undefined,
  });
  const key = [
    "movers",
    input.metric,
    input.window,
    input.direction,
    input.category ?? "all",
    input.limit,
  ].join("/");
  return c.json(await cached(key, () => marketMovers(c.env.DB, input)));
});
