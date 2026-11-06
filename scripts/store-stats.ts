import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { api, collectorToken } from "./client";
import { publicFetch, SourceHttpError } from "./public-fetch";
import { publicUrl, siteOf } from "../src/contracts";
import {
  storeListing,
  storeSnapshotInput,
  type Store,
  type StoreSnapshot,
} from "../src/store-stats";

type Fields = Partial<Omit<StoreSnapshot, "status" | "rawSha256">>;
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const numeric = (v: unknown) =>
  typeof v === "number"
    ? v
    : typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v.replace(/,/g, ""))
      ? Number(v.replace(/,/g, ""))
      : null;
const text = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const decode = (s: string) =>
  s.replace(
    /&(?:#(\d+)|#x([\da-f]+)|amp|quot|apos|lt|gt|nbsp);/gi,
    (whole, decimal, hex) => {
      if (decimal || hex) {
        const cp = Number.parseInt(decimal || hex, hex ? 16 : 10);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
      }
      return (
        (
          {
            "&amp;": "&",
            "&quot;": '"',
            "&apos;": "'",
            "&lt;": "<",
            "&gt;": ">",
            "&nbsp;": " ",
          } as Record<string, string>
        )[whole.toLowerCase()] ?? whole
      );
    },
  );
const visible = (html: string) =>
  decode(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

// A labeled detail, rather than a matching phrase inside a description or review.
const detail = (html: string, label: string) => {
  const value = html.match(
    new RegExp(
      `<div\\b[^>]*>\\s*${label}\\s*</div>\\s*<div\\b[^>]*>([^<]{1,200})</div>`,
      "i",
    ),
  )?.[1];
  return value ? visible(value) : null;
};

function challenge(html: string) {
  if (
    /<(?:title|h1)\b[^>]*>\s*(?:Just a moment|Access denied|Robot Check|Verify (?:you|that)|Before you continue to Google|Service unavailable)/i.test(
      html,
    ) ||
    /id=["']challenge-form["']|\/sorry\/index|Our systems have detected unusual traffic/i.test(
      html,
    )
  )
    throw new Error("Store returned an access challenge");
}

function application(html: string) {
  for (const m of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed)
      ? parsed
      : [
          parsed,
          ...(Array.isArray(record(parsed)["@graph"])
            ? (record(parsed)["@graph"] as unknown[])
            : []),
        ];
    for (const v of candidates) {
      const r = record(v),
        type = r["@type"];
      if (
        type === "SoftwareApplication" ||
        type === "MobileApplication" ||
        (Array.isArray(type) && type.includes("SoftwareApplication"))
      )
        return r;
    }
  }
  return {};
}

function schemaFields(app: Record<string, unknown>): Fields {
  const rating = record(app.aggregateRating);
  const offer = record(Array.isArray(app.offers) ? app.offers[0] : app.offers);
  return {
    rating: numeric(rating.ratingValue),
    ratingCount: numeric(rating.ratingCount ?? rating.reviewCount),
    price: numeric(offer.price),
    currency: text(offer.priceCurrency),
    version: text(app.softwareVersion),
    storeUpdatedAt: text(app.dateModified),
  };
}

/** The store gives a bucket, not an exact download count. */
function bucket(label: string | null) {
  const m = label?.replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*([KMB])?\+?$/i);
  return m
    ? Math.floor(
        Number(m[1]) *
          ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase() as "k" | "m" | "b"] ??
            1),
      )
    : null;
}

export function parseAppStore(
  body: string,
  listingId: string,
  listingPage?: string,
): Fields {
  const response = record(JSON.parse(body));
  const app = Array.isArray(response.results)
    ? response.results
        .map(record)
        .find(
          (r) =>
            String(r.trackId) === listingId && r.wrapperType === "software",
        )
    : undefined;
  if (!app)
    throw new Error("App Store lookup did not return the requested app");
  const purchases: { name: string; price: string }[] = [];
  if (listingPage !== undefined) {
    challenge(listingPage);
    // Restrict to the app's purchases block; never parse prices from recommended apps.
    const block = listingPage.match(
      /<dt\b[^>]*>\s*In-App Purchases\s*<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/i,
    )?.[1];
    for (const li of block?.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi) ?? []) {
      const pair = [...li[1].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(
        (m) => visible(m[1]),
      );
      if (pair.length === 2 && pair[0] && pair[1])
        purchases.push({ name: pair[0], price: pair[1] });
    }
  }
  return {
    rating: numeric(app.averageUserRating),
    ratingCount: numeric(app.userRatingCount),
    price: numeric(app.price),
    currency: text(app.currency),
    version: text(app.version),
    storeUpdatedAt: text(app.currentVersionReleaseDate),
    genre: text(app.primaryGenreName),
    inAppPurchases: purchases.length ? purchases : null,
    hasInAppPurchases: purchases.length ? true : null,
  };
}

export function parseGooglePlay(html: string, listingId: string): Fields {
  challenge(html);
  const app = application(html);
  if (!Object.keys(app).length) throw new Error("Google Play app data missing");
  const url = text(app.url);
  if (url && new URL(url).searchParams.get("id") !== listingId)
    throw new Error("Google Play listing identity mismatch");
  const page = visible(html);
  const installsLabel =
    page.match(/\b([\d,.]+\s*[KMB]?\+)\s+Downloads\b/i)?.[1] ?? null;
  // Absence of a flag is unknown, not proof that an app has no ads or purchases.
  return {
    ...schemaFields(app),
    installsOrUsers: bucket(installsLabel),
    installsLabel,
    containsAds:
      /<span\b[^>]*class=["'][^"']*\bUIuSk\b[^"']*["'][^>]*>\s*Contains ads\s*<\/span>/i.test(
        html,
      )
        ? true
        : null,
    hasInAppPurchases:
      /<span\b[^>]*class=["'][^"']*\bUIuSk\b[^"']*["'][^>]*>\s*In-app purchases\s*<\/span>/i.test(
        html,
      )
        ? true
        : null,
    storeUpdatedAt: detail(html, "Updated on") ?? text(app.dateModified),
  };
}

export function parseChromeWebStore(html: string, listingId: string): Fields {
  challenge(html);
  const page = visible(html);
  // Current public page embeds exact counters in ds:0. Parse JSON only, never execute JS.
  const embedded = html.match(
    /AF_initDataCallback\(\{key:\s*['"]ds:0['"],[\s\S]*?\bdata:([\s\S]*?),\s*sideChannel:/,
  )?.[1];
  let item: unknown[] | undefined;
  if (embedded) {
    const data: unknown = JSON.parse(embedded);
    if (
      Array.isArray(data) &&
      Array.isArray(data[0]) &&
      data[0][0] === listingId
    )
      item = data[0];
    else throw new Error("Chrome listing identity mismatch");
  }
  const fields = schemaFields(application(html));
  const installsLabel =
    page.match(/\b([\d,.]+\s*[KMB]?\+?)\s+users\b/i)?.[1] ?? null;
  const ratingCountText = page.match(/\b([\d,]+)\s+ratings\b/i)?.[1];
  // Rounded "44.9K ratings" isn't an exact count. Leave it null without embedded data.
  const ratingCount = item
    ? numeric(item[4])
    : (fields.ratingCount ?? numeric(ratingCountText));
  const rating = item
    ? numeric(item[3])
    : (fields.rating ??
      numeric(
        html.match(/aria-label=["']Average rating ([\d.]+) out of 5/i)?.[1],
      ));
  if (rating === null && installsLabel === null)
    throw new Error("Chrome listing counters missing");
  return {
    ...fields,
    rating,
    ratingCount,
    installsOrUsers: item ? numeric(item[14]) : bucket(installsLabel),
    installsLabel,
    version: detail(html, "Version") ?? fields.version,
    storeUpdatedAt: detail(html, "Updated") ?? fields.storeUpdatedAt,
  };
}

export function parseFirefoxAddons(body: string, listingId: string): Fields {
  const app = record(JSON.parse(body));
  if (app.slug !== listingId)
    throw new Error("Firefox add-on identity mismatch");
  const ratings = record(app.ratings),
    users = numeric(app.users),
    daily = numeric(app.average_daily_users);
  return {
    rating: numeric(ratings.average),
    ratingCount: numeric(ratings.count),
    installsOrUsers: users ?? daily,
    installsLabel:
      users !== null
        ? `${users} users`
        : daily !== null
          ? `${daily} average daily users`
          : null,
    averageDailyUsers: daily,
  };
}

export function parseVscodeMarketplace(html: string): Fields {
  challenge(html);
  const installs = html.match(
    /class=["'][^"']*\b(?:ux-item-)?installs-text\b[^"']*["'][^>]*>([\s\S]*?)<\//i,
  )?.[1];
  const ratingCount = html.match(
    /class=["'][^"']*\bux-item-rating-count\b[^"']*["'][^>]*>\s*\(?\s*<span[^>]*>([\d,]+)<\/span>/i,
  )?.[1];
  const rating = html.match(
    /(?:title|aria-label)=["']Average rating:\s*([\d.]+) out of 5/i,
  )?.[1];
  if (!installs) throw new Error("VS Code Marketplace install counter missing");
  const installsLabel = visible(installs);
  return {
    installsOrUsers: numeric(installsLabel.match(/[\d,]+/)?.[0]),
    installsLabel,
    rating: numeric(rating),
    ratingCount: numeric(ratingCount),
  };
}

// One sequential collector, one request at a time. Apple documents ~20 calls/minute,
// so use 3.1 seconds there; all other stores wait at least one second, including redirects.
const lastRequest = new Map<Store, number>();
async function fetchStore(store: Store, raw: string, accept = "text/html") {
  let url = raw;
  for (let hop = 0; ; hop++) {
    await delay(
      Math.max(
        0,
        (lastRequest.get(store) ?? 0) +
          (store === "app_store" ? 3100 : 1100) -
          Date.now(),
      ),
    );
    lastRequest.set(store, Date.now());
    try {
      return { ...(await publicFetch(url, 5_000_000, undefined, accept)), url };
    } catch (e) {
      // Same-site, bounded redirects only; each hop is independently DNS-pinned.
      if (
        hop < 3 &&
        e instanceof SourceHttpError &&
        [301, 302, 303, 307, 308].includes(e.status) &&
        e.location
      ) {
        const next = publicUrl.parse(new URL(e.location, url).href);
        if (siteOf(new URL(next).hostname) === siteOf(new URL(raw).hostname)) {
          url = next;
          continue;
        }
      }
      throw e;
    }
  }
}

export async function fetchStoreStats(
  listingUrl: string,
): Promise<StoreSnapshot> {
  const listing = storeListing(listingUrl);
  let url = listing.listingUrl;
  switch (listing.store) {
    case "app_store":
      url = `https://itunes.apple.com/lookup?id=${listing.externalId}&country=us`;
      break;
    case "google_play":
      url += "&hl=en&gl=us";
      break;
    case "chrome_web_store":
      url += "?hl=en";
      break;
    case "firefox_addons":
      url = `https://addons.mozilla.org/api/v5/addons/addon/${listing.externalId}/`;
      break;
  }
  const source = await fetchStore(
    listing.store,
    url,
    listing.store === "app_store" || listing.store === "firefox_addons"
      ? "application/json"
      : "text/html",
  );
  const hash = createHash("sha256").update(source.body);
  if (
    ["google_play", "chrome_web_store", "vscode_marketplace"].includes(
      listing.store,
    ) &&
    storeListing(source.url).externalId !== listing.externalId
  )
    throw new Error("Store redirected to another listing");
  let fields: Fields;
  switch (listing.store) {
    case "app_store": {
      // Use the lookup's canonical US page to obtain the publicly displayed IAP list.
      const app = record(
        (
          record(JSON.parse(source.text)).results as unknown[] | undefined
        )?.find((v) => String(record(v).trackId) === listing.externalId),
      );
      const pageUrl = text(app.trackViewUrl);
      if (
        !pageUrl ||
        storeListing(pageUrl).externalId !== listing.externalId ||
        new URL(pageUrl).hostname !== "apps.apple.com"
      )
        throw new Error("App Store listing URL missing or mismatched");
      const page = await fetchStore(listing.store, pageUrl);
      // For Apple this is the hash of lookup bytes followed by listing-page bytes.
      hash.update(page.body);
      fields = parseAppStore(source.text, listing.externalId, page.text);
      break;
    }
    case "google_play":
      fields = parseGooglePlay(source.text, listing.externalId);
      break;
    case "chrome_web_store":
      fields = parseChromeWebStore(source.text, listing.externalId);
      break;
    case "firefox_addons":
      fields = parseFirefoxAddons(source.text, listing.externalId);
      break;
    case "vscode_marketplace":
      fields = parseVscodeMarketplace(source.text);
      break;
  }
  const snapshot = storeSnapshotInput.parse({
    status: "ok",
    ...fields,
    rawSha256: hash.digest("hex"),
  });
  if (snapshot.status !== "ok") throw new Error("No store observations");
  return snapshot;
}

export async function collectStoreStats(limit = 50) {
  if (!collectorToken) throw new Error("Collector credential required");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error("Store limit must be 1–50");
  const { items } = await api<{
    items: { id: string; listing_url: string; store: Store }[];
  }>(`/api/v1/collector/store-stats/pending?limit=${limit}`, {
    token: collectorToken,
  });
  let saved = 0,
    failed = 0;
  // Stop contacting a store after its first error/challenge in this run. Other stores
  // can finish, and failed listings won't be due again for at least 20 hours.
  const blocked = new Set<Store>();
  for (const listing of items) {
    if (blocked.has(listing.store)) continue;
    let snapshot: StoreSnapshot | { status: "failed"; reason: string };
    try {
      snapshot = await fetchStoreStats(listing.listing_url);
    } catch (e) {
      snapshot = {
        status: "failed",
        reason: (e instanceof SourceHttpError
          ? `Store returned HTTP ${e.status}`
          : e instanceof Error
            ? e.message
            : "Store fetch failed"
        ).slice(0, 300),
      };
      blocked.add(listing.store);
    }
    // A backend write error propagates; it must never be mislabeled a store failure.
    await api(
      `/api/v1/collector/store-stats/${encodeURIComponent(listing.id)}/snapshot`,
      { method: "POST", token: collectorToken, body: snapshot },
    );
    if (snapshot.status === "ok") saved++;
    else failed++;
  }
  return {
    storeStatsSaved: saved,
    storeStatsFailed: failed,
    storeStatsSkipped: items.length - saved - failed,
  };
}
