import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./types";
import { now } from "./types";
import { audit, fail, parse, sha256 } from "./lib";
import { requireAdmin, requireCollector } from "./auth";

export const media = new Hono<AppEnv>();
media.post("/upload", requireCollector, async (c) => {
  if (!c.env.MEDIA)
    fail(503, "Evidence storage is not enabled; retain the capture locally");
  const type = c.req.header("content-type");
  if (!type || !["image/png", "image/jpeg", "image/webp"].includes(type))
    fail(422, "Only PNG, JPEG and WebP captures are accepted");
  const evidenceId = c.req.header("x-evidence-id");
  if (
    !evidenceId ||
    !(await c.env.DB.prepare("SELECT id FROM evidence WHERE id=?")
      .bind(evidenceId)
      .first())
  )
    fail(422, "Valid evidence ID required");
  const bytes = await c.req.arrayBuffer();
  const prefix = new Uint8Array(bytes.slice(0, 12));
  const valid =
    type === "image/png"
      ? prefix[0] === 137 &&
        prefix[1] === 80 &&
        prefix[2] === 78 &&
        prefix[3] === 71
      : type === "image/jpeg"
        ? prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255
        : new TextDecoder().decode(prefix.slice(0, 4)) === "RIFF" &&
          new TextDecoder().decode(prefix.slice(8, 12)) === "WEBP";
  if (!valid) fail(422, "Image content does not match the declared format");
  const assetId = crypto.randomUUID(),
    objectKey = "evidence/" + assetId;
  await c.env.MEDIA.put(objectKey, bytes, {
    httpMetadata: { contentType: type },
  });
  try {
    await c.env.DB.prepare(
      "INSERT INTO assets(id,evidence_id,object_key,content_type,size,sha256,created_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(
        assetId,
        evidenceId,
        objectKey,
        type,
        bytes.byteLength,
        await sha256(bytes),
        now(),
      )
      .run();
  } catch (error) {
    await c.env.MEDIA.delete(objectKey);
    throw error;
  }
  return c.json({ id: assetId, approved: false }, 201);
});
media.put("/:id/approval", requireAdmin, async (c) => {
  const { approved } = await parse(
    c,
    z.object({ approved: z.boolean() }).strict(),
  );
  const row = await c.env.DB.prepare(
    "SELECT e.status FROM assets a JOIN evidence e ON e.id=a.evidence_id WHERE a.id=?",
  )
    .bind(c.req.param("id"))
    .first<{ status: string }>();
  if (!row) fail(404, "Asset not found");
  if (approved && row.status !== "approved")
    fail(409, "Approve the evidence after reviewing capture redaction");
  await c.env.DB.prepare("UPDATE assets SET approved=? WHERE id=?")
    .bind(approved ? 1 : 0, c.req.param("id"))
    .run();
  await audit(c.env.DB, "admin", "asset.approval", c.req.param("id"), {
    approved,
  });
  return c.json({ ok: true });
});
media.get("/:id", async (c) => {
  if (!c.env.MEDIA) fail(503, "Evidence storage is not enabled");
  const row = await c.env.DB.prepare(
    "SELECT a.object_key,a.content_type FROM assets a JOIN evidence e ON e.id=a.evidence_id JOIN products p ON p.id=e.product_id WHERE a.id=? AND a.approved=1 AND e.status='approved' AND p.status='published'",
  )
    .bind(c.req.param("id"))
    .first<{ object_key: string; content_type: string }>();
  if (!row) fail(404, "Asset not found");
  const object = await c.env.MEDIA.get(row.object_key);
  if (!object) fail(404, "Asset not found");
  return new Response(object.body, {
    headers: {
      "content-type": row.content_type,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
