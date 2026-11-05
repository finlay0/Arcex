import type { z } from "zod";
import { funnelInput, paywallInput } from "./contracts";
import { fail } from "./lib";
import { now } from "./types";

type FlowKind = "funnel" | "paywall";
const actionFor = (kind: FlowKind) => `flow.${kind}.version`;
const currentFunnel = `SELECT json_group_array(json_object('position',position,'title',title,'stage',stage,'annotation',annotation,'evidenceId',evidence_id,'assetId',asset_id)) FROM (SELECT * FROM funnel_steps WHERE product_id=? ORDER BY position)`;
const currentPaywall = `SELECT COALESCE((SELECT json_object('evidenceId',evidence_id,'pattern',pattern,'states',json(states),'transitions',json(transitions),'creditRules',json(credit_rules),'notes',notes) FROM paywall_mechanics WHERE product_id=?),'null')`;

// These execute in the same transaction as the actual replacement. An existing state
// gets one baseline revision; subsequent writes append just their new snapshot.
function revisions(
  db: D1Database,
  productId: string,
  kind: FlowKind,
  snapshot: string,
  revisionId: string,
  time: string,
) {
  const current = kind === "funnel" ? currentFunnel : currentPaywall;
  const action = actionFor(kind);
  return [
    db
      .prepare(
        `WITH current(snapshot) AS (${current}) INSERT INTO audit_events(id,actor,action,target,detail,created_at)
      SELECT ?,'admin',?,?,json_object('kind',?,'baseline',json('true'),'snapshot',json(current.snapshot)),?
      FROM current
      WHERE current.snapshot<>? AND current.snapshot NOT IN ('[]','null') AND NOT EXISTS(SELECT 1 FROM audit_events WHERE target=? AND action=?)`,
      )
      .bind(
        productId,
        crypto.randomUUID(),
        action,
        productId,
        kind,
        time,
        snapshot,
        productId,
        action,
      ),
    db
      .prepare(
        `WITH current(snapshot) AS (${current}) INSERT INTO audit_events(id,actor,action,target,detail,created_at)
      SELECT ?,'admin',?,?,json_object('kind',?,'baseline',json('false'),'snapshot',json(?)),?
      FROM current WHERE current.snapshot<>?`,
      )
      .bind(
        productId,
        revisionId,
        action,
        productId,
        kind,
        snapshot,
        time,
        snapshot,
      ),
  ];
}
function resetCoverage(
  db: D1Database,
  productId: string,
  revisionId: string,
  time: string,
) {
  return db
    .prepare(
      `UPDATE products SET status='draft',coverage_level='signals',coverage_notes=NULL,coverage_reviewed_at=NULL,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)`,
    )
    .bind(time, productId, revisionId);
}
export async function replaceFunnel(
  db: D1Database,
  productId: string,
  input: z.infer<typeof funnelInput>,
) {
  const steps = [...input]
    .sort((a, b) => a.position - b.position)
    .map((s) => ({
      position: s.position,
      title: s.title,
      stage: s.stage,
      annotation: s.annotation,
      evidenceId: s.evidenceId,
      assetId: s.assetId ?? null,
    }));
  const snapshot = JSON.stringify(steps);
  const invalid = await db
    .prepare(
      `SELECT 1 FROM json_each(?) j
    LEFT JOIN evidence e ON e.id=json_extract(j.value,'$.evidenceId') AND e.product_id=?
    LEFT JOIN assets a ON a.id=json_extract(j.value,'$.assetId') AND a.evidence_id=e.id
    WHERE e.id IS NULL OR (json_extract(j.value,'$.assetId') IS NOT NULL AND a.id IS NULL) LIMIT 1`,
    )
    .bind(snapshot, productId)
    .first();
  if (invalid)
    fail(
      422,
      "Every step needs evidence from this product and an asset belonging to that evidence",
    );
  const revisionId = crypto.randomUUID(),
    time = now();
  const rows = JSON.stringify(
    steps.map((s) => ({ ...s, id: crypto.randomUUID() })),
  );
  const result = await db.batch([
    ...revisions(db, productId, "funnel", snapshot, revisionId, time),
    db
      .prepare(
        "DELETE FROM funnel_steps WHERE product_id=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)",
      )
      .bind(productId, revisionId),
    db
      .prepare(
        `INSERT INTO funnel_steps(id,product_id,position,title,stage,annotation,evidence_id,asset_id)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.position'),json_extract(value,'$.title'),json_extract(value,'$.stage'),json_extract(value,'$.annotation'),json_extract(value,'$.evidenceId'),json_extract(value,'$.assetId')
      FROM json_each(?) WHERE EXISTS(SELECT 1 FROM audit_events WHERE id=?)`,
      )
      .bind(productId, rows, revisionId),
    resetCoverage(db, productId, revisionId, time),
  ]);
  return {
    ok: true,
    unchanged: result[1].meta.changes === 0,
    revisionId: result[1].meta.changes ? revisionId : null,
  };
}
export async function replacePaywall(
  db: D1Database,
  productId: string,
  input: z.infer<typeof paywallInput>,
) {
  const revisionId = crypto.randomUUID(),
    time = now();
  const result = await db.batch([
    ...revisions(
      db,
      productId,
      "paywall",
      JSON.stringify(input),
      revisionId,
      time,
    ),
    db
      .prepare(
        `INSERT INTO paywall_mechanics SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM audit_events WHERE id=?)
      ON CONFLICT(product_id) DO UPDATE SET evidence_id=excluded.evidence_id,pattern=excluded.pattern,states=excluded.states,transitions=excluded.transitions,credit_rules=excluded.credit_rules,notes=excluded.notes`,
      )
      .bind(
        productId,
        input.evidenceId,
        input.pattern,
        JSON.stringify(input.states),
        JSON.stringify(input.transitions),
        JSON.stringify(input.creditRules),
        input.notes,
        revisionId,
      ),
    resetCoverage(db, productId, revisionId, time),
  ]);
  return {
    ok: true,
    unchanged: result[1].meta.changes === 0,
    revisionId: result[1].meta.changes ? revisionId : null,
  };
}
export async function flowHistory(
  db: D1Database,
  productId: string,
  limit = 5,
  offset = 0,
) {
  const rows = await db
    .prepare(
      `SELECT id,json_extract(detail,'$.kind') kind,json_extract(detail,'$.baseline') baseline,created_at,
    length(json_extract(detail,'$.snapshot')) snapshot_characters FROM audit_events
    WHERE target=? AND action IN ('flow.funnel.version','flow.paywall.version') ORDER BY rowid DESC LIMIT ? OFFSET ?`,
    )
    .bind(productId, limit, offset)
    .all();
  return { items: rows.results, limit, offset };
}
export async function flowVersion(
  db: D1Database,
  productId: string,
  revisionId: string,
  limit = 5,
  offset = 0,
) {
  const row = await db
    .prepare(
      `SELECT id,json_extract(detail,'$.kind') kind,json_extract(detail,'$.baseline') baseline,created_at,
    json_array_length(detail,'$.snapshot') total_steps,
    CASE WHEN action='flow.paywall.version' AND length(json_extract(detail,'$.snapshot'))<=16000 THEN json_extract(detail,'$.snapshot') END snapshot_json,
    length(json_extract(detail,'$.snapshot'))>16000 snapshot_omitted
    FROM audit_events WHERE id=? AND target=? AND action IN ('flow.funnel.version','flow.paywall.version')`,
    )
    .bind(revisionId, productId)
    .first<{
      id: string;
      kind: FlowKind;
      baseline: number;
      created_at: string;
      total_steps: number | null;
      snapshot_json: string | null;
      snapshot_omitted: number;
    }>();
  if (!row) fail(404, "Flow revision not found for this product");
  if (row.kind === "paywall")
    return {
      ...row,
      snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) : null,
      snapshot_json: undefined,
      total_steps: undefined,
      limit,
      offset,
    };
  const steps = await db
    .prepare(
      `SELECT j.value FROM audit_events a,json_each(a.detail,'$.snapshot') j
    WHERE a.id=? AND a.target=? AND a.action='flow.funnel.version' ORDER BY CAST(j.key AS INTEGER) LIMIT ? OFFSET ?`,
    )
    .bind(revisionId, productId, limit, offset)
    .all<{ value: string }>();
  return {
    id: row.id,
    kind: row.kind,
    baseline: !!row.baseline,
    created_at: row.created_at,
    totalSteps: row.total_steps,
    steps: steps.results.map((s) => JSON.parse(s.value)),
    limit,
    offset,
  };
}
