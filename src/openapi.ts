import { z } from "zod";
import { candidateInput, assessmentInput } from "./research";
import { researchContextInput, checkpointInput } from "./research-context";
import { publicPricingInput } from "./public-pricing";
import {
  watchInput,
  scanInput,
  adSightingInput,
  creatorMentionInput,
  launchSnapshotInput,
  googleAdInput,
  shortFormInput,
} from "./distribution";
import { youtubeCollectionInput, sponsorBlockInput } from "./external-signals";
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
  PublicPricingInput: publicPricingInput,
  ResearchContextInput: researchContextInput,
  ResearchCheckpointInput: checkpointInput,
  ResearchAssessmentInput: assessmentInput,
  DistributionWatchInput: watchInput,
  DistributionScanInput: scanInput,
  MetaAdInput: adSightingInput,
  CreatorMentionInput: creatorMentionInput,
  LaunchSnapshotInput: launchSnapshotInput,
  GoogleAdInput: googleAdInput,
  ShortFormInput: shortFormInput,
  YoutubeCollectionInput: youtubeCollectionInput,
  SponsorBlockInput: sponsorBlockInput,
  ResearchCandidateInput: candidateInput,
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
      "Backend contract. Public reads return published records only. Imports are drafts. API keys are free and can only export blueprints unless the owner has an active Insider subscription. Session mutations require Origin matching APP_ORIGIN.",
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
      CollectorOAuth: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "/authorize",
            tokenUrl: "/oauth/token",
            scopes: {
              "arcex:collect": "Owner-only private research draft collection",
            },
          },
        },
      },
    },
  },
  paths: {
    "/api/v1/admin/research/context": {
      post: operation(
        "Versioned playbook, cohort and durable run checkpoints",
        "admin",
        "ResearchContextInput",
      ),
    },
    "/api/v1/admin/research/checkpoint": {
      post: operation(
        "Save resumable research state without relying on chat memory",
        "admin",
        "ResearchCheckpointInput",
      ),
    },
    "/api/v1/admin/research/assessment": {
      post: operation(
        "Save evidence-linked relevance and company-scale assessment as pending",
        "admin",
        "ResearchAssessmentInput",
      ),
    },
    "/api/v1/admin/research/products/{id}": {
      get: operation(
        "Read prior product evidence, captures, watches and funnel versions",
        "admin",
      ),
    },
    "/api/v1/admin/distribution/google": {
      post: operation(
        "Record source-backed Google transparency creative",
        "admin",
        "GoogleAdInput",
      ),
    },
    "/api/v1/admin/distribution/short-form": {
      post: operation(
        "Record short-form hook and visible counters",
        "admin",
        "ShortFormInput",
      ),
    },
    "/api/v1/admin/distribution/youtube/collect": {
      post: operation(
        "Bounded official API description-link collection, requires server key",
        "admin",
        "YoutubeCollectionInput",
      ),
    },
    "/api/v1/admin/distribution/sponsorblock": {
      post: operation(
        "Optional licensed community segment lookup; disabled by default",
        "admin",
        "SponsorBlockInput",
      ),
    },
    "/api/v1/admin/distribution/launch": {
      post: operation(
        "Record a public launch counter snapshot; derive rates only from actual observations",
        "admin",
        "LaunchSnapshotInput",
      ),
    },
    "/api/v1/distribution/{slug}": {
      get: operation(
        "Approved per-ad observation history on a published product",
      ),
    },
    "/api/v1/admin/distribution": {
      get: operation(
        "Private watches, scan outcomes and per-ad history",
        "admin",
      ),
    },
    "/api/v1/admin/distribution/watches": {
      post: operation(
        "Register Meta/YouTube/X browser watch",
        "admin",
        "DistributionWatchInput",
      ),
    },
    "/api/v1/admin/distribution/scans": {
      post: operation(
        "Record exact-URL scan outcome",
        "admin",
        "DistributionScanInput",
      ),
    },
    "/api/v1/admin/distribution/ads": {
      post: operation(
        "Record source-backed Meta ad sighting as draft",
        "admin",
        "MetaAdInput",
      ),
    },
    "/api/v1/admin/distribution/creators": {
      post: operation(
        "Record a source-backed creator outbound link or mention",
        "admin",
        "CreatorMentionInput",
      ),
    },
    "/mcp": {
      post: {
        ...operation("Owner-only collector MCP; OAuth arcex:collect scope"),
        security: [{ CollectorOAuth: ["arcex:collect"] }],
      },
    },
    "/api/v1/admin/research/candidates": {
      get: operation("Private research cohort and ownership evidence", "admin"),
      post: operation(
        "Register independent product as draft",
        "admin",
        "ResearchCandidateInput",
      ),
    },
    "/api/v1/admin/research/candidates/{id}/status": {
      put: operation("Review cohort eligibility", "admin"),
    },
    "/api/v1/admin/billing/readiness": {
      get: operation(
        "Read provider configuration without exposing credentials",
        "admin",
      ),
    },
    "/api/v1/media/storage/setup": {
      post: operation(
        "Create private evidence bucket; preserves existing data",
        "admin",
      ),
    },
    "/api/v1/media/storage/status": {
      get: operation(
        "Private bucket readiness and 900 MB application quota (Supabase Free: 1 GB)",
        "admin",
      ),
    },
    "/api/v1/media/{id}/review": {
      get: operation(
        "Private capture review, including unapproved assets",
        "admin",
      ),
    },
    "/api/v1/media/thumbnails/pending": {
      get: operation(
        "Owner thumbnail queue, maximum25; optional productId. Private captures remain private.",
        "admin",
      ),
    },
    "/api/v1/media/{id}/thumbnail": {
      post: operation(
        "Save owner-generated small WebP derivative within shared evidence quota; does not approve or publish",
        "admin",
      ),
      get: operation(
        "Small derivative for an approved capture/evidence on a published Full Screens product; never serves the full capture",
      ),
    },
    "/api/v1/admin/mcp/grants": {
      get: operation("List owner collector authorization grants", "admin"),
    },
    "/api/v1/admin/mcp/grants/{id}": {
      delete: operation("Revoke collector authorization", "admin"),
    },
    "/health": { get: operation("Database readiness") },
    "/api/v1/changes": {
      get: operation("Published observed changes across products"),
    },
    "/api/v1/screens": {
      get: operation(
        "Published reviewed screen library; locked metadata until the app is unlocked today, a sample, or Insider. Listing spends no allowance. Filters: product slug, category, monetization, stage, q, limit, offset.",
      ),
    },
    "/api/v1/ads": {
      get: operation(
        "Latest approved observation per ad across published products; no current activity or revenue inference. Filters: product slug, category, monetization, platform, activity, q, limit, offset.",
      ),
    },
    "/api/v1/me/usage": {
      get: operation("Today's app usage and limit; session only", "user"),
    },
    "/api/v1/me/history": {
      get: operation(
        "Your 100 most recently opened products, paginated; session only. Reading history never unlocks apps.",
        "user",
      ),
      delete: operation(
        "Clear your recent product history; session only. Does not reset app allowances.",
        "user",
      ),
    },
    "/api/v1/me/history/{productId}": {
      delete: operation(
        "Remove a product from your history; session only",
        "user",
      ),
    },
    "/api/v1/me/watches": {
      get: operation("Tracked products and limit; session only", "user"),
    },
    "/api/v1/me/watches/{productId}": {
      put: operation(
        "Track a product; free accounts get 3; session only",
        "user",
      ),
      delete: operation("Stop tracking a product; session only", "user"),
    },
    "/api/v1/me/watches/changes": {
      get: operation("Changes for tracked products; session only", "user"),
    },
    "/api/v1/me/products": {
      get: operation("Your own products; session only", "user"),
      post: operation("Add your own product; session only", "user"),
    },
    "/api/v1/me/products/{id}": {
      delete: operation("Remove your own product; session only", "user"),
    },
    "/api/v1/me/alerts": {
      get: operation("Alert preference; session only", "user"),
      put: operation("Set alert preference; Insider and session only", "user"),
    },
    "/api/v1/me/requests/{productId}": {
      put: operation("Request a full breakdown; session only", "user"),
    },
    "/api/v1/me/product-requests": {
      get: operation(
        "Your submitted product URLs and review status; session only",
        "user",
      ),
      post: operation(
        "Request an unlisted product by public HTTPS URL; 10 pending per account. Does not create, research or publish a product.",
        "user",
      ),
    },
    "/api/v1/me/product-requests/{id}": {
      delete: operation("Withdraw your product request; session only", "user"),
    },
    "/api/v1/admin/product-requests": {
      get: operation(
        "Domain-grouped product request review queue, Insider first; optional status",
        "admin",
      ),
    },
    "/api/v1/admin/product-requests/{domain}": {
      patch: operation(
        "Mark pending requests reviewed or declined; does not create or publish a product",
        "admin",
      ),
    },
    "/api/v1/admin/metrics/refresh": {
      post: operation("Refresh the next page of table metrics", "admin"),
    },
    "/api/v1/admin/products/{id}/open-sample": {
      put: operation("Mark the app that opens without sign-in", "admin"),
    },
    "/api/v1/admin/products/{id}/revenue": {
      put: operation(
        "Save a sourced, manual revenue range as a draft",
        "admin",
      ),
    },
    "/api/v1/admin/products/{id}/revenue/status": {
      put: operation("Publish or unpublish a manual revenue range", "admin"),
    },
    "/api/v1/admin/products/{id}/revenue/history": {
      get: operation("Revenue range history", "admin"),
    },
    "/api/v1/admin/products/{id}/changes": {
      post: operation("Save an observed change as a draft", "admin"),
    },
    "/api/v1/admin/changes": {
      get: operation(
        "Bounded change review queue; status defaults to draft, optional productId",
        "admin",
      ),
    },
    "/api/v1/admin/changes/{id}": {
      put: operation(
        "Edit a draft summary before explicit publication",
        "admin",
      ),
    },
    "/api/v1/admin/changes/{id}/status": {
      put: operation("Publish or unpublish a change", "admin"),
    },
    "/api/v1/admin/breakdown-requests": {
      get: operation("Most-requested full breakdowns, Insider first", "admin"),
    },
    "/public/mcp": {
      post: operation(
        "Public hosted MCP (Streamable HTTP). No sign-in for search; blueprints use an API key",
      ),
    },
    "/auth/providers": {
      get: operation("Available sign-in providers and configuration readiness"),
    },
    "/auth/{provider}/start": {
      get: operation("Start Google, GitHub or X OAuth"),
    },
    "/auth/{provider}/callback": { get: operation("OAuth callback") },
    "/auth/logout": { post: operation("Revoke current session", "user") },
    "/api/v1/radar": {
      get: operation(
        "Published products; q, category, monetization, minObservedAdDays, limit, offset. Ad days are distinct approved observed dates per ad, not continuous delivery.",
      ),
    },
    "/api/v1/vault/{slug}": {
      get: operation(
        "Public Signals Only details; reviewed Full Screens requires sign-in and ten distinct free apps/day. Bare step numbers never grant screen access; signed shared links expose only their one step.",
      ),
    },
    "/api/v1/vault/{slug}/share": {
      post: operation(
        "Create a seven-day link to one approved screen; JSON position. Open the app first, or use Insider access.",
        "user",
      ),
    },
    "/api/v1/pricing/{slug}": {
      get: operation(
        "Reviewed public-offer history for a published product; no full-app allowance required. Unknown currency stays null.",
      ),
    },
    "/api/v1/admin/products/{id}/public-pricing": {
      post: operation(
        "Save an immutable draft public-offer snapshot with source evidenceIDs and actual observationtime",
        "admin",
        "PublicPricingInput",
      ),
    },
    "/api/v1/admin/pricing/{id}/status": {
      put: operation(
        "Explicitly publish/withdraw a pricing snapshot; all linked source evidence must be approved",
        "admin",
      ),
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
    "/api/v1/email/unsubscribe/{userId}": {
      post: operation(
        "One-click opt-out using the signed capability in the email header; GET never changes preferences",
      ),
    },
    "/api/v1/admin/alerts/status": {
      get: operation(
        "Delivery readiness and aggregate reservations, with no recipient addresses",
        "admin",
      ),
    },
    "/api/v1/admin/alerts/deliver": {
      post: operation(
        "Process at most one opted-in Insider digest when delivery is explicitly enabled; hard50/day and1500/month reservations",
        "admin",
      ),
    },
    "/api/v1/admin/alerts/simulator": {
      post: operation(
        "One budgeted provider-path test perUTCday, fixed Resend simulator recipient and noncustomer content; no arbitrary recipients",
        "admin",
      ),
    },
    "/api/v1/admin/alerts/{id}/resolve": {
      post: operation(
        "Resolve an uncertain provider result after operator review; JSONoutcome accepted/not_accepted and reason. Never refunds quota.",
        "admin",
      ),
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
      post: operation("Create MCP key; secret returned once", "user"),
    },
    "/api/v1/me/api-keys/{id}": {
      delete: operation("Revoke own key; session only", "user"),
    },
    "/api/v1/admin/products": {
      get: operation("All product drafts", "admin"),
      post: operation("Create draft product", "admin", "ProductInput"),
    },
    "/api/v1/admin/research/leads": {
      post: operation(
        "Persist up to25 primary-metadata discovery outcomes, including rejected/unclear leads; operator only, no product publication",
        "admin",
      ),
    },
    "/api/v1/admin/research/leads/lookup": {
      post: operation(
        "Look up at most10 source URLs and their domains against previous outcomes and existing products",
        "admin",
      ),
    },
    "/api/v1/admin/products/{id}": {
      patch: operation("Update product", "admin", "ProductInput"),
    },
    "/api/v1/admin/products/{id}/status": {
      put: operation("Publish, archive or return to draft", "admin"),
    },
    "/api/v1/admin/products/{id}/coverage": {
      put: operation(
        "Owner review: JSON level signals/full and notes (20-2000 chars). Full Screens requires an approved app capture beyond the landing page. Capture changes reset coverage.",
        "admin",
      ),
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
        "Append an immutable flow revision and replace ordered funnel; unchanged input preserves IDs/review",
        "admin",
        "FunnelInput",
      ),
    },
    "/api/v1/admin/products/{id}/paywall": {
      put: operation(
        "Append an immutable paywall revision and replace current state; changes return product to draft",
        "admin",
        "PaywallInput",
      ),
    },
    "/api/v1/admin/products/{id}/flow-history": {
      get: operation(
        "Private funnel/paywall revision metadata, paginated",
        "admin",
      ),
    },
    "/api/v1/admin/products/{id}/flow-history/{revisionId}": {
      get: operation(
        "Private selected revision; funnel steps paginated, oversized paywall data explicitly omitted",
        "admin",
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
    "/api/v1/admin/collection/status": {
      get: operation(
        "Collection allowances, backlog and source freshness",
        "admin",
      ),
    },
    "/api/v1/admin/collection/policy/{lane}": {
      patch: operation(
        "Set daily claim and concurrency ceilings; zero pauses a lane",
        "admin",
      ),
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
    "/api/v1/admin/evidence/{id}/text": {
      get: operation(
        "Private captured-text window, at most 6000 Unicode characters; no collection or publication",
        "admin",
      ),
    },
    "/api/v1/collector/jobs/status": {
      get: operation(
        "Whether recurring source collection is enabled; no work is claimed",
        "collector",
      ),
    },
    "/api/v1/collector/jobs/claim": {
      post: operation(
        "Lease one eligible job and atomically debit its lane allowance",
        "collector",
      ),
    },
    "/api/v1/collector/jobs/{id}/heartbeat": {
      post: operation("Extend current lease", "collector"),
    },
    "/api/v1/collector/jobs/{id}/complete": {
      post: operation(
        "Commit observed evidence or an unchanged HTTP fingerprint and source freshness",
        "collector",
      ),
    },
    "/api/v1/collector/jobs/{id}/fail": {
      post: operation(
        "Record failure, bounded retry and optional blocked-source disable",
        "collector",
      ),
    },
    "/api/v1/media/upload": {
      post: operation(
        "Upload private capture within 900 MB application quota (Supabase Free: 1 GB)",
        "collector",
      ),
    },
    "/api/v1/media/{id}/approval": {
      put: operation("Approve reviewed/redacted capture", "admin"),
    },
    "/api/v1/media/{id}": {
      get: operation("Approved image on published product"),
      delete: operation(
        "Delete unreferenced capture and release application quota",
        "admin",
      ),
    },
    "/api/v1/billing/price": {
      get: operation(
        "ArcX Pro regional monthly offer: CAD in Canada, USD elsewhere",
      ),
    },
    "/api/v1/billing/checkout": {
      post: operation(
        "Create hosted ArcX Pro checkout at the server-selected regional price; session only",
        "user",
      ),
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
