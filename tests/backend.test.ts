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
        await db
          .prepare("UPDATE assets SET size=50000000 WHERE id=?")
          .bind(asset.id)
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
