import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Bindings } from "./types";
import { requireAdmin } from "./auth";
import { fail, parse, rateLimit, sha256 } from "./lib";
import { now } from "./types";
import { id, timestamp, publicUrl } from "./contracts";
import { insertEvidence } from "./catalog";

export const youtubeCollectionInput = z
  .object({ productId: id, publishedAfter: timestamp.optional() })
  .strict();
export const sponsorBlockInput = z
  .object({ videoId: z.string().regex(/^[\w-]{11}$/) })
  .strict();
async function jsonFetch(url: URL, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
    redirect: "manual",
  });
  if (response.status === 404 && url.hostname === "sponsor.ajay.app") return [];
  if (!response.ok)
    fail(
      502,
      `Signal provider returned HTTP ${response.status}; collection failed`,
    );
  if (Number(response.headers.get("content-length") ?? 0) > 1_000_000)
    fail(502, "Signal provider response exceeded limit");
  const reader = response.body?.getReader();
  if (!reader) fail(502, "Signal provider returned no body");
  let size = 0,
    text = "";
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1_000_000) {
      await reader.cancel();
      fail(502, "Signal provider response exceeded limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail(502, "Signal provider returned invalid JSON");
  }
}
async function cached<T>(
  env: Bindings,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  await env.DB.prepare("DELETE FROM provider_cache WHERE expires_at<=?")
    .bind(now())
    .run();
  const hit = await env.DB.prepare(
    "SELECT payload FROM provider_cache WHERE cache_key=? AND expires_at>?",
  )
    .bind(key, now())
    .first<{ payload: string }>();
  if (hit) return JSON.parse(hit.payload) as T;
  const data = await load();
  await env.DB.prepare(
    "INSERT INTO provider_cache VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at",
  )
    .bind(
      key,
      JSON.stringify(data),
      new Date(Date.now() + 86400000).toISOString(),
    )
    .run();
  return data;
}
export async function sponsorBlockSegments(env: Bindings, videoId: string) {
  if (env.SPONSORBLOCK_LICENSE_APPROVED !== "true")
    fail(
      503,
      "SponsorBlock import is disabled pending permission for Arcex commercial use; its database/API license is CC BY-NC-SA 4.0",
    );
  return cached(env, "sponsorblock:" + videoId, async () => {
    await rateLimit(env.DB, "sponsorblock-daily", 100, 86400);
    const url = new URL("https://sponsor.ajay.app/api/skipSegments");
    url.searchParams.set("videoID", videoId);
    url.searchParams.set("categories", JSON.stringify(["sponsor"]));
    const data = z
      .array(
        z
          .object({
            segment: z.tuple([z.number().min(0), z.number().min(0)]),
            category: z.string(),
            UUID: z.string(),
            votes: z.number().optional(),
          })
          .passthrough(),
      )
      .max(100)
      .parse(await jsonFetch(url));
    return {
      videoId,
      segments: data
        .filter((s) => s.category === "sponsor" && s.segment[1] > s.segment[0])
        .map((s) => ({
          startSeconds: s.segment[0],
          endSeconds: s.segment[1],
          uuid: s.UUID,
          votes: s.votes,
        })),
      observedAt: now(),
      sourceUrl: url.href,
      attribution:
        "SponsorBlock community database (CC BY-NC-SA 4.0); https://sponsor.ajay.app",
      scope:
        "Community-reported sponsor segment locations. Sponsor identity and relationship to this product are unverified; no automatic attribution.",
    };
  });
}
const videoSchema = z.object({
  id: z.string().regex(/^[\w-]{11}$/),
  snippet: z.object({
    title: z.string(),
    description: z.string(),
    channelId: z.string(),
    channelTitle: z.string(),
    publishedAt: z.string(),
  }),
  statistics: z
    .object({
      viewCount: z.string().optional(),
      likeCount: z.string().optional(),
      commentCount: z.string().optional(),
    })
    .optional(),
});
export function matchingDescriptionLinks(description: string, domain: string) {
  return [
    ...new Set(
      (description.match(/https?:\/\/[^\s<>"']+/g) ?? [])
        .map((s) => s.replace(/[),.;!?]+$/g, ""))
        .filter((s) => {
          if (!publicUrl.safeParse(s).success) return false;
          const host = new URL(s).hostname.replace(/^www\./, "");
          return host === domain || host.endsWith("." + domain);
        }),
    ),
  ];
}
export async function collectYoutubeMentions(
  env: Bindings,
  input: z.infer<typeof youtubeCollectionInput>,
) {
  if (!env.YOUTUBE_API_KEY)
    fail(
      503,
      "YouTube Data API key is not configured; use the Work cloud browser instead",
    );
  const p = await env.DB.prepare(
    "SELECT domain FROM products WHERE id=? AND status!='archived'",
  )
    .bind(input.productId)
    .first<{ domain: string }>();
  if (!p) fail(404, "Active product not found");
  const after =
    input.publishedAfter ?? new Date(Date.now() - 30 * 86400000).toISOString();
  return cached(
    env,
    "youtube:" + input.productId + ":" + after.slice(0, 10),
    async () => {
      await rateLimit(env.DB, "youtube-search-daily", 25, 86400);
      const search = new URL("https://www.googleapis.com/youtube/v3/search");
      search.search = new URLSearchParams({
        part: "snippet",
        type: "video",
        q: '"' + p.domain + '"',
        order: "date",
        maxResults: "20",
        publishedAfter: after,
      }).toString();
      const headers = { "X-Goog-Api-Key": env.YOUTUBE_API_KEY! };
      const result = z
        .object({
          items: z
            .array(
              z.object({
                id: z.object({ videoId: z.string().regex(/^[\w-]{11}$/) }),
              }),
            )
            .max(20),
          nextPageToken: z.string().optional(),
        })
        .parse(await jsonFetch(search, headers));
      const ids = result.items.map((v) => v.id.videoId);
      if (!ids.length)
        return {
          candidates: 0,
          mentions: [],
          observedAt: now(),
          scope:
            "No results for one bounded domain search; not proof of no creator coverage",
        };
      await rateLimit(env.DB, "youtube-video-daily", 1000, 86400);
      const videos = new URL("https://www.googleapis.com/youtube/v3/videos");
      videos.search = new URLSearchParams({
        part: "snippet,statistics",
        id: ids.join(","),
      }).toString();
      const data = z
          .object({ items: z.array(videoSchema).max(20) })
          .parse(await jsonFetch(videos, headers)),
        observedAt = now();
      const mentions = [];
      for (const video of data.items) {
        const links = matchingDescriptionLinks(
          video.snippet.description,
          p.domain,
        );
        if (!links.length) continue;
        const sourceUrl = "https://www.youtube.com/watch?v=" + video.id;
        const payload = {
          ...video,
          links,
          placement: "unknown",
          scope:
            "Direct product-domain link in public video description; not automatically a sponsorship. Shortened links and search omissions require browser review.",
        };
        const evidence = await insertEvidence(env.DB, {
          productId: input.productId,
          sourceUrl,
          observedAt,
          kind: "video",
          contentHash: await sha256(JSON.stringify(video)),
          summary:
            `Observed description link to ${p.domain}: ${video.snippet.title}`.slice(
              0,
              4000,
            ),
          payload,
        });
        await env.DB.prepare(
          "INSERT INTO distribution_signals VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        )
          .bind(
            crypto.randomUUID(),
            input.productId,
            evidence.id,
            "creator_mention",
            "youtube:" + video.id,
            observedAt,
            sourceUrl,
            JSON.stringify({
              creator: video.snippet.channelTitle,
              destinationUrl: links[0],
              placement: "unknown",
              videoMetadata: video,
            }),
          )
          .run();
        mentions.push({
          videoId: video.id,
          evidenceId: evidence.id,
          status: evidence.status,
          links,
          statistics: video.statistics ?? {},
        });
      }
      return {
        candidates: ids.length,
        mentions,
        observedAt,
        moreResultsAvailable: Boolean(result.nextPageToken),
        scope:
          "One search page, at most 20 videos. Public descriptions and statistics require videos.list, not search.list alone. No paid relationship inferred.",
      };
    },
  );
}
export const externalSignalsAdmin = new Hono<AppEnv>();
externalSignalsAdmin.use("*", requireAdmin);
externalSignalsAdmin.post("/distribution/youtube/collect", async (c) =>
  c.json(
    await collectYoutubeMentions(c.env, await parse(c, youtubeCollectionInput)),
  ),
);
externalSignalsAdmin.post("/distribution/sponsorblock", async (c) =>
  c.json(
    await sponsorBlockSegments(
      c.env,
      (await parse(c, sponsorBlockInput)).videoId,
    ),
  ),
);
