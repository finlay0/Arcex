import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  collectYoutubeMentions,
  sponsorBlockSegments,
  matchingDescriptionLinks,
} from "../src/external-signals";
import { clientStackSignatures } from "../src/stack-signatures";
import type { Bindings } from "../src/types";

test("official YouTube collection filters outbound domains, caches results and surfaces provider denial", async (t) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ["DB"],
      compatibilityDate: "2026-11-03",
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      for (const sql of (await readFile("migrations/" + file, "utf8"))
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await db.prepare(sql).run();
    await db
      .prepare(
        "INSERT INTO products(id,slug,name,url,domain,description,category,monetization,created_at,updated_at) VALUES ('p','tiny-fixture','Tiny fixture','https://tiny-fixture.com','tiny-fixture.com','fixture','other','unknown',?,?)",
      )
      .bind(new Date().toISOString(), new Date().toISOString())
      .run();
    let calls = 0,
      denied = false;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        calls++;
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (url.hostname === "sponsor.ajay.app")
          return Response.json([
            {
              segment: [10, 30],
              category: "sponsor",
              UUID: "fixture",
              votes: 5,
            },
          ]);
        assert.equal(url.hostname, "www.googleapis.com");
        assert.equal(
          new Headers(init?.headers).get("X-Goog-Api-Key"),
          "fixture-key",
        );
        assert.equal(url.searchParams.has("key"), false);
        if (denied)
          return Response.json(
            { error: { message: "fixture denied" } },
            { status: 403 },
          );
        if (url.pathname.endsWith("/search"))
          return Response.json({
            items: [
              { id: { videoId: "abcdefghijk" } },
              { id: { videoId: "lmnopqrstuv" } },
            ],
          });
        assert.equal(url.searchParams.get("part"), "snippet,statistics");
        return Response.json({
          items: [
            {
              id: "abcdefghijk",
              snippet: {
                title: "Creator demo",
                description: "Try https://tiny-fixture.com/?ref=demo",
                channelId: "channel",
                channelTitle: "Creator",
                publishedAt: "2026-01-01T00:00:00Z",
              },
              statistics: { viewCount: "400", likeCount: "15" },
            },
            {
              id: "lmnopqrstuv",
              snippet: {
                title: "Unrelated demo",
                description: "Try https://tiny-fixture.com.evil.com",
                channelId: "other",
                channelTitle: "Other creator",
                publishedAt: "2026-01-01T00:00:00Z",
              },
            },
          ],
        });
      },
    );
    const env = { DB: db, YOUTUBE_API_KEY: "fixture-key" } as Bindings;
    const result = await collectYoutubeMentions(env, {
      productId: "p",
      publishedAfter: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(result.mentions.length, 1);
    assert.equal(calls, 2);
    await collectYoutubeMentions(env, {
      productId: "p",
      publishedAfter: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(calls, 2);
    const e = await db
      .prepare("SELECT status,payload FROM evidence")
      .first<{ status: string; payload: string }>();
    assert.equal(e!.status, "draft");
    assert.equal(JSON.parse(e!.payload).placement, "unknown");
    denied = true;
    await assert.rejects(
      collectYoutubeMentions(env, {
        productId: "p",
        publishedAfter: "2026-01-02T00:00:00.000Z",
      }),
      /403/,
    );
    await assert.rejects(
      collectYoutubeMentions(
        { ...env, YOUTUBE_API_KEY: undefined },
        { productId: "p" },
      ),
      /not configured/,
    );
    await db
      .prepare(
        "UPDATE rate_limits SET hits=25 WHERE key LIKE 'youtube-search-daily:%'",
      )
      .run();
    const beforeLimit = calls;
    await assert.rejects(
      collectYoutubeMentions(env, {
        productId: "p",
        publishedAfter: "2026-01-03T00:00:00.000Z",
      }),
      /Rate limit exceeded/,
    );
    assert.equal(calls, beforeLimit);
    await assert.rejects(
      sponsorBlockSegments(env, "abcdefghijk"),
      /disabled pending permission/,
    );
    const segment = await sponsorBlockSegments(
      { ...env, SPONSORBLOCK_LICENSE_APPROVED: "true" },
      "abcdefghijk",
    );
    assert.equal(segment.segments[0].startSeconds, 10);
    assert.match(segment.scope, /identity.*unverified/);
    assert.deepEqual(
      matchingDescriptionLinks(
        "https://tiny-fixture.com.evil.com https://app.tiny-fixture.com/pricing)",
        "tiny-fixture.com",
      ),
      ["https://app.tiny-fixture.com/pricing"],
    );
  } finally {
    await mf.dispose();
  }
});

test("client stack signatures omit credentials and do not trust lookalike provider hosts", () => {
  const result = clientStackSignatures([
    "https://tiny-fixture.com/_next/static/a.js?token=do-not-store",
    "https://js.stripe.com/v3/?client_secret=do-not-store",
    "https://notstripe.com/v3",
    "https://project.supabase.co/rest/v1/table?apikey=do-not-store",
  ]);
  assert.deepEqual(
    result.signatures.map((x) => x.technology),
    ["Next.js", "Stripe", "Supabase"],
  );
  assert.ok(!JSON.stringify(result).includes("do-not-store"));
  assert.ok(!JSON.stringify(result).includes("notstripe.com"));
});
