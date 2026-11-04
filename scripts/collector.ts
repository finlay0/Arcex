import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { api, collectorToken } from "./client";
import { publicFetch, SourceHttpError } from "./public-fetch";
import { publicUrl, evidenceInput } from "../src/contracts";

type Job = {
  id: string;
  leaseToken: string;
  source: {
    id: string;
    url: string;
    kind: "public_page" | "rss";
    product_id: string | null;
    last_fingerprint: string | null;
    http_etag: string | null;
    http_last_modified: string | null;
  };
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const strip = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export function pageEvidence(
  url: string,
  text: string,
  headers: Record<string, string>,
) {
  const title = strip(
    text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "Untitled page",
  ).slice(0, 500);
  const metaTags = Array.from(text.matchAll(/<meta\b[^>]*>/gi)).map(
    (m) => m[0],
  );
  const descriptionTag = metaTags.find((t) =>
    /(?:name|property)\s*=\s*["'](?:description|og:description)["']/i.test(t),
  );
  const description = strip(
    descriptionTag?.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? "",
  ).slice(0, 2000);
  const headings = Array.from(
    text.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi),
  )
    .slice(0, 20)
    .map((m) => strip(m[1]).slice(0, 300));
  const payload = {
    title,
    description,
    headings,
    headers,
    scope:
      "Public HTML metadata only. No authenticated funnel or paywall observed.",
  };
  return evidenceInput.omit({ productId: true }).parse({
    sourceUrl: url,
    observedAt: new Date().toISOString(),
    kind: "page",
    contentHash: digest(JSON.stringify({ title, description, headings })),
    summary: `${title}${description ? " — " + description : ""}`,
    payload,
  });
}
export function rssEvidence(url: string, text: string) {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
  }).parse(text) as Record<string, unknown>;
  const root = z
    .object({
      rss: z.object({ channel: z.object({ item: z.unknown() }) }).optional(),
      feed: z.object({ entry: z.unknown() }).optional(),
    })
    .parse(parsed);
  const entries = root.rss?.channel.item ?? root.feed?.entry ?? [];
  return (Array.isArray(entries) ? entries : [entries])
    .slice(0, 20)
    .flatMap((raw: unknown) => {
      const entry = z.record(z.string(), z.unknown()).safeParse(raw);
      if (!entry.success) return [];
      const value = entry.data;
      const links = Array.isArray(value.link) ? value.link : [value.link];
      const article = links
        .map((l) =>
          typeof l === "string"
            ? l
            : typeof l === "object" && l !== null
              ? (l as Record<string, unknown>)["@_href"]
              : null,
        )
        .find((l) => typeof l === "string" && publicUrl.safeParse(l).success);
      if (typeof article !== "string") return [];
      const title = strip(String(value.title ?? "Untitled feed entry")).slice(
        0,
        500,
      );
      const published = String(
        value.pubDate ?? value.published ?? value.updated ?? "",
      );
      const payload = {
        title,
        publishedAtFromFeed: published,
        feedUrl: url,
        scope:
          "Publisher RSS entry; not verified sponsorship or commercial traction.",
      };
      return [
        evidenceInput.omit({ productId: true }).parse({
          sourceUrl: article,
          observedAt: new Date().toISOString(),
          kind: "rss_item",
          contentHash: digest(JSON.stringify(payload)),
          summary: title,
          payload,
        }),
      ];
    });
}
export async function collect(limit = 5) {
  if (!collectorToken)
    throw new Error("Configure ARCEX_COLLECTOR_TOKEN or COLLECTOR_TOKEN");
  let completed = 0,
    failed = 0;
  for (let i = 0; i < limit; i++) {
    const { job } = await api<{ job: Job | null }>(
      "/api/v1/collector/jobs/claim",
      {
        method: "POST",
        token: collectorToken,
        body: { kinds: ["public_page", "rss"] },
      },
    );
    if (!job) break;
    try {
      const validators = job.source.last_fingerprint
        ? {
            etag: job.source.http_etag,
            lastModified: job.source.http_last_modified,
          }
        : undefined;
      const result = await publicFetch(job.source.url, 1_000_000, validators);
      if (result.status === 304 && job.source.last_fingerprint) {
        await api(`/api/v1/collector/jobs/${job.id}/complete`, {
          method: "POST",
          token: collectorToken,
          body: {
            leaseToken: job.leaseToken,
            outcome: "unchanged",
            fingerprint: job.source.last_fingerprint,
          },
        });
        completed++;
        console.log(JSON.stringify({ jobId: job.id, status: "not_modified" }));
        continue;
      }
      const evidence =
        job.source.kind === "rss"
          ? rssEvidence(job.source.url, result.text)
          : [pageEvidence(job.source.url, result.text, result.headers)];
      if (!evidence.length)
        throw new Error("No usable feed items; source requires review");
      if (
        job.source.kind === "public_page" &&
        !result.contentType.includes("text/html")
      )
        throw new Error("Expected an HTML public page");
      const fingerprint = digest(
        JSON.stringify(
          evidence.map((e) => [e.sourceUrl, e.contentHash]).sort(),
        ),
      );
      const unchanged = fingerprint === job.source.last_fingerprint;
      await api(`/api/v1/collector/jobs/${job.id}/complete`, {
        method: "POST",
        token: collectorToken,
        body: {
          leaseToken: job.leaseToken,
          evidence: unchanged ? [] : evidence,
          outcome: unchanged ? "unchanged" : "observed",
          fingerprint,
          httpCache: result.httpCache,
        },
      });
      completed++;
      console.log(
        JSON.stringify({
          jobId: job.id,
          status: "succeeded",
          drafts: unchanged ? 0 : evidence.length,
        }),
      );
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "Collection failed";
      await api(`/api/v1/collector/jobs/${job.id}/fail`, {
        method: "POST",
        token: collectorToken,
        body: {
          leaseToken: job.leaseToken,
          error: reason.slice(0, 2000),
          blocked:
            error instanceof SourceHttpError &&
            [401, 403].includes(error.status),
        },
      });
      failed++;
      console.error(
        JSON.stringify({ jobId: job.id, status: "failed", reason }),
      );
    }
  }
  return { completed, failed };
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/collector.ts")) {
  const count = Number(process.argv[2] ?? 5);
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new Error("Job limit must be 1–100");
  const result = await collect(count);
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
}
