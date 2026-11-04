import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./types";
import { now } from "./types";
import { audit, decode, fail, page, parse, randomToken, sha256 } from "./lib";
import { requireAdmin, requireUser, requirePro, requireSession } from "./auth";
import { shipInput, publicUrl } from "./contracts";

const proSql =
  "EXISTS(SELECT 1 FROM subscriptions sub WHERE sub.user_id=s.user_id AND sub.status IN ('active','trialing') AND sub.period_end>? AND NOT EXISTS(SELECT 1 FROM billing_holds h WHERE h.user_id=s.user_id))";
export const community = new Hono<AppEnv>();
community.get("/ship", async (c) => {
  const { limit, offset } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT s.*,u.handle,u.name owner_name,u.avatar_url,${proSql} AS insider,(SELECT count(*) FROM ship_votes v WHERE v.submission_id=s.id) votes FROM ship_submissions s JOIN users u ON u.id=s.user_id WHERE s.status IN ('approved','reviewed') ORDER BY votes DESC,s.created_at DESC,s.id LIMIT ? OFFSET ?`,
  )
    .bind(now(), limit, offset)
    .all();
  return c.json({
    items: result.results.map((r) => ({
      ...r,
      stack: decode(r.stack as string),
    })),
    limit,
    offset,
  });
});
community.post("/ship", requireUser, async (c) => {
  const input = await parse(c, shipInput);
  const userId = c.get("actor").userId;
  const pending = await c.env.DB.prepare(
    "SELECT count(*) count FROM ship_submissions WHERE user_id=? AND status='pending'",
  )
    .bind(userId)
    .first<{ count: number }>();
  if (pending!.count >= 5) fail(409, "Maximum five pending submissions");
  const submissionId = crypto.randomUUID(),
    time = now();
  await c.env.DB.prepare(
    "INSERT INTO ship_submissions(id,user_id,name,url,description,stack,monetization,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      submissionId,
      userId,
      input.name,
      input.url,
      input.description,
      JSON.stringify(input.stack),
      input.monetization,
      time,
      time,
    )
    .run();
  return c.json({ id: submissionId, status: "pending" }, 201);
});
community.patch("/ship/:id", requireUser, async (c) => {
  const input = await parse(c, shipInput);
  const result = await c.env.DB.prepare(
    "UPDATE ship_submissions SET name=?,url=?,description=?,stack=?,monetization=?,status='pending',review_url=NULL,reviewed_at=NULL,updated_at=? WHERE id=? AND user_id=?",
  )
    .bind(
      input.name,
      input.url,
      input.description,
      JSON.stringify(input.stack),
      input.monetization,
      now(),
      c.req.param("id"),
      c.get("actor").userId,
    )
    .run();
  if (!result.meta.changes) fail(404, "Submission not found");
  return c.json({ ok: true, status: "pending" });
});
community.delete("/ship/:id", requireUser, async (c) => {
  const result = await c.env.DB.prepare(
    "DELETE FROM ship_submissions WHERE id=? AND user_id=?",
  )
    .bind(c.req.param("id"), c.get("actor").userId)
    .run();
  if (!result.meta.changes) fail(404, "Submission not found");
  return c.json({ ok: true });
});
community.put("/ship/:id/vote", requireUser, async (c) => {
  if (
    !(await c.env.DB.prepare(
      "SELECT id FROM ship_submissions WHERE id=? AND status IN ('approved','reviewed')",
    )
      .bind(c.req.param("id"))
      .first())
  )
    fail(404, "Submission not found");
  const result = await c.env.DB.prepare(
    "INSERT INTO ship_votes SELECT id,?,? FROM ship_submissions WHERE id=? AND status IN ('approved','reviewed') ON CONFLICT DO NOTHING",
  )
    .bind(c.get("actor").userId, now(), c.req.param("id"))
    .run();
  return c.json({ ok: true, created: result.meta.changes > 0 });
});
community.delete("/ship/:id/vote", requireUser, async (c) => {
  await c.env.DB.prepare(
    "DELETE FROM ship_votes WHERE submission_id=? AND user_id=?",
  )
    .bind(c.req.param("id"), c.get("actor").userId)
    .run();
  return c.json({ ok: true });
});
community.get("/me", requireUser, async (c) => {
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id=?")
    .bind(c.get("actor").userId)
    .first();
  return c.json({ user, insider: c.get("actor").pro });
});
community.get("/me/ship", requireUser, async (c) => {
  const { limit, offset } = page(c);
  return c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT * FROM ship_submissions WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
        .bind(c.get("actor").userId, limit, offset)
        .all()
    ).results,
  });
});
community.get("/me/saves", requireUser, async (c) => {
  const { limit, offset } = page(c);
  return c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT p.* FROM user_saves s JOIN products p ON p.id=s.product_id WHERE s.user_id=? AND p.status='published' ORDER BY s.created_at DESC LIMIT ? OFFSET ?",
      )
        .bind(c.get("actor").userId, limit, offset)
        .all()
    ).results,
  });
});
community.put("/me/saves/:productId", requireUser, async (c) => {
  if (
    !(await c.env.DB.prepare(
      "SELECT id FROM products WHERE id=? AND status='published'",
    )
      .bind(c.req.param("productId"))
      .first())
  )
    fail(404, "Product not found");
  await c.env.DB.prepare(
    "INSERT INTO user_saves VALUES (?,?,?) ON CONFLICT DO NOTHING",
  )
    .bind(c.get("actor").userId, c.req.param("productId"), now())
    .run();
  return c.json({ ok: true });
});
community.delete("/me/saves/:productId", requireUser, async (c) => {
  await c.env.DB.prepare(
    "DELETE FROM user_saves WHERE user_id=? AND product_id=?",
  )
    .bind(c.get("actor").userId, c.req.param("productId"))
    .run();
  return c.json({ ok: true });
});
community.get("/me/collections", requireUser, async (c) => {
  const { limit, offset } = page(c);
  return c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT * FROM collections WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
        .bind(c.get("actor").userId, limit, offset)
        .all()
    ).results,
  });
});
community.post("/me/collections", requireUser, requirePro, async (c) => {
  const { name } = await parse(
    c,
    z.object({ name: z.string().min(1).max(100) }).strict(),
  );
  const collectionId = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO collections VALUES (?,?,?,?)")
    .bind(collectionId, c.get("actor").userId, name, now())
    .run();
  return c.json({ id: collectionId }, 201);
});
community.delete("/me/collections/:id", requireUser, async (c) => {
  const result = await c.env.DB.prepare(
    "DELETE FROM collections WHERE id=? AND user_id=?",
  )
    .bind(c.req.param("id"), c.get("actor").userId)
    .run();
  if (!result.meta.changes) fail(404, "Collection not found");
  return c.json({ ok: true });
});
community.get("/me/collections/:id", requireUser, async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT * FROM collections WHERE id=? AND user_id=?",
  )
    .bind(c.req.param("id"), c.get("actor").userId)
    .first();
  if (!row) fail(404, "Collection not found");
  return c.json({
    ...row,
    items: (
      await c.env.DB.prepare(
        "SELECT p.* FROM collection_items i JOIN products p ON p.id=i.product_id WHERE i.collection_id=? AND p.status='published' ORDER BY p.name LIMIT 500",
      )
        .bind(c.req.param("id"))
        .all()
    ).results,
  });
});
community.put(
  "/me/collections/:id/items/:productId",
  requireUser,
  requirePro,
  async (c) => {
    if (
      !(await c.env.DB.prepare(
        "SELECT p.id FROM products p JOIN collections co ON co.id=? AND co.user_id=? WHERE p.id=? AND p.status='published'",
      )
        .bind(
          c.req.param("id"),
          c.get("actor").userId,
          c.req.param("productId"),
        )
        .first())
    )
      fail(404, "Collection or product not found");
    await c.env.DB.prepare(
      "INSERT INTO collection_items VALUES (?,?) ON CONFLICT DO NOTHING",
    )
      .bind(c.req.param("id"), c.req.param("productId"))
      .run();
    return c.json({ ok: true });
  },
);
community.delete(
  "/me/collections/:id/items/:productId",
  requireUser,
  async (c) => {
    await c.env.DB.prepare(
      "DELETE FROM collection_items WHERE collection_id=? AND product_id=? AND EXISTS(SELECT 1 FROM collections WHERE id=? AND user_id=?)",
    )
      .bind(
        c.req.param("id"),
        c.req.param("productId"),
        c.req.param("id"),
        c.get("actor").userId,
      )
      .run();
    return c.json({ ok: true });
  },
);
community.get("/me/api-keys", requireUser, requireSession, async (c) => {
  return c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT id,name,created_at,revoked_at,last_used_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
      )
        .bind(c.get("actor").userId)
        .all()
    ).results,
  });
});
community.post(
  "/me/api-keys",
  requireUser,
  requireSession,
  async (c) => {
    const { name } = await parse(
      c,
      z.object({ name: z.string().min(1).max(100) }).strict(),
    );
    const count = await c.env.DB.prepare(
      "SELECT count(*) count FROM api_keys WHERE user_id=? AND revoked_at IS NULL",
    )
      .bind(c.get("actor").userId)
      .first<{ count: number }>();
    if (count!.count >= 10) fail(409, "Maximum ten active keys");
    const token = "arcex_" + randomToken(),
      keyId = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO api_keys(id,user_id,token_hash,name,created_at) VALUES (?,?,?,?,?)",
    )
      .bind(keyId, c.get("actor").userId, await sha256(token), name, now())
      .run();
    return c.json({ id: keyId, token }, 201);
  },
);
community.delete("/me/api-keys/:id", requireUser, requireSession, async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE api_keys SET revoked_at=? WHERE id=? AND user_id=?",
  )
    .bind(now(), c.req.param("id"), c.get("actor").userId)
    .run();
  if (!result.meta.changes) fail(404, "Key not found");
  return c.json({ ok: true });
});

export const adminCommunity = new Hono<AppEnv>();
adminCommunity.use("*", requireAdmin);
adminCommunity.get("/ship", async (c) => {
  const { limit, offset } = page(c);
  return c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT * FROM ship_submissions ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
        .bind(limit, offset)
        .all()
    ).results,
  });
});
adminCommunity.put("/ship/:id/status", async (c) => {
  const input = await parse(
    c,
    z
      .object({
        status: z.enum(["pending", "approved", "rejected", "reviewed"]),
        reviewUrl: publicUrl.optional(),
      })
      .strict(),
  );
  if (input.status === "reviewed" && !input.reviewUrl)
    fail(422, "Reviewed submissions require a review URL");
  const result = await c.env.DB.prepare(
    "UPDATE ship_submissions SET status=?,review_url=?,reviewed_at=?,updated_at=? WHERE id=?",
  )
    .bind(
      input.status,
      input.reviewUrl ?? null,
      input.status === "reviewed" ? now() : null,
      now(),
      c.req.param("id"),
    )
    .run();
  if (!result.meta.changes) fail(404, "Submission not found");
  await audit(c.env.DB, "admin", "ship.status", c.req.param("id"), input);
  return c.json({ ok: true });
});
adminCommunity.get("/stream-queue", async (c) => {
  const { limit, offset } = page(c);
  const result = await c.env.DB.prepare(
    `SELECT s.*,u.handle,${proSql} insider,(SELECT count(*) FROM ship_votes v WHERE v.submission_id=s.id) votes FROM ship_submissions s JOIN users u ON u.id=s.user_id WHERE s.status='approved' ORDER BY insider DESC,votes DESC,s.created_at ASC,s.id LIMIT ? OFFSET ?`,
  )
    .bind(now(), limit, offset)
    .all();
  return c.json({ items: result.results });
});
