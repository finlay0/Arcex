import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./types";
import { now } from "./types";
import { requireAdmin } from "./auth";
import { parse, fail, audit } from "./lib";
import { id, publicUrl, timestamp } from "./contracts";
import { insertEvidence, checkEvidence } from "./catalog";

export const watchInput = z
  .object({
    productId: id,
    platform: z.enum(["meta", "youtube", "x", "google"]),
    country: z
      .string()
      .regex(/^(ALL|[A-Z]{2})$/)
      .default("ALL"),
  })
  .strict();
export const scanInput = z
  .object({
    watchId: id,
    evidenceId: id,
    observedAt: timestamp,
    outcome: z.enum(["observed", "no_results", "blocked", "failed"]),
    notes: z.string().min(1).max(4000),
  })
  .strict();
const proof = {
  productId: id,
  observedAt: timestamp,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  destinationUrl: publicUrl,
  summary: z.string().min(10).max(4000),
};
export const adSightingInput = z
  .object({
    ...proof,
    libraryId: z.string().regex(/^\d{5,40}$/),
    advertiserName: z.string().min(1).max(200),
    country: z.string().regex(/^(ALL|[A-Z]{2})$/),
    activity: z.enum(["active", "inactive"]),
    reportedStartDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    creativeText: z.string().max(12000),
  })
  .strict();
export const creatorMentionInput = z
  .object({
    ...proof,
    sourceUrl: publicUrl,
    creator: z.string().min(1).max(200),
    placement: z.enum(["sponsored", "affiliate", "organic", "unknown"]),
    disclosureQuote: z.string().max(2000).default(""),
    timestampSeconds: z.number().int().min(0).max(86400).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      ["sponsored", "affiliate"].includes(v.placement) &&
      v.disclosureQuote.trim().length < 5
    )
      ctx.addIssue({
        code: "custom",
        message: "A paid-placement label requires an observed disclosure quote",
      });
    const url = new URL(v.sourceUrl),
      host = url.hostname.replace(/^www\./, "");
    const valid =
      (host === "youtube.com" &&
        url.pathname === "/watch" &&
        /^[\w-]{11}$/.test(url.searchParams.get("v") ?? "")) ||
      (host === "youtu.be" && /^\/[\w-]{11}$/.test(url.pathname)) ||
      (["x.com", "twitter.com"].includes(host) &&
        /^\/[^/]+\/status\/\d+$/.test(url.pathname));
    if (!valid)
      ctx.addIssue({
        code: "custom",
        message: "Use the exact YouTube video or X post URL",
      });
  });

export const launchSnapshotInput = z
  .object({
    ...proof,
    sourceUrl: publicUrl,
    platform: z.enum([
      "github",
      "x",
      "producthunt",
      "youtube",
      "tiktok",
      "instagram",
    ]),
    metric: z.enum([
      "stars",
      "upvotes",
      "comments",
      "views",
      "likes",
      "reposts",
      "followers",
    ]),
    count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((v, ctx) => {
    const u = new URL(v.sourceUrl),
      host = u.hostname.replace(/^www\./, "");
    const allowed =
      v.platform === "github"
        ? host === "github.com"
        : v.platform === "x"
          ? ["x.com", "twitter.com"].includes(host)
          : v.platform === "producthunt"
            ? host === "producthunt.com"
            : v.platform === "youtube"
              ? ["youtube.com", "youtu.be"].includes(host)
              : v.platform === "tiktok"
                ? host === "tiktok.com"
                : host === "instagram.com";
    if (!allowed)
      ctx.addIssue({
        code: "custom",
        message: "Snapshot source must match the stated platform",
      });
    if (v.platform === "github" && v.metric !== "stars")
      ctx.addIssue({
        code: "custom",
        message:
          "GitHub launch snapshots currently support repository stars only",
      });
  });

export const googleAdInput = z
  .object({
    ...proof,
    advertiserId: z.string().regex(/^AR\d{5,30}$/),
    creativeId: z.string().regex(/^CR\d{5,30}$/),
    advertiserName: z.string().min(1).max(200),
    country: z.string().regex(/^(ALL|[A-Z]{2})$/),
    format: z.enum(["text", "image", "video", "unknown"]),
    reportedLastShownDate: z.iso.date().optional(),
    creativeText: z.string().max(12000),
  })
  .strict();
export const shortFormInput = z
  .object({
    ...proof,
    sourceUrl: publicUrl,
    platform: z.enum(["youtube_shorts", "tiktok", "instagram_reels", "x"]),
    creator: z.string().min(1).max(200),
    hookStyle: z.string().min(1).max(200),
    observedHookQuote: z.string().min(1).max(2000),
    counts: z
      .object({
        views: z.number().int().min(0).optional(),
        likes: z.number().int().min(0).optional(),
        comments: z.number().int().min(0).optional(),
        reposts: z.number().int().min(0).optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((v, ctx) => {
    const u = new URL(v.sourceUrl),
      host = u.hostname.replace(/^www\./, "");
    const valid =
      v.platform === "youtube_shorts"
        ? host === "youtube.com" && /^\/shorts\/[\w-]{11}$/.test(u.pathname)
        : v.platform === "tiktok"
          ? host === "tiktok.com" && /^\/@[^/]+\/video\/\d+$/.test(u.pathname)
          : v.platform === "instagram_reels"
            ? host === "instagram.com" && /^\/reel\/[\w-]+\/?$/.test(u.pathname)
            : ["x.com", "twitter.com"].includes(host) &&
              /^\/[^/]+\/status\/\d+$/.test(u.pathname);
    if (!valid)
      ctx.addIssue({
        code: "custom",
        message:
          "Use the exact short-form video or X post URL matching its platform",
      });
  });
export async function recordGoogleAd(
  db: D1Database,
  input: z.infer<typeof googleAdInput>,
) {
  await matchingDestination(db, input.productId, input.destinationUrl);
  const sourceUrl = `https://adstransparency.google.com/advertiser/${input.advertiserId}/creative/${input.creativeId}?region=${input.country === "ALL" ? "anywhere" : input.country}`;
  const e = await insertEvidence(db, {
    productId: input.productId,
    sourceUrl,
    observedAt: input.observedAt,
    kind: "manual",
    contentHash: input.contentHash,
    summary: input.summary,
    payload: {
      ...input,
      platform: "google",
      scope:
        "Observed transparency listing and source-reported date; does not reveal bidding keywords, spend, revenue or conversion",
    },
  });
  await db
    .prepare(
      "INSERT INTO distribution_signals VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(
      crypto.randomUUID(),
      input.productId,
      e.id,
      "ad_observed",
      "google:" + input.creativeId,
      input.observedAt,
      sourceUrl,
      JSON.stringify({ ...input, platform: "google" }),
    )
    .run();
  return { evidenceId: e.id, status: e.status, sourceUrl };
}
export async function recordShortForm(
  db: D1Database,
  input: z.infer<typeof shortFormInput>,
) {
  await matchingDestination(db, input.productId, input.destinationUrl);
  const u = new URL(input.sourceUrl);
  u.search = "";
  u.hash = "";
  const e = await insertEvidence(db, {
    productId: input.productId,
    sourceUrl: input.sourceUrl,
    observedAt: input.observedAt,
    kind: "video",
    contentHash: input.contentHash,
    summary: input.summary,
    payload: {
      ...input,
      contentType: "short_form",
      placement: "unknown",
      scope:
        "Observed clip hook and visible counters, not proof of viral causality or paid promotion",
    },
  });
  await db
    .prepare(
      "INSERT INTO distribution_signals VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(
      crypto.randomUUID(),
      input.productId,
      e.id,
      "creator_mention",
      input.platform + ":" + u.href,
      input.observedAt,
      input.sourceUrl,
      JSON.stringify({
        ...input,
        contentType: "short_form",
        placement: "unknown",
      }),
    )
    .run();
  return { evidenceId: e.id, status: e.status };
}

export async function recordLaunchSnapshot(
  db: D1Database,
  input: z.infer<typeof launchSnapshotInput>,
) {
  await matchingDestination(db, input.productId, input.destinationUrl);
  const source = new URL(input.sourceUrl);
  source.hash = "";
  const externalId = input.platform + ":" + source.href + "#" + input.metric;
  const evidence = await insertEvidence(db, {
    productId: input.productId,
    sourceUrl: input.sourceUrl,
    observedAt: input.observedAt,
    kind: "manual",
    contentHash: input.contentHash,
    summary: input.summary,
    payload: {
      ...input,
      scope:
        "A displayed public counter at one observation time, not verified sales, users or conversion",
    },
  });
  await db
    .prepare(
      "INSERT INTO distribution_signals VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(
      crypto.randomUUID(),
      input.productId,
      evidence.id,
      "launch",
      externalId,
      input.observedAt,
      input.sourceUrl,
      JSON.stringify(input),
    )
    .run();
  return { evidenceId: evidence.id, status: evidence.status };
}

export function distributionSearch(
  platform: "meta" | "youtube" | "x" | "google",
  domain: string,
  country: string,
) {
  if (platform === "google")
    return (
      "https://adstransparency.google.com/?" +
      new URLSearchParams({
        region: country === "ALL" ? "anywhere" : country,
        domain,
      })
    );
  if (platform === "meta") {
    const url = new URL("https://www.facebook.com/ads/library/");
    url.search = new URLSearchParams({
      active_status: "all",
      ad_type: "all",
      country,
      q: domain,
      search_type: "keyword_unordered",
      media_type: "all",
    }).toString();
    return url.href;
  }
  if (platform === "youtube")
    return (
      "https://www.youtube.com/results?" +
      new URLSearchParams({ search_query: '"' + domain + '"' })
    );
  return (
    "https://x.com/search?" +
    new URLSearchParams({ q: '"' + domain + '"', f: "live" })
  );
}
async function product(db: D1Database, productId: string) {
  const p = await db
    .prepare(
      "SELECT domain,name FROM products WHERE id=? AND status!='archived'",
    )
    .bind(productId)
    .first<{ domain: string; name: string }>();
  if (!p) fail(404, "Active research product not found");
  return p;
}
async function matchingDestination(
  db: D1Database,
  productId: string,
  destination: string,
) {
  const p = await product(db, productId),
    host = new URL(destination).hostname.replace(/^www\./, "");
  if (host !== p.domain && !host.endsWith("." + p.domain))
    fail(
      422,
      "Observed destination must match the product domain; keyword similarity alone is insufficient",
    );
}
export async function registerWatch(
  db: D1Database,
  input: z.infer<typeof watchInput>,
) {
  const p = await product(db, input.productId);
  if (!["meta", "google"].includes(input.platform) && input.country !== "ALL")
    fail(422, "Country filtering is only supported for ad-library watches");
  const existing = await db
    .prepare(
      "SELECT * FROM distribution_watches WHERE product_id=? AND platform=? AND country=?",
    )
    .bind(input.productId, input.platform, input.country)
    .first();
  if (existing) return { ...existing, existing: true };
  const watchId = crypto.randomUUID(),
    sourceId = crypto.randomUUID(),
    time = now();
  const url = distributionSearch(input.platform, p.domain, input.country);
  await db.batch([
    db
      .prepare(
        "INSERT INTO sources(id,product_id,name,url,kind,interval_hours,enabled,next_run_at,created_at) VALUES (?,?,?,?,'browser',24,1,?,?)",
      )
      .bind(
        sourceId,
        input.productId,
        `${input.platform} distribution: ${p.name} (${input.country})`,
        url,
        time,
        time,
      ),
    db
      .prepare("INSERT INTO distribution_watches VALUES (?,?,?,?,?,?,?,?)")
      .bind(
        watchId,
        input.productId,
        sourceId,
        input.platform,
        input.country,
        p.domain,
        url,
        time,
      ),
  ]);
  return { id: watchId, sourceId, searchUrl: url, existing: false };
}
export async function recordScan(
  db: D1Database,
  input: z.infer<typeof scanInput>,
) {
  const watch = await db
    .prepare("SELECT product_id FROM distribution_watches WHERE id=?")
    .bind(input.watchId)
    .first<{ product_id: string }>();
  if (!watch) fail(404, "Distribution watch not found");
  await checkEvidence(db, input.evidenceId, watch.product_id);
  const e = await db
    .prepare(
      "SELECT e.source_url FROM evidence e JOIN evidence_observations o ON o.evidence_id=e.id WHERE e.id=? AND o.observed_at=?",
    )
    .bind(input.evidenceId, input.observedAt)
    .first<{ source_url: string }>();
  if (!e) fail(422, "Scan time must match a recorded observation");
  const expected = await db
    .prepare("SELECT search_url FROM distribution_watches WHERE id=?")
    .bind(input.watchId)
    .first<{ search_url: string }>();
  if (e.source_url !== expected!.search_url)
    fail(422, "Scan evidence must use the exact watch search URL");
  await db
    .prepare(
      "INSERT INTO distribution_scans VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(
      crypto.randomUUID(),
      input.watchId,
      input.observedAt,
      input.outcome,
      input.evidenceId,
      input.notes,
      now(),
    )
    .run();
  return {
    ok: true,
    scope:
      "A failed or empty search never marks an ad inactive or proves no ads exist",
  };
}
export async function recordAdSighting(
  db: D1Database,
  input: z.infer<typeof adSightingInput>,
) {
  await matchingDestination(db, input.productId, input.destinationUrl);
  const sourceUrl =
    "https://www.facebook.com/ads/library/?id=" + input.libraryId;
  const evidence = await insertEvidence(db, {
    productId: input.productId,
    sourceUrl,
    observedAt: input.observedAt,
    kind: "manual",
    contentHash: input.contentHash,
    summary: input.summary,
    payload: {
      ...input,
      platform: "meta",
      scope:
        "Reported ad state at a point in time; not spend, revenue, conversion or continuous delivery",
    },
  });
  await db
    .prepare(
      "INSERT INTO distribution_signals VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(
      crypto.randomUUID(),
      input.productId,
      evidence.id,
      "ad_observed",
      "meta:" + input.libraryId,
      input.observedAt,
      sourceUrl,
      JSON.stringify({ ...input, platform: "meta" }),
    )
    .run();
  return { evidenceId: evidence.id, status: evidence.status, sourceUrl };
}
export async function recordCreatorMention(
  db: D1Database,
  input: z.infer<typeof creatorMentionInput>,
) {
  await matchingDestination(db, input.productId, input.destinationUrl);
  const u = new URL(input.sourceUrl),
    host = u.hostname.replace(/^www\./, "");
  const externalId =
    host === "youtu.be"
      ? "youtube:" + u.pathname.slice(1)
      : host === "youtube.com"
        ? "youtube:" + u.searchParams.get("v")
        : "x:" + u.pathname.split("/").pop();
  const evidence = await insertEvidence(db, {
    productId: input.productId,
    sourceUrl: input.sourceUrl,
    observedAt: input.observedAt,
    kind: host === "x.com" || host === "twitter.com" ? "manual" : "video",
    contentHash: input.contentHash,
    summary: input.summary,
    payload: {
      ...input,
      scope:
        "Observed outbound link or mention; paid relationship requires explicit disclosure",
    },
  });
  await db
    .prepare(
      "INSERT INTO distribution_signals VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(
      crypto.randomUUID(),
      input.productId,
      evidence.id,
      "creator_mention",
      externalId,
      input.observedAt,
      input.sourceUrl,
      JSON.stringify(input),
    )
    .run();
  return { evidenceId: evidence.id, status: evidence.status };
}
export async function distributionStatus(
  db: D1Database,
  productId?: string,
  approvedOnly = false,
) {
  const watches = await db
    .prepare(
      "SELECT w.*,s.enabled,(SELECT outcome FROM distribution_scans d WHERE d.watch_id=w.id ORDER BY observed_at DESC LIMIT 1) last_outcome,(SELECT observed_at FROM distribution_scans d WHERE d.watch_id=w.id ORDER BY observed_at DESC LIMIT 1) last_checked_at FROM distribution_watches w JOIN sources s ON s.id=w.source_id WHERE (? IS NULL OR w.product_id=?) LIMIT 100",
    )
    .bind(productId ?? null, productId ?? null)
    .all();
  const ads = await db
    .prepare(
      `SELECT s.product_id,s.external_id, count(DISTINCT CASE WHEN json_extract(s.detail,'$.activity')='active' THEN substr(s.observed_at,1,10) END) observed_active_days,min(s.observed_at) first_observed,max(s.observed_at) last_observed, (SELECT json_extract(last.detail,'$.activity') FROM distribution_signals last JOIN evidence le ON le.id=last.evidence_id WHERE last.product_id=s.product_id AND last.external_id=s.external_id AND last.kind='ad_observed' ${approvedOnly ? "AND le.status='approved'" : ""} ORDER BY last.observed_at DESC LIMIT 1) last_reported_state FROM distribution_signals s JOIN evidence e ON e.id=s.evidence_id WHERE s.kind='ad_observed' AND json_extract(s.detail,'$.platform')='meta' AND (? IS NULL OR s.product_id=?) ${approvedOnly ? "AND e.status='approved'" : ""} GROUP BY s.product_id,s.external_id LIMIT 100`,
    )
    .bind(productId ?? null, productId ?? null)
    .all();
  const snapshots = await db
    .prepare(
      `SELECT s.product_id,s.external_id,s.observed_at,s.source_url,json_extract(s.detail,'$.count') count,json_extract(s.detail,'$.metric') metric FROM distribution_signals s JOIN evidence e ON e.id=s.evidence_id WHERE s.kind='launch' AND json_type(s.detail,'$.count')='integer' AND (? IS NULL OR s.product_id=?) ${approvedOnly ? "AND e.status='approved'" : ""} ORDER BY s.observed_at ASC LIMIT 1000`,
    )
    .bind(productId ?? null, productId ?? null)
    .all<{
      product_id: string;
      external_id: string;
      observed_at: string;
      source_url: string;
      count: number;
      metric: string;
    }>();
  const groups = new Map<string, typeof snapshots.results>();
  for (const row of snapshots.results) {
    const key = row.product_id + ":" + row.external_id;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const launchVelocity = [...groups.values()].map((group) => {
    const first = group[0],
      last = group[group.length - 1],
      hours =
        (Date.parse(last.observed_at) - Date.parse(first.observed_at)) /
        3600000;
    return {
      productId: first.product_id,
      externalId: first.external_id,
      metric: first.metric,
      sourceUrl: first.source_url,
      snapshots: group.length,
      firstObserved: first.observed_at,
      lastObserved: last.observed_at,
      firstCount: first.count,
      lastCount: last.count,
      change: group.length > 1 ? last.count - first.count : null,
      countPerHour:
        hours > 0
          ? Math.round(((last.count - first.count) / hours) * 10000) / 10000
          : null,
    };
  });
  return {
    watches: approvedOnly ? undefined : watches.results,
    ads: ads.results,
    launchVelocity,
    scope:
      "Distinct observed UTC days per ad, not continuous active days. Search failures and absence are not inactivity. No spend or revenue inference.",
  };
}
export const distributionAdmin = new Hono<AppEnv>();
distributionAdmin.use("*", requireAdmin);
distributionAdmin.get("/distribution", async (c) =>
  c.json(await distributionStatus(c.env.DB, c.req.query("productId"))),
);
distributionAdmin.post("/distribution/watches", async (c) => {
  const value = await registerWatch(c.env.DB, await parse(c, watchInput));
  await audit(c.env.DB, "admin", "distribution.watch", String(value.id));
  return c.json(value, 201);
});
distributionAdmin.post("/distribution/scans", async (c) =>
  c.json(await recordScan(c.env.DB, await parse(c, scanInput)), 201),
);
distributionAdmin.post("/distribution/ads", async (c) =>
  c.json(
    await recordAdSighting(c.env.DB, await parse(c, adSightingInput)),
    201,
  ),
);
distributionAdmin.post("/distribution/creators", async (c) =>
  c.json(
    await recordCreatorMention(c.env.DB, await parse(c, creatorMentionInput)),
    201,
  ),
);
distributionAdmin.post("/distribution/launch", async (c) =>
  c.json(
    await recordLaunchSnapshot(c.env.DB, await parse(c, launchSnapshotInput)),
    201,
  ),
);
distributionAdmin.post("/distribution/google", async (c) =>
  c.json(await recordGoogleAd(c.env.DB, await parse(c, googleAdInput)), 201),
);
distributionAdmin.post("/distribution/short-form", async (c) =>
  c.json(await recordShortForm(c.env.DB, await parse(c, shortFormInput)), 201),
);
