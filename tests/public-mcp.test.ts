import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PUBLIC_MCP_PATH, publicMcpFetch } from "../src/public-mcp";
import { sha256 } from "../src/lib";
import type { Bindings } from "../src/types";

const ORIGIN = "http://localhost:8791";
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

test("public MCP connects without sign-in and keeps key checks", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ["DB"],
      compatibilityDate: "2026-11-03",
    }),
  );
  const clients: Client[] = [];
  try {
    const { DB } = await mf.getBindings<Pick<Bindings, "DB">>();
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      for (const sql of (await readFile("migrations/" + file, "utf8"))
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
    } as Bindings;

    const connect = async (headers: Record<string, string> = {}) => {
      const client = new Client({ name: "test", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(ORIGIN + PUBLIC_MCP_PATH), {
          requestInit: { headers },
          fetch: (url, init) =>
            publicMcpFetch(new Request(url, init), env, ctx),
        }),
      );
      return client;
    };
    const blueprint = (client: Client) =>
      client.callTool({
        name: "get_blueprint",
        arguments: { blueprintId: "unknown" },
      }) as Promise<{ isError?: boolean; content: { text: string }[] }>;

    const anonymous = await connect();
    assert.equal((await anonymous.listTools()).tools.length, 7);
    const overview = (await anonymous.callTool({
      name: "market_overview",
      arguments: {},
    })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(JSON.parse(overview.content[0].text).scope.products, 0);
    const search = (await anonymous.callTool({
      name: "search_products",
      arguments: { query: "paywall", limit: 1 },
    })) as { isError?: boolean; content: { text: string }[] };
    assert.notEqual(search.isError, true);
    assert.deepEqual(JSON.parse(search.content[0].text).items, []);
    assert.match(
      (await blueprint(anonymous)).content[0].text,
      /free Arcex API key/,
    );

    // A session cookie must not stand in for a key.
    const cookie = await connect({ cookie: "arcex_session=anything" });
    assert.match(
      (await blueprint(cookie)).content[0].text,
      /free Arcex API key/,
    );

    const invalid = await connect({ authorization: "Bearer arcex_invalid" });
    assert.match((await blueprint(invalid)).content[0].text, /isn't valid/);

    await DB.prepare(
      "INSERT INTO users(id,handle,name,created_at) VALUES ('u1','u1','U','2026-01-01')",
    ).run();
    await DB.prepare(
      "INSERT INTO api_keys(id,user_id,token_hash,name,created_at) VALUES ('k1','u1',?,'k','2026-01-01')",
    )
      .bind(await sha256("arcex_valid"))
      .run();
    const valid = await connect({ authorization: "Bearer arcex_valid" });
    assert.match((await blueprint(valid)).content[0].text, /HTTP 404/);

    assert.equal(
      (await publicMcpFetch(new Request(ORIGIN + PUBLIC_MCP_PATH), env, ctx))
        .status,
      405,
    );
    assert.equal(
      (
        await publicMcpFetch(
          new Request(ORIGIN + PUBLIC_MCP_PATH, {
            method: "POST",
            headers: { origin: "https://evil.example" },
            body: "{}",
          }),
          env,
          ctx,
        )
      ).status,
      403,
    );
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await mf.dispose();
  }
});
