import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  collectorServer,
  assertCollector,
  COLLECT_SCOPE,
  remoteMcpFetch,
} from "../src/remote-mcp";
import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { candidateInput } from "../src/research";
import type { Bindings } from "../src/types";

test("private collector MCP restricts owner, scope and draft writes", async () => {
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
    const bindings = await mf.getBindings<Pick<Bindings, "DB" | "OAUTH_KV">>();
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      for (const sql of (await readFile("migrations/" + file, "utf8"))
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await bindings.DB.prepare(sql).run();
    const env: Bindings = {
      ...bindings,
      ENVIRONMENT: "development",
      APP_ORIGIN: "http://localhost:8791",
      API_ORIGIN: "http://localhost:8791",
      MCP_OWNER_GITHUB_ID: "42",
      ENABLE_DEV_AUTH: "false",
      COLLECTION_ENABLED: "false",
      ADMIN_TOKEN: "admin-fixture",
      COLLECTOR_TOKEN: "collector-fixture",
    };
    const props = {
      userId: "github:42",
      githubId: "42",
      role: "collector" as const,
    };
    assert.throws(() =>
      assertCollector(env, { ...props, githubId: "other" }, [COLLECT_SCOPE]),
    );
    assert.throws(() => assertCollector(env, props, []));
    assert.deepEqual(assertCollector(env, props, [COLLECT_SCOPE]), props);
    const context = {
      props,
      auth: { scope: [COLLECT_SCOPE] },
    } as OAuthResourceContext<unknown>;
    for (const [method, params] of [
      [
        "initialize",
        {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "http-test", version: "1" },
        },
      ],
      ["tools/list", {}],
    ] as const) {
      const response = await remoteMcpFetch(
        new Request(env.API_ORIGIN + "/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
        env,
        context,
      );
      assert.equal(response.status, 200, await response.clone().text());
      const data = (await response.json()) as {
        result?: { tools?: { name: string }[] };
      };
      assert.ok(data.result);
      if (method === "tools/list")
        assert.ok(data.result.tools!.some((t) => t.name === "attach_capture"));
    }
    const server = collectorServer(env, props),
      client = new Client({ name: "collector-test", version: "1" }),
      [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b);
      await client.connect(a);
      const tools = await client.listTools();
      assert.ok(
        tools.tools.every(
          (t) => !t.name.includes("publish") && !t.name.includes("billing"),
        ),
      );
      const candidate = candidateInput.parse({
        product: {
          slug: "tiny-ai",
          name: "Tiny AI",
          url: "https://tiny-ai-fixture.com",
          description: "Small creator utility",
          category: "video_creator",
          monetization: "unknown",
        },
        maker: {
          name: "Fixture founder",
          sourceUrl: "https://tiny-ai-fixture.com/about",
          evidence: "Founder identifies the product as independently owned.",
          sizeStatus: "unverified",
          currentSizeEvidence:
            "Current team size is not independently established.",
        },
      });
      const created = await client.callTool({
        name: "register_candidate",
        arguments: candidate,
      });
      assert.notEqual(created.isError, true);
      const parsed = JSON.parse(
        (created.content as { text: string }[])[0].text,
      ) as { id: string; status: string };
      assert.equal(parsed.status, "draft");
      const blocked = await client.callTool({
        name: "register_candidate",
        arguments: {
          ...candidate,
          product: { ...candidate.product, slug: "v0", url: "https://v0.app" },
        },
      });
      assert.equal(blocked.isError, true);
      const evidence = await client.callTool({
        name: "add_observation",
        arguments: {
          productId: parsed.id,
          sourceUrl: candidate.product.url,
          observedAt: "2026-01-01T00:00:00.000Z",
          kind: "page",
          contentHash: "d".repeat(64),
          summary: "Observed public landing page",
          payload: {},
        },
      });
      assert.notEqual(evidence.isError, true);
      const product = await bindings.DB.prepare(
        "SELECT status FROM products WHERE id=?",
      )
        .bind(parsed.id)
        .first<{ status: string }>();
      assert.equal(product!.status, "draft");
      const e = await bindings.DB.prepare(
        "SELECT status FROM evidence WHERE product_id=?",
      )
        .bind(parsed.id)
        .first<{ status: string }>();
      assert.equal(e!.status, "draft");
      const publicRows = await bindings.DB.prepare(
        "SELECT count(*) n FROM products WHERE status='published'",
      ).first<{ n: number }>();
      assert.equal(publicRows!.n, 0);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await mf.dispose();
  }
});
