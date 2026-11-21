import { Hono } from "hono";
import { z } from "zod";
import { isPro, requireSession, requireUser } from "./auth";
import { fail, page, parse, randomToken, rateLimit, sha256 } from "./lib";
import { later, now, type AppEnv } from "./types";

const linkLifetime = 600;
const pollInterval = 5;
const sessionLifetime = 86400 * 14;
const hexToken = z.string().regex(/^[0-9a-f]{64}$/);
export const accounts = new Hono<AppEnv>();

accounts.post("/desktop/link", async (c) => {
  const db = c.env.DB;
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  await rateLimit(db, "desktop-link:" + (await sha256(ip)), 12, 600);
  const device = randomToken();
  const code = randomToken().slice(0, 10).toUpperCase();
  const expiresAt = later(linkLifetime);
  await db.prepare("INSERT INTO desktop_links VALUES (?,?,NULL,?,?)")
    .bind(await sha256(device), await sha256(code), expiresAt, now()).run();
  return c.json({
    device, code, expiresAt, interval: pollInterval,
    verificationUrl: new URL("/desktop/link", c.env.APP_ORIGIN).href,
  }, 201);
});

accounts.post("/desktop/approve", requireUser, requireSession, async (c) => {
  const { code } = await parse(c, z.object({ code: z.string().regex(/^[0-9A-F]{10}$/) }));
  const db = c.env.DB;
  const user = c.get("actor").userId;
  await rateLimit(db, "desktop-approve:" + user, 8, 600);
  const changed = await db.prepare(
    "UPDATE desktop_links SET user_id=? WHERE code_hash=? AND user_id IS NULL AND expires_at>?",
  ).bind(user, await sha256(code), now()).run();
  if (!changed.meta.changes) fail(404, "This code is invalid or expired. Start again in Arcex.");
  return c.json({ ok: true });
});

accounts.post("/desktop/exchange", async (c) => {
  const { device } = await parse(c, z.object({ device: hexToken }));
  const db = c.env.DB;
  const deviceHash = await sha256(device);
  const time = now();
  const link = await db.prepare(
    "UPDATE desktop_links SET next_poll_at=? WHERE device_hash=? AND expires_at>? AND next_poll_at<=? RETURNING user_id",
  ).bind(later(pollInterval), deviceHash, time, time).first<{ user_id: string | null }>();
  if (!link) {
    const exists = await db.prepare("SELECT 1 FROM desktop_links WHERE device_hash=? AND expires_at>?")
      .bind(deviceHash, time).first();
    if (exists) fail(429, "Wait before checking again");
    fail(404, "This sign-in expired. Start again in Arcex.");
  }
  if (!link.user_id) return c.json({ status: "pending" as const });
  const token = randomToken();
  const expiresAt = later(sessionLifetime);
  const [created] = await db.batch([
    db.prepare(
      `INSERT INTO desktop_sessions (id,token_hash,user_id,created_at,expires_at)
       SELECT ?,?,user_id,?,? FROM desktop_links WHERE device_hash=? AND user_id IS NOT NULL AND expires_at>?`,
    ).bind(crypto.randomUUID(), await sha256(token), time, expiresAt, deviceHash, time),
    db.prepare("DELETE FROM desktop_links WHERE device_hash=?").bind(deviceHash),
  ]);
  if (!created?.meta.changes) fail(404, "This sign-in already finished. Start again in Arcex.");
  return c.json({ status: "connected" as const, token, expiresAt });
});

async function desktopTokenHash(header: string | undefined) {
  const token = hexToken.safeParse(header?.match(/^Bearer ([0-9a-f]{64})$/)?.[1]);
  if (!token.success) fail(401, "Sign in to Arcex");
  return sha256(token.data);
}

accounts.get("/desktop/me", async (c) => {
  const db = c.env.DB;
  const session = await db.prepare(
    `SELECT u.id,u.name,u.handle,s.expires_at FROM desktop_sessions s
     JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`,
  ).bind(await desktopTokenHash(c.req.header("authorization")), now())
    .first<{ id: string; name: string; handle: string; expires_at: string }>();
  if (!session) fail(401, "Your desktop session expired");
  await rateLimit(db, "desktop-user:" + session.id, 120);
  return c.json({
    account: {
      id: session.id, name: session.name, handle: session.handle,
      pro: await isPro(db, session.id), expiresAt: session.expires_at,
      devicesUrl: new URL("/account/devices", c.env.APP_ORIGIN).href,
    },
  });
});

accounts.delete("/desktop/session", async (c) => {
  await c.env.DB.prepare("DELETE FROM desktop_sessions WHERE token_hash=?")
    .bind(await desktopTokenHash(c.req.header("authorization"))).run();
  return c.json({ ok: true });
});

accounts.get("/devices", requireUser, requireSession, async (c) => {
  const { limit, offset } = page(c);
  const devices = await c.env.DB.prepare(
    "SELECT id,created_at,expires_at FROM desktop_sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
  ).bind(c.get("actor").userId, now(), limit, offset).all();
  return c.json({ items: devices.results });
});

accounts.delete("/devices/:id", requireUser, requireSession, async (c) => {
  const id = z.uuid().safeParse(c.req.param("id"));
  if (!id.success) fail(404, "Desktop session not found");
  const result = await c.env.DB.prepare("DELETE FROM desktop_sessions WHERE id=? AND user_id=?")
    .bind(id.data, c.get("actor").userId).run();
  if (!result.meta.changes) fail(404, "Desktop session not found");
  return c.json({ ok: true });
});

accounts.use("/owner/*", requireUser, requireSession, async (c, next) => {
  const owner = c.env.MCP_OWNER_GITHUB_ID;
  const identity = owner && await c.env.DB.prepare(
    "SELECT 1 FROM identities WHERE provider='github' AND provider_id=? AND user_id=?",
  ).bind(owner, c.get("actor").userId).first();
  if (!identity) fail(403, "Sign in with the owner's GitHub account");
  await next();
});

accounts.post("/owner/customers/search", async (c) => {
  const { query, limit, offset } = await parse(c, z.object({
    query: z.string().trim().max(100).default(""),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).max(10000).default(0),
  }));
  const match = "%" + query.replace(/[\\%_]/g, "\\$&") + "%";
  const time = now();
  const result = await c.env.DB.prepare(
    `SELECT u.id,u.handle,u.name,u.email,u.created_at,s.status AS subscription_status,s.period_end,
       CASE WHEN s.status IN ('active','trialing') AND s.period_end>? AND h.user_id IS NULL THEN 1 ELSE 0 END AS pro,
       h.user_id IS NOT NULL AS billing_hold,
       (SELECT count(*) FROM sessions w WHERE w.user_id=u.id AND w.expires_at>?) AS web_sessions,
       (SELECT count(*) FROM desktop_sessions d WHERE d.user_id=u.id AND d.expires_at>?) AS desktop_sessions
     FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id LEFT JOIN billing_holds h ON h.user_id=u.id
     WHERE u.name LIKE ? ESCAPE '\\' OR u.handle LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\'
     ORDER BY u.created_at DESC,u.id LIMIT ? OFFSET ?`,
  ).bind(time, time, time, match, match, match, limit + 1, offset).all();
  return c.json({ items: result.results.slice(0, limit), more: result.results.length > limit });
});

accounts.post("/owner/customers/:id/revoke-sessions", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  if (id.length > 200 || !await db.prepare("SELECT 1 FROM users WHERE id=?").bind(id).first())
    fail(404, "Customer not found");
  const actor = c.get("actor").userId;
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id=?").bind(id),
    db.prepare("DELETE FROM desktop_sessions WHERE user_id=?").bind(id),
    db.prepare("DELETE FROM desktop_links WHERE user_id=?").bind(id),
    db.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), actor, "account.sessions.revoke", id, "{}", now()),
  ]);
  return c.json({ ok: true });
});
