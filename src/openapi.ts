import { z } from "zod";
import {
  productInput,
  evidenceInput,
  signalInput,
  funnelInput,
  paywallInput,
  blueprintInput,
  arenaInput,
  shipInput,
  sourceInput,
} from "./contracts";

const schemas = {
  ProductInput: productInput,
  EvidenceInput: evidenceInput,
  SignalInput: signalInput,
  FunnelInput: funnelInput,
  PaywallInput: paywallInput,
  BlueprintInput: blueprintInput,
  ArenaInput: arenaInput,
  ShipInput: shipInput,
  SourceInput: sourceInput,
};
const auth = { security: [{ Session: [] }, { InsiderKey: [] }] };
function operation(
  summary: string,
  security: "public" | "user" | "admin" | "collector" = "public",
  schema?: keyof typeof schemas,
) {
  return {
    summary,
    ...(security === "user"
      ? auth
      : security === "admin"
        ? { security: [{ AdminToken: [] }] }
        : security === "collector"
          ? { security: [{ CollectorToken: [] }] }
          : {}),
    ...(schema
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/" + schema },
              },
            },
          },
        }
      : {}),
    responses: {
      "200": { description: "Success" },
      "201": { description: "Created" },
      "401": { description: "Authentication required" },
      "403": { description: "Access denied" },
      "422": { description: "Invalid input" },
    },
  };
}
export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Arcex API",
    version: "0.1.0",
    description:
      "Backend contract. Public reads return published records only. Imports are drafts. Insider keys require an active subscription. Session mutations require Origin matching APP_ORIGIN.",
  },
  components: {
    schemas: Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [
        name,
        z.toJSONSchema(schema),
      ]),
    ),
    securitySchemes: {
      Session: { type: "apiKey", in: "cookie", name: "arcex_session" },
      InsiderKey: { type: "http", scheme: "bearer" },
      AdminToken: { type: "http", scheme: "bearer" },
      CollectorToken: { type: "http", scheme: "bearer" },
    },
  },
  paths: {
    "/health": { get: operation("Database readiness") },
    "/auth/{provider}/start": { get: operation("Start GitHub or X OAuth") },
    "/auth/{provider}/callback": { get: operation("OAuth callback") },
    "/auth/logout": { post: operation("Revoke current session", "user") },
    "/api/v1/radar": {
      get: operation(
        "Published products; q, category, monetization, limit, offset",
      ),
    },
    "/api/v1/vault/{slug}": {
      get: operation("Product, approved evidence, funnel and paywall"),
    },
    "/api/v1/blueprints/{id}/export": {
      get: operation(
        "Export a published version with partner disclosures",
        "user",
      ),
    },
    "/api/v1/arena": { get: operation("Published playable builds") },
    "/api/v1/arena/{slug}": {
      get: operation("Build, prompt, repository and benchmark"),
    },
    "/api/v1/arena/{id}/vote": {
      put: operation("Idempotent vote", "user"),
      delete: operation("Remove vote", "user"),
    },
    "/api/v1/ship": {
      get: operation("Approved and reviewed community builds"),
      post: operation("Submit a build for moderation", "user", "ShipInput"),
    },
    "/api/v1/ship/{id}": {
      patch: operation(
        "Edit own build and return it to moderation",
        "user",
        "ShipInput",
      ),
      delete: operation("Delete own build", "user"),
    },
    "/api/v1/ship/{id}/vote": {
      put: operation("Idempotent vote", "user"),
      delete: operation("Remove vote", "user"),
    },
    "/api/v1/me": {
      get: operation("Private profile and Insider entitlement", "user"),
    },
    "/api/v1/me/ship": {
      get: operation("Own submissions including pending", "user"),
    },
    "/api/v1/me/saves": { get: operation("Saved published products", "user") },
    "/api/v1/me/saves/{productId}": {
      put: operation("Save product", "user"),
      delete: operation("Unsave product", "user"),
    },
    "/api/v1/me/collections": {
      get: operation("Own collections", "user"),
      post: operation("Create Insider collection", "user"),
    },
    "/api/v1/me/collections/{id}": {
      get: operation("Own collection contents", "user"),
      delete: operation("Delete own collection", "user"),
    },
    "/api/v1/me/collections/{id}/items/{productId}": {
      put: operation("Add product as Insider", "user"),
      delete: operation("Remove product", "user"),
    },
    "/api/v1/me/api-keys": {
      get: operation("List keys without secret values; session only", "user"),
      post: operation("Create Insider MCP key; secret returned once", "user"),
    },
    "/api/v1/me/api-keys/{id}": {
      delete: operation("Revoke own key; session only", "user"),
    },
    "/api/v1/admin/products": {
      get: operation("All product drafts", "admin"),
      post: operation("Create draft product", "admin", "ProductInput"),
    },
    "/api/v1/admin/products/{id}": {
      patch: operation("Update product", "admin", "ProductInput"),
    },
    "/api/v1/admin/products/{id}/status": {
      put: operation("Publish, archive or return to draft", "admin"),
    },
    "/api/v1/admin/products/{id}/signals": {
      post: operation(
        "Add evidence-backed distribution observation",
        "admin",
        "SignalInput",
      ),
    },
    "/api/v1/admin/products/{id}/funnel": {
      put: operation(
        "Replace ordered funnel and return product to draft",
        "admin",
        "FunnelInput",
      ),
    },
    "/api/v1/admin/products/{id}/paywall": {
      put: operation(
        "Replace paywall state machine and return product to draft",
        "admin",
        "PaywallInput",
      ),
    },
    "/api/v1/admin/products/{id}/blueprints": {
      post: operation(
        "Create immutable draft blueprint version",
        "admin",
        "BlueprintInput",
      ),
    },
    "/api/v1/admin/blueprints/{id}/status": {
      put: operation("Publish approved evidence-backed blueprint", "admin"),
    },
    "/api/v1/admin/blueprints/{id}/partners/{partnerId}": {
      put: operation("Attach disclosed stack partner", "admin"),
    },
    "/api/v1/admin/evidence": {
      get: operation("Review evidence drafts", "admin"),
      post: operation("Import observation as draft", "admin", "EvidenceInput"),
    },
    "/api/v1/admin/evidence/{id}/observations": {
      get: operation(
        "Distinct recorded sightings of this evidence content",
        "admin",
      ),
    },
    "/api/v1/admin/evidence/{id}/status": {
      put: operation(
        "Approve or retract evidence; retraction unpublishes product",
        "admin",
      ),
    },
    "/api/v1/admin/arena": {
      post: operation("Create draft Arena build", "admin", "ArenaInput"),
    },
    "/api/v1/admin/arena/{id}/status": {
      put: operation("Publish or archive build", "admin"),
    },
    "/api/v1/admin/partners": {
      post: operation("Create disclosed stack partner", "admin"),
    },
    "/api/v1/admin/ship": { get: operation("Moderation queue", "admin") },
    "/api/v1/admin/ship/{id}/status": {
      put: operation("Moderate or record live review", "admin"),
    },
    "/api/v1/admin/stream-queue": {
      get: operation(
        "Insiders first, then votes and oldest submission",
        "admin",
      ),
    },
    "/api/v1/admin/sources": {
      get: operation("Registered collection sources", "admin"),
      post: operation(
        "Register source; disabled by default",
        "admin",
        "SourceInput",
      ),
    },
    "/api/v1/admin/sources/{id}": {
      patch: operation("Enable source or change interval", "admin"),
    },
    "/api/v1/admin/jobs": {
      get: operation("Job status and failure reasons", "admin"),
    },
    "/api/v1/admin/jobs/enqueue": {
      post: operation("Enqueue due sources idempotently", "admin"),
    },
    "/api/v1/admin/jobs/{id}/retry": {
      post: operation("Retry exhausted job", "admin"),
    },
    "/api/v1/admin/audit": { get: operation("Audit history", "admin") },
    "/api/v1/admin/billing/holds": {
      get: operation("Billing risk review queue", "admin"),
    },
    "/api/v1/admin/billing/holds/{userId}": {
      delete: operation("Clear reviewed billing hold", "admin"),
    },
    "/api/v1/collector/jobs/claim": {
      post: operation("Atomically lease one supported job", "collector"),
    },
    "/api/v1/collector/jobs/{id}/heartbeat": {
      post: operation("Extend current lease", "collector"),
    },
    "/api/v1/collector/jobs/{id}/complete": {
      post: operation("Commit evidence drafts and job result", "collector"),
    },
    "/api/v1/collector/jobs/{id}/fail": {
      post: operation("Record failure and schedule bounded retry", "collector"),
    },
    "/api/v1/media/upload": {
      post: operation(
        "Upload capture to private R2; optional storage binding",
        "collector",
      ),
    },
    "/api/v1/media/{id}/approval": {
      put: operation("Approve reviewed/redacted capture", "admin"),
    },
    "/api/v1/media/{id}": {
      get: operation("Approved image on published product"),
    },
    "/api/v1/billing/checkout": {
      post: operation("Create hosted Insider checkout; session only", "user"),
    },
    "/api/v1/billing/portal": {
      post: operation("Create hosted billing portal session", "user"),
    },
    "/api/v1/billing/status": {
      get: operation("Current entitlement and billing status", "user"),
    },
    "/api/v1/billing/webhook": {
      post: operation("Signed Stripe lifecycle and risk event receiver"),
    },
  },
};

for (const [path, item] of Object.entries(openapi.paths)) {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  if (names.length)
    Object.assign(item, {
      parameters: names.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
    });
}
