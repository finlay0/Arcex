import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { app } from "../src/index";
import {
  METRICS_PAGE_SIZE,
  refreshMetrics,
  signedMediaUrl,
} from "../src/insights";
import { sha256 } from "../src/lib";
import type { Bindings } from "../src/types";

const ORIGIN = "http://localhost:8791";
const ADMIN = "admin-test-only";
const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();

test("coverage, gating, limits, metrics, tracking and publication", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ["DB"],
      compatibilityDate: "2026-11-03",
    }),
  );
  try {
    const { DB } = await mf.getBindings<Pick<Bindings, "DB">>();
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      for (const sql of (await readFile("migrations/" + file, "utf8"))
        .replace(/^--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await DB.prepare(sql).run();
    const env = {
      DB,
      ENVIRONMENT: "development",
      APP_ORIGIN: ORIGIN,
      API_ORIGIN: ORIGIN,
      MCP_OWNER_GITHUB_ID: "42",
      ENABLE_DEV_AUTH: "false",
      COLLECTION_ENABLED: "false",
      ADMIN_TOKEN: ADMIN,
      MEDIA_SIGNING_SECRET: "media-secret-test-only",
    } as Bindings;

    const request = (
      method: string,
      path: string,
      body?: unknown,
      credential?: string,
    ) =>
      app.request(
        ORIGIN + path,
        {
          method,
          headers: {
            ...(body !== undefined
              ? { "content-type": "application/json" }
              : {}),
            origin: ORIGIN,
            ...(credential?.startsWith("cookie:")
              ? { cookie: "arcex_session=" + credential.slice(7) }
              : credential
                ? { authorization: "Bearer " + credential }
                : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        env,
        {
          waitUntil() {},
          passThroughOnException() {},
        } as unknown as ExecutionContext,
      );
    const json = async <T>(response: Response, status = 200) => {
      const text = await response.text();
      assert.equal(response.status, status, text);
      return JSON.parse(text) as T;
    };

    const stamp = daysAgo(0);
    const addProduct = async (slug: string, published = true) => {
      await DB.prepare(
        "INSERT INTO products(id,slug,name,url,domain,description,category,monetization,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          slug,
          slug,
          slug,
          `https://${slug}.example`,
          `${slug}.example`,
          "An app",
          "other",
          "unknown",
          published ? "published" : "draft",
          daysAgo(100),
          stamp,
        )
        .run();
      await DB.prepare(
        "INSERT INTO evidence(id,product_id,source_url,observed_at,kind,content_hash,summary,payload,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          "ev-" + slug,
          slug,
          `https://${slug}.example`,
          stamp,
          "page",
          slug,
          "Seen",
          "{}",
          "approved",
          stamp,
        )
        .run();
    };
    const addStep = (
      slug: string,
      position: number,
      asset: string | null = null,
    ) =>
      DB.prepare(
        "INSERT INTO funnel_steps(id,product_id,position,title,stage,annotation,evidence_id,asset_id) VALUES (?,?,?,?,?,?,?,?)",
      )
        .bind(
          `${slug}-${position}`,
          slug,
          position,
          `Step ${position}`,
          "paywall",
          "Secret note",
          "ev-" + slug,
          asset,
        )
        .run();
    const refreshAll = async () => {
      for (;;) if ((await refreshMetrics(DB)).cycleComplete) return;
    };

    await addProduct("captured");
    await addProduct("signals");
    await addProduct("sample");
    await addProduct("hidden", false);
    await DB.prepare(
      "INSERT INTO assets(id,evidence_id,object_key,content_type,size,sha256,approved,created_at) VALUES ('img','ev-captured','evidence/img','image/png',1,'x',1,?)",
    )
      .bind(stamp)
      .run();
    await addStep("captured", 0, "img");
    await addStep("captured", 1);
    await addStep("sample", 0);
    await addStep("hidden", 0);
    await json(
      await request(
        "PUT",
        "/api/v1/admin/products/sample/open-sample",
        { open: true },
        ADMIN,
      ),
    );
    await refreshAll();

    // Captures remain Signals Only until an owner reviews their actual scope.
    assert.equal(
      (
        await request(
          "PUT",
          "/api/v1/admin/products/signals/coverage",
          { level: "full", notes: "No actual app captures exist yet." },
          ADMIN,
        )
      ).status,
      409,
    );
    const partial = await json<{ coverage: string; funnel: unknown[] }>(
      await request("GET", "/api/v1/vault/captured"),
    );
    assert.equal(partial.coverage, "signals");
    assert.deepEqual(partial.funnel, []);
    for (const slug of ["captured", "sample"]) {
      if (slug === "sample") {
        await DB.prepare(
          "INSERT INTO assets(id,evidence_id,object_key,content_type,size,sha256,approved,created_at) VALUES ('sample-img','ev-sample','evidence/sample','image/png',1,'x',1,?)",
        )
          .bind(stamp)
          .run();
        await DB.prepare(
          "UPDATE funnel_steps SET asset_id='sample-img' WHERE product_id='sample'",
        ).run();
      }
      await json(
        await request(
          "PUT",
          `/api/v1/admin/products/${slug}/coverage`,
          {
            level: "full",
            notes: "Reviewed app captures beyond the public landing page.",
          },
          ADMIN,
        ),
      );
    }
    // Drafts never appear, and coverage does not depend on the metrics cache.
    const radar = await json<{
      total: number;
      items: { slug: string; coverage: string; revenue_low_usd: unknown }[];
    }>(await request("GET", "/api/v1/radar"));
    assert.equal(radar.total, 3);
    assert.equal(
      radar.items.find((p) => p.slug === "signals")!.coverage,
      "signals",
    );
    assert.equal(
      radar.items.find((p) => p.slug === "captured")!.coverage,
      "full",
    );
    assert.equal(radar.items[0].revenue_low_usd, null);
    assert.equal(
      (
        await json<{ total: number }>(
          await request("GET", "/api/v1/radar?coverage=full"),
        )
      ).total,
      2,
    );
    assert.equal(
      (await request("GET", "/api/v1/radar?sort=password")).status,
      400,
    );

    // Changing a position cannot enumerate gated screens.
    type Vault = {
      access: string;
      funnel: { image_url: string | null }[];
      outline?: unknown[];
      evidence: unknown[];
      usage: { used: number } | null;
    };
    const preview = await json<Vault>(
      await request("GET", "/api/v1/vault/captured"),
    );
    assert.equal(preview.access, "preview");
    assert.deepEqual(preview.funnel, []);
    assert.equal(preview.outline!.length, 2);
    assert.ok(!JSON.stringify(preview).includes("Secret note"));
    const unshared = await json<Vault>(
      await request("GET", "/api/v1/vault/captured?step=0"),
    );
    assert.equal(unshared.funnel.length, 0);
    assert.equal(
      (await request("POST", "/api/v1/vault/captured/share", { position: 0 }))
        .status,
      401,
    );
    for (const [slug, access] of [
      ["signals", "open"],
      ["sample", "open"],
    ])
      assert.equal(
        (await json<Vault>(await request("GET", "/api/v1/vault/" + slug)))
          .access,
        access,
      );
    assert.equal((await request("GET", "/api/v1/vault/hidden")).status, 404);

    // Image links are required, signed for that image, and expire.
    const link = (await signedMediaUrl(env, "img"))!;
    for (const bad of [
      "/api/v1/media/img",
      link.replace(/signature=.{4}/, "signature=0000"),
      link.replace("/media/img", "/media/other"),
      link.replace(/expires=\d+/, "expires=1000"),
    ])
      assert.equal((await request("GET", bad)).status, 403);
    assert.equal(
      await signedMediaUrl({ ...env, MEDIA_SIGNING_SECRET: undefined }, "img"),
      null,
    );

    // Signed-in users spend one app a day per product, and reopening is free.
    await DB.prepare(
      "INSERT INTO users(id,handle,name) VALUES ('u1','u1','U'),('u2','u2','V')",
    ).run();
    for (const [token, user] of [
      ["cookie-one", "u1"],
      ["cookie-two", "u2"],
    ])
      await DB.prepare("INSERT INTO sessions VALUES (?,?,?)")
        .bind(await sha256(token), user, "2099-01-01T00:00:00.000Z")
        .run();
    const u1 = "cookie:cookie-one";
    const u2 = "cookie:cookie-two";
    const opened = await json<Vault>(
      await request("GET", "/api/v1/vault/captured", undefined, u1),
    );
    assert.equal(opened.funnel.length, 2);
    assert.equal(opened.usage!.used, 1);
    const share = await json<{ url: string }>(
      await request(
        "POST",
        "/api/v1/vault/captured/share",
        { position: 0 },
        u1,
      ),
    );
    const shared = await json<Vault>(await request("GET", share.url));
    assert.equal(shared.funnel.length, 1);
    assert.ok(shared.funnel[0].image_url);
    assert.equal(
      (
        await json<Vault>(
          await request("GET", share.url.replace("step=0", "step=1")),
        )
      ).funnel.length,
      0,
    );
    await json(await request("GET", "/api/v1/vault/captured", undefined, u1));
    await json(await request("GET", "/api/v1/vault/signals", undefined, u1));
    assert.equal(
      (
        await json<{ used: number }>(
          await request("GET", "/api/v1/me/usage", undefined, u1),
        )
      ).used,
      1,
    );
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 9; i++) {
      await addProduct("filler" + i);
      await addStep("filler" + i, 0);
      await DB.prepare("INSERT INTO vault_unlocks VALUES ('u1',?,?,?)")
        .bind(day, "filler" + i, stamp)
        .run();
    }
    await addProduct("one-too-many");
    await addStep("one-too-many", 0);
    await DB.prepare(
      "UPDATE products SET coverage_level='full' WHERE id='one-too-many'",
    ).run();
    const limited = await json<{ code: string; used: number }>(
      await request("GET", "/api/v1/vault/one-too-many", undefined, u1),
      429,
    );
    assert.equal(limited.code, "daily_limit");
    assert.equal(limited.used, 10);
    await json(await request("GET", "/api/v1/vault/captured", undefined, u1));
    const setInsider = (user: string, on: boolean) =>
      on
        ? DB.prepare(
            "INSERT INTO subscriptions(user_id,status,period_end,updated_at) VALUES (?,'active','2099-01-01T00:00:00.000Z',?)",
          )
            .bind(user, stamp)
            .run()
        : DB.prepare("DELETE FROM subscriptions WHERE user_id=?")
            .bind(user)
            .run();
    await setInsider("u1", true);
    await json(
      await request("GET", "/api/v1/vault/one-too-many", undefined, u1),
    );
    await setInsider("u1", false);

    // Free keys can read app details, using the same allowance, but nothing private.
    await DB.prepare(
      "INSERT INTO api_keys(id,user_id,token_hash,name,created_at) VALUES ('k','u2',?,'k',?)",
    )
      .bind(await sha256("arcex_free"), stamp)
      .run();
    assert.equal(
      (
        await json<Vault>(
          await request(
            "GET",
            "/api/v1/vault/captured",
            undefined,
            "arcex_free",
          ),
        )
      ).access,
      "full",
    );
    for (const path of ["/api/v1/me/saves", "/api/v1/me/usage"])
      assert.equal(
        (await request("GET", path, undefined, "arcex_free")).status,
        403,
      );
    assert.equal(
      (
        await request(
          "GET",
          "/api/v1/vault/captured",
          undefined,
          "arcex_invalid",
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await json<Vault>(
          await request(
            "GET",
            "/api/v1/vault/captured",
            undefined,
            "cookie:expired",
          ),
        )
      ).access,
      "preview",
    );

    // The refresh stays inside D1 Free's limit and reaches every product across calls.
    await DB.prepare("DELETE FROM product_metrics").run();
    for (let i = 0; i < METRICS_PAGE_SIZE * 2; i++)
      await addProduct("bulk" + i);
    let queries = 0;
    const counted = new Proxy(DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            queries++;
            return target.prepare(sql);
          };
        const value = target[key as keyof D1Database];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const pages: { processed: number; cycleComplete: boolean }[] = [];
    for (;;) {
      queries = 0;
      const result = await refreshMetrics(counted);
      assert.ok(queries <= 50, `${queries} queries in one invocation`);
      pages.push(result);
      if (result.cycleComplete) break;
    }
    assert.ok(pages.length >= 3);
    assert.ok(pages[0].processed <= METRICS_PAGE_SIZE);
    const everyone = await DB.prepare(
      "SELECT (SELECT count(*) FROM products WHERE status='published') published,(SELECT count(*) FROM product_metrics) refreshed,(SELECT count(*) FROM product_metrics WHERE product_id='hidden') drafts",
    ).first<{ published: number; refreshed: number; drafts: number }>();
    assert.equal(everyone!.refreshed, everyone!.published);
    assert.equal(everyone!.drafts, 0);

    // Nothing collected means unknown, not zero.
    const metricsOf = (slug: string) =>
      DB.prepare("SELECT * FROM product_metrics WHERE product_id=?")
        .bind(slug)
        .first<Record<string, number | string | null>>();
    const blank = await metricsOf("sample");
    for (const field of [
      "active_ads",
      "ads_delta_7d",
      "longest_ad_days",
      "creators",
      "sponsors",
      "activity_change_4w",
    ])
      assert.equal(blank![field], null, field);
    assert.deepEqual(
      JSON.parse(blank!.activity_weekly as string),
      Array(12).fill(null),
    );

    const signal = (
      signalId: string,
      kind: string,
      external: string,
      days: number,
      detail: object,
      evidence = "ev-signals",
    ) =>
      DB.prepare(
        "INSERT INTO distribution_signals(id,product_id,evidence_id,kind,external_id,observed_at,source_url,detail) VALUES (?,?,?,?,?,?,?,?)",
      )
        .bind(
          signalId,
          "signals",
          evidence,
          kind,
          external,
          daysAgo(days),
          "https://signals.example",
          JSON.stringify(detail),
        )
        .run();
    await DB.prepare(
      "INSERT INTO evidence(id,product_id,source_url,observed_at,kind,content_hash,summary,payload,status,created_at) VALUES ('ev-draft','signals','https://signals.example/d',?,'page','d','Draft','{}','draft',?)",
    )
      .bind(stamp, stamp)
      .run();
    // The newest sighting decides, whichever order the rows were inserted in.
    await signal("a-new", "ad_observed", "ended", 2, { activity: "inactive" });
    await signal("a-old", "ad_observed", "ended", 30, { activity: "active" });
    await signal("b-old", "ad_observed", "running", 30, {
      activity: "inactive",
    });
    await signal("b-new", "ad_observed", "running", 2, { activity: "active" });
    await signal("b-mid", "ad_observed", "running", 10, { activity: "active" });
    await signal(
      "draft",
      "ad_observed",
      "draft-ad",
      1,
      { activity: "active" },
      "ev-draft",
    );
    await signal("m-new", "creator_mention", "video", 3, {
      placement: "sponsored",
    });
    await signal("m-old", "creator_mention", "video", 20, {
      placement: "organic",
    });
    await refreshAll();
    const seen = await metricsOf("signals");
    assert.equal(seen!.active_ads, 1);
    assert.equal(seen!.longest_ad_days, 2);
    assert.equal(seen!.creators, 1);
    assert.equal(seen!.sponsors, 1);
    // Unscanned weeks stay null, and too little comparable history gives no percentage.
    assert.equal(seen!.activity_change_4w, null);
    const weekly = JSON.parse(seen!.activity_weekly as string) as (
      number | null
    )[];
    assert.equal(weekly[11], 3);
    assert.equal(weekly[0], null);

    // A completed empty scan is a real zero. A failed one tells us nothing.
    await DB.prepare(
      "INSERT INTO sources(id,product_id,name,url,kind,next_run_at,created_at) VALUES ('src','sample','s','https://sample.example/ads','browser',?,?)",
    )
      .bind(stamp, stamp)
      .run();
    await DB.prepare(
      "INSERT INTO distribution_watches VALUES ('w','sample','src','meta','US','q','https://sample.example/q',?)",
    )
      .bind(stamp)
      .run();
    const scan = (scanId: string, days: number, outcome: string) =>
      DB.prepare(
        "INSERT INTO distribution_scans VALUES (?,'w',?,?,'ev-sample','note',?)",
      )
        .bind(scanId, daysAgo(days), outcome, stamp)
        .run();
    await scan("failed", 1, "failed");
    await refreshAll();
    assert.equal((await metricsOf("sample"))!.active_ads, null);
    await scan("empty", 2, "no_results");
    await refreshAll();
    const scanned = await metricsOf("sample");
    assert.equal(scanned!.active_ads, 0);
    assert.equal(scanned!.creators, null);
    assert.equal(JSON.parse(scanned!.activity_weekly as string)[11], 0);

    // With comparable collection in both windows, activity gets a percentage.
    for (let week = 0; week < 8; week++)
      await scan("week" + week, week * 7 + 3, "no_results");
    for (const [i, days] of [31, 32, 33, 34].entries())
      await DB.prepare(
        "INSERT INTO distribution_signals(id,product_id,evidence_id,kind,external_id,observed_at,source_url,detail) VALUES (?,?,?,?,?,?,?,?)",
      )
        .bind(
          "p" + i,
          "sample",
          "ev-sample",
          "ad_observed",
          "old" + i,
          daysAgo(days),
          "https://sample.example",
          '{"activity":"active"}',
        )
        .run();
    for (const i of [0, 1])
      await DB.prepare(
        "INSERT INTO distribution_signals(id,product_id,evidence_id,kind,external_id,observed_at,source_url,detail) VALUES (?,?,?,?,?,?,?,?)",
      )
        .bind(
          "r" + i,
          "sample",
          "ev-sample",
          "ad_observed",
          "new" + i,
          daysAgo(5),
          "https://sample.example",
          '{"activity":"active"}',
        )
        .run();
    await refreshAll();
    assert.equal((await metricsOf("sample"))!.activity_change_4w, -50);

    // Revenue ranges need sources and evidence, stay drafts, and never use ads as dollars.
    const range = {
      lowUsd: 1000,
      highUsd: 2000,
      confidence: 2,
      methodVersion: "manual-v1",
      inputs: [
        {
          basis: "public_pricing",
          label: "Pro plan",
          value: "$29 a month",
          sourceUrl: "https://signals-fixture.com/pricing",
        },
        { basis: "assumption", label: "Paying customers", value: "35 to 70" },
      ],
      evidenceIds: ["ev-signals"],
    };
    const save = (body: unknown, credential = ADMIN) =>
      request(
        "PUT",
        "/api/v1/admin/products/signals/revenue",
        body,
        credential,
      );
    assert.equal((await save(range, "wrong")).status, 401);
    for (const invalid of [
      {
        ...range,
        inputs: [
          { basis: "assumption", label: "Guess", value: "50 customers" },
        ],
      },
      { ...range, inputs: [{ ...range.inputs[0], sourceUrl: undefined }] },
      {
        ...range,
        inputs: [
          { ...range.inputs[1], label: "Ad longevity", value: "96 days" },
        ],
      },
      {
        ...range,
        inputs: [{ basis: "ad_longevity", label: "Runtime", value: "96 days" }],
      },
      { ...range, evidenceIds: [] },
      { ...range, highUsd: 1 },
    ])
      assert.equal((await save(invalid)).status, 422, JSON.stringify(invalid));
    assert.equal(
      (await save({ ...range, evidenceIds: ["ev-captured"] })).status,
      422,
    );
    await json(await save(range));
    const rangeOf = async () =>
      (
        await json<{
          revenueRange: {
            kind: string;
            computed: boolean;
            method_version: string;
            inputs: unknown[];
            evidence_ids: string[];
          } | null;
        }>(await request("GET", "/api/v1/vault/signals"))
      ).revenueRange;
    assert.equal(await rangeOf(), null);
    await json(
      await request(
        "PUT",
        "/api/v1/admin/products/signals/revenue/status",
        { status: "published" },
        ADMIN,
      ),
    );
    const published = await rangeOf();
    assert.equal(published!.kind, "manual_range");
    assert.equal(published!.computed, false);
    assert.equal(published!.method_version, "manual-v1");
    assert.equal(published!.inputs.length, 2);
    assert.deepEqual(published!.evidence_ids, ["ev-signals"]);
    await DB.prepare(
      "UPDATE evidence SET status='rejected' WHERE id='ev-signals'",
    ).run();
    assert.equal(await rangeOf(), null);
    await DB.prepare(
      "UPDATE evidence SET status='approved' WHERE id='ev-signals'",
    ).run();
    await json(await save({ ...range, highUsd: 9000 }));
    assert.equal(await rangeOf(), null);
    const history = await json<{
      items: { high_usd: number; status: string }[];
    }>(
      await request(
        "GET",
        "/api/v1/admin/products/signals/revenue/history",
        undefined,
        ADMIN,
      ),
    );
    assert.deepEqual(history.items.map((h) => h.status).sort(), [
      "draft",
      "draft",
      "published",
    ]);

    // Changes stay private until published, and leave with their evidence.
    const change = {
      evidenceId: "ev-signals",
      kind: "ads",
      summary: "Launched a new ad",
      observedAt: stamp,
    };
    assert.equal(
      (
        await request(
          "POST",
          "/api/v1/admin/products/signals/changes",
          { ...change, evidenceId: "ev-captured" },
          ADMIN,
        )
      ).status,
      422,
    );
    const created = await json<{ id: string }>(
      await request(
        "POST",
        "/api/v1/admin/products/signals/changes",
        change,
        ADMIN,
      ),
      201,
    );
    const changes = async () =>
      (
        await json<{ items: unknown[] }>(
          await request("GET", "/api/v1/changes"),
        )
      ).items.length;
    assert.equal(await changes(), 0);
    await json(
      await request(
        "PUT",
        `/api/v1/admin/changes/${created.id}/status`,
        { status: "published" },
        ADMIN,
      ),
    );
    assert.equal(await changes(), 1);
    await DB.prepare(
      "UPDATE evidence SET status='rejected' WHERE id='ev-signals'",
    ).run();
    assert.equal(await changes(), 0);
    await DB.prepare(
      "UPDATE evidence SET status='approved' WHERE id='ev-signals'",
    ).run();

    // Free tracking stops at 3. Insider has no hidden ceiling, and reads are paged.
    for (const slug of ["captured", "signals", "sample"])
      await json(await request("PUT", "/api/v1/me/watches/" + slug, {}, u2));
    assert.equal(
      (
        await json<{ code: string }>(
          await request("PUT", "/api/v1/me/watches/filler0", {}, u2),
          409,
        )
      ).code,
      "watch_limit",
    );
    await json(await request("PUT", "/api/v1/me/watches/captured", {}, u2));
    assert.equal(
      (await request("PUT", "/api/v1/me/watches/hidden", {}, u1)).status,
      404,
    );
    assert.equal((await request("GET", "/api/v1/me/watches")).status, 401);
    assert.equal(
      (
        await json<{ items: unknown[] }>(
          await request("GET", "/api/v1/me/watches", undefined, u1),
        )
      ).items.length,
      0,
    );
    assert.equal(
      (
        await json<{ items: unknown[] }>(
          await request("GET", "/api/v1/me/watches/changes", undefined, u2),
        )
      ).items.length,
      1,
    );
    assert.equal(
      (await request("PUT", "/api/v1/me/alerts", { emailAlerts: true }, u2))
        .status,
      403,
    );
    await setInsider("u1", true);
    await DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<520)
       INSERT INTO products(id,slug,name,url,domain,description,category,monetization,status,created_at,updated_at)
       SELECT 'many'||i,'many'||i,'many','https://many'||i||'.example','many'||i||'.example','d','other','unknown','published','2026-01-01','2026-01-01' FROM n`,
    ).run();
    await DB.prepare(
      "INSERT INTO product_watches SELECT 'u1',id,'2026-01-01' FROM products WHERE id LIKE 'many%' AND id<>'many1'",
    ).run();
    await json(await request("PUT", "/api/v1/me/watches/many1", {}, u1));
    const firstPage = await json<{
      items: unknown[];
      watchLimit: number | null;
    }>(await request("GET", "/api/v1/me/watches?limit=100", undefined, u1));
    assert.equal(firstPage.items.length, 100);
    assert.equal(firstPage.watchLimit, null);
    assert.equal(
      (await request("GET", "/api/v1/me/watches?limit=101", undefined, u1))
        .status,
      400,
    );
    await setInsider("u1", false);

    // A user can only remove their own product.
    const own = await json<{ id: string }>(
      await request(
        "POST",
        "/api/v1/me/products",
        { url: "https://mine.example" },
        u2,
      ),
      201,
    );
    assert.equal(
      (
        await request(
          "POST",
          "/api/v1/me/products",
          { url: "http://insecure.example" },
          u2,
        )
      ).status,
      422,
    );
    await json(
      await request("DELETE", "/api/v1/me/products/" + own.id, undefined, u1),
    );
    assert.equal(
      (
        await json<{ items: unknown[] }>(
          await request("GET", "/api/v1/me/products", undefined, u2),
        )
      ).items.length,
      1,
    );

    // Requests are de-duplicated per person and ranked for the admin.
    await json(await request("PUT", "/api/v1/me/requests/signals", {}, u1));
    await json(await request("PUT", "/api/v1/me/requests/signals", {}, u1));
    await json(await request("PUT", "/api/v1/me/requests/signals", {}, u2));
    const ranked = await json<{ items: { slug: string; requests: number }[] }>(
      await request(
        "GET",
        "/api/v1/admin/breakdown-requests",
        undefined,
        ADMIN,
      ),
    );
    assert.equal(ranked.items[0].slug, "signals");
    assert.equal(ranked.items[0].requests, 2);
  } finally {
    await mf.dispose();
  }
});
