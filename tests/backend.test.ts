import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import Stripe from "stripe";
import { signedMediaUrl } from "../src/insights";
import { app } from "../src/index";
import { processStripeEvent } from "../src/billing";
import { sha256 } from "../src/lib";
import { publicUrl, paywallInput } from "../src/contracts";
import { publicAddress } from "../scripts/public-fetch";
import { enqueueDue } from "../src/jobs";
import type { Bindings } from "../src/types";
import sharp from "sharp";
import { makeThumbnail } from "../scripts/thumbnail-image";
import { validThumbnail } from "../src/thumbnail-format";
import { MEDIA_LIMIT_BYTES } from "../src/file-store";
import {
  parseAppStore,
  parseGooglePlay,
  parseChromeWebStore,
  parseFirefoxAddons,
  parseVscodeMarketplace,
} from "../scripts/store-stats";

test("store parser: Apple lookup and publicly listed purchases", () => {
  const body = JSON.stringify({
    results: [
      {
        wrapperType: "software",
        trackId: 123,
        averageUserRating: 4.6,
        userRatingCount: 42,
        price: 0,
        currency: "USD",
        version: "2.0",
        currentVersionReleaseDate: "2026-11-01T00:00:00Z",
        primaryGenreName: "Productivity",
      },
    ],
  });
  const parsed = parseAppStore(
    body,
    "123",
    "<dt>In-App Purchases</dt><dd><ul><li><span>Pro &amp; More</span><span>$9.99</span></li></ul></dd><span>Unrelated $49</span>",
  );
  assert.deepEqual(parsed, {
    rating: 4.6,
    ratingCount: 42,
    price: 0,
    currency: "USD",
    version: "2.0",
    storeUpdatedAt: "2026-11-01T00:00:00Z",
    genre: "Productivity",
    inAppPurchases: [{ name: "Pro & More", price: "$9.99" }],
    hasInAppPurchases: true,
  });
  assert.throws(() => parseAppStore(body, "999"), /requested app/);
});

test("store parser: Google Play keeps install buckets and unknown flags", () => {
  const ld =
    '<script type="application/ld+json">{"@type":"SoftwareApplication","url":"https://play.google.com/store/apps/details?id=com.fixture.app","aggregateRating":{"ratingValue":"4.25","ratingCount":"1,234"},"offers":[{"price":"0","priceCurrency":"USD"}]}</script>';
  const parsed = parseGooglePlay(
    ld +
      '<div>1M+</div><div>Downloads</div><span class="UIuSk">Contains ads</span><span class="UIuSk">In-app purchases</span><div>Updated on</div><div>Nov 1, 2026</div>',
    "com.fixture.app",
  );
  assert.equal(parsed.installsOrUsers, 1_000_000);
  assert.equal(parsed.installsLabel, "1M+");
  assert.equal(parsed.ratingCount, 1234);
  assert.equal(parsed.rating, 4.25);
  assert.equal(parsed.price, 0);
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.containsAds, true);
  assert.equal(parsed.hasInAppPurchases, true);
  assert.equal(parsed.storeUpdatedAt, "Nov 1, 2026");
  assert.equal(parseGooglePlay(ld, "com.fixture.app").containsAds, null);
  assert.equal(
    parseGooglePlay(
      ld + "<p>Our description mentions Contains ads and In-app purchases.</p>",
      "com.fixture.app",
    ).containsAds,
    null,
  );
  assert.throws(
    () => parseGooglePlay("<title>Just a moment...</title>", "com.fixture.app"),
    /challenge/,
  );
});

test("store parser: Chrome exact embedded counters belong to the requested extension", () => {
  const listing = "a".repeat(32);
  const item = [
    listing,
    "icon",
    "Fixture",
    4.123,
    1234,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    10000,
  ];
  const html = `<script>AF_initDataCallback({key: 'ds:0', hash: '2', data:${JSON.stringify([item])}, sideChannel: {}});</script><div>10,000 users</div><div>Version</div><div>1.2.3</div><div>Updated</div><div>November 1, 2026</div>`;
  const parsed = parseChromeWebStore(html, listing);
  assert.equal(parsed.ratingCount, 1234);
  assert.equal(parsed.rating, 4.123);
  assert.equal(parsed.installsOrUsers, 10000);
  assert.equal(parsed.version, "1.2.3");
  assert.equal(parsed.storeUpdatedAt, "November 1, 2026");
  const rounded = parseChromeWebStore(
    '<span aria-label="Average rating 4.1 out of 5 stars."></span><p>44.9K ratings</p><div>10,000 users</div>',
    listing,
  );
  assert.equal(rounded.ratingCount, null);
});

test("store parser: Firefox users and average daily users remain distinct", () => {
  const parsed = parseFirefoxAddons(
    '{"slug":"fixture","users":200,"average_daily_users":150,"weekly_downloads":999,"ratings":{"average":4.8,"count":20}}',
    "fixture",
  );
  assert.equal(parsed.installsOrUsers, 200);
  assert.equal(parsed.averageDailyUsers, 150);
  assert.equal(parsed.rating, 4.8);
  assert.equal(parsed.ratingCount, 20);
  const dailyOnly = parseFirefoxAddons(
    '{"slug":"fixture","average_daily_users":150,"ratings":{"average":0,"count":0}}',
    "fixture",
  );
  assert.equal(dailyOnly.installsLabel, "150 average daily users");
  assert.throws(
    () => parseFirefoxAddons('{"slug":"other"}', "fixture"),
    /identity mismatch/,
  );
});

test("store parser: VS Code Marketplace public install and rating counters", () => {
  const parsed = parseVscodeMarketplace(
    '<span class="installs-text" title="Unique installations, not updates"> 12,345 installs</span><span title="Average rating: 4.2 out of 5"></span><span class="ux-item-rating-count"> (<span>42</span>)</span>',
  );
  assert.deepEqual(parsed, {
    installsOrUsers: 12345,
    installsLabel: "12,345 installs",
    rating: 4.2,
    ratingCount: 42,
  });
  assert.throws(
    () => parseVscodeMarketplace("<title>Access denied</title>"),
    /challenge/,
  );
});

test("Arcex backend: permissions, publication, community, jobs and billing", async (t) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ["DB"],
      kvNamespaces: ["OAUTH_KV"],
      r2Buckets: ["MEDIA"],
      compatibilityDate: "2026-11-03",
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = await readFile("migrations/" + file, "utf8");
      for (const statement of sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await db.prepare(statement).run();
    }
    const bindings =
      await mf.getBindings<Pick<Bindings, "DB" | "MEDIA" | "OAUTH_KV">>();
    const env: Bindings = {
      ...bindings,
      ENVIRONMENT: "development",
      APP_ORIGIN: "http://localhost:8791",
      API_ORIGIN: "http://localhost:8791",
      MCP_OWNER_GITHUB_ID: "207296386",
      ENABLE_DEV_AUTH: "true",
      COLLECTION_ENABLED: "true",
      EMAIL_ALERTS_ENABLED: "false",
      RESEND_SENDER_VERIFIED: "false",
      ADMIN_TOKEN: "admin-test-only",
      COLLECTOR_TOKEN: "collector-test-only",
      DEV_AUTH_TOKEN: "dev-test-only",
      STRIPE_SECRET_KEY: "rk_test_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      STRIPE_PRICE_ID: "price_insider",
      MEDIA_SIGNING_SECRET: "media-test-only",
    };
    const req = (
      method: string,
      path: string,
      body?: unknown,
      credential?: string,
    ) =>
      app.request(
        "http://localhost:8791" + path,
        {
          method,
          headers: {
            ...(body !== undefined
              ? { "content-type": "application/json" }
              : {}),
            origin: env.APP_ORIGIN,
            ...(credential?.startsWith("cookie:")
              ? { cookie: credential.slice(7) }
              : credential
                ? { authorization: "Bearer " + credential }
                : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
        env,
      );
    async function json<T = Record<string, unknown>>(
      method: string,
      path: string,
      body?: unknown,
      credential?: string,
      expected = 200,
    ): Promise<T> {
      const r = await req(method, path, body, credential);
      const data = await r.json();
      assert.equal(r.status, expected, JSON.stringify(data));
      return data as T;
    }
    const admin = "admin-test-only",
      collector = "collector-test-only";
    let cookie = "",
      otherCookie = "",
      productId = "",
      evidenceId = "",
      blueprintId = "",
      shipId = "",
      sourceId = "";
    const input = {
      slug: "fixture-app",
      name: "Fixture app",
      url: "https://fixture-app.com",
      description: "A test app",
      category: "coding_dev",
      monetization: "credit_exhaustion",
    };
    await t.test(
      "unconfigured or unauthorized protected endpoints fail closed",
      async () => {
        assert.equal(
          (await req("POST", "/api/v1/admin/products", input)).status,
          401,
        );
        assert.equal(
          (await req("GET", "/api/v1/blueprints/none/export")).status,
          401,
        );
        assert.equal(
          (
            await req("POST", "/api/v1/collector/jobs/claim", {
              kinds: ["rss"],
            })
          ).status,
          401,
        );
        const prod = { ...env, ENVIRONMENT: "production" };
        assert.equal(
          (
            await app.request(
              "http://localhost:8791/auth/dev/session",
              {
                method: "POST",
                headers: {
                  authorization: "Bearer dev-test-only",
                  "content-type": "application/json",
                },
                body: '{"handle":"owner"}',
              },
              prod,
            )
          ).status,
          404,
        );
      },
    );
    await t.test(
      "local test sessions are isolated and mutations enforce Origin",
      async () => {
        const session = await req(
          "POST",
          "/auth/dev/session",
          { handle: "owner" },
          "dev-test-only",
        );
        assert.equal(session.status, 200);
        cookie = "cookie:" + session.headers.get("set-cookie")!.split(";")[0];
        const second = await req(
          "POST",
          "/auth/dev/session",
          { handle: "other" },
          "dev-test-only",
        );
        otherCookie =
          "cookie:" + second.headers.get("set-cookie")!.split(";")[0];
        const me = await json<{ user: { id: string }; insider: boolean }>(
          "GET",
          "/api/v1/me",
          undefined,
          cookie,
        );
        assert.equal(me.user.id, "dev:owner");
        assert.equal(me.insider, false);
        const forged = await app.request(
          "http://localhost:8791/api/v1/ship",
          {
            method: "POST",
            headers: {
              cookie: cookie.slice(7),
              origin: "https://evil.com",
              "content-type": "application/json",
            },
            body: "{}",
          },
          env,
        );
        assert.equal(forged.status, 403);
      },
    );
    await t.test(
      "draft products stay private and require approved evidence",
      async () => {
        productId = (
          await json<{ id: string }>(
            "POST",
            "/api/v1/admin/products",
            input,
            admin,
            201,
          )
        ).id;
        assert.equal(
          (await json<{ items: unknown[] }>("GET", "/api/v1/radar")).items
            .length,
          0,
        );
        assert.equal(
          (await req("GET", "/api/v1/vault/fixture-app")).status,
          404,
        );
        assert.equal(
          (
            await req(
              "PUT",
              `/api/v1/admin/products/${productId}/status`,
              { status: "published" },
              admin,
            )
          ).status,
          409,
        );
        assert.equal(
          (await req("POST", "/api/v1/admin/products", input, admin)).status,
          409,
        );
        const evidence = {
          productId,
          sourceUrl: input.url,
          observedAt: "2026-01-01T12:00:00.000Z",
          kind: "manual",
          contentHash: "a".repeat(64),
          summary: "Observed a credit gate",
          payload: { private: "never public" },
        };
        evidenceId = (
          await json<{ id: string }>(
            "POST",
            "/api/v1/admin/evidence",
            evidence,
            admin,
            201,
          )
        ).id;
        assert.equal(
          (
            await json<{ id: string }>(
              "POST",
              "/api/v1/admin/evidence",
              evidence,
              admin,
              201,
            )
          ).id,
          evidenceId,
        );
        assert.equal(
          (
            await req(
              "PUT",
              `/api/v1/admin/products/${productId}/status`,
              { status: "published" },
              admin,
            )
          ).status,
          409,
        );
        await json(
          "PUT",
          `/api/v1/admin/evidence/${evidenceId}/status`,
          { status: "approved" },
          admin,
        );
      },
    );
    await t.test(
      "evidence ownership and state transitions are validated",
      async () => {
        assert.equal(
          (
            await req(
              "PUT",
              `/api/v1/admin/products/${productId}/funnel`,
              [
                {
                  position: 0,
                  title: "Paywall",
                  stage: "paywall",
                  annotation: "Observed",
                  evidenceId: "unrelated",
                },
              ],
              admin,
            )
          ).status,
          422,
        );
        assert.equal(
          paywallInput.safeParse({
            evidenceId,
            pattern: "credit_exhaustion",
            states: ["free"],
            transitions: [{ from: "free", to: "paid", trigger: "upgrade" }],
            creditRules: {},
            notes: "",
          }).success,
          false,
        );
        const step = {
          position: 0,
          title: "Paywall",
          stage: "paywall",
          annotation: "Observed credit gate",
          evidenceId,
        };
        // Preserve an existing, pre-versioning state, and exercise the actual 100-step API boundary.
        await bindings.DB.prepare(
          "INSERT INTO funnel_steps VALUES ('legacy-step',?,0,'Paywall','paywall','Observed credit gate',?,NULL)",
        )
          .bind(productId, evidenceId)
          .run();
        let queries = 0;
        const originalDb = env.DB;
        env.DB = {
          prepare(sql: string) {
            queries++;
            return originalDb.prepare(sql);
          },
          batch: originalDb.batch.bind(originalDb),
        } as D1Database;
        await json(
          "PUT",
          `/api/v1/admin/products/${productId}/funnel`,
          Array.from({ length: 100 }, (_, position) => ({ ...step, position })),
          admin,
        );
        env.DB = originalDb;
        assert.ok(
          queries <= 50,
          `100-step replacement used ${queries} queries`,
        );
        const auditList = await json<{
          items: { detail: string | null; detail_omitted: number }[];
        }>("GET", "/api/v1/admin/audit", undefined, admin);
        assert.ok(
          auditList.items.some(
            (row) => row.detail_omitted && row.detail === null,
          ),
          "Large snapshots must not expand the generic audit listing",
        );
        const history = await json<{
          items: { id: string; baseline: number }[];
        }>(
          "GET",
          `/api/v1/admin/products/${productId}/flow-history`,
          undefined,
          admin,
        );
        const baseline = history.items.find((v) => v.baseline)!.id;
        const oldFlow = await json<{
          steps: { annotation: string }[];
          totalSteps: number;
        }>(
          "GET",
          `/api/v1/admin/products/${productId}/flow-history/${baseline}`,
          undefined,
          admin,
        );
        assert.equal(oldFlow.totalSteps, 1);
        assert.equal(oldFlow.steps[0].annotation, step.annotation);
        assert.equal(
          (
            await req(
              "GET",
              `/api/v1/admin/products/another-product/flow-history/${baseline}`,
              undefined,
              admin,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await req(
              "GET",
              `/api/v1/admin/products/${productId}/flow-history/${baseline}`,
            )
          ).status,
          401,
        );
        await json(
          "PUT",
          `/api/v1/admin/products/${productId}/funnel`,
          [step],
          admin,
        );
        await json(
          "PUT",
          `/api/v1/admin/products/${productId}/status`,
          { status: "published" },
          admin,
        );
        const beforeNoop = await originalDb
          .prepare("SELECT id FROM funnel_steps WHERE product_id=?")
          .bind(productId)
          .first();
        assert.equal(
          (
            await json(
              "PUT",
              `/api/v1/admin/products/${productId}/funnel`,
              [step],
              admin,
            )
          ).unchanged,
          true,
        );
        assert.deepEqual(
          await originalDb
            .prepare("SELECT id FROM funnel_steps WHERE product_id=?")
            .bind(productId)
            .first(),
          beforeNoop,
        );
        assert.equal(
          (await originalDb
            .prepare("SELECT status FROM products WHERE id=?")
            .bind(productId)
            .first())!.status,
          "published",
        );
        const paywall = {
          evidenceId,
          pattern: "credit_exhaustion",
          states: ["free", "exhausted", "paid"],
          transitions: [
            { from: "free", to: "exhausted", trigger: "last credit spent" },
            { from: "exhausted", to: "paid", trigger: "payment confirmed" },
          ],
          creditRules: { observedFreeCredits: 3 },
          notes: "Observed fixture only",
        };
        const firstPaywall = await json<{ revisionId: string }>(
          "PUT",
          `/api/v1/admin/products/${productId}/paywall`,
          paywall,
          admin,
        );
        assert.equal(
          (
            await json(
              "PUT",
              `/api/v1/admin/products/${productId}/paywall`,
              paywall,
              admin,
            )
          ).unchanged,
          true,
        );
        await json(
          "PUT",
          `/api/v1/admin/products/${productId}/paywall`,
          { ...paywall, notes: "Second observed fixture state" },
          admin,
        );
        const oldPaywall = await json<{ snapshot: { notes: string } }>(
          "GET",
          `/api/v1/admin/products/${productId}/flow-history/${firstPaywall.revisionId}`,
          undefined,
          admin,
        );
        assert.equal(oldPaywall.snapshot.notes, paywall.notes);
        await json(
          "POST",
          `/api/v1/admin/products/${productId}/signals`,
          {
            evidenceId,
            kind: "ad_observed",
            externalId: "ad-1",
            observedAt: "2026-01-01T12:00:00.000Z",
            sourceUrl: input.url,
            detail: {},
          },
          admin,
          201,
        );
      },
    );
    await t.test(
      "published signals hide incomplete app captures and raw payload",
      async () => {
        await json(
          "PUT",
          `/api/v1/admin/products/${productId}/status`,
          { status: "published" },
          admin,
        );
        const vault = await json<{
          evidence: Record<string, unknown>[];
          adObservations: { observed_days: number };
          funnel: unknown[];
        }>("GET", "/api/v1/vault/fixture-app", undefined, cookie);
        assert.equal(vault.evidence.length, 0);
        assert.equal(vault.adObservations.observed_days, 1);
        assert.equal(vault.funnel.length, 0);
        const radar = await json<{ items: unknown[] }>(
          "GET",
          "/api/v1/radar?q=Fixture&category=coding_dev",
        );
        assert.equal(radar.items.length, 1);
        assert.equal(
          (await json<{ items: unknown[] }>("GET", "/api/v1/radar?q=%25")).items
            .length,
          0,
        );
      },
    );
    await t.test(
      "blueprints are versioned and exports require sign-in",
      async () => {
        const spec = {
          summary: "Credit gate implementation",
          evidenceIds: [evidenceId],
          databaseTables: [
            {
              name: "credit_ledger",
              purpose: "Track debits and grants",
              columns: ["id", "user_id", "amount"],
            },
          ],
          middleware: ["Atomically debit before generation"],
          stateTransitions: [],
          components: ["Credit balance"],
          implementationNotes: ["Use server-side idempotency"],
          assumptions: ["Observed UI does not reveal internal implementation"],
        };
        blueprintId = (
          await json<{ id: string }>(
            "POST",
            `/api/v1/admin/products/${productId}/blueprints`,
            { title: "Credit gate", spec },
            admin,
            201,
          )
        ).id;
        assert.equal(
          (
            await req(
              "GET",
              `/api/v1/blueprints/${blueprintId}/export`,
              undefined,
              cookie,
            )
          ).status,
          404,
        );
        await json(
          "PUT",
          `/api/v1/admin/blueprints/${blueprintId}/status`,
          { status: "published" },
          admin,
        );
        const exported = await json<{ version: number; spec: typeof spec }>(
          "GET",
          `/api/v1/blueprints/${blueprintId}/export`,
          undefined,
          cookie,
        );
        assert.equal(exported.version, 1);
        assert.equal(exported.spec.assumptions.length, 1);
        assert.equal(
          (await req("GET", `/api/v1/blueprints/${blueprintId}/export`)).status,
          401,
        );
      },
    );
    await t.test(
      "Ship moderation, ownership and idempotent voting hold",
      async () => {
        const submission = {
          name: "My app",
          url: "https://my-test-app.com",
          description: "A community build",
          stack: ["TypeScript"],
          monetization: "unknown",
        };
        shipId = (
          await json<{ id: string }>(
            "POST",
            "/api/v1/ship",
            submission,
            cookie,
            201,
          )
        ).id;
        assert.equal(
          (await json<{ items: unknown[] }>("GET", "/api/v1/ship")).items
            .length,
          0,
        );
        assert.equal(
          (
            await req(
              "DELETE",
              `/api/v1/ship/${shipId}`,
              undefined,
              otherCookie,
            )
          ).status,
          404,
        );
        await json(
          "PUT",
          `/api/v1/admin/ship/${shipId}/status`,
          { status: "approved" },
          admin,
        );
        await json("PUT", `/api/v1/ship/${shipId}/vote`, {}, otherCookie);
        await json("PUT", `/api/v1/ship/${shipId}/vote`, {}, otherCookie);
        const board = await json<{
          items: { votes: number; email?: string }[];
        }>("GET", "/api/v1/ship");
        assert.equal(board.items[0].votes, 1);
        assert.equal(board.items[0].email, undefined);
        await json(
          "DELETE",
          `/api/v1/ship/${shipId}/vote`,
          undefined,
          otherCookie,
        );
        assert.equal(
          (
            await req(
              "PUT",
              `/api/v1/admin/ship/${shipId}/status`,
              { status: "reviewed" },
              admin,
            )
          ).status,
          422,
        );
        await json("PATCH", `/api/v1/ship/${shipId}`, submission, cookie);
        assert.equal(
          (await json<{ items: unknown[] }>("GET", "/api/v1/ship")).items
            .length,
          0,
        );
      },
    );
    await t.test(
      "saves work for free users; free keys only export; collections require Insider",
      async () => {
        await json("PUT", `/api/v1/me/saves/${productId}`, {}, cookie);
        await json("PUT", `/api/v1/me/saves/${productId}`, {}, cookie);
        assert.equal(
          (
            await json<{ items: unknown[] }>(
              "GET",
              "/api/v1/me/saves",
              undefined,
              cookie,
            )
          ).items.length,
          1,
        );
        assert.equal(
          (
            await req(
              "POST",
              "/api/v1/me/collections",
              { name: "Patterns" },
              cookie,
            )
          ).status,
          403,
        );
        const key = await json<{ id: string; token: string }>(
          "POST",
          "/api/v1/me/api-keys",
          { name: "IDE" },
          cookie,
          201,
        );
        await json(
          "GET",
          `/api/v1/blueprints/${blueprintId}/export`,
          undefined,
          key.token,
        );
        for (const [method, path] of [
          ["PUT", `/api/v1/me/saves/${productId}`],
          ["GET", "/api/v1/me/saves"],
          ["POST", "/api/v1/me/collections"],
        ] as const)
          assert.equal(
            (
              await req(
                method,
                path,
                method === "GET" ? undefined : { name: "Scope" },
                key.token,
              )
            ).status,
            403,
          );
        await db
          .prepare(
            "INSERT INTO subscriptions(user_id,customer_id,subscription_id,status,price_id,period_end,updated_at) VALUES (?,?,?,?,?,?,?)",
          )
          .bind(
            "dev:owner",
            "cus_owner",
            "sub_owner",
            "active",
            "price_insider",
            "2099-01-01T00:00:00.000Z",
            new Date().toISOString(),
          )
          .run();
        const collection = (
          await json<{ id: string }>(
            "POST",
            "/api/v1/me/collections",
            { name: "Patterns" },
            cookie,
            201,
          )
        ).id;
        await json(
          "PUT",
          `/api/v1/me/collections/${collection}/items/${productId}`,
          {},
          cookie,
        );
        assert.equal(
          (
            await req(
              "GET",
              `/api/v1/me/collections/${collection}`,
              undefined,
              otherCookie,
            )
          ).status,
          404,
        );
        const stored = await db
          .prepare("SELECT token_hash FROM api_keys WHERE id=?")
          .bind(key.id)
          .first<{ token_hash: string }>();
        assert.equal(stored!.token_hash, await sha256(key.token));
        assert.notEqual(stored!.token_hash, key.token);
        assert.equal(
          (
            await req(
              "POST",
              "/api/v1/me/api-keys",
              { name: "Escalation" },
              key.token,
            )
          ).status,
          403,
        );
        await db
          .prepare(
            "UPDATE subscriptions SET status='canceled' WHERE user_id='dev:owner'",
          )
          .run();
        await json(
          "GET",
          `/api/v1/blueprints/${blueprintId}/export`,
          undefined,
          key.token,
        );
        assert.equal(
          (await req("GET", "/api/v1/me/saves", undefined, key.token)).status,
          403,
        );
        const exportBucket = `export:dev:owner:${Math.floor(Date.now() / 86_400_000)}`;
        await db
          .prepare("UPDATE rate_limits SET hits=10 WHERE key=?")
          .bind(exportBucket)
          .run();
        assert.equal(
          (
            await req(
              "GET",
              `/api/v1/blueprints/${blueprintId}/export`,
              undefined,
              key.token,
            )
          ).status,
          429,
        );
        await db
          .prepare("DELETE FROM rate_limits WHERE key=?")
          .bind(exportBucket)
          .run();
        await db
          .prepare(
            "UPDATE subscriptions SET status='active' WHERE user_id='dev:owner'",
          )
          .run();
        await json(
          "DELETE",
          "/api/v1/me/api-keys/" + key.id,
          undefined,
          cookie,
        );
        assert.equal(
          (
            await req(
              "GET",
              `/api/v1/blueprints/${blueprintId}/export`,
              undefined,
              key.token,
            )
          ).status,
          401,
        );
      },
    );
    await t.test(
      "evidence retraction immediately removes published content and exports",
      async () => {
        await json(
          "PUT",
          `/api/v1/admin/evidence/${evidenceId}/status`,
          { status: "rejected" },
          admin,
        );
        assert.equal(
          (await req("GET", "/api/v1/vault/fixture-app")).status,
          404,
        );
        assert.equal(
          (
            await req(
              "GET",
              `/api/v1/blueprints/${blueprintId}/export`,
              undefined,
              cookie,
            )
          ).status,
          404,
        );
      },
    );
    await t.test(
      "job scheduling deduplicates and atomic claims cannot double-lease",
      async () => {
        sourceId = (
          await json<{ id: string }>(
            "POST",
            "/api/v1/admin/sources",
            {
              productId,
              name: "Public fixture",
              url: input.url,
              kind: "public_page",
              enabled: true,
              intervalHours: 24,
            },
            admin,
            201,
          )
        ).id;
        const [a, b] = await Promise.all([enqueueDue(env), enqueueDue(env)]);
        assert.equal(a.enqueued + b.enqueued, 1);
        const [x, y] = await Promise.all([
          json<{ job: { id: string; leaseToken: string } | null }>(
            "POST",
            "/api/v1/collector/jobs/claim",
            { kinds: ["public_page"] },
            collector,
          ),
          json<{ job: { id: string; leaseToken: string } | null }>(
            "POST",
            "/api/v1/collector/jobs/claim",
            { kinds: ["public_page"] },
            collector,
          ),
        ]);
        assert.equal(Number(!!x.job) + Number(!!y.job), 1);
        const job = x.job ?? y.job;
        assert.ok(job);
        assert.equal(
          (
            await req(
              "POST",
              `/api/v1/collector/jobs/${job.id}/complete`,
              { leaseToken: "b".repeat(64), evidence: [] },
              collector,
            )
          ).status,
          422,
        );
        await json(
          "POST",
          `/api/v1/collector/jobs/${job.id}/heartbeat`,
          { leaseToken: job.leaseToken },
          collector,
        );
        const evidence = {
          sourceUrl: input.url,
          observedAt: new Date().toISOString(),
          kind: "page",
          contentHash: "c".repeat(64),
          summary: "Public metadata only",
          payload: { title: "Fixture" },
        };
        assert.equal(
          (
            await req(
              "POST",
              `/api/v1/collector/jobs/${job.id}/complete`,
              {
                leaseToken: job.leaseToken,
                evidence: [
                  { ...evidence, sourceUrl: "https://wrong-host.com" },
                ],
              },
              collector,
            )
          ).status,
          422,
        );
        await json(
          "POST",
          `/api/v1/collector/jobs/${job.id}/complete`,
          { leaseToken: job.leaseToken, evidence: [evidence] },
          collector,
        );
        assert.equal(
          (
            await req(
              "POST",
              `/api/v1/collector/jobs/${job.id}/fail`,
              { leaseToken: job.leaseToken, error: "stale worker" },
              collector,
            )
          ).status,
          409,
        );
        const stored = await db
          .prepare("SELECT status FROM evidence WHERE content_hash=?")
          .bind("c".repeat(64))
          .first<{ status: string }>();
        assert.equal(stored!.status, "draft");
      },
    );
    await t.test(
      "expired leases are reclaimed, stale tokens rejected and retries bounded",
      async () => {
        await db
          .prepare(
            "UPDATE sources SET next_run_at='2026-01-01T00:00:00.000Z' WHERE id=?",
          )
          .bind(sourceId)
          .run();
        await enqueueDue(env);
        const first = (
          await json<{ job: { id: string; leaseToken: string } }>(
            "POST",
            "/api/v1/collector/jobs/claim",
            { kinds: ["public_page"] },
            collector,
          )
        ).job;
        await db
          .prepare(
            "UPDATE jobs SET lease_expires_at='2026-01-01T00:00:00.000Z' WHERE id=?",
          )
          .bind(first.id)
          .run();
        const second = (
          await json<{ job: { id: string; leaseToken: string } }>(
            "POST",
            "/api/v1/collector/jobs/claim",
            { kinds: ["public_page"] },
            collector,
          )
        ).job;
        assert.equal(second.id, first.id);
        assert.notEqual(second.leaseToken, first.leaseToken);
        assert.equal(
          (
            await req(
              "POST",
              `/api/v1/collector/jobs/${first.id}/heartbeat`,
              { leaseToken: first.leaseToken },
              collector,
            )
          ).status,
          409,
        );
        await db
          .prepare("UPDATE jobs SET attempts=max_attempts WHERE id=?")
          .bind(second.id)
          .run();
        await json(
          "POST",
          `/api/v1/collector/jobs/${second.id}/fail`,
          {
            leaseToken: second.leaseToken,
            error: "Provider authentication failed",
          },
          collector,
        );
        const row = await db
          .prepare("SELECT status,error FROM jobs WHERE id=?")
          .bind(second.id)
          .first<{ status: string; error: string }>();
        assert.equal(row!.status, "failed");
        assert.match(row!.error, /authentication/);
        await json("POST", `/api/v1/admin/jobs/${second.id}/retry`, {}, admin);
      },
    );
    await t.test(
      "screenshot uploads use single-use links and must match the evidence hash",
      async () => {
        const shot = await sharp({
          create: { width: 40, height: 30, channels: 3, background: "#fff" },
        })
          .jpeg()
          .toBuffer();
        const { id: shotEvidence } = await json<{ id: string }>(
          "POST",
          "/api/v1/admin/evidence",
          {
            productId,
            sourceUrl: input.url,
            observedAt: "2026-01-02T12:00:00.000Z",
            kind: "screenshot",
            contentHash: await sha256(shot.buffer as ArrayBuffer),
            summary: "Homepage viewport",
            payload: {},
          },
          admin,
          201,
        );
        const link = () =>
          json<{ uploadUrl: string }>(
            "POST",
            "/api/v1/media/uploads",
            { evidenceId: shotEvidence, contentType: "image/jpeg" },
            collector,
            201,
          );
        const put = (url: string, body: Buffer) =>
          app.request(
            url.replace(env.API_ORIGIN, "http://localhost:8791"),
            {
              method: "PUT",
              headers: { "content-type": "image/jpeg" },
              body: new Uint8Array(body),
            },
            env,
          );
        const placeholder = await sharp({
          create: { width: 8, height: 8, channels: 3, background: "#888" },
        })
          .jpeg()
          .toBuffer();
        assert.equal(
          (await put((await link()).uploadUrl, placeholder)).status,
          422,
        );
        const { uploadUrl } = await link();
        assert.equal((await put(uploadUrl, shot)).status, 201);
        assert.equal((await put(uploadUrl, shot)).status, 404);
        assert.equal(
          (
            await req("POST", "/api/v1/media/uploads", {
              evidenceId: shotEvidence,
              contentType: "image/jpeg",
            })
          ).status,
          401,
        );
      },
    );
    await t.test(
      "media requires evidence approval and stays private until reviewed",
      async () => {
        const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
        const uploaded = await app.request(
          "http://localhost:8791/api/v1/media/upload",
          {
            method: "POST",
            headers: {
              authorization: "Bearer " + collector,
              "content-type": "image/png",
              "x-evidence-id": evidenceId,
            },
            body: png,
          },
          env,
        );
        assert.equal(uploaded.status, 201);
        const asset = (await uploaded.json()) as { id: string };
        assert.equal(
          (await req("GET", "/api/v1/media/" + asset.id)).status,
          403,
        );
        // A valid link still can't reach an image that hasn't been approved.
        assert.equal(
          (await req("GET", (await signedMediaUrl(env, asset.id))!)).status,
          404,
        );
        assert.equal(
          (await req("GET", "/api/v1/media/" + asset.id + "/review")).status,
          401,
        );
        assert.equal(
          (
            await req(
              "GET",
              "/api/v1/media/" + asset.id + "/review",
              undefined,
              admin,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await req(
              "PUT",
              "/api/v1/media/" + asset.id + "/approval",
              { approved: true },
              admin,
            )
          ).status,
          409,
        );
        const synthetic = await sharp({
          create: {
            width: 640,
            height: 400,
            channels: 3,
            background: "#147b8f",
          },
        })
          .png()
          .toBuffer();
        const thumbnail = await makeThumbnail(synthetic);
        assert.ok(validThumbnail(thumbnail));
        const uploadThumbnail = (
          body: Buffer,
          credential = admin,
          bindings = env,
        ) =>
          app.request(
            "http://localhost:8791/api/v1/media/" + asset.id + "/thumbnail",
            {
              method: "POST",
              headers: {
                authorization: "Bearer " + credential,
                "content-type": "image/webp",
              },
              body: new Uint8Array(body),
            },
            bindings,
          );
        assert.equal((await uploadThumbnail(thumbnail, collector)).status, 401);
        assert.equal((await uploadThumbnail(thumbnail)).status, 201);
        assert.deepEqual(
          Buffer.from(
            await (
              await req(
                "GET",
                "/api/v1/media/" + asset.id + "/review?variant=thumbnail",
                undefined,
                admin,
              )
            ).arrayBuffer(),
          ),
          thumbnail,
        );
        assert.equal(
          (await req("GET", "/api/v1/media/" + asset.id + "/thumbnail")).status,
          404,
        );
        const prior = await db
          .prepare(
            "SELECT e.status evidence_status,p.status product_status,p.coverage_level FROM evidence e JOIN products p ON p.id=e.product_id WHERE e.id=?",
          )
          .bind(evidenceId)
          .first<{
            evidence_status: string;
            product_status: string;
            coverage_level: string;
          }>();
        await db.batch([
          db
            .prepare("UPDATE evidence SET status='approved' WHERE id=?")
            .bind(evidenceId),
          db
            .prepare(
              "UPDATE products SET status='published',coverage_level='full' WHERE id=?",
            )
            .bind(productId),
          db.prepare("UPDATE assets SET approved=1 WHERE id=?").bind(asset.id),
        ]);
        const publicThumbnail = await req(
          "GET",
          "/api/v1/media/" + asset.id + "/thumbnail",
        );
        assert.equal(publicThumbnail.status, 200);
        assert.deepEqual(
          Buffer.from(await publicThumbnail.arrayBuffer()),
          thumbnail,
        );
        assert.equal(
          (await req("GET", "/api/v1/media/" + asset.id)).status,
          403,
        );
        await db
          .prepare("UPDATE evidence SET status='draft' WHERE id=?")
          .bind(evidenceId)
          .run();
        assert.equal(
          (await req("GET", "/api/v1/media/" + asset.id + "/thumbnail")).status,
          404,
        );
        await db.batch([
          db
            .prepare("UPDATE evidence SET status=? WHERE id=?")
            .bind(prior!.evidence_status, evidenceId),
          db
            .prepare("UPDATE products SET status=?,coverage_level=? WHERE id=?")
            .bind(prior!.product_status, prior!.coverage_level, productId),
          db.prepare("UPDATE assets SET approved=0 WHERE id=?").bind(asset.id),
        ]);
        await db
          .prepare("UPDATE assets SET size=? WHERE id=?")
          .bind(MEDIA_LIMIT_BYTES - thumbnail.byteLength, asset.id)
          .run();
        const denied = await app.request(
          "http://localhost:8791/api/v1/media/upload",
          {
            method: "POST",
            headers: {
              authorization: "Bearer " + collector,
              "content-type": "image/png",
              "x-evidence-id": evidenceId,
            },
            body: png,
          },
          env,
        );
        assert.equal(denied.status, 409);
        assert.match(await denied.text(), /quota reached/);
        await db
          .prepare("UPDATE assets SET size=? WHERE id=?")
          .bind(png.byteLength, asset.id)
          .run();
        const broken = {
          ...env,
          MEDIA: {
            put: async () => {
              throw new Error("fixture storage failure");
            },
          } as unknown as R2Bucket,
        };
        const before = await db
          .prepare("SELECT count(*) n FROM assets")
          .first<{ n: number }>();
        const failed = await app.request(
          "http://localhost:8791/api/v1/media/upload",
          {
            method: "POST",
            headers: {
              authorization: "Bearer " + collector,
              "content-type": "image/png",
              "x-evidence-id": evidenceId,
            },
            body: png,
          },
          broken,
        );
        assert.equal(failed.status, 500);
        assert.equal(
          (await db
            .prepare("SELECT count(*) n FROM assets")
            .first<{ n: number }>())!.n,
          before!.n,
        );
      },
    );
    await t.test(
      "webhook signatures are verified and duplicates are idempotent",
      async () => {
        const payload = JSON.stringify({
          id: "evt_noop",
          object: "event",
          type: "ping",
          created: 123,
          livemode: false,
          data: { object: {} },
        });
        const signature = Stripe.webhooks.generateTestHeaderString({
          payload,
          secret: "whsec_fixture",
        });
        const send = (sig: string) =>
          app.request(
            "http://localhost:8791/api/v1/billing/webhook",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "stripe-signature": sig,
              },
              body: payload,
            },
            env,
          );
        assert.equal((await send("t=1,v1=bad")).status, 400);
        assert.equal((await send(signature)).status, 200);
        const repeat = await send(signature);
        assert.equal(
          ((await repeat.json()) as { duplicate: boolean }).duplicate,
          true,
        );
      },
    );
    await t.test(
      "billing reconciles current provider state and risk holds override Insider",
      async () => {
        const canceled = {
          id: "sub_owner",
          object: "subscription",
          created: 100,
          customer: "cus_owner",
          status: "canceled",
          items: {
            object: "list",
            data: [
              {
                id: "si_owner",
                price: { id: "price_insider" },
                current_period_end: 4070908800,
              },
            ],
          },
        };
        const stripe = new Stripe("rk_test_fixture", {
          httpClient: Stripe.createFetchHttpClient(async () =>
            Response.json(canceled),
          ),
        });
        const event = {
          id: "evt_canceled",
          object: "event",
          type: "customer.subscription.updated",
          created: 123,
          livemode: false,
          data: { object: { id: "sub_owner", customer: "cus_owner" } },
        } as Stripe.Event;
        await processStripeEvent(env, event, stripe);
        const row = await db
          .prepare("SELECT status FROM subscriptions WHERE user_id='dev:owner'")
          .first<{ status: string }>();
        assert.equal(row!.status, "canceled");
        const offPlan = new Stripe("rk_test_fixture", {
          httpClient: Stripe.createFetchHttpClient(async () =>
            Response.json({
              ...canceled,
              status: "active",
              items: {
                object: "list",
                data: [
                  {
                    id: "si_other",
                    price: { id: "price_other" },
                    current_period_end: 4070908800,
                  },
                ],
              },
            }),
          ),
        });
        await processStripeEvent(
          env,
          { ...event, id: "evt_off_plan", created: 125 } as Stripe.Event,
          offPlan,
        );
        const removed = await db
          .prepare(
            "SELECT status,period_end FROM subscriptions WHERE user_id='dev:owner'",
          )
          .first<{ status: string; period_end: string | null }>();
        assert.equal(removed!.status, "inactive");
        assert.equal(removed!.period_end, null);
        await db
          .prepare(
            "UPDATE subscriptions SET status='active',period_end='2099-01-01T00:00:00.000Z' WHERE user_id='dev:owner'",
          )
          .run();
        const risk = {
          id: "evt_refund",
          object: "event",
          type: "charge.refunded",
          created: 124,
          livemode: false,
          data: { object: { id: "ch_owner", customer: "cus_owner" } },
        } as Stripe.Event;
        await processStripeEvent(env, risk, stripe);
        const me = await json<{ insider: boolean }>(
          "GET",
          "/api/v1/me",
          undefined,
          cookie,
        );
        assert.equal(me.insider, false);
        // Check the displayed offer against actual Checkout parameters, with no provider network.
        const originalFetch = globalThis.fetch;
        const checkoutRequests: {
          currency: string | null;
          adaptive: string | null;
          key: string | null;
        }[] = [];
        let amount = 1199;
        globalThis.fetch = (async (url, options) => {
          const path = new URL(String(url)).pathname;
          if (path.startsWith("/v1/prices/"))
            return Response.json({
              id: "price_insider",
              active: true,
              currency: "usd",
              unit_amount: amount,
              currency_options: { cad: { unit_amount: 1199 } },
              recurring: { interval: "month", interval_count: 1 },
              product: { id: "prod_pro", active: true, name: "ArcX Pro" },
            });
          if (path === "/v1/customers")
            return Response.json({ id: "cus_regional" });
          if (path === "/v1/subscriptions") return Response.json({ data: [] });
          if (path === "/v1/checkout/sessions") {
            const body = new URLSearchParams(String(options?.body));
            checkoutRequests.push({
              currency: body.get("currency"),
              adaptive: body.get("adaptive_pricing[enabled]"),
              key: new Headers(options?.headers).get("idempotency-key"),
            });
            return Response.json({
              url: "https://checkout.stripe.com/test_fixture",
            });
          }
          throw new Error("Unexpected provider request: " + path);
        }) as typeof fetch;
        try {
          for (const country of ["CA", "US", undefined]) {
            const request = new Request(
              "http://localhost:8791/api/v1/billing/price",
              { headers: { "cf-ipcountry": "CA" } },
            );
            if (country)
              Object.defineProperty(request, "cf", { value: { country } });
            const response = await app.fetch(request, env);
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.deepEqual(await response.json(), {
              planName: "ArcX Pro",
              currency: country === "CA" ? "cad" : "usd",
              unitAmount: 1199,
              interval: "month",
            });
          }
          for (const country of ["CA", "US"]) {
            const request = new Request(
              "http://localhost:8791/api/v1/billing/checkout",
              {
                method: "POST",
                headers: {
                  cookie: otherCookie.slice(7),
                  origin: env.APP_ORIGIN,
                },
              },
            );
            Object.defineProperty(request, "cf", { value: { country } });
            const response = await app.fetch(request, env);
            assert.equal(response.status, 200, await response.text());
          }
          assert.deepEqual(
            checkoutRequests.map(({ currency, adaptive }) => ({
              currency,
              adaptive,
            })),
            [
              { currency: "cad", adaptive: "false" },
              { currency: "usd", adaptive: "false" },
            ],
          );
          assert.notEqual(checkoutRequests[0].key, checkoutRequests[1].key);
          amount = 1200;
          assert.equal(
            (
              await req(
                "POST",
                "/api/v1/billing/checkout",
                undefined,
                otherCookie,
              )
            ).status,
            503,
          );
          assert.equal(checkoutRequests.length, 2);
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    );
    await t.test(
      "URL, parser and size limits reject unsafe inputs",
      async () => {
        for (const u of [
          "http://example.com",
          "https://127.0.0.1",
          "https://[::1]",
          "https://10.0.0.1",
          "https://localhost",
          "https://host.internal",
          "https://user:pass@public.com",
        ])
          assert.equal(publicUrl.safeParse(u).success, false, u);
        for (const ip of [
          "127.0.0.1",
          "10.1.2.3",
          "192.168.1.1",
          "169.254.169.254",
          "172.16.0.1",
          "::1",
          "fc00::1",
          "::ffff:127.0.0.1",
        ])
          assert.equal(publicAddress(ip), false, ip);
        assert.equal(publicAddress("1.1.1.1"), true);
        assert.equal(publicAddress("2606:4700:4700::1111"), true);
        assert.equal(
          (
            await req(
              "POST",
              "/api/v1/admin/products",
              { ...input, description: "x".repeat(1_000_001) },
              admin,
            )
          ).status,
          413,
        );
      },
    );
    await t.test(
      "code captures are collector-only, first-party and hash-checked",
      async () => {
        const { id } = await json<{ id: string }>(
          "POST",
          "/api/v1/admin/products",
          { ...input, slug: "captured-app", url: "https://captured-app.com" },
          admin,
          201,
        );
        const image = await sharp({
          create: { width: 390, height: 844, channels: 3, background: "#fff" },
        })
          .webp()
          .toBuffer();
        const body = {
          page: "home",
          viewport: "mobile",
          sourceUrl: "https://www.captured-app.com/",
          observedAt: new Date().toISOString(),
          data: image.toString("base64"),
        };
        const path = `/api/v1/collector/captures/${id}`;
        assert.equal((await req("POST", path, body, admin)).status, 401);
        await json(
          "POST",
          path,
          { ...body, sourceUrl: "https://other-site.com/" },
          collector,
          422,
        );
        const saved = await json<{ evidenceId: string; assetId: string }>(
          "POST",
          path,
          body,
          collector,
          201,
        );
        const row = await env.DB.prepare(
          "SELECT e.kind,e.status,e.content_hash,a.sha256,a.approved FROM evidence e JOIN assets a ON a.evidence_id=e.id WHERE a.id=?",
        )
          .bind(saved.assetId)
          .first<Record<string, unknown>>();
        assert.equal(row?.kind, "screenshot");
        assert.equal(
          row?.status,
          "draft",
          "Captures stay private until review",
        );
        assert.equal(row?.approved, 0);
        assert.equal(row?.content_hash, row?.sha256);
      },
    );
    await t.test(
      "daily traffic ranks are collector-only and dated today",
      async () => {
        const { id } = await json<{ id: string }>(
          "POST",
          "/api/v1/admin/products",
          { ...input, slug: "ranked-app", url: "https://ranked-app.com" },
          admin,
          201,
        );
        const pending = await json<{
          observedOn: string;
          items: { productId: string; site: string }[];
        }>("GET", "/api/v1/collector/traffic/pending", undefined, collector);
        const item = pending.items.find((i) => i.productId === id);
        assert.equal(item?.site, "ranked-app.com");
        const body = {
          listId: "K9YYW",
          observedOn: pending.observedOn,
          ranks: [{ productId: id, site: "ranked-app.com", rank: 4200 }],
        };
        assert.equal(
          (await req("POST", "/api/v1/collector/traffic/ranks", body, admin))
            .status,
          401,
        );
        await json(
          "POST",
          "/api/v1/collector/traffic/ranks",
          { ...body, observedOn: "2020-01-01" },
          collector,
          409,
        );
        await json("POST", "/api/v1/collector/traffic/ranks", body, collector);
        const again = await json<{ items: { productId: string }[] }>(
          "GET",
          "/api/v1/collector/traffic/pending",
          undefined,
          collector,
        );
        assert.ok(!again.items.some((i) => i.productId === id));
      },
    );
    await t.test(
      "product icons are collector-written, bounded and public only once published",
      async () => {
        const { id } = await json<{ id: string }>(
          "POST",
          "/api/v1/admin/products",
          { ...input, slug: "icon-app", url: "https://icon-app.com" },
          admin,
          201,
        );
        const icon = await sharp({
          create: { width: 64, height: 64, channels: 4, background: "#5a7ba3" },
        })
          .webp()
          .toBuffer();
        const body = {
          status: "ok",
          sourceUrl: "https://icon-app.com/apple-touch-icon.png",
          data: icon.toString("base64"),
        };
        assert.equal(
          (await req("POST", `/api/v1/collector/icons/${id}`, body, admin))
            .status,
          401,
        );
        const big = await sharp({
          create: { width: 128, height: 128, channels: 3, background: "#000" },
        })
          .webp()
          .toBuffer();
        await json(
          "POST",
          `/api/v1/collector/icons/${id}`,
          { ...body, data: big.toString("base64") },
          collector,
          422,
        );
        await json("POST", `/api/v1/collector/icons/${id}`, body, collector);
        // A later failed check keeps the good icon.
        await json(
          "POST",
          `/api/v1/collector/icons/${id}`,
          { status: "missing", reason: "HTTP 503" },
          collector,
        );
        assert.equal((await req("GET", `/api/v1/icons/${id}`)).status, 404);
        assert.equal(
          (
            await req(
              "GET",
              `/api/v1/admin/products/${id}/icon`,
              undefined,
              admin,
            )
          ).status,
          200,
        );
        await env.DB.prepare(
          "UPDATE products SET status='published' WHERE id=?",
        )
          .bind(id)
          .run();
        const served = await req("GET", `/api/v1/icons/${id}`);
        assert.equal(served.status, 200);
        assert.deepEqual(Buffer.from(await served.arrayBuffer()), icon);
        const row = (
          await json<{ items: { id: string; icon_url: string | null }[] }>(
            "GET",
            "/api/v1/radar?q=Fixture",
          )
        ).items.find((p) => p.id === id);
        assert.match(row!.icon_url!, /\/api\/v1\/icons\/.+\?v=[0-9a-f]{16}$/);
      },
    );
    await t.test(
      "store stats enforce publication, bounded collector writes and daily upserts",
      async () => {
        const { id: ownId } = await json<{ id: string }>(
          "POST",
          "/api/v1/admin/products",
          {
            ...input,
            slug: "store-stats-app",
            url:
              "https://chromewebstore.google.com/detail/fixture/" +
              "c".repeat(32),
          },
          admin,
          201,
        );
        assert.equal(
          (
            await req(
              "GET",
              "/api/v1/collector/store-stats/pending",
              undefined,
              admin,
            )
          ).status,
          401,
        );
        const pending = await json<{
          items: { id: string; product_id: string }[];
        }>(
          "GET",
          "/api/v1/collector/store-stats/pending?limit=50",
          undefined,
          collector,
        );
        const listing = pending.items.find((s) => s.product_id === ownId)!;
        assert.ok(
          listing,
          "Product's own store URL must be discovered automatically",
        );
        const path = `/api/v1/collector/store-stats/${listing.id}/snapshot`;
        const body = {
          status: "ok",
          rating: 4.5,
          ratingCount: 10,
          installsOrUsers: 1000,
          installsLabel: "1,000 users",
          rawSha256: "a".repeat(64),
        };
        assert.equal((await req("POST", path, body, admin)).status, 401);
        for (const change of [
          { rating: 6 },
          { ratingCount: -1 },
          { installsOrUsers: 1.5 },
          { installsOrUsers: 1e13 },
          { price: -1 },
          { version: "v".repeat(101) },
          { rawSha256: "bad" },
          { observedOn: "2020-01-01" },
        ]) {
          await json("POST", path, { ...body, ...change }, collector, 422);
        }
        await json("POST", path, body, collector);
        await json("POST", path, { ...body, ratingCount: 11 }, collector);
        assert.equal(
          (await req("GET", `/api/v1/products/${ownId}/store-stats`)).status,
          404,
        );
        assert.equal(
          (await req("GET", "/api/v1/products/missing/store-stats")).status,
          404,
        );
        const after = await json<{ items: { id: string }[] }>(
          "GET",
          "/api/v1/collector/store-stats/pending?limit=50",
          undefined,
          collector,
        );
        assert.ok(!after.items.some((s) => s.id === listing.id));
        await json(
          "POST",
          path,
          { status: "failed", reason: "Store returned HTTP 429" },
          collector,
        );
        assert.equal(
          (await db
            .prepare("SELECT failure_streak FROM store_listings WHERE id=?")
            .bind(listing.id)
            .first<{ failure_streak: number }>())!.failure_streak,
          1,
        );
        assert.equal(
          (await db
            .prepare(
              "SELECT count(*) AS n FROM store_listing_snapshots WHERE listing_id=?",
            )
            .bind(listing.id)
            .first<{ n: number }>())!.n,
          1,
        );
        // A web product can have an extra listing; tracking/locale variants are duplicates.
        const extra = {
          listingUrl:
            "https://play.google.com/store/apps/details?id=com.fixture.app&hl=fr&gl=ca",
        };
        await json(
          "POST",
          `/api/v1/admin/products/${productId}/store-listings`,
          extra,
          admin,
          201,
        );
        await json(
          "POST",
          `/api/v1/admin/products/${productId}/store-listings`,
          {
            listingUrl:
              "https://play.google.com/store/apps/details?id=com.fixture.app",
          },
          admin,
          409,
        );
        await json(
          "POST",
          `/api/v1/admin/products/${productId}/store-listings`,
          { listingUrl: "https://play.google.com/store/apps/" },
          admin,
          422,
        );
        await db
          .prepare("UPDATE products SET status='published' WHERE id=?")
          .bind(ownId)
          .run();
        await db
          .prepare(
            `INSERT INTO store_listing_snapshots(listing_id,observed_on,rating_count,raw_sha256,created_at)
        WITH RECURSIVE days(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM days WHERE n<181)
        SELECT ?,date('now','-'||n||' days'),n,?,? FROM days`,
          )
          .bind(listing.id, "b".repeat(64), new Date().toISOString())
          .run();
        const stats = await json<{
          meaning: string;
          listings: {
            snapshots: { rating_count: number; observed_on: string }[];
          }[];
        }>("GET", `/api/v1/products/${ownId}/store-stats`);
        assert.match(stats.meaning, /not verified downloads/);
        assert.equal(stats.listings[0].snapshots.length, 180);
        assert.equal(
          stats.listings[0].snapshots.at(-1)!.rating_count,
          11,
          "Failure must preserve the last successful observation",
        );
        assert.equal(
          stats.listings[0].snapshots.at(-1)!.observed_on,
          new Date().toISOString().slice(0, 10),
        );
      },
    );
    await t.test(
      "store listings stay separate and near-duplicate candidates need confirmation",
      async () => {
        const candidate = (
          name: string,
          url: string,
          distinctFrom?: string[],
        ) => ({
          product: {
            slug: url
              .replace(/^https:\/\//, "")
              .replace(/\W+/g, "-")
              .slice(0, 60)
              .replace(/-$/, ""),
            name,
            url,
            description: "A browser extension",
            category: "coding_dev",
          },
          maker: {
            name: "Unknown operator",
            sourceUrl: url,
            evidence: "Listing names no operator beyond the publisher label.",
            sizeStatus: "unverified",
            currentSizeEvidence: "No current size source.",
          },
          ...(distinctFrom ? { distinctFrom } : {}),
        });
        const store = "https://chromewebstore.google.com/detail/";
        const first = await json<{ id: string; existing: boolean }>(
          "POST",
          "/api/v1/admin/research/candidates",
          candidate("Tab Pilot", store + "tab-pilot/" + "a".repeat(32)),
          admin,
          201,
        );
        const second = await json<{ id: string; existing: boolean }>(
          "POST",
          "/api/v1/admin/research/candidates",
          candidate("Clip Lens", store + "clip-lens/" + "b".repeat(32)),
          admin,
          201,
        );
        assert.notEqual(first.id, second.id);
        assert.equal(second.existing, false);
        // A bare store URL cannot identify one product.
        await json(
          "POST",
          "/api/v1/admin/research/candidates",
          candidate("Store Root", "https://chromewebstore.google.com/"),
          admin,
          422,
        );
        // The same name on the maker's own site is flagged until confirmed distinct.
        await json(
          "POST",
          "/api/v1/admin/research/candidates",
          candidate("Tab Pilot", "https://tabpilot.dev"),
          admin,
          409,
        );
        await json(
          "POST",
          "/api/v1/admin/research/candidates",
          candidate("Tab Pilot", "https://tabpilot.dev", [first.id]),
          admin,
          201,
        );
      },
    );
    await t.test(
      "review leases never overlap and auto-publish enforces server gates",
      async () => {
        const { id } = await json<{ id: string }>(
          "POST",
          "/api/v1/admin/research/candidates",
          {
            product: {
              slug: "queue-app",
              name: "Queue App",
              url: "https://queue-app.dev",
              description: "Turns prompts into landing pages",
              category: "coding_dev",
            },
            maker: {
              name: "Unknown operator",
              sourceUrl: "https://queue-app.dev",
              evidence: "The site names no operator beyond the product.",
              sizeStatus: "unverified",
              currentSizeEvidence: "No current size source.",
            },
          },
          admin,
          201,
        );
        const { id: evidence } = await json<{ id: string }>(
          "POST",
          "/api/v1/admin/evidence",
          {
            productId: id,
            sourceUrl: "https://queue-app.dev/",
            observedAt: new Date().toISOString(),
            kind: "page",
            contentHash: "c".repeat(64),
            summary: "Queue App — prompts to landing pages",
            payload: {},
          },
          admin,
          201,
        );
        await json(
          "POST",
          "/api/v1/admin/research/assessment",
          {
            productId: id,
            relevance: "in_scope",
            rationale:
              "Landing-page builder for AI-native founders, priced monthly",
            evidenceIds: [evidence],
            sizeStatus: "unverified",
            sizeBasis: "unknown",
            sizeNotes: "No current size source is public.",
            nextAction: "Review for publication",
          },
          admin,
          201,
        );
        const { nextWork, finishWork, recordReviewDecision } =
          await import("../src/work-queue");
        // Nothing is reviewed before its deep-research pass.
        assert.ok(
          !(await nextWork(env.DB, { task: "review", limit: 10 })).items.some(
            (p) => p.id === id,
          ),
        );
        const deep = await nextWork(env.DB, { task: "deep", limit: 10 });
        assert.ok(deep.items.some((p) => p.id === id));
        await finishWork(env.DB, {
          productId: id,
          task: "deep",
          summary: "Pricing page and homepage covered; no ads found.",
        });
        const first = await nextWork(env.DB, { task: "review", limit: 10 });
        assert.ok(first.items.some((p) => p.id === id));
        const second = await nextWork(env.DB, { task: "review", limit: 10 });
        assert.ok(!second.items.some((p) => p.id === id));
        const decision = {
          productId: id,
          decision: "publish" as const,
          reviewerModel: "fixture",
          reason: "Clear builder audience and first-party pricing source",
          checks: {
            audienceFit: true,
            claimsSupportedBySources: true,
            noPersonalData: true,
            notDuplicate: true,
          },
          approveAssetIds: [],
          withholdAssetIds: [],
          holdDays: 7,
        };
        // The homepage has not been checked yet, so publishing is refused.
        await assert.rejects(
          recordReviewDecision(env.DB, decision),
          /Homepage has no successful check/,
        );
        await env.DB.prepare(
          "UPDATE sources SET last_checked_at=? WHERE product_id=? AND lane='http'",
        )
          .bind(new Date().toISOString(), id)
          .run();
        await assert.rejects(
          recordReviewDecision(env.DB, {
            ...decision,
            checks: { ...decision.checks, noPersonalData: false },
          }),
          /reviewer checks must pass/,
        );
        await assert.rejects(
          recordReviewDecision(env.DB, {
            ...decision,
            withholdAssetIds: ["asset-of-another-product"],
          }),
          /must belong to this product/,
        );
        await recordReviewDecision(env.DB, decision);
        const row = (
          await json<{ items: { id: string }[] }>(
            "GET",
            "/api/v1/radar?q=Queue",
          )
        ).items.find((p) => p.id === id);
        assert.ok(row, "Published product appears in the public table");
        await assert.rejects(
          recordReviewDecision(env.DB, decision),
          /Lease this product/,
        );
      },
    );
    await t.test("logout revokes server session", async () => {
      await json("POST", "/auth/logout", {}, cookie);
      assert.equal(
        (await req("GET", "/api/v1/me", undefined, cookie)).status,
        401,
      );
    });
  } finally {
    await mf.dispose();
  }
});
