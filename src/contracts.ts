import { z } from "zod";

export const status = z.enum(["draft", "published", "archived"]);
export const category = z.enum([
  "coding_dev",
  "video_creator",
  "sales_automation",
  "consumer_ai",
  "other",
]);
export const monetization = z.enum([
  "hard_trial_gate",
  "credit_exhaustion",
  "watermark_export",
  "usage_based",
  "free_viral_utility",
  "subscription",
  "unknown",
]);
export const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100);
export const id = z.string().min(1).max(100);
export const timestamp = z.iso.datetime();
export const publicUrl = z
  .url()
  .max(2048)
  .superRefine((s, ctx) => {
    const u = new URL(s);
    const h = u.hostname.toLowerCase();
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      !h.includes(".") ||
      /[\[\]:]/.test(h) ||
      /^\d+[.]/.test(h) ||
      ["localhost", "local", "internal", "test", "invalid", "example"].some(
        (t) => h === t || h.endsWith("." + t),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Use a public HTTPS URL without credentials or a custom port",
      });
    }
  });
export const productInput = z
  .object({
    slug,
    name: z.string().min(1).max(120),
    url: publicUrl.refine((u) => {
      try {
        productKey(u);
        return true;
      } catch {
        return false;
      }
    }, "Store and code-host URLs must point to one listing"),
    description: z.string().min(1).max(2000),
    category,
    monetization: monetization.default("unknown"),
  })
  .strict();
export const evidenceInput = z
  .object({
    productId: id.optional(),
    sourceUrl: publicUrl,
    observedAt: timestamp,
    kind: z.enum(["page", "rss_item", "screenshot", "video", "manual"]),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z.string().min(1).max(4000),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const signalInput = z
  .object({
    evidenceId: id,
    kind: z.enum(["ad_observed", "creator_mention", "launch", "public_page"]),
    externalId: z.string().min(1).max(250),
    observedAt: timestamp,
    sourceUrl: publicUrl,
    detail: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const funnelInput = z
  .array(
    z
      .object({
        position: z.number().int().min(0).max(200),
        title: z.string().min(1).max(200),
        stage: z.enum([
          "landing",
          "signup",
          "onboarding",
          "activation",
          "paywall",
          "retention",
        ]),
        annotation: z.string().max(4000),
        evidenceId: id,
        assetId: id.optional(),
      })
      .strict(),
  )
  .max(100)
  .refine(
    (a) => new Set(a.map((s) => s.position)).size === a.length,
    "Duplicate positions",
  );
export const paywallInput = z
  .object({
    evidenceId: id,
    pattern: monetization,
    states: z.array(z.string().min(1).max(100)).min(1).max(50),
    transitions: z
      .array(
        z
          .object({
            from: z.string(),
            to: z.string(),
            trigger: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(100),
    creditRules: z.record(z.string(), z.unknown()),
    notes: z.string().max(6000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      new Set(v.states).size !== v.states.length ||
      v.transitions.some(
        (t) => !v.states.includes(t.from) || !v.states.includes(t.to),
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "States must be unique; transitions must reference known states",
      });
  });
export const blueprintSpec = z
  .object({
    summary: z.string().min(1).max(4000),
    evidenceIds: z.array(id).min(1).max(100),
    databaseTables: z
      .array(
        z
          .object({
            name: z.string(),
            purpose: z.string(),
            columns: z.array(z.string()),
          })
          .strict(),
      )
      .max(50),
    middleware: z.array(z.string().max(4000)).max(100),
    stateTransitions: z
      .array(
        z
          .object({ from: z.string(), to: z.string(), trigger: z.string() })
          .strict(),
      )
      .max(100),
    components: z.array(z.string().max(500)).max(100),
    implementationNotes: z.array(z.string().max(4000)).max(100),
    assumptions: z.array(z.string().max(2000)).max(100),
  })
  .strict();
export const blueprintInput = z
  .object({ title: z.string().min(1).max(200), spec: blueprintSpec })
  .strict();
export const arenaInput = z
  .object({
    slug,
    title: z.string().min(1).max(200),
    description: z.string().max(4000),
    model: z.string().min(1).max(200),
    prompt: z.string().min(1).max(30000),
    repositoryUrl: publicUrl.optional(),
    demoUrl: publicUrl.optional(),
    benchmark: z.record(z.string(), z.unknown()).default({}),
    rating: z.number().min(0).max(10).optional(),
  })
  .strict();
export const shipInput = z
  .object({
    name: z.string().min(1).max(120),
    url: publicUrl,
    description: z.string().min(1).max(500),
    stack: z.array(z.string().min(1).max(100)).max(30),
    monetization,
  })
  .strict();
export const sourceCaptureMode = z.enum(["metadata", "text"]);
export const sourceInput = z
  .object({
    productId: id.optional(),
    name: z.string().min(1).max(200),
    url: publicUrl,
    kind: z.enum(["public_page", "rss", "browser"]),
    lane: z.enum(["http", "browser", "discovery"]).optional(),
    intervalHours: z.number().int().min(1).max(720).default(24),
    enabled: z.boolean().default(false),
    captureMode: sourceCaptureMode.default("metadata"),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.captureMode === "text" && input.kind !== "public_page")
      ctx.addIssue({
        code: "custom",
        message: "Text capture is only supported for public-page HTTP sources",
      });
  });
export type ProductInput = z.infer<typeof productInput>;
export type EvidenceInput = z.infer<typeof evidenceInput>;

// Stores and code hosts list many unrelated products on one hostname. Their identity
// includes the listing path, so a second extension is never merged into the first.
const LISTING_HOSTS: Record<string, (u: URL) => string | null> = {
  "chromewebstore.google.com": (u) =>
    u.pathname.match(/^\/detail\/(?:[^/]+\/)?([a-p]{32})/)?.[1] ?? null,
  "chrome.google.com": (u) =>
    u.pathname.match(/^\/webstore\/detail\/(?:[^/]+\/)?([a-p]{32})/)?.[1] ??
    null,
  "marketplace.visualstudio.com": (u) => u.searchParams.get("itemName"),
  "addons.mozilla.org": (u) =>
    u.pathname.match(/\/addon\/([^/]+)/)?.[1] ?? null,
  "apps.apple.com": (u) => u.pathname.match(/\/(id\d+)/)?.[1] ?? null,
  "play.google.com": (u) => u.searchParams.get("id"),
  "github.com": (u) =>
    u.pathname.match(/^\/([^/]+\/[^/]+)/)?.[1]?.replace(/\.git$/, "") ?? null,
  "huggingface.co": (u) =>
    u.pathname.match(/^\/(spaces\/[^/]+\/[^/]+)/)?.[1] ?? null,
  "www.npmjs.com": (u) =>
    u.pathname.match(/^\/package\/((?:@[^/]+\/)?[^/]+)/)?.[1] ?? null,
  "pypi.org": (u) => u.pathname.match(/^\/project\/([^/]+)/)?.[1] ?? null,
};

/** The unique product key stored in products.domain: host without www, plus the listing id on store hosts. */
export function productKey(raw: string) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const listing = LISTING_HOSTS[host];
  const bare = host.replace(/^www\./, "");
  if (!listing) return bare;
  const item = listing(url);
  if (!item)
    throw new Error("Store and code-host URLs must point to one listing");
  return `${bare}/${item.toLowerCase()}`;
}
export const SHARED_HOSTING =
  /\.(vercel\.app|netlify\.app|pages\.dev|workers\.dev|web\.app|firebaseapp\.com|github\.io|herokuapp\.com|onrender\.com|fly\.dev|replit\.app|lovable\.app|bolt\.host|framer\.website|webflow\.io|carrd\.co|notion\.site|super\.site)$/;
/** The registrable site a product key sits under, used only to flag possible duplicates. */
export function siteOf(key: string) {
  const host = productHost(key);
  if (SHARED_HOSTING.test(host) || key.includes("/")) return host;
  const labels = host.split(".");
  const take =
    labels.length > 2 &&
    labels.at(-1)!.length === 2 &&
    labels.at(-2)!.length <= 3
      ? 3
      : 2;
  return labels.slice(-take).join(".");
}
/** Hostname part of a product key. */
export const productHost = (key: string) => key.split("/")[0];
