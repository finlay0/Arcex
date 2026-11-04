import { now } from "./types";

export async function collectionStatus(db: D1Database) {
  const time = now();
  const results = await db.batch([
    db
      .prepare(
        `SELECT p.*,COALESCE(u.claims,0) claims_today,
      max(0,p.daily_limit-COALESCE(u.claims,0)) remaining_today
      FROM collection_policy p LEFT JOIN collection_usage u ON u.lane=p.lane AND u.day=? ORDER BY p.lane`,
      )
      .bind(time.slice(0, 10)),
    db.prepare(
      "SELECT s.lane,j.status,COUNT(*) jobs,MIN(j.available_at) oldest_available_at FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.status IN ('queued','running') GROUP BY s.lane,j.status",
    ),
    db
      .prepare(
        `SELECT lane,COUNT(*) sources,MIN(last_checked_at) oldest_check,
      SUM(last_checked_at IS NULL) never_checked,SUM(enabled=0) disabled,
      SUM(enabled=1 AND next_run_at<=?) scheduled_due,
      SUM(enabled=1 AND next_run_at<=? AND (lane='discovery' OR NOT EXISTS(SELECT 1 FROM research_profiles r WHERE r.product_id=sources.product_id AND r.status!='accepted')) AND NOT EXISTS(SELECT 1 FROM products p WHERE p.id=sources.product_id AND p.status='archived')) eligible_due FROM sources GROUP BY lane`,
      )
      .bind(time, time),
  ]);
  return {
    asOf: time,
    reset: "00:00 UTC",
    lanes: results[0].results,
    backlog: results[1].results,
    coverage: results[2].results,
    budgetUnit:
      "Claim attempts, including retries. Not a token or dollar meter.",
    spending:
      "No paid API fallback. Work account usage remains subject to its own limits.",
  };
}
