import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
import { api, adminToken } from "./client";
import { extractionSchema } from "../src/extraction";
import { publicUrl, timestamp } from "../src/contracts";

const [target, productId] = process.argv.slice(2);
if (!target || !productId)
  throw new Error("Usage: pnpm import:teardown captures/DIRECTORY PRODUCT_ID");
if (!adminToken) throw new Error("Configure an Arcex admin token");
const directory = resolve(target),
  analysis = extractionSchema.parse(
    JSON.parse(await readFile(join(directory, "analysis.json"), "utf8")),
  );
const captures = new Set([
  ...analysis.steps.map((s) => s.capture),
  ...(analysis.paywall ? [analysis.paywall.capture] : []),
  ...(analysis.blueprint?.captures ?? []),
]);
const evidenceIds = new Map<string, string>();
// Keep the whole product unpublished if an import stops partway through.
await api(`/api/v1/admin/products/${encodeURIComponent(productId)}/status`, {
  method: "PUT",
  token: adminToken,
  body: { status: "draft" },
});
for (const capture of captures) {
  if (!/^(landing|\d{3})\.json$/.test(capture))
    throw new Error("Invalid capture filename");
  const raw = JSON.parse(await readFile(join(directory, capture), "utf8"));
  const metadata = z
    .object({
      sourceUrl: publicUrl,
      observedAt: timestamp,
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      contentHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .passthrough()
    .parse(raw);
  const hash = metadata.sha256 ?? metadata.contentHash;
  if (!hash) throw new Error("Capture hash missing");
  const facts = analysis.steps
    .filter((s) => s.capture === capture)
    .flatMap((s) => s.observedFacts);
  const row = await api<{ id: string }>("/api/v1/admin/evidence", {
    method: "POST",
    token: adminToken,
    body: {
      productId,
      sourceUrl: metadata.sourceUrl,
      observedAt: metadata.observedAt,
      kind: capture === "landing.json" ? "page" : "screenshot",
      contentHash: hash,
      summary:
        facts.join("; ").slice(0, 4000) || "Capture requires editorial review",
      payload: {
        capture,
        facts,
        limitations: analysis.limitations,
        extractionModel: "gpt-6.1-terra",
        reasoningEffort: "medium",
        imageUploaded: false,
      },
    },
  });
  evidenceIds.set(capture, row.id);
}
await api(`/api/v1/admin/products/${encodeURIComponent(productId)}/funnel`, {
  method: "PUT",
  token: adminToken,
  body: analysis.steps.map((s, position) => ({
    position,
    title: s.title,
    stage: s.stage,
    annotation: s.annotation,
    evidenceId: evidenceIds.get(s.capture),
  })),
});
if (analysis.paywall) {
  const p = analysis.paywall;
  await api(`/api/v1/admin/products/${encodeURIComponent(productId)}/paywall`, {
    method: "PUT",
    token: adminToken,
    body: {
      evidenceId: evidenceIds.get(p.capture),
      pattern: p.pattern,
      states: p.states,
      transitions: p.transitions,
      creditRules: { observations: p.creditRules },
      notes: p.notes,
    },
  });
}
if (analysis.blueprint) {
  const b = analysis.blueprint;
  const result = await api(
    `/api/v1/admin/products/${encodeURIComponent(productId)}/blueprints`,
    {
      method: "POST",
      token: adminToken,
      body: {
        title: b.title,
        spec: {
          summary: b.summary,
          evidenceIds: [...new Set(b.captures.map((c) => evidenceIds.get(c)))],
          databaseTables: b.databaseTables,
          middleware: b.middleware,
          stateTransitions: b.stateTransitions,
          components: b.components,
          implementationNotes: b.implementationNotes,
          assumptions: b.assumptions,
        },
      },
    },
  );
  console.log(JSON.stringify(result));
}
console.log(
  JSON.stringify({
    productId,
    status: "draft",
    evidence: [...evidenceIds.values()],
    screenshotsUploaded: false,
  }),
);
