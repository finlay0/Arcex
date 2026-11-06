import { z } from "zod";
import { now, later } from "./types";
import { audit, fail } from "./lib";
import { assessmentInput, referenceDomains } from "./research";
import { id, productHost } from "./contracts";

const LEASE_SECONDS = 2 * 3600,
  UNCLEAR_RETRY_DAYS = 14,
  EVIDENCE_MAX_AGE_DAYS = 60,
  HOMEPAGE_MAX_AGE_DAYS = 8;

export const nextWorkInput = z
  .object({
    task: z.enum(["qualify", "review"]),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();

/**
 * Lease the next products for one task. qualify: no assessment yet (or an old
 * "unclear" one). review: a positive assessment waiting for the publish decision.
 */
export async function nextWork(
  db: D1Database,
  input: z.infer<typeof nextWorkInput>,
) {
  const time = now();
  const relevance = "json_extract(r.assessment_json,'$.relevance')";
  const eligible =
    input.task === "qualify"
      ? `(r.assessment_json IS NULL OR (${relevance}='unclear' AND r.updated_at<?))`
      : `${relevance} IN ('in_scope','reference') AND p.status='draft' AND (r.review_hold_until IS NULL OR r.review_hold_until<?)`;
  const leased = await db
    .prepare(
      `UPDATE research_profiles SET work_lease_until=? WHERE product_id IN (
        SELECT r.product_id FROM research_profiles r JOIN products p ON p.id=r.product_id
        WHERE r.status='pending' AND p.status!='archived' AND ${eligible}
          AND (r.work_lease_until IS NULL OR r.work_lease_until<?)
        ORDER BY r.updated_at,r.product_id LIMIT ?)
      AND (work_lease_until IS NULL OR work_lease_until<?) RETURNING product_id`,
    )
    .bind(
      later(LEASE_SECONDS),
      input.task === "qualify" ? later(-UNCLEAR_RETRY_DAYS * 86400) : time,
      time,
      input.limit,
      time,
    )
    .all<{ product_id: string }>();
  const ids = leased.results.map((r) => r.product_id);
  if (!ids.length) return { task: input.task, items: [], leaseExpiresAt: null };
  const rows = await db
    .prepare(
      `SELECT p.id,p.name,p.url,p.domain,p.category,p.description,r.assessment_json,
        (SELECT max(s.last_checked_at) FROM sources s WHERE s.product_id=p.id AND s.lane='http' AND s.failure_streak=0) homepage_checked_at
       FROM products p JOIN research_profiles r ON r.product_id=p.id
       WHERE p.id IN (${ids.map(() => "?").join(",")}) ORDER BY r.updated_at,p.id`,
    )
    .bind(...ids)
    .all<Record<string, unknown> & { id: string; assessment_json: string | null }>();
  return {
    task: input.task,
    leaseExpiresAt: later(LEASE_SECONDS),
    items: rows.results.map(({ assessment_json, ...row }) => ({
      ...row,
      assessment: assessment_json ? JSON.parse(assessment_json) : null,
    })),
    scope:
      input.task === "qualify"
        ? "Research each product, save primary-source evidence and a save_research_assessment. Leases expire after two hours."
        : "Check each product independently, then call record_review_decision once per product. Leases expire after two hours.",
  };
}

export const reviewDecisionInput = z
  .object({
    productId: id,
    decision: z.enum(["publish", "exclude", "hold"]),
    reviewerModel: z.string().min(1).max(100),
    reason: z.string().min(20).max(2000),
    checks: z
      .object({
        audienceFit: z.boolean(),
        claimsSupportedBySources: z.boolean(),
        noPersonalData: z.boolean(),
        notDuplicate: z.boolean(),
      })
      .strict(),
    approveAssetIds: z.array(id).max(20).default([]),
    holdDays: z.number().int().min(1).max(30).default(7),
  })
  .strict();

/**
 * Record the independent reviewer's decision. Publishing is refused unless the
 * server's own checks pass: positive source-backed assessment, recent first-party
 * evidence, a live homepage check, no same-name duplicate and approved references.
 */
export async function recordReviewDecision(
  db: D1Database,
  input: z.infer<typeof reviewDecisionInput>,
) {
  const time = now();
  const row = await db
    .prepare(
      "SELECT p.name,p.domain,p.status product_status,r.status research_status,r.assessment_json,r.work_lease_until FROM products p JOIN research_profiles r ON r.product_id=p.id WHERE p.id=?",
    )
    .bind(input.productId)
    .first<{
      name: string;
      domain: string;
      product_status: string;
      research_status: string;
      assessment_json: string | null;
      work_lease_until: string | null;
    }>();
  if (!row) fail(404, "Research product not found");
  if (!row.work_lease_until || row.work_lease_until < time)
    fail(409, "Lease this product with next_research_work(task=review) first");
  const release = "work_lease_until=NULL,updated_at=?";
  if (input.decision === "hold") {
    await db
      .prepare(
        `UPDATE research_profiles SET review_hold_until=?,${release} WHERE product_id=?`,
      )
      .bind(later(input.holdDays * 86400), time, input.productId)
      .run();
    await audit(db, "collector:review", "review.hold", input.productId, input);
    return { decision: "hold", until: later(input.holdDays * 86400) };
  }
  if (input.decision === "exclude") {
    await db
      .prepare(
        `UPDATE research_profiles SET status='excluded',${release} WHERE product_id=?`,
      )
      .bind(time, input.productId)
      .run();
    await audit(
      db,
      "collector:review",
      "review.exclude",
      input.productId,
      input,
    );
    return { decision: "exclude" };
  }

  // Publish: every gate is checked here, not trusted from the reviewer.
  const problems: string[] = [];
  if (!Object.values(input.checks).every(Boolean))
    problems.push(
      "All reviewer checks must pass to publish; use hold or exclude",
    );
  if (row.product_status !== "draft") problems.push("Product is not a draft");
  if (!row.assessment_json) problems.push("No saved assessment");
  const assessment = row.assessment_json
    ? assessmentInput.safeParse(JSON.parse(row.assessment_json))
    : null;
  const host = productHost(row.domain);
  if (assessment && !assessment.success) problems.push("Assessment is invalid");
  const a = assessment?.success ? assessment.data : null;
  if (a && !["in_scope", "reference"].includes(a.relevance))
    problems.push("Assessment is not in scope or reference");
  if (
    a?.relevance === "in_scope" &&
    [...referenceDomains].some((d) => host === d || host.endsWith("." + d))
  )
    problems.push("Major platforms publish only as reference");
  const evidenceIds = a
    ? [
        ...new Set([
          ...a.evidenceIds,
          ...(a.sizeEvidenceId ? [a.sizeEvidenceId] : []),
        ]),
      ]
    : [];
  const evidence = evidenceIds.length
    ? await db
        .prepare(
          `SELECT id,product_id,source_url,observed_at,kind FROM evidence WHERE id IN (${evidenceIds.map(() => "?").join(",")})`,
        )
        .bind(...evidenceIds)
        .all<{
          id: string;
          product_id: string;
          source_url: string;
          observed_at: string;
          kind: string;
        }>()
    : { results: [] };
  if (
    evidence.results.length !== evidenceIds.length ||
    evidence.results.some((e) => e.product_id !== input.productId)
  )
    problems.push("Assessment evidence must all belong to this product");
  const firstParty = evidence.results.some((e) => {
    const h = new URL(e.source_url).hostname.replace(/^www\./, "");
    return (
      (h === host || h.endsWith("." + host)) &&
      e.observed_at >= later(-EVIDENCE_MAX_AGE_DAYS * 86400)
    );
  });
  if (!firstParty)
    problems.push(
      `Needs first-party evidence from ${host} observed in the last ${EVIDENCE_MAX_AGE_DAYS} days`,
    );
  const homepage = await db
    .prepare(
      "SELECT 1 FROM sources WHERE product_id=? AND lane='http' AND failure_streak=0 AND last_checked_at>=? LIMIT 1",
    )
    .bind(input.productId, later(-HOMEPAGE_MAX_AGE_DAYS * 86400))
    .first();
  if (!homepage)
    problems.push(
      "Homepage has no successful check in the last 8 days; hold and retry",
    );
  const sameName = await db
    .prepare(
      "SELECT id,domain FROM products WHERE lower(name)=lower(?) AND id!=? AND status!='archived' LIMIT 3",
    )
    .bind(row.name, input.productId)
    .all<{ id: string; domain: string }>();
  if (sameName.results.length)
    problems.push(
      "Same-name product exists: " +
        sameName.results.map((r) => `${r.domain} (${r.id})`).join(", ") +
        "; resolve the duplicate first",
    );
  // Anything the public page would show must be approved together with the product.
  const referenced = await db
    .prepare(
      "SELECT DISTINCT e.id,e.kind FROM evidence e WHERE e.product_id=? AND e.id IN (SELECT evidence_id FROM funnel_steps WHERE product_id=? UNION SELECT evidence_id FROM paywall_mechanics WHERE product_id=? UNION SELECT evidence_id FROM distribution_signals WHERE product_id=?)",
    )
    .bind(input.productId, input.productId, input.productId, input.productId)
    .all<{ id: string; kind: string }>();
  const assets = input.approveAssetIds.length
    ? await db
        .prepare(
          `SELECT a.id,a.evidence_id FROM assets a JOIN evidence e ON e.id=a.evidence_id WHERE e.product_id=? AND a.id IN (${input.approveAssetIds.map(() => "?").join(",")})`,
        )
        .bind(input.productId, ...input.approveAssetIds)
        .all<{ id: string; evidence_id: string }>()
    : { results: [] };
  if (assets.results.length !== input.approveAssetIds.length)
    problems.push("Every approved asset must belong to this product");
  const assetEvidence = new Set(assets.results.map((r) => r.evidence_id));
  const uncheckedScreens = referenced.results.filter(
    (e) => e.kind === "screenshot" && !assetEvidence.has(e.id),
  );
  if (uncheckedScreens.length)
    problems.push(
      "Funnel screenshots must be checked and listed in approveAssetIds",
    );
  if (problems.length) fail(409, "Not publishable: " + problems.join("; "));

  const approve = [
    ...new Set([
      ...evidenceIds,
      ...referenced.results.map((e) => e.id),
      ...assetEvidence,
    ]),
  ];
  await db.batch([
    ...approve.map((e) =>
      db.prepare("UPDATE evidence SET status='approved' WHERE id=?").bind(e),
    ),
    ...assets.results.map((r) =>
      db.prepare("UPDATE assets SET approved=1 WHERE id=?").bind(r.id),
    ),
    db
      .prepare(
        `UPDATE research_profiles SET status='accepted',${release} WHERE product_id=?`,
      )
      .bind(time, input.productId),
    db
      .prepare(
        "UPDATE products SET status='published',updated_at=? WHERE id=? AND status='draft'",
      )
      .bind(time, input.productId),
  ]);
  await audit(db, "collector:review", "review.publish", input.productId, {
    reviewerModel: input.reviewerModel,
    reason: input.reason,
    evidenceApproved: approve.length,
    assetsApproved: assets.results.length,
  });
  return {
    decision: "publish",
    evidenceApproved: approve.length,
    assetsApproved: assets.results.length,
    undo: "Owner can unpublish any time with PUT /api/v1/admin/products/:id/status",
  };
}
