import assert from "node:assert/strict";
import { api, apiUrl, adminToken } from "./client";

const health = await api<{ ok: boolean }>("/health");
assert.equal(health.ok, true);
for (const path of ["/api/v1/radar", "/api/v1/arena", "/api/v1/ship"]) {
  const result = await api<{ items: unknown[] }>(path);
  assert.ok(Array.isArray(result.items));
}
const denied = await fetch(apiUrl + "/api/v1/admin/products");
assert.equal(denied.status, 401);
const exportDenied = await fetch(apiUrl + "/api/v1/blueprints/unknown/export");
assert.equal(exportDenied.status, 401);
const schema = await api<{ openapi: string; paths: Record<string, unknown> }>(
  "/openapi.json",
);
assert.equal(schema.openapi, "3.1.0");
if (adminToken) {
  const jobs = await api<{ items: unknown[] }>("/api/v1/admin/jobs", {
    token: adminToken,
  });
  assert.ok(Array.isArray(jobs.items));
}
console.log(
  JSON.stringify({
    ok: true,
    url: apiUrl,
    paths: Object.keys(schema.paths).length,
    checks: [
      "database",
      "public modules",
      "admin denial",
      "export denial",
      "schema",
      ...(adminToken ? ["authenticated job listing"] : []),
    ],
  }),
);
