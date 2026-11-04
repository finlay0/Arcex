import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { app } from "../src/index";
import { enqueueDue } from "../src/jobs";
import { pageEvidence } from "../scripts/collector";
import type { Bindings } from "../src/types";

test("10,000 sources: bounded fair scheduling, atomic budgets, conditional completion and blocked-source stop", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ["DB"],
      kvNamespaces: ["OAUTH_KV"],
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
    const env = {
      DB: db,
      ENVIRONMENT: "development",
      APP_ORIGIN: "http://localhost:8791",
      API_ORIGIN: "http://localhost:8791",
      COLLECTOR_TOKEN: "scale-test-only",
      ADMIN_TOKEN: "admin-test-only",
    } as Bindings;
    await db
      .prepare(
        `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO sources(id,name,url,kind,enabled,next_run_at,created_at,lane)
      SELECT printf('http-%05d',x),'Fixture','https://fixture.com/'||x,'public_page',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','http' FROM n`,
      )
      .run();
    for (const [lane, count] of [
      ["browser", 24],
      ["discovery", 8],
    ] as const)
      await db
        .prepare(
          `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
        INSERT INTO sources(id,name,url,kind,enabled,next_run_at,created_at,lane)
        SELECT ?||x,'Fixture','https://fixture.com/'||?||x,'browser',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',? FROM n`,
        )
        .bind(count, lane, lane, lane)
        .run();
    const first = await enqueueDue(env);
    assert.equal(first.enqueued, 215);
    console.log(JSON.stringify({ scaleSources: 10032, firstEnqueue: first }));
    const concurrent = await Promise.all([enqueueDue(env), enqueueDue(env)]);
    assert.equal(
      concurrent.reduce((n, r) => n + r.enqueued, 0),
      417,
    );
    for (let i = 0; i < 3; i++) await enqueueDue(env);
    assert.equal(
      (await db.prepare("SELECT COUNT(*) n FROM jobs").first<{ n: number }>())!
        .n,
      932,
    );
    assert.equal(
      (await db
        .prepare("SELECT COUNT(DISTINCT source_id) n FROM jobs")
        .first<{ n: number }>())!.n,
      932,
    );
    assert.equal(
      (await db
        .prepare("SELECT next_run_at FROM sources WHERE id='http-10000'")
        .first<{ next_run_at: string }>())!.next_run_at,
      "2026-01-01T00:00:00.000Z",
    );
    const req = async (path: string, body: unknown, expected = 200) => {
      const response = await app.request(
        "http://localhost:8791/api/v1/collector/jobs" + path,
        {
          method: "POST",
          headers: {
            authorization: "Bearer scale-test-only",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        env,
      );
      const result = (await response.json()) as any;
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    };
    await db
      .prepare(
        "UPDATE collection_policy SET daily_limit=CASE lane WHEN 'browser' THEN 0 ELSE 1 END,concurrency_limit=1",
      )
      .run();
    const claims = await Promise.all([
      req("/claim", { kinds: ["public_page"] }),
      req("/claim", { kinds: ["public_page"] }),
    ]);
    const jobs = claims.flatMap((r) => (r.job ? [r.job] : []));
    assert.equal(jobs.length, 1);
    const job = jobs[0];
    assert.equal((await req("/claim", { kinds: ["browser"] })).job, null);
    const discovery = (
      await req("/claim", { kinds: ["browser"], lane: "discovery" })
    ).job;
    assert.ok(
      discovery,
      "Discovery retains its allowance while HTTP is exhausted",
    );
    await req(`/${discovery.id}/fail`, {
      leaseToken: discovery.leaseToken,
      error: "Authentication challenge",
      blocked: true,
    });
    assert.equal(
      (await db
        .prepare("SELECT enabled FROM sources WHERE id=?")
        .bind(discovery.source.id)
        .first<{ enabled: number }>())!.enabled,
      0,
    );
    const evidence = pageEvidence(
      job.source.url,
      "<title>Fixture</title><h1>Pricing</h1>",
      { server: "one" },
    );
    assert.equal(
      evidence.contentHash,
      pageEvidence(job.source.url, "<title>Fixture</title><h1>Pricing</h1>", {
        server: "two",
      }).contentHash,
    );
    const fingerprint = "a".repeat(64);
    await req(`/${job.id}/complete`, {
      leaseToken: job.leaseToken,
      evidence: [evidence],
      fingerprint,
      httpCache: { etag: '"v1"', lastModified: null },
    });
    const old = await db
      .prepare("SELECT last_changed_at FROM sources WHERE id=?")
      .bind(job.source.id)
      .first<{ last_changed_at: string }>();
    // Make only this source eligible for its next cycle.
    await db
      .prepare("UPDATE sources SET enabled=0 WHERE lane='http' AND id!=?")
      .bind(job.source.id)
      .run();
    await db
      .prepare(
        "UPDATE sources SET next_run_at='2026-01-02T00:00:00.000Z' WHERE id=?",
      )
      .bind(job.source.id)
      .run();
    await enqueueDue(env);
    assert.equal(
      (await req("/claim", { kinds: ["public_page"] })).job,
      null,
      "Finished work cannot restore the daily allowance",
    );
    await db
      .prepare("UPDATE collection_policy SET daily_limit=2 WHERE lane='http'")
      .run();
    const next = (await req("/claim", { kinds: ["public_page"] })).job;
    assert.ok(next);
    await req(
      `/${next.id}/complete`,
      {
        leaseToken: next.leaseToken,
        outcome: "unchanged",
        fingerprint: "b".repeat(64),
      },
      422,
    );
    await req(`/${next.id}/complete`, {
      leaseToken: next.leaseToken,
      outcome: "unchanged",
      fingerprint,
    });
    assert.equal(
      (await db
        .prepare("SELECT COUNT(*) n FROM evidence")
        .first<{ n: number }>())!.n,
      1,
    );
    const updated = await db
      .prepare(
        "SELECT last_changed_at,unchanged_streak,http_etag FROM sources WHERE id=?",
      )
      .bind(job.source.id)
      .first();
    assert.equal(updated!.last_changed_at, old!.last_changed_at);
    assert.equal(updated!.unchanged_streak, 1);
    assert.equal(updated!.http_etag, '"v1"');
    assert.equal(
      (await db
        .prepare("SELECT claims FROM collection_usage WHERE lane='http'")
        .first<{ claims: number }>())!.claims,
      2,
    );
  } finally {
    await mf.dispose();
  }
});
