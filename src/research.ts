import { z } from "zod";
import { productInput, publicUrl } from "./contracts";
import { fail, audit } from "./lib";
import { now } from "./types";
import { Hono } from "hono";
import type { AppEnv } from "./types";
import { requireAdmin } from "./auth";
import { parse, page } from "./lib";

export const excludedDomains = new Set([
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
  })
  .strict();

export async function registerCandidate(
  db: D1Database,
  actor: string,
  input: z.infer<typeof candidateInput>,
) {
  const p = input.product,
    m = input.maker,
    domain = new URL(p.url).hostname.replace(/^www\./, "");
  if (
    [...excludedDomains].some((d) => domain === d || domain.endsWith("." + d))
  )
    fail(422, "This platform is excluded from the core research cohort");
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
        "INSERT INTO research_profiles(product_id,maker_name,ownership_source_url,ownership_evidence,size_status,current_size_evidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
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
        "SELECT p.*,r.maker_name,r.ownership_source_url,r.ownership_evidence,r.size_status,r.current_size_evidence,r.status research_status FROM products p JOIN research_profiles r ON r.product_id=p.id ORDER BY p.updated_at DESC LIMIT ? OFFSET ?",
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
  const result = await c.env.DB.prepare(
    "UPDATE research_profiles SET status=?,updated_at=? WHERE product_id=?",
  )
    .bind(input.status, now(), c.req.param("id"))
    .run();
  if (!result.meta.changes) fail(404, "Research candidate not found");
  await audit(c.env.DB, "admin", "research.status", c.req.param("id"), input);
  return c.json({ ok: true });
});
