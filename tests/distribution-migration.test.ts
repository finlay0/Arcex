import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("Google watch migration preserves existing source and scan evidence relationships", async () => {
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
    const apply = async (file: string) => {
      for (const sql of (await readFile("migrations/" + file, "utf8"))
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await db.prepare(sql).run();
    };
    const files = (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files.filter((f) => f < "0006")) await apply(file);
    const time = "2026-01-01T00:00:00.000Z";
    await db
      .prepare(
        "INSERT INTO products(id,slug,name,url,domain,description,category,monetization,created_at,updated_at) VALUES ('p','fixture','Fixture','https://fixture.com','fixture.com','fixture','other','unknown',?,?)",
      )
      .bind(time, time)
      .run();
    await db
      .prepare(
        "INSERT INTO sources(id,product_id,name,url,kind,interval_hours,enabled,next_run_at,created_at) VALUES ('s','p','Meta fixture','https://www.facebook.com/ads/library/','browser',24,1,?,?)",
      )
      .bind(time, time)
      .run();
    await db
      .prepare(
        "INSERT INTO evidence(id,product_id,source_url,observed_at,kind,content_hash,summary,payload,created_at) VALUES ('e','p','https://www.facebook.com/ads/library/',?,'manual',?,'No matches for bounded search','{}',?)",
      )
      .bind(time, "a".repeat(64), time)
      .run();
    await db
      .prepare(
        "INSERT INTO distribution_watches VALUES ('w','p','s','meta','ALL','fixture.com','https://www.facebook.com/ads/library/',?)",
      )
      .bind(time)
      .run();
    await db
      .prepare(
        "INSERT INTO distribution_scans VALUES ('scan','w',?,'no_results','e','Observed empty result',?)",
      )
      .bind(time, time)
      .run();
    for (const file of files.filter((f) => f >= "0006")) await apply(file);
    const row = await db
      .prepare(
        "SELECT w.platform,w.source_id,d.evidence_id,d.outcome FROM distribution_watches w JOIN distribution_scans d ON d.watch_id=w.id WHERE w.id='w'",
      )
      .first();
    assert.deepEqual(row, {
      platform: "meta",
      source_id: "s",
      evidence_id: "e",
      outcome: "no_results",
    });
    assert.equal(
      (await db.prepare("PRAGMA foreign_key_check").all()).results.length,
      0,
    );
    await db
      .prepare(
        "INSERT INTO distribution_watches VALUES ('g','p','s','google','ALL','fixture.com','https://adstransparency.google.com/',?)",
      )
      .bind(time)
      .run();
    assert.equal(
      (await db
        .prepare("SELECT count(*) n FROM distribution_watches")
        .first<{ n: number }>())!.n,
      2,
    );
  } finally {
    await mf.dispose();
  }
});
