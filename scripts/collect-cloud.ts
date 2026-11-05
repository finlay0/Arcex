import { api, collectorToken } from "./client";
import { collect } from "./collector";

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
  console.log(JSON.stringify({ mode, ...status, ...result }));
  if (result.failed) process.exitCode = 1;
}
