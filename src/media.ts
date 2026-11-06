import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./types";
import { now, later } from "./types";
import { audit, fail, parse, randomToken, rateLimit, sha256 } from "./lib";
import { requireAdmin, requireCollector } from "./auth";
import { mediaLinkValid } from "./insights";
import { validThumbnail } from "./thumbnail-format";
import {
  fileStore,
  setupStorage,
  storageClient,
  EVIDENCE_BUCKET,
  MEDIA_LIMIT_BYTES,
} from "./file-store";

export const media = new Hono<AppEnv>();
const CAPTURE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const CAPTURE_MAX_BYTES = 1_000_000;
/** Validate and store one capture for existing evidence. Screenshot evidence must carry the image's own hash. */
async function storeCapture(
  env: AppEnv["Bindings"],
  evidenceId: string,
  type: string | undefined,
  bytes: ArrayBuffer,
) {
  if (!type || !(CAPTURE_TYPES as readonly string[]).includes(type))
    fail(422, "Only PNG, JPEG and WebP captures are accepted");
  const evidence = await env.DB.prepare(
    "SELECT kind,content_hash FROM evidence WHERE id=?",
  )
    .bind(evidenceId)
    .first<{ kind: string; content_hash: string }>();
  if (!evidence) fail(422, "Valid evidence ID required");
  if (bytes.byteLength > CAPTURE_MAX_BYTES) fail(413, "Capture exceeds 1 MB");
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
  const hash = await sha256(bytes);
  // A placeholder or re-encoded image can never stand in for the observed capture.
  if (evidence.kind === "screenshot" && hash !== evidence.content_hash)
    fail(
      422,
      "Image bytes do not match the screenshot evidence hash; upload the exact captured file",
    );
  const store = fileStore(env);
  const assetId = crypto.randomUUID(),
    objectKey = "evidence/" + assetId;
  const reservation = await env.DB.prepare(
    "INSERT INTO assets(id,evidence_id,object_key,content_type,size,sha256,created_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COALESCE(sum(size+thumbnail_size),0) FROM assets)+?<=?",
  )
    .bind(
      assetId,
      evidenceId,
      objectKey,
      type,
      bytes.byteLength,
      hash,
      now(),
      bytes.byteLength,
      MEDIA_LIMIT_BYTES,
    )
    .run();
  if (!reservation.meta.changes)
    fail(
      409,
      "Evidence storage quota reached; no upgrade or paid fallback is enabled",
    );
  try {
    await store.put(objectKey, bytes, type);
  } catch (error) {
    await env.DB.prepare("DELETE FROM assets WHERE id=?").bind(assetId).run();
    throw error;
  }
  return { id: assetId, approved: false, sha256: hash, size: bytes.byteLength };
}
media.post("/upload", requireCollector, async (c) =>
  c.json(
    await storeCapture(
      c.env,
      c.req.header("x-evidence-id") ?? "",
      c.req.header("content-type"),
      await c.req.arrayBuffer(),
    ),
    201,
  ),
);
// The collector mints a 15-minute, single-use link; the worker's machine PUTs the file to it.
media.post("/uploads", requireCollector, async (c) => {
  const input = await parse(
    c,
    z
      .object({
        evidenceId: z.string().min(1).max(100),
        contentType: z.enum(CAPTURE_TYPES),
      })
      .strict(),
  );
  // Seed phase: about 10 screens per product. The 900 MB storage cap is the real bound.
  await rateLimit(c.env.DB, "capture-upload-links", 3000, 86400);
  if (
    !(await c.env.DB.prepare("SELECT id FROM evidence WHERE id=?")
      .bind(input.evidenceId)
      .first())
  )
    fail(422, "Valid evidence ID required");
  const token = randomToken(),
    time = now(),
    expiresAt = later(15 * 60);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM capture_uploads WHERE expires_at<?").bind(
      later(-86400),
    ),
    c.env.DB.prepare(
      "INSERT INTO capture_uploads(token_hash,evidence_id,content_type,expires_at,created_at) VALUES (?,?,?,?,?)",
    ).bind(
      await sha256(token),
      input.evidenceId,
      input.contentType,
      expiresAt,
      time,
    ),
  ]);
  return c.json(
    {
      uploadUrl: `${c.env.API_ORIGIN}/api/v1/media/direct/${token}`,
      method: "PUT",
      contentType: input.contentType,
      expiresAt,
    },
    201,
  );
});
media.put("/direct/:token", async (c) => {
  const token = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .safeParse(c.req.param("token"));
  if (!token.success) fail(404, "Upload link not found");
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > CAPTURE_MAX_BYTES) fail(413, "Capture exceeds 1 MB");
  const claim = await c.env.DB.prepare(
    "UPDATE capture_uploads SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING evidence_id,content_type",
  )
    .bind(now(), await sha256(token.data), now())
    .first<{ evidence_id: string; content_type: string }>();
  if (!claim) fail(404, "Upload link not found, expired or already used");
  if (c.req.header("content-type") !== claim.content_type)
    fail(422, "Content type does not match the upload link");
  return c.json(
    await storeCapture(
      c.env,
      claim.evidence_id,
      claim.content_type,
      await c.req.arrayBuffer(),
    ),
    201,
  );
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
  if (!approved)
    await c.env.DB.prepare(
      "UPDATE products SET coverage_level='signals',coverage_notes=NULL,coverage_reviewed_at=NULL WHERE id IN (SELECT product_id FROM funnel_steps WHERE asset_id=?)",
    )
      .bind(c.req.param("id"))
      .run();
  await audit(c.env.DB, "admin", "asset.approval", c.req.param("id"), {
    approved,
  });
  return c.json({ ok: true });
});
media.get("/:id", async (c) => {
  // Full screenshots are only reachable through a short-lived link from the app's details.
  if (
    !(await mediaLinkValid(
      c.env,
      c.req.param("id"),
      c.req.query("expires"),
      c.req.query("signature"),
    ))
  )
    fail(403, "This image link is invalid or has expired");
  const row = await c.env.DB.prepare(
    "SELECT a.object_key,a.content_type FROM assets a JOIN evidence e ON e.id=a.evidence_id JOIN products p ON p.id=e.product_id WHERE a.id=? AND a.approved=1 AND e.status='approved' AND p.status='published'",
  )
    .bind(c.req.param("id"))
    .first<{ object_key: string; content_type: string }>();
  if (!row) fail(404, "Asset not found");
  const store = fileStore(c.env);
  const body = await store.get(row.object_key);
  if (!body) fail(404, "Asset not found");
  return new Response(body, {
    headers: {
      "content-type": row.content_type,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

media.get("/:id/review", requireAdmin, async (c) => {
  const variant = z
    .enum(["original", "thumbnail"])
    .default("original")
    .parse(c.req.query("variant"));
  const row = await c.env.DB.prepare(
    "SELECT object_key,content_type,thumbnail_key FROM assets WHERE id=?",
  )
    .bind(c.req.param("id"))
    .first<{
      object_key: string;
      content_type: string;
      thumbnail_key: string | null;
    }>();
  if (!row) fail(404, "Asset not found");
  const key = variant === "thumbnail" ? row.thumbnail_key : row.object_key;
  if (!key) fail(404, "Thumbnail not found");
  const body = await fileStore(c.env).get(key);
  if (!body) fail(404, "Asset not found");
  return new Response(body, {
    headers: {
      "content-type": variant === "thumbnail" ? "image/webp" : row.content_type,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

media.delete("/:id", requireAdmin, async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT object_key,thumbnail_key FROM assets WHERE id=?",
  )
    .bind(c.req.param("id"))
    .first<{ object_key: string; thumbnail_key: string | null }>();
  if (!row) fail(404, "Asset not found");
  if (
    await c.env.DB.prepare("SELECT id FROM funnel_steps WHERE asset_id=?")
      .bind(c.req.param("id"))
      .first()
  )
    fail(409, "Remove the capture from funnel steps before deleting it");
  await fileStore(c.env).delete(row.object_key);
  if (row.thumbnail_key) await fileStore(c.env).delete(row.thumbnail_key);
  await c.env.DB.prepare("DELETE FROM assets WHERE id=?")
    .bind(c.req.param("id"))
    .run();
  await audit(c.env.DB, "admin", "asset.delete", c.req.param("id"));
  return c.json({ ok: true });
});

media.post("/storage/setup", requireAdmin, async (c) =>
  c.json(await setupStorage(c.env)),
);
media.get("/storage/status", requireAdmin, async (c) => {
  const { data, error } = await storageClient(c.env).storage.getBucket(
    EVIDENCE_BUCKET,
  );
  if (error) fail(502, "Evidence storage is not ready");
  const used = await c.env.DB.prepare(
    "SELECT COALESCE(sum(size+thumbnail_size),0) bytes,count(*) objects,sum(thumbnail_key IS NOT NULL) thumbnails FROM assets",
  ).first();
  return c.json({
    provider: "supabase",
    bucket: data.name,
    private: !data.public,
    usage: used,
    applicationLimitBytes: MEDIA_LIMIT_BYTES,
  });
});

media.get("/thumbnails/pending", requireAdmin, async (c) => {
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(25)
    .default(10)
    .parse(c.req.query("limit"));
  const productId = c.req.query("productId");
  const result = await c.env.DB.prepare(
    "SELECT a.id,a.sha256,e.product_id FROM assets a JOIN evidence e ON e.id=a.evidence_id JOIN products p ON p.id=e.product_id WHERE a.thumbnail_key IS NULL AND p.status!='archived' AND (? IS NULL OR e.product_id=?) ORDER BY a.created_at,a.id LIMIT ?",
  )
    .bind(productId ?? null, productId ?? null, limit)
    .all();
  return c.json({ items: result.results, limit });
});
media.post("/:id/thumbnail", requireAdmin, async (c) => {
  if (c.req.header("content-type") !== "image/webp")
    fail(422, "Use an owner-generated WebP thumbnail");
  const bytes = await c.req.arrayBuffer();
  if (!validThumbnail(new Uint8Array(bytes)))
    fail(422, "Thumbnail must be a single WebP frame, at most160x100 and20KB");
  const assetId = c.req.param("id"),
    hash = await sha256(bytes);
  const row = await c.env.DB.prepare(
    "SELECT thumbnail_key,thumbnail_sha256 FROM assets WHERE id=?",
  )
    .bind(assetId)
    .first<{ thumbnail_key: string | null; thumbnail_sha256: string | null }>();
  if (!row) fail(404, "Asset not found");
  if (row.thumbnail_key) {
    if (row.thumbnail_sha256 === hash)
      return c.json({ id: assetId, unchanged: true });
    fail(409, "This capture already has a thumbnail");
  }
  const key = "thumbnails/" + assetId + ".webp";
  const result = await c.env.DB.prepare(
    "UPDATE assets SET thumbnail_key=?,thumbnail_size=?,thumbnail_sha256=? WHERE id=? AND thumbnail_key IS NULL AND (SELECT COALESCE(sum(size+thumbnail_size),0) FROM assets)+?<=?",
  )
    .bind(
      key,
      bytes.byteLength,
      hash,
      assetId,
      bytes.byteLength,
      MEDIA_LIMIT_BYTES,
    )
    .run();
  if (!result.meta.changes)
    fail(409, "Evidence storage quota reached or thumbnail already reserved");
  try {
    await fileStore(c.env).put(key, bytes, "image/webp");
  } catch (error) {
    await c.env.DB.prepare(
      "UPDATE assets SET thumbnail_key=NULL,thumbnail_size=0,thumbnail_sha256=NULL WHERE id=? AND thumbnail_key=?",
    )
      .bind(assetId, key)
      .run();
    throw error;
  }
  await audit(c.env.DB, "admin", "asset.thumbnail", assetId, {
    bytes: bytes.byteLength,
  });
  return c.json(
    { id: assetId, bytes: bytes.byteLength, approvalChanged: false },
    201,
  );
});
media.get("/:id/thumbnail", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT a.thumbnail_key FROM assets a JOIN evidence e ON e.id=a.evidence_id JOIN products p ON p.id=e.product_id WHERE a.id=? AND a.approved=1 AND e.status='approved' AND p.status='published' AND p.coverage_level='full' AND a.thumbnail_key IS NOT NULL",
  )
    .bind(c.req.param("id"))
    .first<{ thumbnail_key: string }>();
  if (!row) fail(404, "Thumbnail not found");
  const body = await fileStore(c.env).get(row.thumbnail_key);
  if (!body) fail(404, "Thumbnail not found");
  return new Response(body, {
    headers: {
      "content-type": "image/webp",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
