import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Bindings } from "./types";
import { now } from "./types";
import { requireAdmin } from "./auth";
import { audit, fail, parse } from "./lib";
import { signedLinkParameters, signedLinkValid } from "./signed-links";

// Conservative application reservations, below the separately verified Resend Free quotas.
export const EMAIL_DAILY_LIMIT = 50;
export const EMAIL_MONTHLY_LIMIT = 1500;
export function emailDeliveryStatus(env: Bindings) {
  const configured = !!(
    env.RESEND_API_KEY &&
    env.MEDIA_SIGNING_SECRET &&
    env.RESEND_SENDER_VERIFIED === "true"
  );
  const enabled = configured && env.EMAIL_ALERTS_ENABLED === "true";
  return {
    deliveryEnabled: enabled,
    deliveryStatus: !configured
      ? "not_configured"
      : enabled
        ? "enabled"
        : "paused",
  };
}
const ELIGIBLE = `a.email_alerts=1 AND u.email IS NOT NULL
  AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id=u.id AND s.status IN ('active','trialing') AND s.period_end>?)
  AND NOT EXISTS(SELECT 1 FROM billing_holds h WHERE h.user_id=u.id)`;
const APPROVED_CHANGE = `c.status='published' AND c.published_at IS NOT NULL AND p.status='published' AND e.status='approved'`;
type Outbox = {
  id: string;
  user_id: string;
  envelope: string;
  change_ids: string;
  cursor_at: string;
  cursor_id: string;
  attempts: number;
  lease_token: string;
};
async function sendResendRequest(env: Bindings, id: string, envelope: string) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "Idempotency-Key": `arcex-digest/${id}`,
    },
    body: envelope,
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
}
/** Claim and charge the current UTC periods atomically, including retries of older jobs. */
async function reserveSendLease(db: D1Database, id: string) {
  const time = now(),
    day = "day:" + time.slice(0, 10),
    month = "month:" + time.slice(0, 7),
    lease = crypto.randomUUID();
  const result = await db.batch([
    db
      .prepare(
        "INSERT INTO email_send_usage(period_key) VALUES (?) ON CONFLICT DO NOTHING",
      )
      .bind(day),
    db
      .prepare(
        "INSERT INTO email_send_usage(period_key) VALUES (?) ON CONFLICT DO NOTHING",
      )
      .bind(month),
    db
      .prepare(
        `UPDATE email_outbox SET status='sending',attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?),lease_token=?,lease_until=? WHERE id=? AND attempts<3
      AND ((status='pending' AND available_at<=?) OR (status='sending' AND lease_until<=?))
      AND (first_attempt_at IS NULL OR first_attempt_at>?)
      AND (SELECT attempts FROM email_send_usage WHERE period_key=?)<? AND (SELECT attempts FROM email_send_usage WHERE period_key=?)<? RETURNING *`,
      )
      .bind(
        time,
        lease,
        new Date(Date.now() + 120000).toISOString(),
        id,
        time,
        time,
        new Date(Date.now() - 23 * 3600000).toISOString(),
        day,
        EMAIL_DAILY_LIMIT,
        month,
        EMAIL_MONTHLY_LIMIT,
      ),
    db
      .prepare(
        "UPDATE email_send_usage SET attempts=attempts+1 WHERE period_key IN (?,?) AND EXISTS(SELECT 1 FROM email_outbox WHERE id=? AND lease_token=? AND status='sending')",
      )
      .bind(day, month, id, lease),
  ]);
  return result[2].results[0] as Outbox | undefined;
}

/** One bounded digest per invocation; retries reuse the exact immutable provider request. */
export async function deliverOneDigest(
  env: Bindings,
): Promise<
  ReturnType<typeof emailDeliveryStatus> & { sent: number; reason?: string }
> {
  const readiness = emailDeliveryStatus(env);
  if (!readiness.deliveryEnabled) return { ...readiness, sent: 0 };
  const db = env.DB,
    time = now(),
    day = time.slice(0, 10),
    month = time.slice(0, 7);
  // Never retry after the provider's24h idempotency window. Unknown delivery needs review.
  await db
    .prepare(
      "UPDATE email_outbox SET status='uncertain',last_error='idempotency_window_expired',lease_token=NULL WHERE status IN ('pending','sending') AND first_attempt_at<?",
    )
    .bind(new Date(Date.now() - 23 * 3600000).toISOString())
    .run();
  let pending = await db
    .prepare(
      "SELECT id FROM email_outbox WHERE user_id IS NOT NULL AND attempts<3 AND ((status='pending' AND available_at<=?) OR (status='sending' AND lease_until<=?)) ORDER BY available_at,id LIMIT 1",
    )
    .bind(time, time)
    .first<{ id: string }>();
  if (!pending) {
    const user = await db
      .prepare(
        `SELECT u.id,u.email,a.last_change_at,a.last_change_id,a.updated_at FROM users u JOIN alert_settings a ON a.user_id=u.id
      WHERE ${ELIGIBLE} AND COALESCE(a.last_sent_at,'')<? AND NOT EXISTS(SELECT 1 FROM email_outbox o WHERE o.user_id=u.id AND (o.day=? OR o.status IN ('pending','sending','uncertain')))
      AND EXISTS(SELECT 1 FROM product_watches w JOIN product_changes c ON c.product_id=w.product_id JOIN products p ON p.id=c.product_id JOIN evidence e ON e.id=c.evidence_id
        WHERE w.user_id=u.id AND ${APPROVED_CHANGE} AND c.published_at>=a.updated_at AND (c.published_at, c.id)>(COALESCE(a.last_change_at,a.updated_at),COALESCE(a.last_change_id,'')))
      ORDER BY COALESCE(a.last_sent_at,a.updated_at),u.id LIMIT 1`,
      )
      .bind(time, day + "T00:00:00.000Z", day)
      .first<{
        id: string;
        email: string;
        last_change_at: string | null;
        last_change_id: string | null;
        updated_at: string;
      }>();
    if (!user) return { ...readiness, sent: 0, reason: "no_due_changes" };
    if (!z.email().safeParse(user.email).success)
      return { ...readiness, sent: 0, reason: "invalid_recipient" };
    const changes = await db
      .prepare(
        `SELECT c.id,c.summary,c.published_at,p.name,p.slug FROM product_watches w JOIN product_changes c ON c.product_id=w.product_id JOIN products p ON p.id=c.product_id JOIN evidence e ON e.id=c.evidence_id
      WHERE w.user_id=? AND ${APPROVED_CHANGE} AND c.published_at>=? AND (c.published_at,c.id)>(?,?) ORDER BY c.published_at,c.id LIMIT 20`,
      )
      .bind(
        user.id,
        user.updated_at,
        user.last_change_at ?? user.updated_at,
        user.last_change_id ?? "",
      )
      .all<{
        id: string;
        summary: string;
        published_at: string;
        name: string;
        slug: string;
      }>();
    if (!changes.results.length)
      return { ...readiness, sent: 0, reason: "no_due_changes" };
    const id = crypto.randomUUID(),
      last = changes.results.at(-1)!;
    const signature = await signedLinkParameters(
      env,
      `unsubscribe:${user.id}`,
      180 * 86400,
    );
    const unsubscribe = `${env.GOOGLE_AUTH_ORIGIN ?? env.API_ORIGIN}/api/v1/email/unsubscribe/${encodeURIComponent(user.id)}?${signature}`;
    const envelope = {
      from: "Arcex <alerts@arcex.dev>",
      to: [user.email],
      subject: "Changes to products you watch on Arcex",
      text: [
        "New observed changes to products you watch:",
        ...changes.results.map(
          (c) =>
            `\n${c.name}: ${c.summary}\n${env.APP_ORIGIN}/app/${encodeURIComponent(c.slug)}`,
        ),
        `\nManage alerts: ${env.APP_ORIGIN}/settings`,
      ].join("\n"),
      headers: {
        "List-Unsubscribe": `<${unsubscribe}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };
    pending = await db
      .prepare(
        `INSERT INTO email_outbox(id,user_id,day,month,envelope,change_ids,cursor_at,cursor_id,created_at,available_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT attempts FROM email_send_usage WHERE period_key=?),0)<? AND COALESCE((SELECT attempts FROM email_send_usage WHERE period_key=?),0)<? ON CONFLICT DO NOTHING RETURNING id`,
      )
      .bind(
        id,
        user.id,
        day,
        month,
        JSON.stringify(envelope),
        JSON.stringify(changes.results.map((c) => c.id)),
        last.published_at,
        last.id,
        time,
        time,
        "day:" + day,
        EMAIL_DAILY_LIMIT,
        "month:" + month,
        EMAIL_MONTHLY_LIMIT,
      )
      .first<{ id: string }>();
    if (!pending) return { ...readiness, sent: 0, reason: "reservation_limit" };
  }
  const job = await reserveSendLease(db, pending.id);
  if (!job) return { ...readiness, sent: 0, reason: "reservation_limit" };
  const lease = job.lease_token;
  // Opt-out, expiry, risk holds, watch removal and evidence retraction take effect before retries.
  const recipient = JSON.parse(job.envelope).to[0] as string;
  const eligible = await db
    .prepare(
      `SELECT u.id FROM users u JOIN alert_settings a ON a.user_id=u.id WHERE u.id=? AND u.email=? AND ${ELIGIBLE}
    AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN product_changes c ON c.id=j.value LEFT JOIN products p ON p.id=c.product_id LEFT JOIN evidence e ON e.id=c.evidence_id
      WHERE c.id IS NULL OR NOT(${APPROVED_CHANGE}) OR NOT EXISTS(SELECT 1 FROM product_watches w WHERE w.user_id=u.id AND w.product_id=c.product_id))`,
    )
    .bind(job.user_id, recipient, time, job.change_ids)
    .first();
  if (!eligible) {
    await db
      .prepare(
        "UPDATE email_outbox SET status='cancelled',last_error='eligibility_changed',lease_token=NULL WHERE id=? AND lease_token=?",
      )
      .bind(job.id, lease)
      .run();
    return { ...readiness, sent: 0, reason: "eligibility_changed" };
  }
  try {
    const response = await sendResendRequest(env, job.id, job.envelope);
    if (!response.ok) {
      const retry =
        (response.status === 429 || response.status >= 500) && job.attempts < 3;
      await db
        .prepare(
          "UPDATE email_outbox SET status=?,available_at=?,last_error=?,lease_token=NULL WHERE id=? AND lease_token=?",
        )
        .bind(
          retry ? "pending" : response.status >= 500 ? "uncertain" : "failed",
          new Date(Date.now() + 3600000).toISOString(),
          `provider_http_${response.status}`,
          job.id,
          lease,
        )
        .run();
      return {
        ...readiness,
        sent: 0,
        reason: retry
          ? "provider_retry_pending"
          : response.status >= 500
            ? "delivery_unknown"
            : "provider_rejected",
      };
    }
    const result = z
      .object({ id: z.string().min(1).max(200) })
      .parse(await response.json());
    await db.batch([
      db
        .prepare(
          "UPDATE alert_settings SET last_change_at=?,last_change_id=?,last_sent_at=? WHERE user_id=? AND EXISTS(SELECT 1 FROM email_outbox WHERE id=? AND lease_token=?)",
        )
        .bind(job.cursor_at, job.cursor_id, now(), job.user_id, job.id, lease),
      db
        .prepare(
          "UPDATE email_outbox SET status='sent',provider_id=?,last_error=NULL,lease_token=NULL WHERE id=? AND lease_token=?",
        )
        .bind(result.id, job.id, lease),
    ]);
    return { ...readiness, sent: 1 };
  } catch {
    await db
      .prepare(
        "UPDATE email_outbox SET status=?,available_at=?,last_error='delivery_unknown',lease_token=NULL WHERE id=? AND lease_token=?",
      )
      .bind(
        job.attempts < 3 ? "pending" : "uncertain",
        new Date(Date.now() + 3600000).toISOString(),
        job.id,
        lease,
      )
      .run();
    return { ...readiness, sent: 0, reason: "delivery_unknown" };
  }
}

export const emailAlerts = new Hono<AppEnv>();
emailAlerts.post("/email/unsubscribe/:userId", async (c) => {
  const userId = c.req.param("userId");
  if (
    !(await signedLinkValid(
      c.env,
      `unsubscribe:${userId}`,
      c.req.query("expires"),
      c.req.query("signature"),
    ))
  )
    return c.json({ error: "Invalid unsubscribe link" }, 403);
  await c.env.DB.prepare(
    "UPDATE alert_settings SET email_alerts=0,updated_at=? WHERE user_id=?",
  )
    .bind(now(), userId)
    .run();
  return c.json({ emailAlerts: false });
});
export const adminEmailAlerts = new Hono<AppEnv>();
adminEmailAlerts.use("*", requireAdmin);
adminEmailAlerts.post("/alerts/deliver", async (c) =>
  c.json(await deliverOneDigest(c.env)),
);
adminEmailAlerts.post("/alerts/:id/resolve", async (c) => {
  const { outcome, reason } = await parse(
    c,
    z
      .object({
        outcome: z.enum(["accepted", "not_accepted"]),
        reason: z.string().min(20).max(1000),
      })
      .strict(),
  );
  const row = await c.env.DB.prepare(
    "SELECT user_id,cursor_at,cursor_id FROM email_outbox WHERE id=? AND status='uncertain'",
  )
    .bind(c.req.param("id"))
    .first<{ user_id: string | null; cursor_at: string; cursor_id: string }>();
  if (!row) fail(409, "Only an uncertain delivery can be resolved");
  const statements = [
    c.env.DB.prepare(
      "UPDATE email_outbox SET status=?,last_error=? WHERE id=? AND status='uncertain'",
    ).bind(
      outcome === "accepted" ? "sent" : "failed",
      outcome === "accepted" ? null : "operator_not_accepted",
      c.req.param("id"),
    ),
  ];
  if (outcome === "accepted")
    statements.unshift(
      c.env.DB.prepare(
        "UPDATE alert_settings SET last_change_at=?,last_change_id=?,last_sent_at=? WHERE user_id=? AND EXISTS(SELECT 1 FROM email_outbox WHERE id=? AND status='uncertain')",
      ).bind(
        row.cursor_at,
        row.cursor_id,
        now(),
        row.user_id,
        c.req.param("id"),
      ),
    );
  const resolved = await c.env.DB.batch(statements);
  if (resolved.at(-1)?.meta.changes !== 1)
    fail(409, "Delivery was already resolved");
  await audit(c.env.DB, "admin", "alert.resolve", c.req.param("id"), {
    outcome,
    reason,
  });
  return c.json({ ok: true, quotaRefunded: false });
});
// The only diagnostic recipient is Resend's own simulator; no customer data or arbitrary addresses.
adminEmailAlerts.post("/alerts/simulator", async (c) => {
  if (emailDeliveryStatus(c.env).deliveryStatus === "not_configured")
    return c.json({ error: "Sending domain/key not configured" }, 503);
  const time = now(),
    day = time.slice(0, 10),
    month = time.slice(0, 7),
    id = "simulator-" + day;
  let envelope = JSON.stringify({
    from: "Arcex <alerts@arcex.dev>",
    to: ["delivered@resend.dev"],
    subject: "Arcex sending-path verification",
    text: "Sending-path verification for arcex.dev, addressed only to the Resend simulator. No customer data.",
  });
  const reserved = await c.env.DB.prepare(
    `INSERT INTO email_outbox(id,user_id,day,month,envelope,change_ids,cursor_at,cursor_id,status,attempts,created_at,available_at) SELECT ?,NULL,?,?,?,'[]',?,'simulator','pending',0,?,? WHERE COALESCE((SELECT attempts FROM email_send_usage WHERE period_key=?),0)<? AND COALESCE((SELECT attempts FROM email_send_usage WHERE period_key=?),0)<? ON CONFLICT DO NOTHING RETURNING id`,
  )
    .bind(
      id,
      day,
      month,
      envelope,
      time,
      time,
      time,
      "day:" + day,
      EMAIL_DAILY_LIMIT,
      "month:" + month,
      EMAIL_MONTHLY_LIMIT,
    )
    .first();
  if (!reserved) {
    const reviewed = await c.env.DB.prepare(
      "SELECT envelope FROM email_outbox WHERE id=? AND user_id IS NULL AND status='failed' AND last_error='operator_not_accepted' AND attempts<3",
    )
      .bind(id)
      .first<{ envelope: string }>();
    if (!reviewed)
      return c.json(
        {
          error:
            "Simulator already reserved today or sending allowance exhausted",
        },
        409,
      );
    envelope = reviewed.envelope;
    const reset = await c.env.DB.prepare(
      "UPDATE email_outbox SET status='pending',available_at=?,lease_token=NULL WHERE id=? AND status='failed' AND last_error='operator_not_accepted'",
    )
      .bind(time, id)
      .run();
    if (reset.meta.changes !== 1)
      return c.json({ error: "Simulator is already being processed" }, 409);
  }
  if (!(await reserveSendLease(c.env.DB, id)))
    return c.json({ error: "Sending allowance exhausted" }, 409);
  try {
    const response = await sendResendRequest(c.env, id, envelope);
    if (!response.ok) {
      await c.env.DB.prepare(
        "UPDATE email_outbox SET status='failed',last_error=? WHERE id=?",
      )
        .bind("provider_http_" + response.status, id)
        .run();
      return c.json({ accepted: false, providerStatus: response.status }, 502);
    }
    const result = z
      .object({ id: z.string().min(1).max(200) })
      .parse(await response.json());
    await c.env.DB.prepare(
      "UPDATE email_outbox SET status='sent',provider_id=? WHERE id=?",
    )
      .bind(result.id, id)
      .run();
    return c.json({
      accepted: true,
      providerId: result.id,
      recipient: "Resend simulator",
      meaning:
        "Provider accepted the request; inbox delivery is not established by this response.",
    });
  } catch {
    await c.env.DB.prepare(
      "UPDATE email_outbox SET status='uncertain',last_error='delivery_unknown' WHERE id=?",
    )
      .bind(id)
      .run();
    return c.json({ accepted: false, reason: "delivery_unknown" }, 502);
  }
});
adminEmailAlerts.get("/alerts/status", async (c) => {
  const time = now();
  const usage = await c.env.DB.prepare(
    "SELECT COALESCE((SELECT attempts FROM email_send_usage WHERE period_key=?),0) daily_attempts,COALESCE((SELECT attempts FROM email_send_usage WHERE period_key=?),0) monthly_attempts,sum(status='pending') pending,sum(status='uncertain') needs_review FROM email_outbox",
  )
    .bind("day:" + time.slice(0, 10), "month:" + time.slice(0, 7))
    .first();
  return c.json({
    ...emailDeliveryStatus(c.env),
    dailyLimit: EMAIL_DAILY_LIMIT,
    monthlyLimit: EMAIL_MONTHLY_LIMIT,
    usage,
  });
});
