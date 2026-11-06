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
    const setMode = (mode: string) =>
      app.request(
        `http://localhost:8791/api/v1/admin/sources/${job.source.id}`,
        {
          method: "PATCH",
          headers: {
            authorization: "Bearer admin-test-only",
            "content-type": "application/json",
          },
          body: JSON.stringify({ enabled: true, captureMode: mode }),
        },
        env,
      );
    assert.equal(
      (await setMode("text")).status,
      409,
      "A running collector must finish before its capture mode changes",
    );
    await db
      .prepare(
        "INSERT INTO products(id,slug,name,url,domain,description,category,monetization,created_at,updated_at) VALUES ('tracked','tracked','Tracked','https://fixture.com','fixture.com','Fixture','other','unknown',?,?)",
      )
      .bind(new Date().toISOString(), new Date().toISOString())
      .run();
    await db
      .prepare("UPDATE sources SET product_id='tracked' WHERE id=?")
      .bind(job.source.id)
      .run();
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
      `<title>Fixture</title><h1>Pricing</h1><script src="https://js.stripe.com/v3/"></script>`,
      { server: "one" },
    );
    assert.equal(
      evidence.contentHash,
      pageEvidence(job.source.url, "<title>Fixture</title><h1>Pricing</h1>", {
        server: "two",
      }).contentHash,
      "A new script tag is not a page content change",
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
    assert.equal(
      (await db
        .prepare("SELECT count(*) n FROM product_changes")
        .first<{ n: number }>())!.n,
      0,
      "Baseline and unchanged checks are not change events",
    );
    await db
      .prepare(
        "UPDATE sources SET next_run_at='2026-01-03T00:00:00.000Z' WHERE id=?",
      )
      .bind(job.source.id)
      .run();
    await db
      .prepare("UPDATE collection_policy SET daily_limit=3 WHERE lane='http'")
      .run();
    await enqueueDue(env);
    const changedJob = (await req("/claim", { kinds: ["public_page"] })).job;
    const changed = pageEvidence(
      job.source.url,
      "<title>New positioning</title><h1>New public offer</h1>",
      {},
    );
    await req(`/${changedJob.id}/complete`, {
      leaseToken: changedJob.leaseToken,
      evidence: [changed],
      fingerprint: "b".repeat(64),
    });
    // Stripe was seen on the first check and is gone from the changed page.
    const stack = await db
      .prepare(
        "SELECT technology,category,removed_at FROM product_stack WHERE product_id=?",
      )
      .bind("tracked")
      .all<{
        technology: string;
        category: string;
        removed_at: string | null;
      }>();
    assert.equal(stack.results.length, 1);
    assert.equal(stack.results[0].technology, "Stripe");
    assert.equal(stack.results[0].category, "payments");
    assert.ok(stack.results[0].removed_at);
    const comparison = await db.prepare("SELECT * FROM product_changes").first<{
      id: string;
      evidence_id: string;
      previous_evidence_id: string;
      kind: string;
      status: string;
    }>();
    assert.equal(comparison!.status, "draft");
    assert.equal(comparison!.kind, "public_page");
    assert.notEqual(comparison!.evidence_id, comparison!.previous_evidence_id);
    const admin = (path: string, body?: unknown) =>
      app.request(
        "http://localhost:8791/api/v1/admin" + path,
        {
          method: body ? "PUT" : "GET",
          headers: {
            authorization: "Bearer admin-test-only",
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        env,
      );
    const feed = async () =>
      (await (
        await app.request("http://localhost:8791/api/v1/changes", {}, env)
      ).json()) as { items: unknown[] };
    assert.equal((await feed()).items.length, 0);
    const review = (await (
      await admin("/changes?productId=tracked")
    ).json()) as { items: { previous_evidence_id: string }[] };
    assert.equal(
      review.items[0].previous_evidence_id,
      comparison!.previous_evidence_id,
    );
    await db
      .prepare(
        "UPDATE evidence SET status='approved' WHERE product_id='tracked'",
      )
      .run();
    await db
      .prepare("UPDATE products SET status='published' WHERE id='tracked'")
      .run();
    assert.equal(
      (
        await admin(`/changes/${comparison!.id}`, {
          summary: "Public title and offer heading changed.",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await admin(`/changes/${comparison!.id}/status`, {
          status: "published",
        })
      ).status,
      200,
    );
    assert.equal((await feed()).items.length, 1);
    await db
      .prepare("UPDATE evidence SET status='rejected' WHERE id=?")
      .bind(comparison!.previous_evidence_id)
      .run();
    assert.equal(
      (await feed()).items.length,
      0,
      "Retracting the previous observation hides the comparison too",
    );
    assert.equal(
      (
        await admin(`/changes/${comparison!.id}/status`, {
          status: "published",
        })
      ).status,
      409,
    );

    const price9 =
      "<title>Fixture pricing</title><h1>Pricing</h1><p>Pro $9 per month</p>";
    const price19 = price9.replace("$9", "$19");
    assert.equal(
      pageEvidence(job.source.url, price9, {}).contentHash,
      pageEvidence(job.source.url, price19, {}).contentHash,
      "Metadata mode retains its documented limited scope",
    );
    const textCapture = pageEvidence(job.source.url, price9, {}, "text");
    assert.notEqual(
      textCapture.contentHash,
      pageEvidence(job.source.url, price19, {}, "text").contentHash,
      "Text capture must detect price-only edits",
    );
    assert.equal(
      textCapture.contentHash,
      pageEvidence(
        job.source.url,
        price9 + "<script>changing nonce</script>",
        {},
        "text",
      ).contentHash,
      "Script nonces do not create text-content changes",
    );
    assert.equal((await setMode("text")).status, 200);
    const reset = await db
      .prepare(
        "SELECT last_fingerprint,last_evidence_id,http_etag,last_checked_at FROM sources WHERE id=?",
      )
      .bind(job.source.id)
      .first();
    assert.deepEqual(reset, {
      last_fingerprint: null,
      last_evidence_id: null,
      http_etag: null,
      last_checked_at: null,
    });
    await db
      .prepare("UPDATE collection_policy SET daily_limit=4 WHERE lane='http'")
      .run();
    await enqueueDue(env);
    const textJob = (await req("/claim", { kinds: ["public_page"] })).job;
    await req(
      `/${textJob.id}/complete`,
      { leaseToken: textJob.leaseToken, evidence: [evidence] },
      422,
    );
    await req(`/${textJob.id}/complete`, {
      leaseToken: textJob.leaseToken,
      evidence: [textCapture],
    });
    assert.equal(
      (await db
        .prepare("SELECT count(*) n FROM product_changes")
        .first<{ n: number }>())!.n,
      1,
      "Changing capture mode establishes a new baseline, not a product-change claim",
    );

    // The REST completion accepts up to 30 entries. Measure that boundary, not only one-page jobs.
    const stamp = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO sources(id,name,url,kind,enabled,next_run_at,created_at,lane) VALUES ('feed','Feed','https://fixture.com/feed','rss',1,?,?,'http')",
      )
      .bind(stamp, stamp)
      .run();
    await db
      .prepare("UPDATE collection_policy SET daily_limit=5 WHERE lane='http'")
      .run();
    await enqueueDue(env);
    const feedJob = (await req("/claim", { kinds: ["rss"] })).job;
    const entries = Array.from({ length: 30 }, (_, i) => ({
      ...pageEvidence(
        `https://fixture.com/post/${i}`,
        `<title>Entry ${i}</title>`,
        {},
      ),
      kind: "rss_item",
    }));
    let queries = 0;
    env.DB = {
      prepare(sql: string) {
        queries++;
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    } as D1Database;
    const bulk = await req(`/${feedJob.id}/complete`, {
      leaseToken: feedJob.leaseToken,
      evidence: entries,
    });
    env.DB = db;
    assert.equal(bulk.inserted, 30);
    assert.ok(queries <= 50, `30-item completion used ${queries} queries`);
    assert.equal(
      (await db
        .prepare("SELECT count(*) n FROM evidence_observations WHERE job_id=?")
        .bind(feedJob.id)
        .first<{ n: number }>())!.n,
      30,
    );
  } finally {
    await mf.dispose();
  }
});
