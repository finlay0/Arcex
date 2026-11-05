import { createHash } from "node:crypto";
import { z } from "zod";
import { api, apiUrl, adminToken } from "./client";
import { makeThumbnail } from "./thumbnail-image";
import { validThumbnail } from "../src/thumbnail-format";
import { id } from "../src/contracts";

if (!adminToken) throw new Error("Owner configuration required");
const limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(25)
  .parse(process.argv[2] ?? 10);
const productId =
  process.argv[3] === undefined ? undefined : id.parse(process.argv[3]);
const queue = await api<{ items: { id: string; sha256: string }[] }>(
  `/api/v1/media/thumbnails/pending?limit=${limit}${productId ? "&productId=" + encodeURIComponent(productId) : ""}`,
  { token: adminToken },
);
let generated = 0,
  bytesSaved = 0;
for (const asset of queue.items) {
  const original = await fetch(
    `${apiUrl}/api/v1/media/${encodeURIComponent(asset.id)}/review`,
    {
      headers: { authorization: `Bearer ${adminToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!original.ok) throw new Error(`Capture read failed: ${original.status}`);
  const bytes = new Uint8Array(await original.arrayBuffer());
  if (
    bytes.length > 1_000_000 ||
    createHash("sha256").update(bytes).digest("hex") !== asset.sha256
  )
    throw new Error("Original capture hash/size mismatch");
  const thumbnail = await makeThumbnail(bytes);
  if (!validThumbnail(thumbnail))
    throw new Error("Generator exceeded thumbnail format/size bounds");
  const saved = await fetch(
    `${apiUrl}/api/v1/media/${encodeURIComponent(asset.id)}/thumbnail`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "image/webp",
      },
      body: thumbnail,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!saved.ok) throw new Error(`Thumbnail save failed: ${saved.status}`);
  generated++;
  bytesSaved += thumbnail.byteLength;
  console.log(
    JSON.stringify({ assetId: asset.id, thumbnailBytes: thumbnail.byteLength }),
  );
}
console.log(
  JSON.stringify({
    generated,
    bytesSaved,
    scope:
      "Private derivative generation only; approval and publication unchanged",
  }),
);
