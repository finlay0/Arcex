import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  registerWatch,
  recordScan,
  recordAdSighting,
  recordCreatorMention,
  distributionStatus,
  creatorMentionInput,
  recordLaunchSnapshot,
  recordGoogleAd,
  recordShortForm,
  shortFormInput,
} from "../src/distribution";
import { insertEvidence } from "../src/catalog";

test("distribution tracking separates per-ad sightings, blocked searches and disclosed creator links", async () => {
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
    const watch = await registerWatch(db, {
      productId: "p",
      platform: "meta",
      country: "ALL",
    });
    const again = await registerWatch(db, {
      productId: "p",
      platform: "meta",
      country: "ALL",
    });
    assert.equal(watch.id, again.id);
    const url = String(watch.searchUrl);
    assert.equal(new URL(url).hostname, "www.facebook.com");
    assert.equal(new URL(url).searchParams.get("q"), "tiny-fixture.com");
    assert.equal(
      (await db
        .prepare("SELECT count(*) n FROM sources")
        .first<{ n: number }>())!.n,
      1,
    );
    const first = {
      productId: "p",
      observedAt: "2026-10-01T01:00:00.000Z",
      contentHash: "a".repeat(64),
      destinationUrl: "https://tiny-fixture.com/pricing",
      summary:
        "Observed an active library card linking to the product pricing page",
      libraryId: "1234567890123",
      advertiserName: "Tiny Fixture",
      country: "ALL",
      activity: "active" as const,
      creativeText: "Observed creative",
    };
    await assert.rejects(
      recordAdSighting(db, {
        ...first,
        destinationUrl: "https://unrelated-fixture.com",
      }),
      /match the product domain/,
    );
    const a = await recordAdSighting(db, first);
    await recordAdSighting(db, {
      ...first,
      observedAt: "2026-10-01T08:00:00.000Z",
    });
    await recordAdSighting(db, {
      ...first,
      observedAt: "2026-10-15T08:00:00.000Z",
    });
    await recordAdSighting(db, {
      ...first,
      observedAt: "2026-10-15T08:00:00.000Z",
    });
    await recordAdSighting(db, {
      ...first,
      libraryId: "9999999999999",
      observedAt: "2026-10-03T08:00:00.000Z",
      contentHash: "b".repeat(64),
    });
    const blocked = await insertEvidence(db, {
      productId: "p",
      sourceUrl: url,
      observedAt: "2026-10-16T08:00:00.000Z",
      kind: "manual",
      contentHash: "c".repeat(64),
      summary:
        "Meta displayed an access challenge; ad results could not be examined",
      payload: {},
    });
    await recordScan(db, {
      watchId: String(watch.id),
      evidenceId: blocked.id,
      observedAt: "2026-10-16T08:00:00.000Z",
      outcome: "blocked",
      notes: "No challenge bypass attempted. Coverage unavailable.",
    });
    const privateStatus = await distributionStatus(db, "p");
    const ad = privateStatus.ads.find(
      (x) => x.external_id === "meta:" + first.libraryId,
    )!;
    assert.equal(ad.observed_active_days, 2);
    assert.equal(ad.last_reported_state, "active");
    assert.equal(privateStatus.watches![0].last_outcome, "blocked");
    assert.equal((await distributionStatus(db, "p", true)).ads.length, 0);
    await db
      .prepare("UPDATE evidence SET status='approved' WHERE id=?")
      .bind(a.evidenceId)
      .run();
    assert.equal((await distributionStatus(db, "p", true)).ads.length, 1);
    await recordAdSighting(db, {
      ...first,
      observedAt: "2026-10-17T08:00:00.000Z",
      activity: "inactive",
      contentHash: "d".repeat(64),
    });
    const after = (await distributionStatus(db, "p")).ads.find(
      (x) => x.external_id === "meta:" + first.libraryId,
    )!;
    assert.equal(after.observed_active_days, 2);
    assert.equal(after.last_reported_state, "inactive");
    assert.equal(
      (await distributionStatus(db, "p", true)).ads[0].last_reported_state,
      "active",
    );
    const creator = {
      productId: "p",
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      observedAt: "2026-10-18T08:00:00.000Z",
      contentHash: "e".repeat(64),
      destinationUrl: "https://tiny-fixture.com/?ref=creator",
      summary:
        "Observed a product link in this video description; paid status not established",
      creator: "Fixture creator",
      placement: "unknown" as const,
      disclosureQuote: "",
    };
    assert.equal(
      creatorMentionInput.safeParse({ ...creator, placement: "sponsored" })
        .success,
      false,
    );
    assert.equal(
      creatorMentionInput.safeParse({
        ...creator,
        sourceUrl: "https://www.youtube.com/results?search_query=fixture",
      }).success,
      false,
    );
    const mention = await recordCreatorMention(
      db,
      creatorMentionInput.parse(creator),
    );
    assert.equal(mention.status, "draft");
    const signal = await db
      .prepare(
        "SELECT detail FROM distribution_signals WHERE kind='creator_mention'",
      )
      .first<{ detail: string }>();
    assert.equal(JSON.parse(signal!.detail).placement, "unknown");
    const unrelated = await insertEvidence(db, {
      productId: "p",
      sourceUrl: "https://tiny-fixture.com",
      observedAt: "2026-10-18T08:00:00.000Z",
      kind: "page",
      contentHash: "f".repeat(64),
      summary: "Product page is not Meta search evidence",
      payload: {},
    });
    await assert.rejects(
      recordScan(db, {
        watchId: String(watch.id),
        evidenceId: unrelated.id,
        observedAt: "2026-10-18T08:00:00.000Z",
        outcome: "no_results",
        notes: "Wrong URL must fail",
      }),
      /exact watch search URL/,
    );
    const google = await registerWatch(db, {
      productId: "p",
      platform: "google",
      country: "ALL",
    });
    assert.equal(
      new URL(String(google.searchUrl)).searchParams.get("domain"),
      "tiny-fixture.com",
    );
    const googleAd = await recordGoogleAd(db, {
      ...first,
      advertiserId: "AR123456789",
      creativeId: "CR123456789",
      format: "video",
      creativeText: "Observed Google creative",
      observedAt: "2026-10-19T08:00:00.000Z",
    });
    assert.match(googleAd.sourceUrl, /adstransparency\.google\.com/);
    const launch = {
      productId: "p",
      sourceUrl: "https://github.com/tiny-fixture/app",
      observedAt: "2026-10-20T00:00:00.000Z",
      contentHash: "1".repeat(64),
      destinationUrl: first.destinationUrl,
      summary:
        "Observed public repository star count, no user or revenue claims",
      platform: "github" as const,
      metric: "stars" as const,
      count: 20,
    };
    const snapshot = await recordLaunchSnapshot(db, launch);
    const baseline = (await distributionStatus(db, "p")).launchVelocity[0];
    assert.equal(baseline.change, null);
    assert.equal(baseline.countPerHour, null);
    await recordLaunchSnapshot(db, {
      ...launch,
      observedAt: "2026-10-21T00:00:00.000Z",
      contentHash: "2".repeat(64),
      count: 68,
    });
    const velocity = (await distributionStatus(db, "p")).launchVelocity[0];
    assert.equal(velocity.change, 48);
    assert.equal(velocity.countPerHour, 2);
    assert.equal(
      (await distributionStatus(db, "p", true)).launchVelocity.length,
      0,
    );
    await db
      .prepare("UPDATE evidence SET status='approved' WHERE id=?")
      .bind(snapshot.evidenceId)
      .run();
    assert.equal(
      (await distributionStatus(db, "p", true)).launchVelocity[0].countPerHour,
      null,
    );
    const clip = {
      productId: "p",
      sourceUrl: "https://www.youtube.com/shorts/abcdefghijk",
      observedAt: "2026-10-21T01:00:00.000Z",
      contentHash: "3".repeat(64),
      destinationUrl: first.destinationUrl,
      summary: "Observed a creator demo clip with a product link",
      platform: "youtube_shorts" as const,
      creator: "Fixture creator",
      hookStyle: "Product demo",
      observedHookQuote: "Watch this turn a note into a demo",
      counts: { views: 200 },
    };
    assert.equal(
      shortFormInput.safeParse({
        ...clip,
        sourceUrl: "https://www.youtube.com/results?search_query=demo",
      }).success,
      false,
    );
    assert.equal(
      (await recordShortForm(db, shortFormInput.parse(clip))).status,
      "draft",
    );
  } finally {
    await mf.dispose();
  }
});
