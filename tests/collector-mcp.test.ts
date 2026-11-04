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
import { enqueueDue } from "../src/jobs";
import { app } from "../src/index";

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
      const evidenceId = JSON.parse(
        (evidence.content as { text: string }[])[0].text,
      ).id as string;
      const contextResult = await client.callTool({
        name: "research_context",
        arguments: { mode: "qualification" },
      });
      const runContext = JSON.parse(
        (contextResult.content as { text: string }[])[0].text,
      );
      assert.ok(
        runContext.cohort.some((p: { id: string }) => p.id === parsed.id),
      );
      const read = await client.callTool({
        name: "read_product_research",
        arguments: { productId: parsed.id },
      });
      assert.ok(
        JSON.parse(
          (read.content as { text: string }[])[0].text,
        ).untrustedEvidence.some((e: { id: string }) => e.id === evidenceId),
      );
      const checkpoint = await client.callTool({
        name: "save_research_checkpoint",
        arguments: {
          runId: runContext.runId,
          mode: "qualification",
          status: "partial",
          productIds: [parsed.id],
          evidenceIds: [evidenceId],
          queries: [],
          summary:
            "Product evidence saved; current scale still needs a primary source",
          nextAction:
            "Check the current founder/team page; do not infer size from the original launch",
        },
      });
      assert.notEqual(checkpoint.isError, true);
      const freshServer = collectorServer(env, props),
        freshClient = new Client({ name: "fresh-context-test", version: "1" }),
        [c, d] = InMemoryTransport.createLinkedPair();
      try {
        await freshServer.connect(d);
        await freshClient.connect(c);
        const resumed = await freshClient.callTool({
          name: "research_context",
          arguments: { resumeRunId: runContext.runId },
        });
        assert.equal(
          JSON.parse((resumed.content as { text: string }[])[0].text).resume
            .nextAction,
          "Check the current founder/team page; do not infer size from the original launch",
        );
      } finally {
        await freshClient.close();
        await freshServer.close();
      }
      await client.callTool({
        name: "register_browser_source",
        arguments: {
          productId: parsed.id,
          url: candidate.product.url,
          name: "Fixture recurring source",
        },
      });
      assert.equal((await enqueueDue(env)).enqueued, 0);
      const accept = () =>
        app.request(
          env.API_ORIGIN +
            `/api/v1/admin/research/candidates/${parsed.id}/status`,
          {
            method: "PUT",
            headers: {
              authorization: "Bearer " + env.ADMIN_TOKEN,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              status: "accepted",
              reason: "Fixture owner review",
            }),
          },
          env,
        );
      assert.equal((await accept()).status, 409);
      const assessment = await client.callTool({
        name: "save_research_assessment",
        arguments: {
          productId: parsed.id,
          relevance: "in_scope",
          rationale:
            "Relevant creator utility with an observed commercial workflow",
          evidenceIds: [evidenceId],
          sizeStatus: "unverified",
          sizeBasis: "unknown",
          sizeNotes:
            "Current workforce is not publicly established; do not label it as verified small",
          nextAction: "Owner must review the source before cohort acceptance",
        },
      });
      assert.notEqual(assessment.isError, true);
      assert.equal((await accept()).status, 409);
      await bindings.DB.prepare(
        "UPDATE evidence SET status='approved' WHERE id=?",
      )
        .bind(evidenceId)
        .run();
      assert.equal((await accept()).status, 200);
      assert.equal((await enqueueDue(env)).enqueued, 1);
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
      assert.equal(e!.status, "approved");
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
