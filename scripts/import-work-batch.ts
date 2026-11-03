import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { api, adminToken } from "./client";
import { publicUrl } from "../src/contracts";

const path = process.argv[2],
  taskUrl = process.argv[3];
if (!path || !taskUrl)
  throw new Error("Usage: pnpm import:work WORK_JSON CHATGPT_TASK_URL");
if (!taskUrl.startsWith("https://chatgpt.com/c/"))
  throw new Error("Use the originating Work task URL");
if (!adminToken) throw new Error("Configure an Arcex admin token");
const raw = await readFile(path, "utf8");
const batch = z
  .object({
    candidates: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            url: publicUrl,
            founder_evidence: z.object({
              url: publicUrl,
              claim: z.string().min(20).max(4000),
              type: z.string().max(200),
            }),
            observed: z.string().max(4000),
            inference: z.string().max(4000).optional(),
            unknowns: z.array(z.string()).max(50),
            screenshot: z
              .object({
                filename: z.string().max(200),
                source_url: publicUrl,
                captured_at_utc: z.iso.datetime(),
              })
              .optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(100),
  })
  .passthrough()
  .parse(JSON.parse(raw));
for (const item of batch.candidates) {
  const slug = item.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const product = await api<{ id: string }>(
    "/api/v1/admin/research/candidates",
    {
      method: "POST",
      token: adminToken,
      body: {
        product: {
          slug,
          name: item.name,
          url: item.url,
          description:
            "Independent-product research candidate. Cloud capture awaits editorial review.",
          category: "other",
          monetization: "unknown",
        },
        maker: {
          name: item.founder_evidence.claim.split(/[.;]/)[0].slice(0, 200),
          sourceUrl: item.founder_evidence.url,
          evidence: item.founder_evidence.claim,
          sizeStatus: "unverified",
          currentSizeEvidence:
            "Current team size is not independently established. " +
            item.unknowns.join("; ").slice(0, 3000),
        },
      },
    },
  );
  const payload = {
    originTask: taskUrl,
    reportedObservations: item.observed,
    inference: item.inference ?? null,
    unknowns: item.unknowns,
    screenshotReference: item.screenshot ?? null,
    review:
      "Unreviewed cloud report; screenshot bytes not uploaded by this importer.",
  };
  const contentHash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  const result = await api("/api/v1/admin/evidence", {
    method: "POST",
    token: adminToken,
    body: {
      productId: product.id,
      sourceUrl: item.screenshot?.source_url ?? item.url,
      observedAt: item.screenshot?.captured_at_utc ?? new Date().toISOString(),
      kind: "manual",
      contentHash,
      summary:
        "Cloud Work capture report pending editorial review: " +
        item.observed.slice(0, 3500),
      payload,
    },
  });
  console.log(
    JSON.stringify({
      name: item.name,
      productId: product.id,
      evidence: result,
      status: "draft",
    }),
  );
}
