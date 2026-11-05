import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Bindings } from "./types";
import { now } from "./types";
import { audit, decode, fail, page, parse } from "./lib";
import { requireAdmin, requirePro, requireSession, requireUser } from "./auth";
import { id, publicUrl } from "./contracts";
import { emailDeliveryStatus } from "./email-alerts";
import { CHANGE_EVIDENCE_APPROVED } from "./change-history";
export {
  signedMediaUrl,
  mediaLinkValid,
  signedLinkParameters,
  signedLinkValid,
} from "./signed-links";

export const DAILY_APP_LIMIT = 10;
export const FREE_WATCH_LIMIT = 3;
export const HISTORY_LIMIT = 100;
const OWN_PRODUCT_LIMIT = 10;
const PENDING_PRODUCT_REQUEST_LIMIT = 10;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const WEEKS_TRACKED = 12;
/**
 * D1 Free allows 50 queries per invocation. One refresh runs 7 reads, one write per product
 * and up to 2 more writes (34 at most), which stays well inside it. Runs every 10 minutes, which covers
 * 3,600 products a day and all 10,000 in under 3 days.
 */
export const METRICS_PAGE_SIZE = 25;
export const METRICS_CRON = "*/10 * * * *";

const utcDay = (time = Date.now()) => new Date(time).toISOString().slice(0, 10);
const nextUtcMidnight = () =>
  new Date(Math.floor(Date.now() / DAY_MS + 1) * DAY_MS).toISOString();

export async function appUsage(db: D1Database, userId: string) {
  const row = await db
    .prepare("SELECT count(*) n FROM vault_unlocks WHERE user_id=? AND day=?")
    .bind(userId, utcDay())
    .first<{ n: number }>();
  return {
    used: row!.n,
    limit: DAILY_APP_LIMIT,
    resetsAt: nextUtcMidnight(),
  };
}

/** Recent successful browser-session opens, independent of the daily access allowance. */
export async function rememberProduct(
  db: D1Database,
  userId: string,
  productId: string,
) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO product_view_history(user_id,product_id,last_opened_at) VALUES (?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET last_opened_at=excluded.last_opened_at",
      )
      .bind(userId, productId, now()),
    db
      .prepare(
        "DELETE FROM product_view_history WHERE user_id=? AND product_id NOT IN (SELECT product_id FROM product_view_history WHERE user_id=? ORDER BY last_opened_at DESC,product_id LIMIT ?)",
      )
      .bind(userId, userId, HISTORY_LIMIT),
  ]);
}

/** Spends one of today's apps. Reopening an app is free. Returns false at the limit. */
export async function unlockApp(
  db: D1Database,
  userId: string,
  productId: string,
) {
  const day = utcDay();
  await db
    .prepare(
      "INSERT INTO vault_unlocks(user_id,day,product_id,created_at) SELECT ?,?,?,? WHERE (SELECT count(*) FROM vault_unlocks WHERE user_id=? AND day=?)<? ON CONFLICT DO NOTHING",
    )
    .bind(userId, day, productId, now(), userId, day, DAILY_APP_LIMIT)
    .run();
  return !!(await db
    .prepare(
      "SELECT 1 FROM vault_unlocks WHERE user_id=? AND day=? AND product_id=?",
    )
    .bind(userId, day, productId)
    .first());
}

type SightingRow = {
  product_id: string;
  kind: "ad_observed" | "creator_mention";
  external_id: string;
  first_at: string;
  last_at: string;
  active_days: number;
  active_then: number;
  recent: number;
  prior: number;
  activity: string | null;
  placement: string | null;
};

/**
 * Refreshes one page of table metrics and moves a saved cursor, so every published product
 * gets its turn however large the catalog grows. Only the page's own signals are read.
 *
 * These describe distribution activity we observed, not product or business growth. Values
 * stay null when nothing comparable was collected, so a gap never reads as zero or decline.
 */
export async function refreshMetrics(db: D1Database) {
  const time = Date.now();
  const at = (days: number) => new Date(time - days * DAY_MS).toISOString();
  const t7 = at(7),
    t14 = at(14),
    t21 = at(21),
    t28 = at(28),
    t56 = at(56),
    tracked = at(WEEKS_TRACKED * 7);
  const state = await db
    .prepare("SELECT cursor FROM metrics_refresh_state WHERE id=1")
    .first<{ cursor: string }>();
  const products = await db
    .prepare(
      "SELECT id,created_at FROM products WHERE status='published' AND id>? ORDER BY id LIMIT ?",
    )
    .bind(state?.cursor ?? "", METRICS_PAGE_SIZE)
    .all<{ id: string; created_at: string }>();
  const ids = products.results.map((p) => p.id);
  const cycleComplete = ids.length < METRICS_PAGE_SIZE;
  const statements: D1PreparedStatement[] = [];

  if (ids.length) {
    const scope = ids.map(() => "?").join(",");
    const sightings = await db
      .prepare(
        `WITH scoped AS (
           SELECT s.id,s.product_id,s.kind,s.external_id,s.observed_at,s.detail
           FROM distribution_signals s JOIN evidence e ON e.id=s.evidence_id
           WHERE s.product_id IN (${scope}) AND s.kind IN ('ad_observed','creator_mention') AND e.status='approved'
         ), stats AS (
           SELECT product_id,kind,external_id,min(observed_at) first_at,max(observed_at) last_at,
             count(DISTINCT CASE WHEN json_extract(detail,'$.activity')='active' THEN substr(observed_at,1,10) END) active_days,
             sum(json_extract(detail,'$.activity')='active' AND observed_at>=? AND observed_at<=?) active_then,
             sum(observed_at>=?) recent,
             sum(observed_at>=? AND observed_at<?) prior
           FROM scoped GROUP BY product_id,kind,external_id
         ), latest AS (
           SELECT product_id,kind,external_id,detail,
             row_number() OVER (PARTITION BY product_id,kind,external_id ORDER BY observed_at DESC,id DESC) position
           FROM scoped
         )
         SELECT stats.*,json_extract(latest.detail,'$.activity') activity,json_extract(latest.detail,'$.placement') placement
         FROM stats JOIN latest USING(product_id,kind,external_id) WHERE latest.position=1`,
      )
      .bind(...ids, t21, t7, t28, t56, t28)
      .all<SightingRow>();
    const weekly = await db
      .prepare(
        `SELECT s.product_id,CAST((julianday(?)-julianday(s.observed_at))/7 AS INTEGER) week,count(DISTINCT s.external_id) n
         FROM distribution_signals s JOIN evidence e ON e.id=s.evidence_id
         WHERE s.product_id IN (${scope}) AND e.status='approved' AND s.kind IN ('ad_observed','creator_mention') AND s.observed_at>=?
         GROUP BY s.product_id,week`,
      )
      .bind(new Date(time).toISOString(), ...ids, tracked)
      .all<{ product_id: string; week: number; n: number }>();
    // A blocked or failed scan tells us nothing, so only completed ones count as collected.
    const scans = await db
      .prepare(
        `SELECT w.product_id,w.platform,d.observed_at FROM distribution_scans d
         JOIN distribution_watches w ON w.id=d.watch_id JOIN evidence e ON e.id=d.evidence_id
         WHERE w.product_id IN (${scope}) AND d.outcome IN ('observed','no_results') AND e.status='approved' AND d.observed_at>=?`,
      )
      .bind(...ids, tracked)
      .all<{ product_id: string; platform: string; observed_at: string }>();
    const totals = await db
      .prepare(
        `SELECT s.product_id,count(*) n FROM distribution_signals s JOIN evidence e ON e.id=s.evidence_id
         WHERE s.product_id IN (${scope}) AND e.status='approved' GROUP BY s.product_id`,
      )
      .bind(...ids)
      .all<{ product_id: string; n: number }>();
    const steps = await db
      .prepare(
        `SELECT f.product_id,count(*) n FROM funnel_steps f JOIN evidence e ON e.id=f.evidence_id
         WHERE f.product_id IN (${scope}) AND e.status='approved' GROUP BY f.product_id`,
      )
      .bind(...ids)
      .all<{ product_id: string; n: number }>();

    const countsOf = (rows: { product_id: string; n: number }[]) =>
      new Map(rows.map((r) => [r.product_id, r.n]));
    const observationCounts = countsOf(totals.results);
    const stepCounts = countsOf(steps.results);
    const updatedAt = now();
    const weekOf = (iso: string) =>
      Math.floor((time - new Date(iso).getTime()) / WEEK_MS);

    for (const product of products.results) {
      const rows = sightings.results.filter((r) => r.product_id === product.id);
      const ads = rows.filter((r) => r.kind === "ad_observed");
      const creators = rows.filter((r) => r.kind === "creator_mention");
      const productScans = scans.results.filter(
        (s) => s.product_id === product.id,
      );
      const isAdPlatform = (p: string) => p === "meta" || p === "google";
      const adTimes = [
        ...productScans
          .filter((s) => isAdPlatform(s.platform))
          .map((s) => s.observed_at),
        ...ads.map((r) => r.last_at),
      ];
      const creatorTimes = [
        ...productScans
          .filter((s) => !isAdPlatform(s.platform))
          .map((s) => s.observed_at),
        ...creators.map((r) => r.first_at),
      ];
      const collectedAds = adTimes.length > 0;
      const collectedCreators = creatorTimes.length > 0;
      const adsCurrent = adTimes.some((t) => t >= t14);
      const adsComparable = adTimes.some((t) => t >= t21 && t <= t7);
      const creatorsComparable = creatorTimes.some((t) => t <= t7);
      const activeAds = adsCurrent
        ? ads.filter((r) => r.activity === "active" && r.last_at >= t14).length
        : null;

      // Weeks with no completed collection stay null rather than reading as zero.
      const weekly12 = Array<number | null>(WEEKS_TRACKED).fill(null);
      const weeksCollected = new Set<number>();
      for (const scan of productScans) {
        const week = weekOf(scan.observed_at);
        if (week >= 0 && week < WEEKS_TRACKED) {
          weekly12[WEEKS_TRACKED - 1 - week] = 0;
          weeksCollected.add(week);
        }
      }
      for (const row of weekly.results) {
        if (
          row.product_id === product.id &&
          row.week >= 0 &&
          row.week < WEEKS_TRACKED
        ) {
          weekly12[WEEKS_TRACKED - 1 - row.week] = row.n;
          weeksCollected.add(row.week);
        }
      }
      const collectedIn = (from: number, to: number) =>
        [...weeksCollected].filter((w) => w >= from && w <= to).length;
      const recent = rows.filter((r) => r.recent > 0).length;
      const prior = rows.filter((r) => r.prior > 0).length;
      const comparable =
        collectedIn(0, 3) >= 3 && collectedIn(4, 7) >= 3 && prior >= 3;

      const firstSeen = rows.reduce(
        (first, r) => (r.first_at < first ? r.first_at : first),
        product.created_at,
      );
      const lastSeen = [
        ...rows.map((r) => r.last_at),
        ...productScans.map((s) => s.observed_at),
      ].reduce<string | null>(
        (last, t) => (!last || t > last ? t : last),
        null,
      );

      statements.push(
        db
          .prepare(
            `INSERT INTO product_metrics(product_id,observations,step_count,active_ads,ads_delta_7d,longest_ad_days,creators,sponsors,creators_delta_7d,activity_change_4w,activity_weekly,first_seen,last_seen,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(product_id) DO UPDATE SET observations=excluded.observations,step_count=excluded.step_count,active_ads=excluded.active_ads,ads_delta_7d=excluded.ads_delta_7d,longest_ad_days=excluded.longest_ad_days,creators=excluded.creators,sponsors=excluded.sponsors,creators_delta_7d=excluded.creators_delta_7d,activity_change_4w=excluded.activity_change_4w,activity_weekly=excluded.activity_weekly,first_seen=excluded.first_seen,last_seen=excluded.last_seen,updated_at=excluded.updated_at`,
          )
          .bind(
            product.id,
            observationCounts.get(product.id) ?? 0,
            stepCounts.get(product.id) ?? 0,
            activeAds,
            activeAds !== null && adsComparable
              ? activeAds - ads.filter((r) => r.active_then > 0).length
              : null,
            collectedAds
              ? ads.reduce((longest, r) => Math.max(longest, r.active_days), 0)
              : null,
            collectedCreators ? creators.length : null,
            collectedCreators
              ? creators.filter((r) => r.placement === "sponsored").length
              : null,
            creatorsComparable
              ? creators.filter((r) => r.first_at >= t7).length
              : null,
            comparable ? Math.round(((recent - prior) / prior) * 100) : null,
            JSON.stringify(weekly12),
            firstSeen,
            lastSeen,
            updatedAt,
          ),
      );
    }
  }

  const cursor = cycleComplete ? "" : ids[ids.length - 1];
  const stamp = now();
  statements.push(
    db
      .prepare(
        `INSERT INTO metrics_refresh_state(id,cursor,last_cycle_completed_at,updated_at) VALUES (1,?,?,?)
         ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,last_cycle_completed_at=COALESCE(excluded.last_cycle_completed_at,last_cycle_completed_at),updated_at=excluded.updated_at`,
      )
      .bind(cursor, cycleComplete ? stamp : null, stamp),
  );
  if (cycleComplete)
    statements.push(
      db
        .prepare("DELETE FROM vault_unlocks WHERE day<?")
        .bind(utcDay(time - 7 * DAY_MS)),
    );
  await db.batch(statements);
  return { processed: ids.length, cursor, cycleComplete };
}

const CHANGE_FEED = `SELECT c.id,c.kind,c.summary,c.observed_at,p.slug,p.name
  FROM product_changes c
  JOIN products p ON p.id=c.product_id
  JOIN evidence e ON e.id=c.evidence_id
  WHERE c.status='published' AND p.status='published' AND ${CHANGE_EVIDENCE_APPROVED}`;
const changeKind = z.enum([
  "ads",
  "creators",
  "paywall",
  "flow",
  "public_page",
]);

/** Publishes only while every evidence item behind a range is still approved. */
export const PUBLISHED_REVENUE_RANGE = `r.status='published' AND NOT EXISTS (
  SELECT 1 FROM json_each(r.evidence_ids) j
  LEFT JOIN evidence re ON re.id=j.value AND re.product_id=r.product_id AND re.status='approved'
  WHERE re.id IS NULL)`;
export const revenueRangeMeaning =
  "A manually entered range from the listed sources. Not reported revenue and not a computed estimate.";

export const insights = new Hono<AppEnv>();

insights.get("/changes", async (c) => {
  const { limit, offset } = page(c);
  const kind = c.req.query("kind");
  const parsed = kind ? changeKind.parse(kind) : null;
  const result = await c.env.DB.prepare(
    `${CHANGE_FEED} ${parsed ? "AND c.kind=?" : ""} ORDER BY c.observed_at DESC,c.id LIMIT ? OFFSET ?`,
  )
    .bind(...(parsed ? [parsed] : []), limit, offset)
    .all();
  return c.json({ items: result.results, limit, offset });
});

insights.get("/me/usage", requireUser, requireSession, async (c) => {
  const actor = c.get("actor");
  return c.json(
    actor.pro
      ? { insider: true, unlimited: true }
      : { insider: false, ...(await appUsage(c.env.DB, actor.userId)) },
  );
});

insights.get("/me/history", requireUser, requireSession, async (c) => {
  const { limit, offset } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT p.id,p.slug,p.name,p.description,p.category,p.monetization,p.coverage_level,h.last_opened_at
     FROM product_view_history h JOIN products p ON p.id=h.product_id
     WHERE h.user_id=? AND p.status='published' ORDER BY h.last_opened_at DESC,h.product_id LIMIT ? OFFSET ?`,
  )
    .bind(c.get("actor").userId, limit, offset)
    .all();
  return c.json({
    items: result.results,
    retainedLimit: HISTORY_LIMIT,
    limit,
    offset,
  });
});
insights.delete("/me/history", requireUser, requireSession, async (c) => {
  await c.env.DB.prepare("DELETE FROM product_view_history WHERE user_id=?")
    .bind(c.get("actor").userId)
    .run();
  return c.json({ ok: true });
});
insights.delete(
  "/me/history/:productId",
  requireUser,
  requireSession,
  async (c) => {
    await c.env.DB.prepare(
      "DELETE FROM product_view_history WHERE user_id=? AND product_id=?",
    )
      .bind(c.get("actor").userId, c.req.param("productId"))
      .run();
    return c.json({ ok: true });
  },
);

insights.get("/me/watches", requireUser, requireSession, async (c) => {
  const actor = c.get("actor");
  const { limit, offset } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT p.id,p.slug,p.name,p.description,m.active_ads,m.activity_change_4w FROM product_watches w
     JOIN products p ON p.id=w.product_id LEFT JOIN product_metrics m ON m.product_id=p.id
     WHERE w.user_id=? AND p.status='published' ORDER BY w.created_at DESC,p.id LIMIT ? OFFSET ?`,
  )
    .bind(actor.userId, limit, offset)
    .all();
  return c.json({
    items: result.results,
    watchLimit: actor.pro ? null : FREE_WATCH_LIMIT,
    limit,
    offset,
  });
});
insights.put(
  "/me/watches/:productId",
  requireUser,
  requireSession,
  async (c) => {
    const actor = c.get("actor");
    const productId = c.req.param("productId");
    if (
      !(await c.env.DB.prepare(
        "SELECT id FROM products WHERE id=? AND status='published'",
      )
        .bind(productId)
        .first())
    )
      fail(404, "Product not found");
    // Free accounts have a limit. Insider really has none.
    await (
      actor.pro
        ? c.env.DB.prepare(
            "INSERT INTO product_watches(user_id,product_id,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING",
          ).bind(actor.userId, productId, now())
        : c.env.DB.prepare(
            "INSERT INTO product_watches(user_id,product_id,created_at) SELECT ?,?,? WHERE (SELECT count(*) FROM product_watches WHERE user_id=?)<? ON CONFLICT DO NOTHING",
          ).bind(actor.userId, productId, now(), actor.userId, FREE_WATCH_LIMIT)
    ).run();
    if (
      !(await c.env.DB.prepare(
        "SELECT 1 FROM product_watches WHERE user_id=? AND product_id=?",
      )
        .bind(actor.userId, productId)
        .first())
    )
      return c.json(
        {
          error: `Free accounts can track ${FREE_WATCH_LIMIT} products`,
          code: "watch_limit",
          watchLimit: FREE_WATCH_LIMIT,
        },
        409,
      );
    return c.json({ ok: true });
  },
);
insights.delete(
  "/me/watches/:productId",
  requireUser,
  requireSession,
  async (c) => {
    await c.env.DB.prepare(
      "DELETE FROM product_watches WHERE user_id=? AND product_id=?",
    )
      .bind(c.get("actor").userId, c.req.param("productId"))
      .run();
    return c.json({ ok: true });
  },
);
insights.get("/me/watches/changes", requireUser, requireSession, async (c) => {
  const { limit, offset } = page(c);
  const result = await c.env.DB.prepare(
    `${CHANGE_FEED} AND c.product_id IN (SELECT product_id FROM product_watches WHERE user_id=?) ORDER BY c.observed_at DESC,c.id LIMIT ? OFFSET ?`,
  )
    .bind(c.get("actor").userId, limit, offset)
    .all();
  return c.json({ items: result.results, limit, offset });
});

insights.get("/me/products", requireUser, requireSession, async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT id,url,created_at FROM user_products WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
      )
        .bind(c.get("actor").userId, OWN_PRODUCT_LIMIT)
        .all()
    ).results,
  }),
);
insights.post("/me/products", requireUser, requireSession, async (c) => {
  const { url } = await parse(
    c,
    z
      .object({
        url: z
          .string()
          .url()
          .max(500)
          .refine((v) => v.startsWith("https://"), "Use an https URL"),
      })
      .strict(),
  );
  const userId = c.get("actor").userId,
    rowId = crypto.randomUUID();
  const result = await c.env.DB.prepare(
    "INSERT INTO user_products(id,user_id,url,created_at) SELECT ?,?,?,? WHERE (SELECT count(*) FROM user_products WHERE user_id=?)<? ON CONFLICT DO NOTHING",
  )
    .bind(rowId, userId, url, now(), userId, OWN_PRODUCT_LIMIT)
    .run();
  if (!result.meta.changes) fail(409, "Already added, or the limit is reached");
  return c.json({ id: rowId }, 201);
});
insights.delete("/me/products/:id", requireUser, requireSession, async (c) => {
  await c.env.DB.prepare("DELETE FROM user_products WHERE id=? AND user_id=?")
    .bind(c.req.param("id"), c.get("actor").userId)
    .run();
  return c.json({ ok: true });
});

insights.get("/me/alerts", requireUser, requireSession, async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT email_alerts FROM alert_settings WHERE user_id=?",
  )
    .bind(c.get("actor").userId)
    .first<{ email_alerts: number }>();
  return c.json({
    emailAlerts: !!row?.email_alerts,
    ...emailDeliveryStatus(c.env),
  });
});
insights.put("/me/alerts", requireUser, requireSession, async (c) => {
  const { emailAlerts } = await parse(
    c,
    z.object({ emailAlerts: z.boolean() }).strict(),
  );
  if (emailAlerts && !c.get("actor").pro)
    fail(403, "Insider is required for email alerts");
  await c.env.DB.prepare(
    "INSERT INTO alert_settings(user_id,email_alerts,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET email_alerts=excluded.email_alerts,updated_at=excluded.updated_at",
  )
    .bind(c.get("actor").userId, emailAlerts ? 1 : 0, now())
    .run();
  return c.json({
    ok: true,
    ...emailDeliveryStatus(c.env),
  });
});

insights.put(
  "/me/requests/:productId",
  requireUser,
  requireSession,
  async (c) => {
    const productId = c.req.param("productId");
    if (
      !(await c.env.DB.prepare(
        "SELECT id FROM products WHERE id=? AND status='published'",
      )
        .bind(productId)
        .first())
    )
      fail(404, "Product not found");
    await c.env.DB.prepare(
      "INSERT INTO breakdown_requests(user_id,product_id,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING",
    )
      .bind(c.get("actor").userId, productId, now())
      .run();
    return c.json({ ok: true });
  },
);

insights.get("/me/product-requests", requireUser, requireSession, async (c) => {
  const { limit, offset } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT r.id,r.url,r.domain,r.status,r.created_at,r.updated_at,p.slug published_product_slug
     FROM product_requests r LEFT JOIN products p ON p.domain=r.domain AND p.status='published'
     WHERE r.user_id=? ORDER BY r.created_at DESC,r.id LIMIT ? OFFSET ?`,
  )
    .bind(c.get("actor").userId, limit, offset)
    .all();
  return c.json({
    items: result.results,
    limit,
    offset,
    pendingLimit: PENDING_PRODUCT_REQUEST_LIMIT,
  });
});
insights.post(
  "/me/product-requests",
  requireUser,
  requireSession,
  async (c) => {
    const input = await parse(c, z.object({ url: publicUrl }).strict());
    const url = new URL(input.url);
    url.search = "";
    url.hash = "";
    const domain = url.hostname.replace(/^www\./, ""),
      userId = c.get("actor").userId,
      requestId = crypto.randomUUID(),
      time = now();
    const result = await c.env.DB.prepare(
      "INSERT INTO product_requests(id,user_id,url,domain,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE (SELECT count(*) FROM product_requests WHERE user_id=? AND status='pending')<? ON CONFLICT(user_id,domain) DO NOTHING",
    )
      .bind(
        requestId,
        userId,
        url.toString(),
        domain,
        time,
        time,
        userId,
        PENDING_PRODUCT_REQUEST_LIMIT,
      )
      .run();
    const saved = await c.env.DB.prepare(
      "SELECT id,url,domain,status,created_at,updated_at FROM product_requests WHERE user_id=? AND domain=?",
    )
      .bind(userId, domain)
      .first();
    if (!saved)
      return c.json(
        {
          error: "Pending product request limit reached",
          code: "product_request_limit",
          pendingLimit: PENDING_PRODUCT_REQUEST_LIMIT,
        },
        409,
      );
    return c.json(
      { ...saved, created: result.meta.changes > 0 },
      result.meta.changes ? 201 : 200,
    );
  },
);
insights.delete(
  "/me/product-requests/:id",
  requireUser,
  requireSession,
  async (c) => {
    await c.env.DB.prepare(
      "DELETE FROM product_requests WHERE id=? AND user_id=?",
    )
      .bind(c.req.param("id"), c.get("actor").userId)
      .run();
    return c.json({ ok: true });
  },
);

export const adminInsights = new Hono<AppEnv>();
adminInsights.use("*", requireAdmin);

adminInsights.post("/metrics/refresh", async (c) =>
  c.json(await refreshMetrics(c.env.DB)),
);
adminInsights.put("/products/:id/open-sample", async (c) => {
  const { open } = await parse(c, z.object({ open: z.boolean() }).strict());
  const result = await c.env.DB.prepare(
    "UPDATE products SET open_sample=? WHERE id=?",
  )
    .bind(open ? 1 : 0, c.req.param("id"))
    .run();
  if (!result.meta.changes) fail(404, "Product not found");
  await audit(c.env.DB, "admin", "product.open_sample", c.req.param("id"), {
    open,
  });
  return c.json({ ok: true });
});

// Ad longevity isn't an allowed basis, because it says nothing about dollars.
const ADS_AS_DOLLARS = /\bads?\b|advert|longevity/i;
const revenueInput = z
  .object({
    basis: z.enum([
      "reported_revenue",
      "public_pricing",
      "customer_count",
      "public_traffic",
      "app_store_rank",
      "assumption",
    ]),
    label: z.string().min(1).max(200),
    value: z.string().min(1).max(500),
    sourceUrl: publicUrl.optional(),
  })
  .strict()
  .refine((v) => !ADS_AS_DOLLARS.test(v.label + " " + v.value), {
    message: "Revenue ranges can't be derived from ad activity",
  })
  .refine((v) => v.basis === "assumption" || !!v.sourceUrl, {
    message: "Inputs other than assumptions need a source URL",
  });
const revenueRangeInput = z
  .object({
    lowUsd: z.number().int().min(0).max(1_000_000_000),
    highUsd: z.number().int().min(0).max(1_000_000_000),
    confidence: z.number().int().min(1).max(4),
    methodVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,39}$/),
    inputs: z.array(revenueInput).min(1).max(20),
    evidenceIds: z.array(id).min(1).max(20),
  })
  .strict()
  .refine((v) => v.highUsd >= v.lowUsd, "High must not be below low")
  .refine(
    (v) => v.inputs.some((i) => i.basis !== "assumption"),
    "At least one input must come from a source",
  );

async function recordRevenueHistory(db: D1Database, productId: string) {
  await db
    .prepare(
      "INSERT INTO revenue_range_history(id,product_id,low_usd,high_usd,confidence,method_version,inputs,evidence_ids,status,created_at) SELECT ?,product_id,low_usd,high_usd,confidence,method_version,inputs,evidence_ids,status,? FROM revenue_ranges WHERE product_id=?",
    )
    .bind(crypto.randomUUID(), now(), productId)
    .run();
}

// A saved range is always a draft. Publishing is a separate, explicit step.
adminInsights.put("/products/:id/revenue", async (c) => {
  const input = await parse(c, revenueRangeInput);
  const productId = c.req.param("id");
  if (
    !(await c.env.DB.prepare("SELECT id FROM products WHERE id=?")
      .bind(productId)
      .first())
  )
    fail(404, "Product not found");
  const owned = await c.env.DB.prepare(
    "SELECT count(*) n FROM evidence e JOIN json_each(?) j ON j.value=e.id WHERE e.product_id=?",
  )
    .bind(JSON.stringify(input.evidenceIds), productId)
    .first<{ n: number }>();
  if (owned!.n !== new Set(input.evidenceIds).size)
    fail(422, "Evidence must belong to this product");
  await c.env.DB.prepare(
    `INSERT INTO revenue_ranges(product_id,low_usd,high_usd,confidence,method_version,inputs,evidence_ids,status,updated_at) VALUES (?,?,?,?,?,?,?,'draft',?)
     ON CONFLICT(product_id) DO UPDATE SET low_usd=excluded.low_usd,high_usd=excluded.high_usd,confidence=excluded.confidence,method_version=excluded.method_version,inputs=excluded.inputs,evidence_ids=excluded.evidence_ids,status='draft',updated_at=excluded.updated_at`,
  )
    .bind(
      productId,
      input.lowUsd,
      input.highUsd,
      input.confidence,
      input.methodVersion,
      JSON.stringify(input.inputs),
      JSON.stringify(input.evidenceIds),
      now(),
    )
    .run();
  await recordRevenueHistory(c.env.DB, productId);
  await audit(c.env.DB, "admin", "revenue.draft", productId);
  return c.json({ ok: true, status: "draft" });
});
const publication = z
  .object({ status: z.enum(["draft", "published"]) })
  .strict();
adminInsights.put("/products/:id/revenue/status", async (c) => {
  const { status } = await parse(c, publication);
  const productId = c.req.param("id");
  const range = await c.env.DB.prepare(
    "SELECT evidence_ids FROM revenue_ranges WHERE product_id=?",
  )
    .bind(productId)
    .first<{ evidence_ids: string }>();
  if (!range) fail(404, "Revenue range not found");
  if (status === "published") {
    const evidenceIds = decode<string[]>(range.evidence_ids);
    const approved = await c.env.DB.prepare(
      "SELECT count(*) n FROM evidence e JOIN json_each(?) j ON j.value=e.id WHERE e.product_id=? AND e.status='approved'",
    )
      .bind(range.evidence_ids, productId)
      .first<{ n: number }>();
    if (approved!.n !== new Set(evidenceIds).size)
      fail(409, "Approve all evidence before publishing this range");
  }
  await c.env.DB.prepare(
    "UPDATE revenue_ranges SET status=?,updated_at=? WHERE product_id=?",
  )
    .bind(status, now(), productId)
    .run();
  await recordRevenueHistory(c.env.DB, productId);
  await audit(c.env.DB, "admin", "revenue.status", productId, { status });
  return c.json({ ok: true });
});
adminInsights.get("/products/:id/revenue/history", async (c) => {
  const { limit, offset } = page(c);
  const result = await c.env.DB.prepare(
    "SELECT * FROM revenue_range_history WHERE product_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
  )
    .bind(c.req.param("id"), limit, offset)
    .all<{ inputs: string; evidence_ids: string }>();
  return c.json({
    items: result.results.map((row) => ({
      ...row,
      inputs: decode(row.inputs),
      evidence_ids: decode(row.evidence_ids),
    })),
    limit,
    offset,
  });
});

adminInsights.get("/changes", async (c) => {
  const { limit, offset } = page(c);
  const status = publication.shape.status.parse(
    c.req.query("status") ?? "draft",
  );
  const productId = c.req.query("productId")
    ? id.parse(c.req.query("productId"))
    : null;
  const result = await c.env.DB.prepare(
    `SELECT c.*,e.source_url,e.summary AS evidence_summary,previous.summary AS previous_summary
     FROM product_changes c JOIN evidence e ON e.id=c.evidence_id
     LEFT JOIN evidence previous ON previous.id=c.previous_evidence_id
     WHERE c.status=? AND (? IS NULL OR c.product_id=?) ORDER BY c.observed_at DESC,c.id LIMIT ? OFFSET ?`,
  )
    .bind(status, productId, productId, limit, offset)
    .all();
  return c.json({ items: result.results, limit, offset });
});
adminInsights.put("/changes/:id", async (c) => {
  const input = await parse(
    c,
    z.object({ summary: z.string().min(5).max(280) }).strict(),
  );
  const result = await c.env.DB.prepare(
    "UPDATE product_changes SET summary=? WHERE id=? AND status='draft' RETURNING id",
  )
    .bind(input.summary, c.req.param("id"))
    .first();
  if (!result) fail(409, "Only an existing draft change can be edited");
  await audit(c.env.DB, "admin", "change.edit", c.req.param("id"));
  return c.json({ ok: true });
});
adminInsights.post("/products/:id/changes", async (c) => {
  const input = await parse(
    c,
    z
      .object({
        evidenceId: id,
        kind: changeKind,
        summary: z.string().min(5).max(280),
        observedAt: z.string().datetime(),
      })
      .strict(),
  );
  const productId = c.req.param("id");
  const evidence = await c.env.DB.prepare(
    "SELECT product_id FROM evidence WHERE id=?",
  )
    .bind(input.evidenceId)
    .first<{ product_id: string }>();
  if (evidence?.product_id !== productId)
    fail(422, "Evidence must belong to this product");
  const changeId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO product_changes(id,product_id,evidence_id,kind,summary,observed_at,created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      changeId,
      productId,
      input.evidenceId,
      input.kind,
      input.summary,
      input.observedAt,
      now(),
    )
    .run();
  await audit(c.env.DB, "admin", "change.draft", changeId);
  return c.json({ id: changeId, status: "draft" }, 201);
});
adminInsights.put("/changes/:id/status", async (c) => {
  const { status } = await parse(c, publication);
  const change = await c.env.DB.prepare(
    `SELECT (${CHANGE_EVIDENCE_APPROVED}) AS approved FROM product_changes c JOIN evidence e ON e.id=c.evidence_id WHERE c.id=?`,
  )
    .bind(c.req.param("id"))
    .first<{ approved: number }>();
  if (!change) fail(404, "Change not found");
  if (status === "published" && !change.approved)
    fail(409, "Approve all comparison evidence before publishing this change");
  await c.env.DB.prepare(
    "UPDATE product_changes SET status=?,published_at=CASE WHEN ?='published' THEN COALESCE(published_at,?) ELSE NULL END WHERE id=?",
  )
    .bind(status, status, now(), c.req.param("id"))
    .run();
  await audit(c.env.DB, "admin", "change.status", c.req.param("id"), {
    status,
  });
  return c.json({ ok: true });
});

adminInsights.get("/breakdown-requests", async (c) => {
  const { limit, offset } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT p.id,p.slug,p.name,count(*) requests,
      sum(EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id=r.user_id AND s.status IN ('active','trialing') AND s.period_end>?)) insider_requests
     FROM breakdown_requests r JOIN products p ON p.id=r.product_id
     GROUP BY p.id ORDER BY insider_requests DESC,requests DESC,p.id LIMIT ? OFFSET ?`,
  )
    .bind(now(), limit, offset)
    .all();
  return c.json({ items: result.results, limit, offset });
});

adminInsights.get("/product-requests", async (c) => {
  const { limit, offset } = page(c),
    status = z
      .enum(["pending", "reviewed", "declined"])
      .default("pending")
      .parse(c.req.query("status"));
  const result = await c.env.DB.prepare(
    `SELECT r.domain,min(r.url) example_url,count(*) requests,min(r.created_at) first_requested_at,max(r.created_at) last_requested_at,
     sum(EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id=r.user_id AND s.status IN ('active','trialing') AND s.period_end>? AND NOT EXISTS(SELECT 1 FROM billing_holds b WHERE b.user_id=r.user_id))) insider_requests
     FROM product_requests r WHERE r.status=? GROUP BY r.domain ORDER BY insider_requests DESC,requests DESC,first_requested_at,r.domain LIMIT ? OFFSET ?`,
  )
    .bind(now(), status, limit, offset)
    .all();
  return c.json({ items: result.results, status, limit, offset });
});
adminInsights.patch("/product-requests/:domain", async (c) => {
  const { status } = await parse(
    c,
    z.object({ status: z.enum(["reviewed", "declined"]) }).strict(),
  );
  const domain = z
    .string()
    .min(1)
    .max(253)
    .parse(c.req.param("domain"))
    .toLowerCase()
    .replace(/^www\./, "");
  const result = await c.env.DB.prepare(
    "UPDATE product_requests SET status=?,updated_at=? WHERE domain=? AND status='pending'",
  )
    .bind(status, now(), domain)
    .run();
  if (!result.meta.changes) fail(404, "No pending requests for this domain");
  await audit(c.env.DB, "admin", "product_request.review", domain, {
    status,
    requests: result.meta.changes,
  });
  return c.json({ ok: true, requests: result.meta.changes, status });
});
