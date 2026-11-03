import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./types";
import { now } from "./types";
import { audit, decode, fail, page, parse } from "./lib";
import { requireAdmin, requireUser } from "./auth";
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
  if (c.req.query("q")) {
    const q = z.string().max(120).parse(c.req.query("q"));
    clauses.push(
      "(p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')",
    );
    const term = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
    values.push(term, term);
  }
  const result = await c.env.DB.prepare(
    `SELECT p.*, (SELECT count(*) FROM distribution_signals s JOIN evidence e ON e.id=s.evidence_id WHERE s.product_id=p.id AND e.status='approved') AS observations FROM products p WHERE ${clauses.join(" AND ")} ORDER BY observations DESC,p.updated_at DESC,p.id LIMIT ? OFFSET ?`,
  )
    .bind(...values, limit, offset)
    .all();
  return c.json({ items: result.results, limit, offset });
});
catalog.get("/vault/:slug", async (c) => {
  const product = await c.env.DB.prepare(
    "SELECT * FROM products WHERE slug=? AND status='published'",
  )
    .bind(c.req.param("slug"))
    .first<{ id: string }>();
  if (!product) fail(404, "Product not found");
  const results = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      "SELECT s.* FROM distribution_signals s JOIN evidence e ON e.id=s.evidence_id WHERE s.product_id=? AND e.status='approved' ORDER BY s.observed_at DESC LIMIT 100",
    ).bind(product.id),
    c.env.DB.prepare(
      "SELECT f.* FROM funnel_steps f JOIN evidence e ON e.id=f.evidence_id WHERE f.product_id=? AND e.status='approved' ORDER BY position",
    ).bind(product.id),
    c.env.DB.prepare(
      "SELECT p.* FROM paywall_mechanics p JOIN evidence e ON e.id=p.evidence_id WHERE p.product_id=? AND e.status='approved'",
    ).bind(product.id),
    c.env.DB.prepare(
      "SELECT id,version,title,created_at FROM agent_blueprints WHERE product_id=? AND status='published' ORDER BY version DESC",
    ).bind(product.id),
    c.env.DB.prepare(
      "SELECT id,source_url,observed_at,kind,summary FROM evidence WHERE product_id=? AND status='approved' ORDER BY observed_at DESC LIMIT 100",
    ).bind(product.id),
    c.env.DB.prepare(
      "SELECT count(DISTINCT substr(s.observed_at,1,10)) observed_days,min(s.observed_at) first_observed,max(s.observed_at) last_observed FROM distribution_signals s JOIN evidence e ON e.id=s.evidence_id WHERE s.product_id=? AND s.kind='ad_observed' AND e.status='approved'",
    ).bind(product.id),
  ]);
  return c.json({
    product,
    signals: results[0].results.map((r) => ({
      ...r,
      detail: decode(r.detail as string),
    })),
    funnel: results[1].results,
    paywall:
      results[2].results.map((r) => ({
        ...r,
        states: decode(r.states as string),
        transitions: decode(r.transitions as string),
        credit_rules: decode(r.credit_rules as string),
      }))[0] ?? null,
    blueprints: results[3].results,
    evidence: results[4].results,
    adObservations: {
      ...results[5].results[0],
      meaning:
        "Distinct observed days; does not establish continuous activity, spend or revenue.",
    },
  });
});
catalog.get("/blueprints/:id/export", requireUser, async (c) => {
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
  const domain = new URL(input.url).hostname.replace(/^www\./, "");
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
      new URL(input.url).hostname.replace(/^www\./, ""),
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
        "UPDATE products SET status='draft',updated_at=? WHERE id=?",
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
  for (const step of input) {
    await checkEvidence(c.env.DB, step.evidenceId, productId);
    if (
      step.assetId &&
      !(await c.env.DB.prepare(
        "SELECT id FROM assets WHERE id=? AND evidence_id=?",
      )
        .bind(step.assetId, step.evidenceId)
        .first())
    )
      fail(422, "Asset must belong to step evidence");
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM funnel_steps WHERE product_id=?").bind(
      productId,
    ),
    ...input.map((s) =>
      c.env.DB.prepare(
        "INSERT INTO funnel_steps VALUES (?,?,?,?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(),
        productId,
        s.position,
        s.title,
        s.stage,
        s.annotation,
        s.evidenceId,
        s.assetId ?? null,
      ),
    ),
    c.env.DB.prepare(
      "UPDATE products SET status='draft',updated_at=? WHERE id=?",
    ).bind(now(), productId),
  ]);
  return c.json({ ok: true });
});
adminCatalog.put("/products/:id/paywall", async (c) => {
  const input = await parse(c, paywallInput),
    productId = c.req.param("id");
  await checkEvidence(c.env.DB, input.evidenceId, productId);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO paywall_mechanics VALUES (?,?,?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET evidence_id=excluded.evidence_id,pattern=excluded.pattern,states=excluded.states,transitions=excluded.transitions,credit_rules=excluded.credit_rules,notes=excluded.notes",
    ).bind(
      productId,
      input.evidenceId,
      input.pattern,
      JSON.stringify(input.states),
      JSON.stringify(input.transitions),
      JSON.stringify(input.creditRules),
      input.notes,
    ),
    c.env.DB.prepare(
      "UPDATE products SET status='draft',updated_at=? WHERE id=?",
    ).bind(now(), productId),
  ]);
  return c.json({ ok: true });
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
