import sharp from "sharp";
import { api, collectorToken } from "./client";
import { fetchFollow, SourceHttpError } from "./public-fetch";
import { publicUrl } from "../src/contracts";
import { ICON_MAX_BYTES, ICON_SIZE, validIcon } from "../src/icon-format";

const HTML_LIMIT = 3_000_000,
  IMAGE_LIMIT = 300_000,
  MIN_SOURCE_PIXELS = 32;

const attr = (tag: string, name: string) =>
  tag
    .match(
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
    )
    ?.slice(1)
    .find((v) => v !== undefined)
    ?.replace(/&amp;/g, "&");

/** Icon candidates from the page's own markup, best first, then the conventional paths. */
export function iconCandidates(html: string, pageUrl: string) {
  const head = html.slice(0, 200_000);
  const found: { href: string; score: number }[] = [];
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    const href = attr(tag, "href");
    if (!href || href.startsWith("data:")) continue;
    const type = (attr(tag, "type") ?? "").toLowerCase();
    const size = Math.max(
      0,
      ...(attr(tag, "sizes") ?? "")
        .split(/\s+/)
        .map((s) => Number(s.toLowerCase().split("x")[0]) || 0),
    );
    let score = 0;
    if (
      rel.includes("apple-touch-icon") ||
      rel.includes("apple-touch-icon-precomposed")
    )
      score = 300 + Math.min(size || 180, 512);
    else if (rel.includes("icon")) {
      const svg = type.includes("svg") || /\.svg(\?|$)/i.test(href);
      score = svg ? 250 : 100 + Math.min(size || 16, 512);
    } else if (rel.includes("mask-icon")) continue;
    else continue;
    found.push({ href, score });
  }
  const origin = new URL(pageUrl).origin;
  const urls = found
    .sort((a, b) => b.score - a.score)
    .map((c) => {
      try {
        return new URL(c.href, pageUrl).href;
      } catch {
        return null;
      }
    })
    .filter((u): u is string => !!u && publicUrl.safeParse(u).success);
  urls.push(origin + "/apple-touch-icon.png", origin + "/favicon.ico");
  return [...new Set(urls)].slice(0, 6);
}

/** Extract the largest PNG image stored inside an .ico file; BMP entries are skipped. */
function pngFromIco(bytes: Buffer) {
  if (
    bytes.length < 6 ||
    bytes.readUInt16LE(0) !== 0 ||
    bytes.readUInt16LE(2) !== 1
  )
    return null;
  let best: Buffer | null = null,
    bestSize = 0;
  const count = Math.min(bytes.readUInt16LE(4), 32);
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    if (at + 16 > bytes.length) break;
    const size = bytes[at] || 256,
      length = bytes.readUInt32LE(at + 8),
      offset = bytes.readUInt32LE(at + 12);
    if (offset + length > bytes.length || length < 8) continue;
    const entry = bytes.subarray(offset, offset + length);
    if (entry.readUInt32BE(0) === 0x89504e47 && size > bestSize) {
      best = entry;
      bestSize = size;
    }
  }
  return best;
}

function safeSvg(bytes: Buffer) {
  const text = bytes.toString("utf8");
  // Rendering must stay self-contained: no entities, scripts or external references.
  return !/<!ENTITY|<!DOCTYPE|<script|<foreignObject|<image\b|(?:xlink:)?href\s*=\s*["'](?!#)/i.test(
    text,
  );
}

export async function makeIcon(bytes: Buffer, contentType: string) {
  let input: Buffer = bytes;
  const isSvg =
    contentType.includes("svg") ||
    bytes.subarray(0, 300).toString("utf8").includes("<svg");
  if (isSvg) {
    if (bytes.length > 100_000 || !safeSvg(bytes)) return null;
  } else if (bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) {
    const png = pngFromIco(bytes);
    if (!png) return null;
    input = png;
  }
  const image = sharp(input, {
    limitInputPixels: 4_194_304,
    animated: false,
    density: isSvg ? 288 : undefined,
  });
  const meta = await image.metadata();
  if (!isSvg && Math.min(meta.width ?? 0, meta.height ?? 0) < MIN_SOURCE_PIXELS)
    return null;
  for (const quality of [88, 75, 60]) {
    const out = await sharp(input, {
      limitInputPixels: 4_194_304,
      animated: false,
      density: isSvg ? 288 : undefined,
    })
      .resize(ICON_SIZE, ICON_SIZE, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality, alphaQuality: 90, effort: 5 })
      .toBuffer();
    if (out.length <= ICON_MAX_BYTES && validIcon(out)) return out;
  }
  return null;
}

export async function iconFor(productUrl: string) {
  // A blocked or oversized homepage still leaves the conventional icon paths to try.
  let candidates: string[],
    pageError: unknown = null;
  try {
    const page = await fetchFollow(productUrl, HTML_LIMIT, {
      accept: "text/html",
    });
    candidates = iconCandidates(page.text, page.url);
  } catch (error) {
    pageError = error;
    candidates = iconCandidates("", productUrl);
  }
  for (const candidate of candidates) {
    try {
      const image = await fetchFollow(candidate, IMAGE_LIMIT, {
        accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8",
      });
      if (!/image\/|octet-stream|^$/.test(image.contentType)) continue;
      const icon = await makeIcon(image.body, image.contentType);
      if (icon) return { icon, sourceUrl: image.url };
    } catch {
      // Try the next candidate; a single broken link is not a missing icon.
    }
  }
  if (pageError) throw pageError;
  return null;
}

export async function collectIcons(limit = 25) {
  if (!collectorToken) throw new Error("Collector credential required");
  const { items } = await api<{ items: { id: string; url: string }[] }>(
    `/api/v1/collector/icons/pending?limit=${limit}`,
    { token: collectorToken },
  );
  let saved = 0,
    missing = 0;
  for (const product of items) {
    let result: Awaited<ReturnType<typeof iconFor>> = null,
      reason = "No usable icon of at least 32px on the product site";
    try {
      result = await iconFor(product.url);
    } catch (error) {
      reason =
        error instanceof SourceHttpError
          ? `Product page returned HTTP ${error.status}`
          : "Product page could not be fetched";
    }
    await api(`/api/v1/collector/icons/${encodeURIComponent(product.id)}`, {
      method: "POST",
      token: collectorToken,
      body: result
        ? {
            status: "ok",
            sourceUrl: result.sourceUrl,
            data: result.icon.toString("base64"),
          }
        : { status: "missing", reason },
    });
    if (result) saved++;
    else missing++;
  }
  return {
    iconsChecked: items.length,
    iconsSaved: saved,
    iconsMissing: missing,
  };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/icons.ts")) {
  const count = Number(process.argv[2] ?? 25);
  if (!Number.isInteger(count) || count < 1 || count > 50)
    throw new Error("Icon limit must be 1–50");
  console.log(JSON.stringify(await collectIcons(count)));
}
