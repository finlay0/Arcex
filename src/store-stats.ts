import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./types";
import { later, now } from "./types";
import { requireAdmin, requireCollector } from "./auth";
import { fail, parse } from "./lib";
import { id, productKey, publicUrl } from "./contracts";

export type Store =
  | "app_store"
  | "google_play"
  | "chrome_web_store"
  | "firefox_addons"
  | "vscode_marketplace";

/** Apply the existing listing identity rules, then restrict to supported store paths. */
export function storeListing(raw: string) {
  const u = new URL(publicUrl.parse(raw));
  productKey(u.href);
  let store: Store, externalId: string, listingUrl: string;
  switch (u.hostname) {
    case "apps.apple.com": {
      const match = u.pathname.match(
        /^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id(\d+)\/?$/i,
      );
      if (!match) throw new Error("Use one App Store app listing");
      store = "app_store";
      externalId = match[1];
      listingUrl = `https://apps.apple.com/us/app/id${externalId}`;
      break;
    }
    case "play.google.com":
      externalId = u.searchParams.get("id") ?? "";
      if (
        u.pathname !== "/store/apps/details" ||
        !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(externalId)
      )
        throw new Error("Use one Google Play app listing");
      store = "google_play";
      listingUrl = `https://play.google.com/store/apps/details?id=${externalId}`;
      break;
    case "chromewebstore.google.com":
    case "chrome.google.com": {
      const match = u.pathname.match(
        /^\/(?:webstore\/)?detail\/(?:[^/]+\/)?([a-p]{32})\/?$/,
      );
      if (!match) throw new Error("Use one Chrome Web Store listing");
      store = "chrome_web_store";
      externalId = match[1];
      listingUrl = `https://chromewebstore.google.com/detail/${externalId}`;
      break;
    }
    case "addons.mozilla.org": {
      const match = u.pathname.match(
        /^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?(?:firefox|android)\/addon\/([a-z0-9_-]+)\/?$/i,
      );
      if (!match) throw new Error("Use one Firefox add-on listing");
      store = "firefox_addons";
      externalId = match[1].toLowerCase();
      listingUrl = `https://addons.mozilla.org/en-US/firefox/addon/${externalId}/`;
      break;
    }
    case "marketplace.visualstudio.com":
      externalId = u.searchParams.get("itemName") ?? "";
      if (
        u.pathname !== "/items" ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/.test(externalId)
      )
        throw new Error("Use one VS Code Marketplace listing");
      store = "vscode_marketplace";
      externalId = externalId.toLowerCase();
      listingUrl = `https://marketplace.visualstudio.com/items?itemName=${externalId}`;
      break;
    default:
      throw new Error("Unsupported listing store");
  }
  if (externalId.length > 250) throw new Error("Listing ID is too long");
  return { store, externalId, listingUrl };
}

export const registerStoreListingInput = z
  .object({
    productId: id,
    listingUrl: publicUrl.refine((url) => {
      try {
        storeListing(url);
        return true;
      } catch {
        return false;
      }
    }, "Use one supported store listing URL"),
  })
  .strict();

async function addListing(
  db: D1Database,
  productId: string,
  url: string,
  automatic = false,
) {
  const listing = storeListing(url);
  const listingId = crypto.randomUUID();
  // Bound the public response and avoid accumulating unrelated listings on a product.
  const result = await db
    .prepare(
      `INSERT INTO store_listings(id,product_id,store,listing_url,external_id,created_at)
     SELECT ?,p.id,?,?,?,? FROM products p WHERE p.id=?
       AND (SELECT count(*) FROM store_listings WHERE product_id=p.id)<20
     ON CONFLICT DO NOTHING`,
    )
    .bind(
      listingId,
      listing.store,
      listing.listingUrl,
      listing.externalId,
      now(),
      productId,
    )
    .run();
  if (!result.meta.changes && !automatic)
    fail(
      409,
      "Listing already registered, product missing, or listing limit reached",
    );
  return { id: listingId, ...listing };
}

// Lazy backfill also catches products created through any API/MCP/import path, without
// changing catalog writes. At most 50 registrations per hourly collector invocation.
async function discoverOwnListings(db: D1Database) {
  const rows = await db
    .prepare(
      `WITH candidates AS (
       SELECT p.id,p.url,substr(p.domain,instr(p.domain,'/')+1) AS external_key,
         CASE substr(p.domain,1,instr(p.domain,'/')-1)
           WHEN 'apps.apple.com' THEN 'app_store'
           WHEN 'play.google.com' THEN 'google_play'
           WHEN 'chromewebstore.google.com' THEN 'chrome_web_store'
           WHEN 'chrome.google.com' THEN 'chrome_web_store'
           WHEN 'addons.mozilla.org' THEN 'firefox_addons'
           WHEN 'marketplace.visualstudio.com' THEN 'vscode_marketplace' END AS store
       FROM products p WHERE p.status!='archived'
         AND NOT EXISTS(SELECT 1 FROM research_profiles r WHERE r.product_id=p.id AND r.status='excluded')
     ) SELECT id,url FROM candidates c WHERE store IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM store_listings s WHERE s.store=c.store
         AND lower(CASE WHEN s.store='app_store' THEN 'id'||s.external_id ELSE s.external_id END)=c.external_key)
       AND (SELECT count(*) FROM store_listings s WHERE s.product_id=c.id)<20
     ORDER BY id LIMIT 50`,
    )
    .all<{ id: string; url: string }>();
  for (const row of rows.results) {
    // Legacy catalog data may predate strict listing validation.
    if (
      registerStoreListingInput.safeParse({
        productId: row.id,
        listingUrl: row.url,
      }).success
    )
      await addListing(db, row.id, row.url, true);
  }
}

const counter = z.number().int().min(0).max(1_000_000_000_000);
const short = z.string().min(1).max(100);
export const storeSnapshotInput = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      rating: z.number().min(0).max(5).nullable().default(null),
      ratingCount: counter.nullable().default(null),
      installsOrUsers: counter.nullable().default(null),
      installsLabel: short.nullable().default(null),
      price: z.number().min(0).max(1_000_000).nullable().default(null),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .nullable()
        .default(null),
      version: short.nullable().default(null),
      storeUpdatedAt: short.nullable().default(null),
      rawSha256: z.string().regex(/^[a-f0-9]{64}$/),
      genre: short.nullable().default(null),
      containsAds: z.boolean().nullable().default(null),
      hasInAppPurchases: z.boolean().nullable().default(null),
      inAppPurchases: z
        .array(
          z
            .object({
              name: z.string().min(1).max(200),
              price: z.string().min(1).max(100),
            })
            .strict(),
        )
        .max(100)
        .nullable()
        .default(null),
      averageDailyUsers: counter.nullable().default(null),
    })
    .strict()
    .refine(
      (s) =>
        [s.rating, s.ratingCount, s.installsOrUsers, s.price, s.version].some(
          (v) => v !== null,
        ),
      "No store observations",
    ),
  z
    .object({ status: z.literal("failed"), reason: z.string().min(1).max(300) })
    .strict(),
]);
export type StoreSnapshot = Extract<
  z.infer<typeof storeSnapshotInput>,
  { status: "ok" }
>;

export const collectorStoreStats = new Hono<AppEnv>();
collectorStoreStats.use("*", requireCollector);
collectorStoreStats.get("/pending", async (c) => {
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(25)
    .parse(c.req.query("limit"));
  await discoverOwnListings(c.env.DB);
  const rows = await c.env.DB.prepare(
    `SELECT s.id,s.product_id,s.store,s.listing_url,s.external_id FROM store_listings s
     JOIN products p ON p.id=s.product_id WHERE s.enabled=1 AND p.status!='archived'
       AND NOT EXISTS(SELECT 1 FROM research_profiles r WHERE r.product_id=p.id AND r.status='excluded')
       AND (s.last_checked_at IS NULL OR s.last_checked_at<?)
     ORDER BY s.last_checked_at IS NOT NULL,s.last_checked_at,s.created_at,s.id LIMIT ?`,
  )
    .bind(later(-20 * 3600), limit)
    .all();
  return c.json({ items: rows.results, limit });
});
collectorStoreStats.post("/:listingId/snapshot", async (c) => {
  const listingId = id.parse(c.req.param("listingId"));
  const input = await parse(c, storeSnapshotInput);
  const db = c.env.DB,
    time = now();
  const eligible = await db
    .prepare(
      `SELECT s.id FROM store_listings s JOIN products p ON p.id=s.product_id
     WHERE s.id=? AND s.enabled=1 AND p.status!='archived'
       AND NOT EXISTS(SELECT 1 FROM research_profiles r WHERE r.product_id=p.id AND r.status='excluded')`,
    )
    .bind(listingId)
    .first();
  if (!eligible) fail(404, "Enabled listing not found");
  if (input.status === "failed") {
    await db
      .prepare(
        "UPDATE store_listings SET last_checked_at=?,failure_streak=failure_streak+1,last_error=? WHERE id=?",
      )
      .bind(time, input.reason, listingId)
      .run();
    return c.json({ status: "failed" });
  }
  const columns = [
    "rating",
    "rating_count",
    "installs_or_users",
    "installs_label",
    "price",
    "currency",
    "version",
    "store_updated_at",
    "raw_sha256",
    "genre",
    "contains_ads",
    "has_in_app_purchases",
    "in_app_purchases",
    "average_daily_users",
  ];
  const values = [
    input.rating,
    input.ratingCount,
    input.installsOrUsers,
    input.installsLabel,
    input.price,
    input.currency,
    input.version,
    input.storeUpdatedAt,
    input.rawSha256,
    input.genre,
    input.containsAds === null ? null : Number(input.containsAds),
    input.hasInAppPurchases === null ? null : Number(input.hasInAppPurchases),
    input.inAppPurchases === null ? null : JSON.stringify(input.inAppPurchases),
    input.averageDailyUsers,
  ];
  await db.batch([
    db
      .prepare(
        `INSERT INTO store_listing_snapshots(listing_id,observed_on,${columns.join(",")},created_at)
      VALUES (?,?,${columns.map(() => "?").join(",")},?) ON CONFLICT(listing_id,observed_on)
      DO UPDATE SET ${columns.map((col) => `${col}=excluded.${col}`).join(",")},created_at=excluded.created_at`,
      )
      .bind(listingId, time.slice(0, 10), ...values, time),
    db
      .prepare(
        "UPDATE store_listings SET last_checked_at=?,failure_streak=0,last_error=NULL WHERE id=?",
      )
      .bind(time, listingId),
  ]);
  return c.json({ status: "ok", observedOn: time.slice(0, 10) });
});

export const adminStoreStats = new Hono<AppEnv>();
adminStoreStats.post(
  "/products/:productId/store-listings",
  requireAdmin,
  async (c) => {
    const input = await parse(
      c,
      registerStoreListingInput.omit({ productId: true }),
    );
    return c.json(
      await addListing(
        c.env.DB,
        id.parse(c.req.param("productId")),
        input.listingUrl,
      ),
      201,
    );
  },
);

export const publicStoreStats = new Hono<AppEnv>();
publicStoreStats.get("/products/:productId/store-stats", async (c) => {
  const productId = id.parse(c.req.param("productId"));
  const product = await c.env.DB.prepare(
    "SELECT id FROM products WHERE id=? AND status='published'",
  )
    .bind(productId)
    .first();
  if (!product) fail(404, "Product not found");
  const listings = await c.env.DB.prepare(
    "SELECT id,store,listing_url,external_id,enabled,last_checked_at,failure_streak FROM store_listings WHERE product_id=? ORDER BY store,id LIMIT 20",
  )
    .bind(productId)
    .all<{ id: string }>();
  const history = await c.env.DB.prepare(
    `SELECT * FROM (SELECT t.*,row_number() OVER (PARTITION BY listing_id ORDER BY observed_on DESC) AS n
       FROM store_listing_snapshots t JOIN store_listings s ON s.id=t.listing_id WHERE s.product_id=?)
     WHERE n<=180 ORDER BY observed_on`,
  )
    .bind(productId)
    .all<{
      listing_id: string;
      in_app_purchases: string | null;
      contains_ads: number | null;
      has_in_app_purchases: number | null;
      n: number;
    }>();
  return c.json({
    meaning:
      "Public store counters (US where regional) and listed prices, not verified downloads, unique people or revenue; bucket counts are lower bounds and unavailable fields are null.",
    listings: listings.results.map((listing) => ({
      ...listing,
      snapshots: history.results
        .filter((s) => s.listing_id === listing.id)
        .map(({ n, ...s }) => ({
          ...s,
          in_app_purchases:
            s.in_app_purchases === null ? null : JSON.parse(s.in_app_purchases),
          contains_ads: s.contains_ads === null ? null : !!s.contains_ads,
          has_in_app_purchases:
            s.has_in_app_purchases === null ? null : !!s.has_in_app_purchases,
        })),
    })),
  });
});
