import { Hono } from "hono";
import { z } from "zod";
import type { Actor, AppEnv } from "./types";
import { now } from "./types";
import {
  replaceFunnel,
  replacePaywall,
  flowHistory,
  flowVersion,
} from "./flow-history";
import { PUBLIC_PRICING_SELECT, pricingResponse } from "./public-pricing";
import { iconUrl } from "./icons";
import { productTraffic, trafficTier } from "./traffic";
import { audit, decode, fail, page, parse, rateLimit } from "./lib";
import {
  optionalUser,
  requireAdmin,
  requireBlueprintReader,
  requireUser,
} from "./auth";
import {
  appUsage,
  DAILY_APP_LIMIT,
  PUBLISHED_REVENUE_RANGE,
  revenueRangeMeaning,
  signedMediaUrl,
  signedLinkParameters,
  signedLinkValid,
  unlockApp,
  rememberProduct,
} from "./insights";
import {
  productInput,
  evidenceInput,
  signalInput,
  funnelInput,
  paywallInput,
  blueprintInput,
  arenaInput,
  status,
  category,
  monetization,
  productKey,
} from "./contracts";

export async function productExists(db: D1Database, productId: string) {
  if (
    !(await db
      .prepare("SELECT id FROM products WHERE id=?")
      .bind(productId)
      .first())
  )
    fail(404, "Product not found");
}
export async function checkEvidence(
  db: D1Database,
  evidenceId: string,
  productId: string,
  approved = false,
) {
  const row = await db
    .prepare("SELECT product_id,status FROM evidence WHERE id=?")
    .bind(evidenceId)
    .first<{ product_id: string; status: string }>();
  if (!row || row.product_id !== productId)
    fail(422, "Evidence must belong to this product");
  if (approved && row.status !== "approved")
    fail(409, "Evidence must be approved before publishing");
}
export async function insertEvidence(
  db: D1Database,
  input: z.infer<typeof evidenceInput>,
) {
  if (input.observedAt > new Date(Date.now() + 60000).toISOString())
    fail(422, "Evidence cannot be observed in the future");
  if (input.productId) await productExists(db, input.productId);
  const evidenceId = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO evidence(id,product_id,source_url,observed_at,kind,content_hash,summary,payload,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(
      evidenceId,
      input.productId ?? null,
      input.sourceUrl,
      input.observedAt,
      input.kind,
      input.contentHash,
      input.summary,
      JSON.stringify(input.payload),
      now(),
    )
    .run();
  const row = await db
    .prepare(
      "SELECT id,status FROM evidence WHERE product_id IS ? AND source_url=? AND content_hash=?",
    )
    .bind(input.productId ?? null, input.sourceUrl, input.contentHash)
    .first<{ id: string; status: string }>();
  await db
    .prepare(
      "INSERT INTO evidence_observations(evidence_id,observed_at) VALUES (?,?) ON CONFLICT DO NOTHING",
    )
    .bind(row!.id, input.observedAt)
    .run();
  return row!;
}
export const catalog = new Hono<AppEnv>();
const RADAR_SORT: Record<string, string> = {
  activity: "m.activity_change_4w",
  revenue: "r.high_usd",
  ads: "m.active_ads",
  sponsors: "m.sponsors",
  first: "m.first_seen",
  seen: "m.last_seen",
};
catalog.get("/radar", async (c) => {
  const { limit, offset } = page(c);
  const clauses = ["p.status='published'"];
  const values: (string | number)[] = [];
  if (c.req.query("category")) {
    clauses.push("p.category=?");
    values.push(category.parse(c.req.query("category")));
  }
  if (c.req.query("monetization")) {
    clauses.push("p.monetization=?");
    values.push(monetization.parse(c.req.query("monetization")));
  }
  if (c.req.query("minObservedAdDays") !== undefined) {
    const days = z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .parse(c.req.query("minObservedAdDays"));
    clauses.push(
      "EXISTS (SELECT 1 FROM distribution_signals ad JOIN evidence ae ON ae.id=ad.evidence_id WHERE ad.product_id=p.id AND ad.kind='ad_observed' AND ae.status='approved' AND json_extract(ad.detail,'$.activity')='active' GROUP BY ad.external_id HAVING count(DISTINCT substr(ad.observed_at,1,10))>=?)",
    );
    values.push(days);
  }
  if (c.req.query("q")) {
    const q = z.string().max(120).parse(c.req.query("q"));
    clauses.push(
      "(p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')",
    );
    const term = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
    values.push(term, term);
  }
  const coverage = c.req.query("coverage");
  if (coverage) {
    const parsed = z.enum(["full", "signals"]).parse(coverage);
    clauses.push("p.coverage_level=?");
    values.push(parsed);
  }
  if (c.req.query("firstSeenDays") !== undefined) {
    const days = z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .parse(c.req.query("firstSeenDays"));
    clauses.push("m.first_seen>=?");
    values.push(new Date(Date.now() - days * 86_400_000).toISOString());
  }
  if (c.req.query("changedDays") !== undefined) {
    const days = z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .parse(c.req.query("changedDays"));
    clauses.push(
      "EXISTS (SELECT 1 FROM product_changes pc JOIN evidence ce ON ce.id=pc.evidence_id WHERE pc.product_id=p.id AND pc.status='published' AND ce.status='approved' AND pc.observed_at>=?)",
    );
    values.push(new Date(Date.now() - days * 86_400_000).toISOString());
  }
  const sort = c.req.query("sort");
  const sortColumn = sort ? RADAR_SORT[sort] : undefined;
  if (sort && !sortColumn) fail(400, "Invalid sort");
  const direction = z
    .enum(["asc", "desc"])
    .default("desc")
    .parse(c.req.query("dir"));
  const order = sortColumn
    ? `${sortColumn} IS NULL,${sortColumn} ${direction},p.id`
    : "COALESCE(m.observations,0) DESC,p.updated_at DESC,p.id";
  const from = `FROM products p
    LEFT JOIN product_metrics m ON m.product_id=p.id
    LEFT JOIN revenue_ranges r ON r.product_id=p.id AND ${PUBLISHED_REVENUE_RANGE}
    WHERE ${clauses.join(" AND ")}`;
  const [total, result] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(`SELECT count(*) total ${from}`).bind(...values),
    c.env.DB.prepare(
      `SELECT p.*,
        COALESCE(m.observations,0) AS observations,
        COALESCE(m.step_count,0) AS step_count,
        m.active_ads,m.ads_delta_7d,m.longest_ad_days,m.creators,m.sponsors,m.creators_delta_7d,m.activity_change_4w,m.activity_weekly,m.first_seen,m.last_seen,
        r.low_usd AS revenue_low_usd,r.high_usd AS revenue_high_usd,r.confidence AS revenue_confidence,r.method_version AS revenue_method_version,
        (SELECT id FROM agent_blueprints b WHERE b.product_id=p.id AND b.status='published' LIMIT 1) IS NOT NULL AS has_blueprint,
        (SELECT pi.sha256 FROM product_icons pi WHERE pi.product_id=p.id AND pi.status='ok') AS icon_sha256,
        (SELECT json_object('rank',t.rank,'on',t.observed_on) FROM traffic_ranks t WHERE t.product_id=p.id AND t.source='tranco' ORDER BY t.observed_on DESC LIMIT 1) AS traffic_latest,
        (SELECT a.id FROM funnel_steps f JOIN evidence e ON e.id=f.evidence_id JOIN assets a ON a.id=f.asset_id AND a.evidence_id=e.id WHERE f.product_id=p.id AND p.coverage_level='full' AND e.status='approved' AND a.approved=1 AND a.thumbnail_key IS NOT NULL ORDER BY (f.stage='paywall') DESC,f.position DESC LIMIT 1) AS thumbnail_asset_id
       ${from} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ).bind(...values, limit, offset),
  ]);
  return c.json({
    items: result.results.map((row) => ({
      ...row,
      coverage: row.coverage_level,
      step_count: row.coverage_level === "full" ? Number(row.step_count) : 0,
      activity_weekly: decode<(number | null)[]>(
        (row.activity_weekly as string | null) ?? "[]",
      ),
      has_blueprint: !!row.has_blueprint,
      open_sample: !!row.open_sample,
      traffic_rank: row.traffic_latest
        ? decode<{ rank: number | null }>(row.traffic_latest as string).rank
        : null,
      traffic_tier: row.traffic_latest
        ? trafficTier(
            decode<{ rank: number | null }>(row.traffic_latest as string).rank,
          )
        : null,
      traffic_latest: undefined,
      icon_url: iconUrl(
        c.env.API_ORIGIN,
        String(row.id),
        row.icon_sha256 as string | null,
      ),
      thumbnail_url: row.thumbnail_asset_id
        ? `${c.env.API_ORIGIN}/api/v1/media/${row.thumbnail_asset_id}/thumbnail`
        : null,
    })),
    total: Number(total.results[0].total),
    limit,
    offset,
  });
});
catalog.get("/vault/:slug", optionalUser, async (c) => {
  const db = c.env.DB;
  const product = await db
    .prepare("SELECT * FROM products WHERE slug=? AND status='published'")
    .bind(c.req.param("slug"))
    .first<{
      id: string;
      open_sample: number;
      coverage_level: "full" | "signals";
    }>();
  if (!product) fail(404, "Product not found");
  const steps = await db
    .prepare(
      "SELECT f.id,f.evidence_id,f.position,f.title,f.stage,f.annotation,a.id AS approved_asset FROM funnel_steps f JOIN evidence e ON e.id=f.evidence_id LEFT JOIN assets a ON a.id=f.asset_id AND a.approved=1 WHERE f.product_id=? AND e.status='approved' ORDER BY f.position",
    )
    .bind(product.id)
    .all<
      {
        position: number;
        title: string;
        stage: string;
        approved_asset: string | null;
      } & Record<string, unknown>
    >();
  const coverage = product.coverage_level;
  const actor = c.get("actor") as Actor | undefined;

  // Public signals and the chosen sample are open. A captured app needs sign-in and,
  // unless the viewer is Insider, uses one of today's free apps.
  let usage: Awaited<ReturnType<typeof appUsage>> | undefined;
  let access: "open" | "preview" | "full" = "open";
  if (coverage === "full" && !product.open_sample) {
    if (!actor) {
      access = "preview";
      await rateLimit(
        db,
        "vault-preview:" + (c.req.header("cf-connecting-ip") ?? "local"),
        60,
        3600,
      );
    } else {
      access = "full";
      if (!actor.pro) {
        const allowed = await unlockApp(db, actor.userId, product.id);
        usage = await appUsage(db, actor.userId);
        if (!allowed)
          return c.json(
            {
              error: `You've opened your ${DAILY_APP_LIMIT} free apps for today`,
              code: "daily_limit",
              ...usage,
            },
            429,
          );
      }
    }
  }
  const results = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        "SELECT s.* FROM distribution_signals s JOIN evidence e ON e.id=s.evidence_id WHERE s.product_id=? AND e.status='approved' ORDER BY s.observed_at DESC LIMIT 100",
      )
      .bind(product.id),
    db
      .prepare(
        "SELECT p.* FROM paywall_mechanics p JOIN evidence e ON e.id=p.evidence_id WHERE p.product_id=? AND e.status='approved'",
      )
      .bind(product.id),
    db
      .prepare(
        "SELECT id,version,title,created_at FROM agent_blueprints WHERE product_id=? AND status='published' ORDER BY version DESC",
      )
      .bind(product.id),
    db
      .prepare(
        "SELECT id,source_url,observed_at,kind,summary FROM evidence WHERE product_id=? AND status='approved' ORDER BY observed_at DESC LIMIT 100",
      )
      .bind(product.id),
    db
      .prepare(
        "SELECT count(DISTINCT substr(s.observed_at,1,10)) observed_days,min(s.observed_at) first_observed,max(s.observed_at) last_observed FROM distribution_signals s JOIN evidence e ON e.id=s.evidence_id WHERE s.product_id=? AND s.kind='ad_observed' AND e.status='approved'",
      )
      .bind(product.id),
    db
      .prepare("SELECT * FROM product_metrics WHERE product_id=?")
      .bind(product.id),
    db
      .prepare(
        `SELECT r.low_usd,r.high_usd,r.confidence,r.method_version,r.inputs,r.evidence_ids,r.updated_at FROM revenue_ranges r WHERE r.product_id=? AND ${PUBLISHED_REVENUE_RANGE}`,
      )
      .bind(product.id),
    db.prepare(PUBLIC_PRICING_SELECT + " LIMIT 1").bind(product.id),
  ]);
  const metricsRow = results[5].results[0];
  const shared = {
    product: {
      ...product,
      open_sample: !!product.open_sample,
      icon_url: iconUrl(
        c.env.API_ORIGIN,
        product.id,
        (
          await db
            .prepare(
              "SELECT sha256 FROM product_icons WHERE product_id=? AND status='ok'",
            )
            .bind(product.id)
            .first<{ sha256: string }>()
        )?.sha256,
      ),
    },
    coverage,
    access,
    usage: usage ?? null,
    publicPricing: pricingResponse(results[7].results[0]),
    traffic: await productTraffic(db, product.id),
    metrics: metricsRow
      ? {
          ...metricsRow,
          step_count: coverage === "full" ? metricsRow.step_count : 0,
          activity_weekly: decode<(number | null)[]>(
            metricsRow.activity_weekly as string,
          ),
          meaning:
            "Observed ad and creator activity. Null means not collected. Not product or business growth.",
        }
      : null,
    revenueRange: results[6].results[0]
      ? {
          ...results[6].results[0],
          inputs: decode(results[6].results[0].inputs as string),
          evidence_ids: decode(results[6].results[0].evidence_ids as string),
          kind: "manual_range",
          computed: false,
          meaning: revenueRangeMeaning,
        }
      : null,
    adObservations: {
      ...results[4].results[0],
      meaning:
        "Distinct observed days; does not establish continuous activity, spend or revenue.",
    },
  };
  const withImage = async (step: (typeof steps.results)[number]) => {
    const { approved_asset: asset, ...rest } = step;
    return {
      ...rest,
      image_url: asset ? await signedMediaUrl(c.env, asset) : null,
    };
  };
  if (access === "preview") {
    // A shared link shows one screen. Everything else waits for sign-in.
    const requested = c.req.query("step");
    const position =
      requested === undefined
        ? null
        : z.coerce.number().int().min(0).max(10000).parse(requested);
    const linked = steps.results.find((s) => s.position === position);
    const sharedStep =
      linked &&
      (await signedLinkValid(
        c.env,
        `step:${product.id}:${linked.id}`,
        c.req.query("expires"),
        c.req.query("signature"),
      ));
    return c.json({
      ...shared,
      outline: steps.results.map(({ position, title, stage }) => ({
        position,
        title,
        stage,
      })),
      funnel: sharedStep ? [await withImage(linked!)] : [],
      signals: [],
      paywall: null,
      blueprints: [],
      evidence: [],
    });
  }
  const captureEvidence = new Set([
    ...steps.results.map((s) => s.evidence_id),
    ...results[1].results.map((r) => r.evidence_id),
  ]);
  if (actor?.via === "session")
    await rememberProduct(db, actor.userId, product.id);
  return c.json({
    ...shared,
    signals: results[0].results.map((r) => ({
      ...r,
      detail: decode(r.detail as string),
    })),
    funnel:
      coverage === "full"
        ? await Promise.all(steps.results.map(withImage))
        : [],
    paywall:
      (coverage === "full" ? results[1].results : []).map((r) => ({
        ...r,
        states: decode(r.states as string),
        transitions: decode(r.transitions as string),
        credit_rules: decode(r.credit_rules as string),
      }))[0] ?? null,
    blueprints: results[2].results,
    evidence:
      coverage === "full"
        ? results[3].results
        : results[3].results.filter(
            (r) => r.kind !== "screenshot" && !captureEvidence.has(r.id),
          ),
  });
});
catalog.post("/vault/:slug/share", requireUser, async (c) => {
  const { position } = await parse(
    c,
    z.object({ position: z.number().int().min(0).max(200) }).strict(),
  );
  const product = await c.env.DB.prepare(
    "SELECT id,open_sample FROM products WHERE slug=? AND status='published' AND coverage_level='full'",
  )
    .bind(c.req.param("slug"))
    .first<{ id: string; open_sample: number }>();
  if (!product) fail(404, "Captured app not found");
  const actor = c.get("actor");
  if (
    !actor.pro &&
    !product.open_sample &&
    !(await c.env.DB.prepare(
      "SELECT 1 FROM vault_unlocks WHERE user_id=? AND day=? AND product_id=?",
    )
      .bind(actor.userId, now().slice(0, 10), product.id)
      .first())
  )
    fail(403, "Open this app before sharing a screen");
  const step = await c.env.DB.prepare(
    "SELECT f.id FROM funnel_steps f JOIN evidence e ON e.id=f.evidence_id WHERE f.product_id=? AND f.position=? AND e.status='approved'",
  )
    .bind(product.id, position)
    .first<{ id: string }>();
  if (!step) fail(404, "Screen not found");
  const parameters = await signedLinkParameters(
    c.env,
    `step:${product.id}:${step.id}`,
    7 * 86400,
  );
  if (!parameters) fail(503, "Screen sharing is not configured");
  return c.json({
    url: `/api/v1/vault/${encodeURIComponent(c.req.param("slug"))}?step=${position}&${parameters}`,
    expiresIn: 7 * 86400,
  });
});
catalog.get("/blueprints/:id/export", requireBlueprintReader, async (c) => {
  // Free accounts get 10 exports a day. Insider has no daily cap.
  if (!c.get("actor").pro)
    await rateLimit(c.env.DB, "export:" + c.get("actor").userId, 10, 86400);
  const row = await c.env.DB.prepare(
    "SELECT b.* FROM agent_blueprints b JOIN products p ON p.id=b.product_id WHERE b.id=? AND b.status='published' AND p.status='published'",
  )
    .bind(c.req.param("id"))
    .first<{ id: string; product_id: string; spec: string }>();
  if (!row) fail(404, "Blueprint not found");
  // Recheck referenced evidence so a later retraction immediately removes exports.
  const spec = decode<z.infer<typeof blueprintInput>["spec"]>(row.spec);
  for (const evidenceId of spec.evidenceIds)
    await checkEvidence(c.env.DB, evidenceId, row.product_id, true);
  const partners = await c.env.DB.prepare(
    "SELECT p.name,p.url,p.relationship,p.disclosure,bp.role FROM blueprint_partners bp JOIN partners p ON p.id=bp.partner_id WHERE bp.blueprint_id=? AND p.active=1",
  )
    .bind(row.id)
    .all();
  return c.json({ ...row, spec, partners: partners.results });
});
catalog.get("/arena", async (c) => {
  const { limit, offset } = page(c);
  const result = await c.env.DB.prepare(
    "SELECT a.*, (SELECT count(*) FROM arena_votes v WHERE v.build_id=a.id) votes FROM arena_builds a WHERE status='published' ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
  )
    .bind(limit, offset)
    .all();
  return c.json({
    items: result.results.map((r) => ({
      ...r,
      benchmark: decode(r.benchmark as string),
    })),
    limit,
    offset,
  });
});
catalog.get("/arena/:slug", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT * FROM arena_builds WHERE slug=? AND status='published'",
  )
    .bind(c.req.param("slug"))
    .first<{ benchmark: string }>();
  if (!row) fail(404, "Build not found");
  return c.json({ ...row, benchmark: decode(row.benchmark) });
});
catalog.put("/arena/:id/vote", requireUser, async (c) => {
  const result = await c.env.DB.prepare(
    "INSERT INTO arena_votes SELECT id,?,? FROM arena_builds WHERE id=? AND status='published' ON CONFLICT DO NOTHING",
  )
    .bind(c.get("actor").userId, now(), c.req.param("id"))
    .run();
  if (
    !(await c.env.DB.prepare(
      "SELECT id FROM arena_builds WHERE id=? AND status='published'",
    )
      .bind(c.req.param("id"))
      .first())
  )
    fail(404, "Build not found");
  return c.json({ ok: true, created: result.meta.changes > 0 });
});
catalog.delete("/arena/:id/vote", requireUser, async (c) => {
  await c.env.DB.prepare(
    "DELETE FROM arena_votes WHERE build_id=? AND user_id=?",
  )
    .bind(c.req.param("id"), c.get("actor").userId)
    .run();
  return c.json({ ok: true });
});

export const adminCatalog = new Hono<AppEnv>();
adminCatalog.use("*", requireAdmin);
adminCatalog.get("/products", async (c) => {
  const { limit, offset } = page(c);
  return c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT * FROM products ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      )
        .bind(limit, offset)
        .all()
    ).results,
  });
});
adminCatalog.post("/products", async (c) => {
  const input = await parse(c, productInput);
  const productId = crypto.randomUUID(),
    time = now();
  const domain = productKey(input.url);
  if (
    await c.env.DB.prepare("SELECT id FROM products WHERE slug=? OR domain=?")
      .bind(input.slug, domain)
      .first()
  )
    fail(409, "Product slug or domain already exists");
  await c.env.DB.prepare(
    "INSERT INTO products(id,slug,name,url,domain,description,category,monetization,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      productId,
      input.slug,
      input.name,
      input.url,
      domain,
      input.description,
      input.category,
      input.monetization,
      time,
      time,
    )
    .run();
  await audit(c.env.DB, "admin", "product.create", productId);
  return c.json({ id: productId, status: "draft" }, 201);
});
adminCatalog.patch("/products/:id", async (c) => {
  const input = await parse(c, productInput);
  await productExists(c.env.DB, c.req.param("id"));
  await c.env.DB.prepare(
    "UPDATE products SET slug=?,name=?,url=?,domain=?,description=?,category=?,monetization=?,updated_at=? WHERE id=?",
  )
    .bind(
      input.slug,
      input.name,
      input.url,
      productKey(input.url),
      input.description,
      input.category,
      input.monetization,
      now(),
      c.req.param("id"),
    )
    .run();
  await audit(c.env.DB, "admin", "product.update", c.req.param("id"));
  return c.json({ ok: true });
});
adminCatalog.put("/products/:id/status", async (c) => {
  const { status: next } = await parse(c, z.object({ status }).strict()),
    productId = c.req.param("id");
  await productExists(c.env.DB, productId);
  if (next === "published") {
    const research = await c.env.DB.prepare(
      "SELECT status FROM research_profiles WHERE product_id=?",
    )
      .bind(productId)
      .first<{ status: string }>();
    if (research && research.status !== "accepted")
      fail(
        409,
        "Review and accept the research candidate before publishing it",
      );
    if (
      !(await c.env.DB.prepare(
        "SELECT id FROM evidence WHERE product_id=? AND status='approved' LIMIT 1",
      )
        .bind(productId)
        .first())
    )
      fail(409, "Approve evidence before publishing");
    const references = await c.env.DB.prepare(
      "SELECT evidence_id FROM funnel_steps WHERE product_id=? UNION SELECT evidence_id FROM paywall_mechanics WHERE product_id=? UNION SELECT evidence_id FROM distribution_signals WHERE product_id=?",
    )
      .bind(productId, productId, productId)
      .all<{ evidence_id: string }>();
    for (const ref of references.results)
      await checkEvidence(c.env.DB, ref.evidence_id, productId, true);
  }
  await c.env.DB.prepare("UPDATE products SET status=?,updated_at=? WHERE id=?")
    .bind(next, now(), productId)
    .run();
  await audit(c.env.DB, "admin", "product.status", productId, { status: next });
  return c.json({ ok: true });
});
adminCatalog.put("/products/:id/coverage", async (c) => {
  const input = await parse(
    c,
    z
      .object({
        level: z.enum(["signals", "full"]),
        notes: z.string().min(20).max(2000),
      })
      .strict(),
  );
  const productId = c.req.param("id");
  await productExists(c.env.DB, productId);
  if (
    input.level === "full" &&
    !(await c.env.DB.prepare(
      "SELECT f.id FROM funnel_steps f JOIN evidence e ON e.id=f.evidence_id JOIN assets a ON a.id=f.asset_id AND a.evidence_id=e.id WHERE f.product_id=? AND f.stage<>'landing' AND e.status='approved' AND a.approved=1 LIMIT 1",
    )
      .bind(productId)
      .first())
  )
    fail(
      409,
      "Full Screens requires reviewed app captures beyond the landing page",
    );
  await c.env.DB.prepare(
    "UPDATE products SET coverage_level=?,coverage_notes=?,coverage_reviewed_at=?,updated_at=? WHERE id=?",
  )
    .bind(input.level, input.notes, now(), now(), productId)
    .run();
  await audit(c.env.DB, "admin", "product.coverage", productId, input);
  return c.json({ ok: true });
});
adminCatalog.post("/evidence", async (c) => {
  const input = await parse(c, evidenceInput);
  const row = await insertEvidence(c.env.DB, input);
  await audit(c.env.DB, "admin", "evidence.import", row.id);
  return c.json(row, 201);
});
adminCatalog.get("/evidence", async (c) => {
  const { limit, offset } = page(c);
  return c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT * FROM evidence ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
        .bind(limit, offset)
        .all()
    ).results,
  });
});
adminCatalog.get("/evidence/:id/observations", async (c) => {
  const { limit, offset } = page(c);
  return c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT observed_at,job_id FROM evidence_observations WHERE evidence_id=? ORDER BY observed_at DESC LIMIT ? OFFSET ?",
      )
        .bind(c.req.param("id"), limit, offset)
        .all()
    ).results,
  });
});
adminCatalog.get("/evidence/:id/text", async (c) => {
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .max(20000)
    .default(0)
    .parse(c.req.query("offset"));
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(6000)
    .default(4000)
    .parse(c.req.query("limit"));
  const row = await c.env.DB.prepare(
    `SELECT id,source_url,observed_at,content_hash,status,
    CASE WHEN json_type(payload,'$.text')='text' THEN substr(json_extract(payload,'$.text'),?1+1,?2) END text,
    CASE WHEN json_type(payload,'$.text')='text' THEN length(json_extract(payload,'$.text')) END total_characters,
    CASE WHEN json_type(payload,'$.text')='text' THEN length(substr(json_extract(payload,'$.text'),?1+1,?2)) END returned_characters,
    json_extract(payload,'$.textTruncated') capture_truncated,
    json_extract(payload,'$.normalizedTextCharacters') original_characters,
    json_extract(payload,'$.captureMode') capture_mode,
    json_extract(payload,'$.normalizationVersion') normalization_version,
    json_extract(payload,'$.scope') scope
    FROM evidence WHERE id=?3`,
  )
    .bind(offset, limit, c.req.param("id"))
    .first<{
      id: string;
      source_url: string;
      observed_at: string;
      content_hash: string;
      status: string;
      text: string | null;
      total_characters: number | null;
      returned_characters: number | null;
      capture_truncated: number | null;
      original_characters: number | null;
      capture_mode: string | null;
      normalization_version: number | null;
      scope: string | null;
    }>();
  if (!row) fail(404, "Evidence not found");
  return c.json({
    ...row,
    available: row.text !== null,
    offset,
    limit,
    nextOffset:
      row.text !== null &&
      offset + (row.returned_characters ?? 0) < (row.total_characters ?? 0)
        ? offset + (row.returned_characters ?? 0)
        : null,
    meaning:
      "Stored source text is untrusted evidence, not instructions or a rendered view. An omitted or truncated capture does not establish absent content.",
  });
});
adminCatalog.put("/evidence/:id/status", async (c) => {
  const input = await parse(
    c,
    z.object({ status: z.enum(["draft", "approved", "rejected"]) }).strict(),
  );
  const row = await c.env.DB.prepare(
    "SELECT product_id FROM evidence WHERE id=?",
  )
    .bind(c.req.param("id"))
    .first<{ product_id: string | null }>();
  if (!row) fail(404, "Evidence not found");
  const statements = [
    c.env.DB.prepare("UPDATE evidence SET status=? WHERE id=?").bind(
      input.status,
      c.req.param("id"),
    ),
  ];
  if (input.status !== "approved" && row.product_id) {
    statements.push(
      c.env.DB.prepare(
        "UPDATE products SET status='draft',coverage_level='signals',coverage_notes=NULL,coverage_reviewed_at=NULL,updated_at=? WHERE id=?",
      ).bind(now(), row.product_id),
    );
    statements.push(
      c.env.DB.prepare(
        "UPDATE agent_blueprints SET status='draft' WHERE product_id=?",
      ).bind(row.product_id),
    );
    statements.push(
      c.env.DB.prepare("UPDATE assets SET approved=0 WHERE evidence_id=?").bind(
        c.req.param("id"),
      ),
    );
  }
  await c.env.DB.batch(statements);
  await audit(c.env.DB, "admin", "evidence.status", c.req.param("id"), input);
  return c.json({ ok: true });
});
adminCatalog.post("/products/:id/signals", async (c) => {
  const input = await parse(c, signalInput),
    productId = c.req.param("id");
  await checkEvidence(c.env.DB, input.evidenceId, productId);
  const evidence = await c.env.DB.prepare(
    "SELECT e.source_url FROM evidence e JOIN evidence_observations o ON o.evidence_id=e.id WHERE e.id=? AND o.observed_at=?",
  )
    .bind(input.evidenceId, input.observedAt)
    .first<{ source_url: string }>();
  if (!evidence || input.sourceUrl !== evidence.source_url)
    fail(422, "Signal time and source must match a recorded observation");
  await c.env.DB.prepare(
    "INSERT INTO distribution_signals VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
  )
    .bind(
      crypto.randomUUID(),
      productId,
      input.evidenceId,
      input.kind,
      input.externalId,
      input.observedAt,
      input.sourceUrl,
      JSON.stringify(input.detail),
    )
    .run();
  return c.json({ ok: true }, 201);
});
adminCatalog.put("/products/:id/funnel", async (c) => {
  const input = await parse(c, funnelInput),
    productId = c.req.param("id");
  await productExists(c.env.DB, productId);
  return c.json(await replaceFunnel(c.env.DB, productId, input));
});
adminCatalog.put("/products/:id/paywall", async (c) => {
  const input = await parse(c, paywallInput),
    productId = c.req.param("id");
  await checkEvidence(c.env.DB, input.evidenceId, productId);
  return c.json(await replacePaywall(c.env.DB, productId, input));
});
adminCatalog.get("/products/:id/flow-history", async (c) => {
  const { limit, offset } = page(c);
  await productExists(c.env.DB, c.req.param("id"));
  return c.json(await flowHistory(c.env.DB, c.req.param("id"), limit, offset));
});
adminCatalog.get("/products/:id/flow-history/:revisionId", async (c) => {
  const { limit, offset } = page(c);
  return c.json(
    await flowVersion(
      c.env.DB,
      c.req.param("id"),
      c.req.param("revisionId"),
      limit,
      offset,
    ),
  );
});
adminCatalog.post("/products/:id/blueprints", async (c) => {
  const input = await parse(c, blueprintInput),
    productId = c.req.param("id");
  await productExists(c.env.DB, productId);
  for (const evidenceId of input.spec.evidenceIds)
    await checkEvidence(c.env.DB, evidenceId, productId);
  const blueprintId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO agent_blueprints(id,product_id,version,title,spec,created_at) SELECT ?,?,COALESCE(MAX(version),0)+1,?,?,? FROM agent_blueprints WHERE product_id=?",
  )
    .bind(
      blueprintId,
      productId,
      input.title,
      JSON.stringify(input.spec),
      now(),
      productId,
    )
    .run();
  return c.json({ id: blueprintId, status: "draft" }, 201);
});
adminCatalog.put("/blueprints/:id/status", async (c) => {
  const input = await parse(c, z.object({ status }).strict());
  const row = await c.env.DB.prepare(
    "SELECT product_id,spec FROM agent_blueprints WHERE id=?",
  )
    .bind(c.req.param("id"))
    .first<{ product_id: string; spec: string }>();
  if (!row) fail(404, "Blueprint not found");
  if (input.status === "published")
    for (const evidenceId of decode<z.infer<typeof blueprintInput>["spec"]>(
      row.spec,
    ).evidenceIds)
      await checkEvidence(c.env.DB, evidenceId, row.product_id, true);
  await c.env.DB.prepare("UPDATE agent_blueprints SET status=? WHERE id=?")
    .bind(input.status, c.req.param("id"))
    .run();
  await audit(c.env.DB, "admin", "blueprint.status", c.req.param("id"), input);
  return c.json({ ok: true });
});
adminCatalog.post("/arena", async (c) => {
  const input = await parse(c, arenaInput),
    buildId = crypto.randomUUID(),
    time = now();
  await c.env.DB.prepare(
    "INSERT INTO arena_builds(id,slug,title,description,model,prompt,repository_url,demo_url,benchmark,rating,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      buildId,
      input.slug,
      input.title,
      input.description,
      input.model,
      input.prompt,
      input.repositoryUrl ?? null,
      input.demoUrl ?? null,
      JSON.stringify(input.benchmark),
      input.rating ?? null,
      time,
      time,
    )
    .run();
  return c.json({ id: buildId, status: "draft" }, 201);
});
adminCatalog.put("/arena/:id/status", async (c) => {
  const input = await parse(c, z.object({ status }).strict());
  const result = await c.env.DB.prepare(
    "UPDATE arena_builds SET status=?,updated_at=? WHERE id=?",
  )
    .bind(input.status, now(), c.req.param("id"))
    .run();
  if (!result.meta.changes) fail(404, "Build not found");
  return c.json({ ok: true });
});
adminCatalog.post("/partners", async (c) => {
  const input = await parse(
    c,
    z
      .object({
        name: z.string().min(1).max(200),
        url: z.url().startsWith("https://").max(2048),
        relationship: z.enum(["affiliate", "sponsor", "independent"]),
        disclosure: z.string().min(1).max(1000),
      })
      .strict(),
  );
  const partnerId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO partners(id,name,url,relationship,disclosure) VALUES (?,?,?,?,?)",
  )
    .bind(
      partnerId,
      input.name,
      input.url,
      input.relationship,
      input.disclosure,
    )
    .run();
  return c.json({ id: partnerId }, 201);
});
adminCatalog.put("/blueprints/:id/partners/:partnerId", async (c) => {
  const { role } = await parse(
    c,
    z.object({ role: z.string().min(1).max(100) }).strict(),
  );
  await c.env.DB.prepare(
    "INSERT INTO blueprint_partners VALUES (?,?,?) ON CONFLICT DO NOTHING",
  )
    .bind(c.req.param("id"), c.req.param("partnerId"), role)
    .run();
  return c.json({ ok: true });
});
