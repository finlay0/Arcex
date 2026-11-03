import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Bindings } from "./types";
import { now, later } from "./types";
import { audit, fail, page, parse, randomToken } from "./lib";
import { requireAdmin, requireCollector } from "./auth";
import { sourceInput, evidenceInput } from "./contracts";
import { productExists } from "./catalog";

export async function enqueueDue(env: Bindings) {
  const time = now();
  // A D1 batch is transactional. Advancing the schedule and inserting a unique job commit together.
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO jobs(id,source_id,dedupe_key,available_at,created_at,updated_at) SELECT lower(hex(randomblob(16))),id,id||':'||next_run_at,?,?,? FROM sources WHERE enabled=1 AND next_run_at<=? ON CONFLICT(dedupe_key) DO NOTHING",
    ).bind(time, time, time, time),
    env.DB.prepare(
      "UPDATE sources SET next_run_at=strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+'||interval_hours||' hours') WHERE enabled=1 AND next_run_at<=?",
    ).bind(time, time),
    env.DB.prepare(
      "UPDATE jobs SET status='failed',error='Lease expired after maximum attempts',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE status='running' AND lease_expires_at<=? AND attempts>=max_attempts",
    ).bind(time, time),
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at<?").bind(time),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(time),
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(time),
    env.DB.prepare("DELETE FROM checkout_attempts WHERE bucket<?").bind(
      Math.floor(Date.now() / 1800000) - 336,
    ),
  ]);
  return { enqueued: results[0].meta.changes };
}
export const jobAdmin = new Hono<AppEnv>();
jobAdmin.use("*", requireAdmin);
jobAdmin.post("/sources", async (c) => {
  const input = await parse(c, sourceInput);
  if (input.productId) await productExists(c.env.DB, input.productId);
  const sourceId = crypto.randomUUID(),
    time = now();
  await c.env.DB.prepare(
    "INSERT INTO sources(id,product_id,name,url,kind,interval_hours,enabled,next_run_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      sourceId,
      input.productId ?? null,
      input.name,
      input.url,
      input.kind,
      input.intervalHours,
      input.enabled ? 1 : 0,
      time,
      time,
    )
    .run();
  await audit(c.env.DB, "admin", "source.create", sourceId);
  return c.json({ id: sourceId }, 201);
});
jobAdmin.get("/sources", async (c) => {
  const { limit, offset } = page(c);
  return c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT * FROM sources ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
        .bind(limit, offset)
        .all()
    ).results,
  });
});
jobAdmin.patch("/sources/:id", async (c) => {
  const input = await parse(
    c,
    z
      .object({
        enabled: z.boolean(),
        intervalHours: z.number().int().min(1).max(720).optional(),
      })
      .strict(),
  );
  const result = await c.env.DB.prepare(
    "UPDATE sources SET enabled=?,interval_hours=COALESCE(?,interval_hours) WHERE id=?",
  )
    .bind(input.enabled ? 1 : 0, input.intervalHours ?? null, c.req.param("id"))
    .run();
  if (!result.meta.changes) fail(404, "Source not found");
  return c.json({ ok: true });
});
jobAdmin.post("/jobs/enqueue", async (c) => c.json(await enqueueDue(c.env)));
jobAdmin.get("/jobs", async (c) => {
  const { limit, offset } = page(c);
  return c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT id,source_id,status,attempts,max_attempts,available_at,lease_expires_at,result,error,created_at,updated_at FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
        .bind(limit, offset)
        .all()
    ).results,
  });
});
jobAdmin.post("/jobs/:id/retry", async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET status='queued',attempts=0,error=NULL,lease_token=NULL,lease_expires_at=NULL,available_at=?,updated_at=? WHERE id=? AND status='failed'",
  )
    .bind(now(), now(), c.req.param("id"))
    .run();
  if (!result.meta.changes) fail(409, "Only failed jobs can be retried");
  return c.json({ ok: true });
});
jobAdmin.get("/audit", async (c) => {
  const { limit, offset } = page(c);
  return c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
        .bind(limit, offset)
        .all()
    ).results,
  });
});

export const collector = new Hono<AppEnv>();
collector.use("*", requireCollector);
collector.post("/claim", async (c) => {
  const input = await parse(
    c,
    z
      .object({
        kinds: z
          .array(z.enum(["public_page", "rss", "browser"]))
          .min(1)
          .max(3),
      })
      .strict(),
  );
  const token = randomToken(),
    time = now();
  const result = await c.env.DB.prepare(
    `UPDATE jobs SET status='running',attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=? WHERE id=(SELECT j.id FROM jobs j JOIN sources s ON s.id=j.source_id WHERE s.enabled=1 AND s.kind IN (${input.kinds.map(() => "?").join(",")}) AND j.attempts<j.max_attempts AND ((j.status='queued' AND j.available_at<=?) OR (j.status='running' AND j.lease_expires_at<=?)) ORDER BY j.available_at,j.id LIMIT 1) RETURNING id,source_id,attempts,lease_expires_at`,
  )
    .bind(token, later(600), time, ...input.kinds, time, time)
    .first<{ id: string; source_id: string }>();
  if (!result) return c.json({ job: null });
  const source = await c.env.DB.prepare("SELECT * FROM sources WHERE id=?")
    .bind(result.source_id)
    .first();
  return c.json({ job: { ...result, leaseToken: token, source } });
});
const leaseSchema = z.object({
  leaseToken: z.string().regex(/^[a-f0-9]{64}$/),
});
collector.post("/:id/heartbeat", async (c) => {
  const { leaseToken } = await parse(c, leaseSchema.strict());
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET lease_expires_at=?,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?",
  )
    .bind(later(600), now(), c.req.param("id"), leaseToken, now())
    .run();
  if (!result.meta.changes) fail(409, "Job lease expired or replaced");
  return c.json({ ok: true });
});
collector.post("/:id/complete", async (c) => {
  const input = await parse(
    c,
    leaseSchema
      .extend({
        evidence: z
          .array(evidenceInput.omit({ productId: true }))
          .min(1)
          .max(30),
      })
      .strict(),
  );
  const jobId = c.req.param("id"),
    time = now();
  const job = await c.env.DB.prepare(
    "SELECT s.product_id,s.url,s.kind FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.id=? AND j.status='running' AND j.lease_token=? AND j.lease_expires_at>?",
  )
    .bind(jobId, input.leaseToken, time)
    .first<{ product_id: string | null; url: string; kind: string }>();
  if (!job) fail(409, "Job lease expired or replaced");
  for (const item of input.evidence) {
    if (item.observedAt > new Date(Date.now() + 60000).toISOString())
      fail(422, "Evidence cannot be observed in the future");
    // RSS items may point to a publisher's individual articles; browser/page evidence stays on the registered host.
    if (
      job.kind !== "rss" &&
      new URL(item.sourceUrl).hostname !== new URL(job.url).hostname
    )
      fail(422, "Evidence must match the registered source host");
  }
  const statements = input.evidence.map((item) =>
    c.env.DB.prepare(
      "INSERT INTO evidence(id,product_id,source_url,observed_at,kind,content_hash,summary,payload,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?) ON CONFLICT DO NOTHING",
    ).bind(
      crypto.randomUUID(),
      job.product_id,
      item.sourceUrl,
      item.observedAt,
      item.kind,
      item.contentHash,
      item.summary,
      JSON.stringify(item.payload),
      time,
      jobId,
      input.leaseToken,
      time,
    ),
  );
  for (const item of input.evidence)
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO evidence_observations(evidence_id,observed_at,job_id) SELECT e.id,?,? FROM evidence e WHERE e.product_id IS ? AND e.source_url=? AND e.content_hash=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?) ON CONFLICT DO NOTHING",
      ).bind(
        item.observedAt,
        jobId,
        job.product_id,
        item.sourceUrl,
        item.contentHash,
        jobId,
        input.leaseToken,
        time,
      ),
    );
  statements.push(
    c.env.DB.prepare(
      "UPDATE jobs SET status='succeeded',result=?,error=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?",
    ).bind(
      JSON.stringify({ submittedEvidence: input.evidence.length }),
      time,
      jobId,
      input.leaseToken,
      time,
    ),
  );
  const results = await c.env.DB.batch(statements);
  if (!results.at(-1)!.meta.changes) fail(409, "Job lease replaced");
  return c.json({
    ok: true,
    inserted: results
      .slice(0, input.evidence.length)
      .reduce((n, r) => n + r.meta.changes, 0),
  });
});
collector.post("/:id/fail", async (c) => {
  const input = await parse(
    c,
    leaseSchema.extend({ error: z.string().min(1).max(2000) }).strict(),
  );
  const job = await c.env.DB.prepare("SELECT attempts FROM jobs WHERE id=?")
    .bind(c.req.param("id"))
    .first<{ attempts: number }>();
  const result = await c.env.DB.prepare(
    "UPDATE jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,error=?,available_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?",
  )
    .bind(
      input.error,
      later(Math.min(3600, 60 * 2 ** (job?.attempts ?? 1))),
      now(),
      c.req.param("id"),
      input.leaseToken,
      now(),
    )
    .run();
  if (!result.meta.changes) fail(409, "Job lease expired or replaced");
  return c.json({ ok: true });
});
