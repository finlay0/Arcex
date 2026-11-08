import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Bindings } from "./types";
import { now, later } from "./types";
import { audit, fail, page, parse, randomToken, sha256 } from "./lib";
import { requireAdmin, requireCollector } from "./auth";
import { sourceInput, evidenceInput, sourceCaptureMode } from "./contracts";
import { collectionStatus } from "./collection-policy";
import { productExists } from "./catalog";

export async function enqueueDue(env: Bindings) {
  const time = now();
  // Selection and schedule advancement share one transaction. Sources
  // with an unfinished job keep their place without creating a second backlog.
  // Code-only HTTP checks also build history for pending candidates (not excluded ones);
  // model and browser monitoring stays limited to owner-accepted products.
  const due = `SELECT s.id FROM sources s
    WHERE s.enabled=1 AND s.next_run_at<=? AND s.lane=?
      AND (s.lane='discovery' OR NOT EXISTS(SELECT 1 FROM research_profiles r WHERE r.product_id=s.product_id AND r.status!='accepted') OR (s.lane='http' AND NOT EXISTS(SELECT 1 FROM research_profiles r WHERE r.product_id=s.product_id AND r.status='excluded')))
      AND NOT EXISTS(SELECT 1 FROM products p WHERE p.id=s.product_id AND p.status='archived')
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.source_id=s.id AND j.status IN ('queued','running'))
    ORDER BY s.next_run_at,s.id LIMIT min(?,max(0,?-(SELECT COUNT(*) FROM jobs j JOIN sources q ON q.id=j.source_id WHERE j.status IN ('queued','running') AND q.lane=?)))`;
  const statements: D1PreparedStatement[] = [];
  for (const [lane, batch] of [
    ["http", 200],
    ["browser", 12],
    ["discovery", 3],
  ] as const) {
    const queueCap = lane === "http" ? 900 : lane === "browser" ? 80 : 20;
    statements.push(
      env.DB.prepare(
        `INSERT INTO jobs(id,source_id,dedupe_key,available_at,created_at,updated_at)
      SELECT lower(hex(randomblob(16))),id,id||':'||next_run_at,?,?,? FROM sources
      WHERE id IN (${due})
      ON CONFLICT(dedupe_key) DO NOTHING`,
      ).bind(time, time, time, time, lane, batch, queueCap, lane),
    );
    // Only inserted jobs advance the schedule, including when the backlog is full.
    statements.push(
      env.DB.prepare(
        `UPDATE sources SET next_run_at=strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+'||interval_hours||' hours')
      WHERE id IN (SELECT j.source_id FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.created_at=? AND j.status='queued' AND s.lane=? AND j.dedupe_key=s.id||':'||s.next_run_at)`,
      ).bind(time, time, lane),
    );
  }
  const results = await env.DB.batch([
    ...statements,
    // Work for a disabled source or archived product is closed rather than left queued.
    env.DB.prepare(
      "UPDATE jobs SET status='failed',error='Source disabled or product archived',updated_at=? WHERE status='queued' AND source_id IN (SELECT s.id FROM sources s LEFT JOIN products p ON p.id=s.product_id WHERE s.enabled=0 OR p.status='archived')",
    ).bind(time),
    env.DB.prepare(
      "UPDATE jobs SET status='failed',error='Lease expired after maximum attempts',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE status='running' AND lease_expires_at<=? AND attempts>=max_attempts",
    ).bind(time, time),
    env.DB.prepare(
      "DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE status IN ('succeeded','failed') AND updated_at<? ORDER BY updated_at LIMIT 2000)",
    ).bind(later(-30 * 86400)),
    env.DB.prepare("DELETE FROM collection_usage WHERE day<?").bind(
      later(-35 * 86400).slice(0, 10),
    ),
  ]);
  return {
    enqueued: [0, 2, 4].reduce((n, i) => n + results[i].meta.changes, 0),
    rowsRead: results.reduce((n, r) => n + r.meta.rows_read, 0),
    rowsWritten: results.reduce((n, r) => n + r.meta.rows_written, 0),
  };
}
export const jobAdmin = new Hono<AppEnv>();
export async function expireAuthState(db: D1Database) {
  const time = now();
  await db.batch([
    db.prepare("DELETE FROM rate_limits WHERE expires_at<?").bind(time),
    db.prepare("DELETE FROM sessions WHERE expires_at<?").bind(time),
    db.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(time),
    db
      .prepare("DELETE FROM checkout_attempts WHERE bucket<?")
      .bind(Math.floor(Date.now() / 1800000) - 336),
  ]);
}
jobAdmin.use("*", requireAdmin);
jobAdmin.post("/sources", async (c) => {
  const input = await parse(c, sourceInput);
  if (input.lane && (input.lane === "http") !== (input.kind !== "browser"))
    fail(
      422,
      "HTTP sources use the http lane; browser sources use browser or discovery",
    );
  if (input.productId) await productExists(c.env.DB, input.productId);
  const sourceId = crypto.randomUUID(),
    time = now();
  const inserted = await c.env.DB.prepare(
    "INSERT INTO sources(id,product_id,name,url,kind,interval_hours,enabled,next_run_at,created_at,lane,capture_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(url,kind) DO NOTHING RETURNING id",
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
      input.lane ?? (input.kind === "browser" ? "browser" : "http"),
      input.captureMode,
    )
    .first();
  if (!inserted)
    fail(
      409,
      "A source with this URL and collection kind already exists; reuse it",
    );
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
        captureMode: sourceCaptureMode.optional(),
      })
      .strict(),
  );
  const result = await c.env.DB.prepare(
    `UPDATE sources SET enabled=?2,interval_hours=COALESCE(?3,interval_hours),
     last_fingerprint=CASE WHEN capture_mode<>COALESCE(?1,capture_mode) THEN NULL ELSE last_fingerprint END,
     last_evidence_id=CASE WHEN capture_mode<>COALESCE(?1,capture_mode) THEN NULL ELSE last_evidence_id END,
     http_etag=CASE WHEN capture_mode<>COALESCE(?1,capture_mode) THEN NULL ELSE http_etag END,
     http_last_modified=CASE WHEN capture_mode<>COALESCE(?1,capture_mode) THEN NULL ELSE http_last_modified END,
     last_checked_at=CASE WHEN capture_mode<>COALESCE(?1,capture_mode) THEN NULL ELSE last_checked_at END,
     last_changed_at=CASE WHEN capture_mode<>COALESCE(?1,capture_mode) THEN NULL ELSE last_changed_at END,
     unchanged_streak=CASE WHEN capture_mode<>COALESCE(?1,capture_mode) THEN 0 ELSE unchanged_streak END,
     next_run_at=CASE WHEN capture_mode<>COALESCE(?1,capture_mode) THEN ?4 ELSE next_run_at END,
     capture_mode=COALESCE(?1,capture_mode)
     WHERE id=?5 AND (?1 IS NULL OR ?1='metadata' OR kind='public_page')
       AND (capture_mode=COALESCE(?1,capture_mode) OR NOT EXISTS(SELECT 1 FROM jobs WHERE source_id=sources.id AND status='running'))`,
  )
    .bind(
      input.captureMode ?? null,
      input.enabled ? 1 : 0,
      input.intervalHours ?? null,
      now(),
      c.req.param("id"),
    )
    .run();
  if (!result.meta.changes) {
    const source = await c.env.DB.prepare("SELECT kind FROM sources WHERE id=?")
      .bind(c.req.param("id"))
      .first<{ kind: string }>();
    if (!source) fail(404, "Source not found");
    if (input.captureMode === "text" && source.kind !== "public_page")
      fail(422, "Text capture is only supported for public-page HTTP sources");
    fail(
      409,
      "Finish or reclaim the running source job before changing capture mode",
    );
  }
  return c.json({ ok: true });
});
jobAdmin.get("/collection/status", async (c) =>
  c.json(await collectionStatus(c.env.DB)),
);
jobAdmin.patch("/collection/policy/:lane", async (c) => {
  const input = await parse(
    c,
    z
      .object({
        dailyLimit: z.number().int().min(0).max(10000),
        concurrencyLimit: z.number().int().min(0).max(10),
      })
      .strict(),
  );
  const result = await c.env.DB.prepare(
    "UPDATE collection_policy SET daily_limit=?,concurrency_limit=? WHERE lane=?",
  )
    .bind(input.dailyLimit, input.concurrencyLimit, c.req.param("lane"))
    .run();
  if (!result.meta.changes) fail(404, "Collection lane not found");
  await audit(
    c.env.DB,
    "admin",
    "collection.policy",
    c.req.param("lane"),
    input,
  );
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
        "SELECT id,actor,action,target,CASE WHEN length(detail)<=8000 THEN detail ELSE NULL END detail,length(detail)>8000 detail_omitted,created_at FROM audit_events ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
        .bind(limit, offset)
        .all()
    ).results,
  });
});

export const collector = new Hono<AppEnv>();
collector.use("*", requireCollector);
collector.get("/status", (c) =>
  c.json({ collectionEnabled: c.env.COLLECTION_ENABLED === "true" }),
);
export const claimInput = z
  .object({
    kinds: z
      .array(z.enum(["public_page", "rss", "browser"]))
      .min(1)
      .max(3),
    lane: z.enum(["http", "browser", "discovery"]).optional(),
  })
  .strict();
collector.post("/claim", async (c) => {
  const input = await parse(c, claimInput);
  const lane =
    input.lane ?? (input.kinds.includes("browser") ? "browser" : "http");
  if (input.kinds.some((kind) => (kind === "browser") !== (lane !== "http")))
    fail(422, "Claim one resource lane at a time");
  const token = randomToken(),
    time = now(),
    day = time.slice(0, 10);
  // Allocation and budget debit are one transaction, including reclaimed leases.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO collection_usage(lane,day) VALUES (?,?) ON CONFLICT DO NOTHING",
    ).bind(lane, day),
    c.env.DB.prepare(
      `UPDATE jobs SET status='running',attempts=attempts+1,claimed_lane=?,lease_token=?,lease_expires_at=?,updated_at=?
      WHERE id=(SELECT j.id FROM jobs j JOIN sources s ON s.id=j.source_id
        WHERE s.enabled=1 AND s.lane=? AND s.kind IN (${input.kinds.map(() => "?").join(",")})
          AND (s.lane='discovery' OR NOT EXISTS(SELECT 1 FROM research_profiles r WHERE r.product_id=s.product_id AND r.status!='accepted') OR (s.lane='http' AND NOT EXISTS(SELECT 1 FROM research_profiles r WHERE r.product_id=s.product_id AND r.status='excluded')))
          AND NOT EXISTS(SELECT 1 FROM products p WHERE p.id=s.product_id AND p.status='archived')
          AND j.attempts<j.max_attempts AND ((j.status='queued' AND j.available_at<=?) OR (j.status='running' AND j.lease_expires_at<=?))
          AND (SELECT claims FROM collection_usage WHERE lane=? AND day=?) < (SELECT daily_limit FROM collection_policy WHERE lane=?)
          AND (SELECT COUNT(*) FROM jobs WHERE claimed_lane=? AND status='running' AND lease_expires_at>?) < (SELECT concurrency_limit FROM collection_policy WHERE lane=?)
        ORDER BY j.available_at,j.id LIMIT 1)
      RETURNING id,source_id,attempts,lease_expires_at`,
    ).bind(
      lane,
      token,
      later(600),
      time,
      lane,
      ...input.kinds,
      time,
      time,
      lane,
      day,
      lane,
      lane,
      time,
      lane,
    ),
    c.env.DB.prepare(
      "UPDATE collection_usage SET claims=claims+1 WHERE lane=? AND day=? AND EXISTS(SELECT 1 FROM jobs WHERE lease_token=?)",
    ).bind(lane, day, token),
  ]);
  const job = results[1].results[0] as
    { id: string; source_id: string } | undefined;
  if (!job)
    return c.json({
      job: null,
      reason: "No eligible work or lane allowance exhausted",
      lane,
    });
  const source = await c.env.DB.prepare("SELECT * FROM sources WHERE id=?")
    .bind(job.source_id)
    .first();
  return c.json({ job: { ...job, leaseToken: token, lane, source } });
});
export const leaseSchema = z.object({
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
export const completionInput = leaseSchema
  .extend({
    evidence: z
      .array(evidenceInput.omit({ productId: true }))
      .max(30)
      .default([]),
    outcome: z.enum(["observed", "unchanged"]).default("observed"),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    httpCache: z
      .object({
        etag: z
          .string()
          .max(1000)
          .regex(/^[^\r\n]*$/)
          .nullable(),
        lastModified: z
          .string()
          .max(200)
          .regex(/^[^\r\n]*$/)
          .nullable(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.outcome === "observed"
        ? input.evidence.length > 0
        : input.evidence.length === 0 && !!input.fingerprint,
    "Observed work needs evidence; unchanged work needs a previous fingerprint and no evidence",
  );
collector.post("/:id/complete", async (c) => {
  const input = await parse(c, completionInput);
  const jobId = c.req.param("id"),
    time = now();
  const job = await c.env.DB.prepare(
    "SELECT s.id,s.product_id,s.url,s.kind,s.last_fingerprint,s.capture_mode FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.id=? AND j.status='running' AND j.lease_token=? AND j.lease_expires_at>?",
  )
    .bind(jobId, input.leaseToken, time)
    .first<{
      id: string;
      product_id: string | null;
      url: string;
      kind: string;
      last_fingerprint: string | null;
      capture_mode: "metadata" | "text";
    }>();
  if (!job) fail(409, "Job lease expired or replaced");
  if (
    job.kind === "public_page" &&
    job.capture_mode === "text" &&
    input.outcome === "observed" &&
    (input.evidence.length !== 1 ||
      input.evidence[0].kind !== "page" ||
      input.evidence[0].sourceUrl !== job.url ||
      input.evidence[0].payload.captureMode !== "text" ||
      typeof input.evidence[0].payload.text !== "string")
  )
    fail(
      422,
      "Text-mode sources require one matching text capture from an updated HTTP collector",
    );
  if (
    input.outcome === "unchanged" &&
    (job.kind === "browser" ||
      !job.last_fingerprint ||
      input.fingerprint !== job.last_fingerprint)
  )
    fail(
      422,
      "Unchanged completion needs a previously observed HTTP source fingerprint",
    );
  const fingerprint =
    input.fingerprint ??
    (await sha256(
      JSON.stringify(
        input.evidence.map((e) => [e.sourceUrl, e.contentHash]).sort(),
      ),
    ));
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
  // Bulk inserts keep a 30-item completion below D1 Free's per-invocation query limit.
  const rows = JSON.stringify(
    input.evidence.map((item) => ({ ...item, id: crypto.randomUUID() })),
  );
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO evidence(id,product_id,source_url,observed_at,kind,content_hash,summary,payload,created_at)
       SELECT json_extract(value,'$.id'),?,json_extract(value,'$.sourceUrl'),json_extract(value,'$.observedAt'),json_extract(value,'$.kind'),
         json_extract(value,'$.contentHash'),json_extract(value,'$.summary'),json_extract(value,'$.payload'),?
       FROM json_each(?) WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?) ON CONFLICT DO NOTHING`,
    ).bind(job.product_id, time, rows, jobId, input.leaseToken, time),
    c.env.DB.prepare(
      `INSERT INTO evidence_observations(evidence_id,observed_at,job_id)
       SELECT e.id,json_extract(j.value,'$.observedAt'),? FROM json_each(?) j JOIN evidence e
         ON e.product_id IS ? AND e.source_url=json_extract(j.value,'$.sourceUrl') AND e.content_hash=json_extract(j.value,'$.contentHash')
       WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?) ON CONFLICT DO NOTHING`,
    ).bind(jobId, rows, job.product_id, jobId, input.leaseToken, time),
  ];
  const page = input.evidence.find(
    (e) =>
      e.kind === "page" &&
      e.sourceUrl === job.url &&
      Array.isArray(e.payload.stack),
  );
  if (
    job.kind === "public_page" &&
    input.outcome === "observed" &&
    job.product_id &&
    page
  ) {
    // Homepage technologies: upsert what this observation shows, then mark the rest removed.
    const leased =
      "EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?)";
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO product_stack(product_id,technology,category,first_seen,last_seen)
         SELECT ?,json_extract(value,'$.technology'),json_extract(value,'$.category'),?,? FROM json_each(?)
         WHERE typeof(json_extract(value,'$.technology'))='text' AND length(json_extract(value,'$.technology')) BETWEEN 1 AND 40
           AND json_extract(value,'$.category') IN ('framework','site_builder','payments','analytics','ad_pixel','support','auth','backend','marketing')
           AND ${leased}
         ON CONFLICT(product_id,technology) DO UPDATE SET last_seen=excluded.last_seen,removed_at=NULL`,
      ).bind(
        job.product_id,
        time,
        time,
        JSON.stringify((page.payload.stack as unknown[]).slice(0, 40)),
        jobId,
        input.leaseToken,
        time,
      ),
      c.env.DB.prepare(
        `UPDATE product_stack SET removed_at=? WHERE product_id=? AND removed_at IS NULL AND last_seen<? AND ${leased}`,
      ).bind(time, job.product_id, time, jobId, input.leaseToken, time),
    );
  }
  if (job.kind === "public_page" && input.outcome === "observed") {
    // A first check establishes a baseline. Only a later, different observation creates a private comparison.
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO product_changes(id,product_id,evidence_id,previous_evidence_id,source_id,kind,summary,observed_at,created_at)
       SELECT ?,s.product_id,e.id,previous.id,s.id,'public_page',
         'Public page content changed. Review the linked observations before describing the change.',json_extract(j.value,'$.observedAt'),?
       FROM sources s JOIN evidence previous ON previous.id=s.last_evidence_id AND previous.product_id=s.product_id
       JOIN json_each(?) j ON json_extract(j.value,'$.sourceUrl')=s.url AND json_extract(j.value,'$.kind')='page'
       JOIN evidence e ON e.product_id=s.product_id AND e.source_url=s.url AND e.content_hash=json_extract(j.value,'$.contentHash')
       WHERE s.id=? AND s.last_fingerprint IS NOT NULL AND s.last_fingerprint<>? AND previous.content_hash<>e.content_hash
         AND json_extract(j.value,'$.observedAt')>COALESCE((SELECT max(observed_at) FROM evidence_observations WHERE evidence_id=previous.id),previous.observed_at)
         AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?)
       LIMIT 1 ON CONFLICT DO NOTHING`,
      ).bind(
        "page:" + jobId,
        time,
        rows,
        job.id,
        fingerprint,
        jobId,
        input.leaseToken,
        time,
      ),
    );
    statements.push(
      c.env.DB.prepare(
        `UPDATE sources SET last_evidence_id=COALESCE((
         SELECT e.id FROM json_each(?) j JOIN evidence e ON e.product_id=sources.product_id
           AND e.source_url=sources.url AND e.content_hash=json_extract(j.value,'$.contentHash')
         WHERE json_extract(j.value,'$.sourceUrl')=sources.url AND json_extract(j.value,'$.kind')='page'
           AND json_extract(j.value,'$.observedAt')>=COALESCE((SELECT max(observed_at) FROM evidence_observations WHERE evidence_id=sources.last_evidence_id),'')
         ORDER BY json_extract(j.value,'$.observedAt') DESC LIMIT 1),last_evidence_id)
       WHERE id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?)
         AND EXISTS(SELECT 1 FROM json_each(?) WHERE json_extract(value,'$.sourceUrl')=sources.url AND json_extract(value,'$.kind')='page')`,
      ).bind(rows, job.id, jobId, input.leaseToken, time, rows),
    );
  }
  statements.push(
    c.env.DB.prepare(
      `UPDATE sources SET
    last_checked_at=?,last_changed_at=CASE WHEN last_fingerprint IS ? THEN last_changed_at ELSE ? END,
    unchanged_streak=CASE WHEN last_fingerprint IS ? THEN unchanged_streak+1 ELSE 0 END,
    failure_streak=0,last_fingerprint=?,
    http_etag=CASE WHEN ? THEN ? ELSE http_etag END,
    http_last_modified=CASE WHEN ? THEN ? ELSE http_last_modified END,
    next_run_at=strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+'||min(720,interval_hours * CASE WHEN kind='public_page' AND last_fingerprint IS ? THEN (1 << min(3,(unchanged_streak+1)/3)) ELSE 1 END)||' hours')
    WHERE id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?)`,
    ).bind(
      time,
      fingerprint,
      time,
      fingerprint,
      fingerprint,
      input.httpCache ? 1 : 0,
      input.httpCache?.etag ?? null,
      input.httpCache ? 1 : 0,
      input.httpCache?.lastModified ?? null,
      time,
      fingerprint,
      job.id,
      jobId,
      input.leaseToken,
      time,
    ),
  );
  statements.push(
    c.env.DB.prepare(
      "UPDATE jobs SET status='succeeded',result=?,error=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?",
    ).bind(
      JSON.stringify({
        submittedEvidence: input.evidence.length,
        outcome: input.outcome,
      }),
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
    inserted: results[0].meta.changes,
  });
});
collector.post("/:id/fail", async (c) => {
  const input = await parse(
    c,
    leaseSchema
      .extend({
        error: z.string().min(1).max(2000),
        blocked: z.boolean().default(false),
      })
      .strict(),
  );
  const job = await c.env.DB.prepare("SELECT attempts FROM jobs WHERE id=?")
    .bind(c.req.param("id"))
    .first<{ attempts: number }>();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE sources SET failure_streak=failure_streak+1,
      enabled=CASE WHEN ? THEN 0 ELSE enabled END,
      next_run_at=strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+'||min(720,interval_hours*(1 << min(5,failure_streak+1)))||' hours')
      WHERE id=(SELECT source_id FROM jobs WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?)`,
    ).bind(
      input.blocked ? 1 : 0,
      now(),
      c.req.param("id"),
      input.leaseToken,
      now(),
    ),
    c.env.DB.prepare(
      "UPDATE jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,error=?,available_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?",
    ).bind(
      input.error,
      later(Math.min(3600, 60 * 2 ** (job?.attempts ?? 1))),
      now(),
      c.req.param("id"),
      input.leaseToken,
      now(),
    ),
  ]);
  if (!results[1].meta.changes) fail(409, "Job lease expired or replaced");
  return c.json({ ok: true });
});
