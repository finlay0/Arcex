import { z } from "zod";
import { productInput, publicUrl, timestamp } from "./contracts";
import { fail, audit } from "./lib";
import { now } from "./types";
import { Hono } from "hono";
import type { AppEnv } from "./types";
import { requireAdmin } from "./auth";
import { parse, page } from "./lib";
import { checkEvidence } from "./catalog";
import {
  researchContext,
  researchContextInput,
  productResearch,
  checkpointInput,
  saveCheckpoint,
} from "./research-context";

export const referenceDomains = new Set([
  "chatgpt.com",
  "claude.com",
  "google.dev",
  "labs.google",
  "cursor.com",
  "lovable.dev",
  "bolt.new",
  "v0.app",
  "v0.dev",
  "replit.com",
  "openai.com",
  "anthropic.com",
  "google.com",
  "microsoft.com",
]);
export const discoveryLookupInput = z
  .object({ urls: z.array(publicUrl).min(1).max(10) })
  .strict();
export async function lookupDiscoveryLeads(
  db: D1Database,
  input: z.infer<typeof discoveryLookupInput>,
) {
  const urls = [
    ...new Set(
      input.urls.map((url) => {
        const parsed = new URL(url);
        parsed.hash = "";
        return parsed.toString();
      }),
    ),
  ];
  const domains = [
    ...new Set(urls.map((url) => new URL(url).hostname.replace(/^www\./, ""))),
  ];
  const placeholders = (items: string[]) => items.map(() => "?").join(",");
  const [leads, products] = await db.batch([
    db
      .prepare(
        `SELECT source_url,domain,proposed_name,outcome,rationale,next_check,observed_at,model,policy_version FROM discovery_leads WHERE source_url IN (${placeholders(urls)}) OR domain IN (${placeholders(domains)}) ORDER BY updated_at DESC,source_url LIMIT 31`,
      )
      .bind(...urls, ...domains),
    db
      .prepare(
        `SELECT p.id,p.name,p.domain,p.status,r.status research_status FROM products p LEFT JOIN research_profiles r ON r.product_id=p.id WHERE p.domain IN (${placeholders(domains)})`,
      )
      .bind(...domains),
  ]);
  return {
    leads: leads.results.slice(0, 30),
    truncated: leads.results.length > 30,
    existingProducts: products.results,
    scope:
      "Previous private discovery outcomes, including rejected or unclear leads. Read existing product research before revisiting. Absence does not establish a new or eligible product.",
  };
}
const discoveryLeadInput = z
  .object({
    sourceUrl: publicUrl,
    discoverySource: publicUrl,
    proposedName: z.string().min(1).max(120),
    outcome: z.enum([
      "candidate",
      "reference",
      "out_of_scope",
      "duplicate_or_feature",
      "unclear",
    ]),
    rationale: z.string().min(1).max(2000),
    nextCheck: z.string().min(1).max(2000),
    observedAt: timestamp,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    primaryMetadata: z
      .object({
        title: z.string().max(2000),
        description: z.string().max(4000),
        headings: z.array(z.string().max(2000)).max(20),
      })
      .strict(),
    model: z.string().min(1).max(100),
    policyVersion: z.string().min(1).max(100),
  })
  .strict();
export const candidateInput = z
  .object({
    product: productInput,
    maker: z
      .object({
        name: z.string().min(1).max(200),
        sourceUrl: publicUrl,
        evidence: z.string().min(20).max(4000),
        sizeStatus: z.enum(["solo", "small_team", "unverified"]),
        currentSizeEvidence: z.string().min(10).max(4000),
      })
      .strict(),
    discovery: z
      .object({
        lane: z.enum(["founder_launch", "distribution", "ecosystem"]),
        sourceUrl: publicUrl,
        query: z.string().min(1).max(500),
        rationale: z.string().min(10).max(2000),
      })
      .strict()
      .optional(),
  })
  .strict();

export const assessmentInput = z
  .object({
    productId: z.string().min(1).max(100),
    relevance: z.enum(["in_scope", "reference", "out_of_scope", "unclear"]),
    rationale: z.string().min(20).max(3000),
    evidenceIds: z.array(z.string().min(1).max(100)).min(1).max(10),
    sizeStatus: z.enum(["solo", "small_team", "unverified"]),
    sizeBasis: z.enum(["self_reported", "independent", "unknown"]),
    sizeEvidenceId: z.string().min(1).max(100).optional(),
    sizeNotes: z.string().min(10).max(2000),
    nextAction: z.string().min(1).max(2000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.sizeStatus !== "unverified" &&
      (!v.sizeEvidenceId || v.sizeBasis === "unknown")
    )
      ctx.addIssue({
        code: "custom",
        message:
          "A solo/small-team claim requires a source evidence ID and an explicit evidence basis",
      });
  });
export async function saveAssessment(
  db: D1Database,
  input: z.infer<typeof assessmentInput>,
) {
  if (
    !(await db
      .prepare("SELECT product_id FROM research_profiles WHERE product_id=?")
      .bind(input.productId)
      .first())
  )
    fail(404, "Register a research candidate first");
  for (const evidenceId of new Set([
    ...input.evidenceIds,
    ...(input.sizeEvidenceId ? [input.sizeEvidenceId] : []),
  ]))
    await checkEvidence(db, evidenceId, input.productId);
  await db.batch([
    db
      .prepare(
        "UPDATE research_profiles SET assessment_json=?,size_status=?,current_size_evidence=?,status='pending',updated_at=? WHERE product_id=?",
      )
      .bind(
        JSON.stringify(input),
        input.sizeStatus,
        input.sizeNotes,
        now(),
        input.productId,
      ),
    db
      .prepare(
        "UPDATE products SET status='draft',updated_at=? WHERE id=? AND status='published'",
      )
      .bind(now(), input.productId),
  ]);
  await audit(db, "collector", "research.assessment", input.productId, {
    relevance: input.relevance,
    evidenceIds: input.evidenceIds,
  });
  return { productId: input.productId, researchStatus: "pending", saved: true };
}

export async function registerCandidate(
  db: D1Database,
  actor: string,
  input: z.infer<typeof candidateInput>,
) {
  const p = input.product,
    m = input.maker,
    domain = new URL(p.url).hostname.replace(/^www\./, "");
  const existing = await db
    .prepare("SELECT id,status,domain FROM products WHERE domain=? OR slug=?")
    .bind(domain, p.slug)
    .first<{ id: string; status: string; domain: string }>();
  if (existing) {
    if (existing.domain !== domain)
      fail(409, "Candidate slug belongs to a different domain");
    return { id: existing.id, status: existing.status, existing: true };
  }
  const productId = crypto.randomUUID(),
    time = now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO products(id,slug,name,url,domain,description,category,monetization,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        productId,
        p.slug,
        p.name,
        p.url,
        domain,
        p.description,
        p.category,
        p.monetization,
        time,
        time,
      ),
    db
      .prepare(
        "INSERT INTO research_profiles(product_id,maker_name,ownership_source_url,ownership_evidence,size_status,current_size_evidence,created_at,updated_at,discovery_json) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        productId,
        m.name,
        m.sourceUrl,
        m.evidence,
        m.sizeStatus,
        m.currentSizeEvidence,
        time,
        time,
        input.discovery ? JSON.stringify(input.discovery) : null,
      ),
  ]);
  await audit(db, actor, "research.candidate", productId, {
    sourceUrl: m.sourceUrl,
    sizeStatus: m.sizeStatus,
  });
  return {
    id: productId,
    status: "draft",
    researchStatus: "pending",
    existing: false,
  };
}

export const researchAdmin = new Hono<AppEnv>();
researchAdmin.use("*", requireAdmin);
researchAdmin.post("/research/candidates", async (c) =>
  c.json(
    await registerCandidate(c.env.DB, "admin", await parse(c, candidateInput)),
    201,
  ),
);
researchAdmin.get("/research/candidates", async (c) => {
  const { limit, offset } = page(c);
  return c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT p.*,r.maker_name,r.ownership_source_url,r.ownership_evidence,r.size_status,r.current_size_evidence,r.status research_status,r.discovery_json,r.assessment_json FROM products p JOIN research_profiles r ON r.product_id=p.id ORDER BY p.updated_at DESC LIMIT ? OFFSET ?",
      )
        .bind(limit, offset)
        .all()
    ).results,
  });
});
researchAdmin.put("/research/candidates/:id/status", async (c) => {
  const input = await parse(
    c,
    z
      .object({
        status: z.enum(["pending", "accepted", "excluded"]),
        reason: z.string().min(1).max(2000),
      })
      .strict(),
  );
  if (input.status === "accepted") {
    const row = await c.env.DB.prepare(
      "SELECT r.assessment_json,p.domain FROM research_profiles r JOIN products p ON p.id=r.product_id WHERE r.product_id=?",
    )
      .bind(c.req.param("id"))
      .first<{ assessment_json: string | null; domain: string }>();
    if (!row?.assessment_json)
      fail(
        409,
        "Save and review a source-backed assessment before accepting a candidate",
      );
    const assessment = assessmentInput.parse(JSON.parse(row.assessment_json));
    if (!["in_scope", "reference"].includes(assessment.relevance))
      fail(
        409,
        "Cohort acceptance requires an in-scope or reference, source-backed assessment",
      );
    if (
      assessment.relevance !== "reference" &&
      [...referenceDomains].some(
        (d) => row.domain === d || row.domain.endsWith("." + d),
      )
    )
      fail(
        409,
        "Known major platforms belong in reference coverage, not the independent-product core",
      );
    for (const evidenceId of new Set([
      ...assessment.evidenceIds,
      ...(assessment.sizeEvidenceId ? [assessment.sizeEvidenceId] : []),
    ]))
      await checkEvidence(c.env.DB, evidenceId, c.req.param("id"), true);
  }
  const result = await c.env.DB.prepare(
    "UPDATE research_profiles SET status=?,updated_at=? WHERE product_id=?",
  )
    .bind(input.status, now(), c.req.param("id"))
    .run();
  if (!result.meta.changes) fail(404, "Research candidate not found");
  await audit(c.env.DB, "admin", "research.status", c.req.param("id"), input);
  return c.json({ ok: true });
});
researchAdmin.post("/research/assessment", async (c) =>
  c.json(await saveAssessment(c.env.DB, await parse(c, assessmentInput)), 201),
);
researchAdmin.post("/research/leads/lookup", async (c) =>
  c.json(
    await lookupDiscoveryLeads(c.env.DB, await parse(c, discoveryLookupInput)),
  ),
);
researchAdmin.post("/research/leads", async (c) => {
  const { records } = await parse(
    c,
    z.object({ records: z.array(discoveryLeadInput).min(1).max(25) }).strict(),
  );
  const time = now();
  const results = await c.env.DB.batch(
    records.map((row) => {
      const url = new URL(row.sourceUrl);
      url.hash = "";
      return c.env.DB.prepare(
        `INSERT INTO discovery_leads(source_url,domain,discovery_source,proposed_name,outcome,rationale,next_check,observed_at,content_hash,primary_metadata,model,policy_version,first_recorded_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_url) DO UPDATE SET discovery_source=excluded.discovery_source,proposed_name=excluded.proposed_name,outcome=excluded.outcome,rationale=excluded.rationale,next_check=excluded.next_check,observed_at=excluded.observed_at,content_hash=excluded.content_hash,primary_metadata=excluded.primary_metadata,model=excluded.model,policy_version=excluded.policy_version,updated_at=excluded.updated_at WHERE excluded.observed_at>=discovery_leads.observed_at`,
      ).bind(
        url.toString(),
        url.hostname.replace(/^www\./, ""),
        row.discoverySource,
        row.proposedName,
        row.outcome,
        row.rationale,
        row.nextCheck,
        row.observedAt,
        row.contentHash,
        JSON.stringify(row.primaryMetadata),
        row.model,
        row.policyVersion,
        time,
        time,
      );
    }),
  );
  const saved = results.reduce((sum, row) => sum + row.meta.changes, 0);
  await audit(c.env.DB, "admin", "discovery.leads", "batch", { saved });
  return c.json({ saved, submitted: records.length }, 201);
});
researchAdmin.post("/research/context", async (c) =>
  c.json(await researchContext(c.env.DB, await parse(c, researchContextInput))),
);
researchAdmin.post("/research/checkpoint", async (c) =>
  c.json(await saveCheckpoint(c.env.DB, await parse(c, checkpointInput))),
);
researchAdmin.get("/research/products/:id", async (c) => {
  const { limit, offset } = page(c);
  return c.json(
    await productResearch(
      c.env.DB,
      c.req.param("id"),
      Math.min(limit, 10),
      offset,
    ),
  );
});
