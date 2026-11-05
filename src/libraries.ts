import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Actor, AppEnv } from "./types";
import { category, monetization, funnelInput } from "./contracts";
import { optionalUser } from "./auth";
import { page } from "./lib";
import { signedMediaUrl } from "./signed-links";

function productFilters(c: Context<AppEnv>) {
  const clauses = ["p.status='published'"],
    values: (string | number | null)[] = [];
  for (const [key, schema] of [
    ["category", category],
    ["monetization", monetization],
  ] as const) {
    const value = c.req.query(key);
    if (value !== undefined) {
      clauses.push(`p.${key}=?`);
      values.push(schema.parse(value));
    }
  }
  const product = c.req.query("product");
  if (product !== undefined) {
    clauses.push("p.slug=?");
    values.push(z.string().min(1).max(120).parse(product));
  }
  const q = z
    .string()
    .max(200)
    .parse(c.req.query("q") ?? "")
    .trim();
  if (q) {
    clauses.push("(p.name LIKE ? OR p.description LIKE ?)");
    values.push(`%${q}%`, `%${q}%`);
  }
  return { clauses, values };
}

export const libraries = new Hono<AppEnv>();
libraries.get("/screens", optionalUser, async (c) => {
  const { limit, offset } = page(c),
    { clauses, values } = productFilters(c);
  clauses.push(
    "p.coverage_level='full'",
    "e.product_id=p.id",
    "e.status='approved'",
    "a.approved=1",
    "a.evidence_id=e.id",
  );
  const stage = c.req.query("stage");
  if (stage !== undefined) {
    clauses.push("f.stage=?");
    values.push(funnelInput.element.shape.stage.parse(stage));
  }
  const actor = c.get("actor") as Actor | undefined;
  const result = await c.env.DB.prepare(
    `SELECT f.id,f.position,f.title,f.stage,f.annotation,p.id product_id,p.slug,p.name,p.category,p.monetization,
      a.id asset_id,e.id evidence_id,e.source_url,e.observed_at,
      CASE WHEN p.open_sample=1 OR ?=1 OR EXISTS(SELECT 1 FROM vault_unlocks u WHERE u.product_id=p.id AND u.user_id=? AND u.day=?) THEN 1 ELSE 0 END can_open
     FROM funnel_steps f JOIN products p ON p.id=f.product_id JOIN evidence e ON e.id=f.evidence_id JOIN assets a ON a.id=f.asset_id
     WHERE ${clauses.join(" AND ")} ORDER BY e.observed_at DESC,p.id,f.position,f.id LIMIT ? OFFSET ?`,
  )
    .bind(
      actor?.pro ? 1 : 0,
      actor?.userId ?? null,
      new Date().toISOString().slice(0, 10),
      ...values,
      limit + 1,
      offset,
    )
    .all<{
      id: string;
      position: number;
      title: string;
      stage: string;
      annotation: string;
      product_id: string;
      slug: string;
      name: string;
      category: string;
      monetization: string;
      asset_id: string;
      evidence_id: string;
      source_url: string;
      observed_at: string;
      can_open: number;
    }>();
  const items = await Promise.all(
    result.results.slice(0, limit).map(async (r) => ({
      id: r.id,
      position: r.position,
      title: r.title,
      stage: r.stage,
      product: {
        id: r.product_id,
        slug: r.slug,
        name: r.name,
        category: r.category,
        monetization: r.monetization,
      },
      locked: !r.can_open,
      annotation: r.can_open ? r.annotation : null,
      image_url: r.can_open ? await signedMediaUrl(c.env, r.asset_id) : null,
      evidence: r.can_open
        ? {
            id: r.evidence_id,
            source_url: r.source_url,
            observed_at: r.observed_at,
          }
        : null,
    })),
  );
  return c.json({
    items,
    limit,
    offset,
    hasMore: result.results.length > limit,
    accessRule:
      "Listing never unlocks an app. Open its details to use today's allowance; samples and Insider remain available.",
  });
});

libraries.get("/ads", async (c) => {
  const { limit, offset } = page(c),
    { clauses, values } = productFilters(c);
  clauses.push(
    "s.kind='ad_observed'",
    "e.product_id=p.id",
    "e.status='approved'",
    "json_extract(s.detail,'$.platform') IN ('meta','google')",
  );
  for (const [key, schema] of [
    ["platform", z.enum(["meta", "google"])],
    ["activity", z.enum(["active", "inactive"])],
  ] as const) {
    const value = c.req.query(key);
    if (value !== undefined) {
      clauses.push(`json_extract(s.detail,'$.${key}')=?`);
      values.push(schema.parse(value));
    }
  }
  clauses.push(`NOT EXISTS(SELECT 1 FROM distribution_signals newer JOIN evidence ne ON ne.id=newer.evidence_id
    WHERE newer.product_id=s.product_id AND newer.kind=s.kind AND newer.external_id=s.external_id AND ne.product_id=s.product_id AND ne.status='approved'
    AND (newer.observed_at>s.observed_at OR (newer.observed_at=s.observed_at AND newer.id>s.id)))`);
  const result = await c.env.DB.prepare(
    `SELECT s.id,s.external_id,s.source_url,s.observed_at,p.id product_id,p.slug,p.name,p.category,p.monetization,e.id evidence_id,e.summary,
      json_extract(s.detail,'$.platform') platform,json_extract(s.detail,'$.activity') activity,
      json_extract(s.detail,'$.advertiserName') advertiser_name,json_extract(s.detail,'$.country') country,
      json_extract(s.detail,'$.destinationUrl') destination_url,json_extract(s.detail,'$.creativeText') creative_text,
      json_extract(s.detail,'$.format') format,
      json_extract(s.detail,'$.reportedStartDate') reported_start_date,json_extract(s.detail,'$.reportedLastShownDate') reported_last_shown_date
     FROM distribution_signals s JOIN products p ON p.id=s.product_id JOIN evidence e ON e.id=s.evidence_id
     WHERE ${clauses.join(" AND ")} ORDER BY s.observed_at DESC,s.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...values, limit + 1, offset)
    .all();
  return c.json({
    items: result.results.slice(0, limit),
    limit,
    offset,
    hasMore: result.results.length > limit,
    meaning:
      "Latest approved observation per ad on a published product. State is reported at observed_at, not current global activity, uninterrupted delivery, spend or revenue.",
  });
});
