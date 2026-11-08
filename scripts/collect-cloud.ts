import { api, collectorToken } from "./client";
import { collect } from "./collector";
import { collectIcons } from "./icons";
import { collectTraffic } from "./traffic";
import { collectStoreStats } from "./store-stats";

const mode = process.env.COLLECTION_MODE ?? "status";
const limit = Number(process.env.COLLECTION_LIMIT ?? 50);
if (!["status", "scheduled", "upfront"].includes(mode))
  throw new Error("Invalid collection mode");
if (!Number.isInteger(limit) || limit < 1 || limit > 100)
  throw new Error("Job limit must be 1–100");
if (!collectorToken) throw new Error("Collector credential required");
const status = await api<{ collectionEnabled: boolean }>(
  "/api/v1/collector/jobs/status",
  { token: collectorToken },
);
if (mode === "status" || (mode === "scheduled" && !status.collectionEnabled)) {
  console.log(
    JSON.stringify({
      mode,
      ...status,
      completed: 0,
      failed: 0,
      reason: "no_collection_requested_or_paused",
    }),
  );
} else {
  // Only an explicit manual upfront run may collect while recurring collection is paused.
  const result = await collect(limit);
  // Brand icons ride on the same code-only run: at most 25 sites per run, no model.
  const icons = await collectIcons(Math.min(limit, 25));
  // Daily Tranco rank for every tracked site; a no-op once today is recorded.
  const traffic = await collectTraffic();
  const stores = await collectStoreStats(Math.min(limit, 50));
  console.log(
    JSON.stringify({
      mode,
      ...status,
      ...result,
      ...icons,
      ...traffic,
      ...stores,
    }),
  );
  // Single sites failing (404s, redirects, bot checks) are recorded per source; only a run
  // where several attempts all failed points at the collector itself.
  if (result.failed >= 3 && !result.completed) process.exitCode = 1;
}
