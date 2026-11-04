import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../packages/mcp/src/init";
import { createMcpServer } from "../packages/mcp/src/server";
import { parseModelResponse } from "../src/extraction";

test("MCP SDK handshake, tools and entitlement errors", async () => {
  const requests: { path: string; authorization?: string }[] = [];
  const http = createServer((req, res) => {
    requests.push({ path: req.url!, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (
      req.url!.includes("/blueprints/") &&
      req.headers.authorization !== "Bearer fixture-key"
    ) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Insider required" }));
      return;
    }
    res.end(JSON.stringify({ items: [], source: "fixture" }));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const server = createMcpServer({
    apiUrl: `http://127.0.0.1:${address.port}`,
    apiKey: "fixture-key",
  });
  const client = new Client({ name: "arcex-test", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 5);
    const result = await client.callTool({
      name: "search_products",
      arguments: { query: "credit gate", limit: 5 },
    });
    assert.notEqual(result.isError, true);
    assert.ok(requests[0].path.includes("q=credit+gate"));
    assert.equal(requests[0].authorization, undefined);
    const blueprint = await client.callTool({
      name: "get_blueprint",
      arguments: { blueprintId: "bp-1" },
    });
    assert.notEqual(blueprint.isError, true);
    assert.equal(requests[1].authorization, "Bearer fixture-key");
  } finally {
    await client.close();
    await server.close();
    await new Promise<void>((r, e) =>
      http.close((err) => (err ? e(err) : r())),
    );
  }
});
test("arcex init merges client config without secrets or overwriting", () => {
  const cwd = mkdtempSync(join(tmpdir(), "arcex-init-"));
  const options = { cwd, platform: "linux", log: () => {} };
  try {
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other" } } }),
    );
    mkdirSync(join(cwd, ".cursor"));
    runInit([], options);
    const claude = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    assert.deepEqual(claude.mcpServers.other, { command: "other" });
    assert.deepEqual(claude.mcpServers.arcex.args, ["-y", "arcex"]);
    assert.equal(
      claude.mcpServers.arcex.env.ARCEX_API_KEY,
      "${ARCEX_API_KEY:-}",
    );
    const cursor = JSON.parse(
      readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
    );
    assert.equal(
      cursor.mcpServers.arcex.env.ARCEX_API_KEY,
      "${env:ARCEX_API_KEY}",
    );

    const customised = { mcpServers: { arcex: { command: "custom" } } };
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify(customised));
    runInit(["--client", "claude"], options);
    assert.deepEqual(
      JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")),
      customised,
    );

    writeFileSync(join(cwd, ".mcp.json"), "{ not json");
    assert.throws(
      () => runInit(["--client", "claude"], options),
      /left unchanged/,
    );
    assert.equal(readFileSync(join(cwd, ".mcp.json"), "utf8"), "{ not json");
    assert.throws(() => runInit(["--client", "bad"], options), /Usage/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
test("extractor rejects incomplete, malformed and refused model responses", () => {
  assert.throws(() => parseModelResponse({ status: "incomplete", output: [] }));
  assert.throws(() =>
    parseModelResponse({
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal" }] }],
    }),
  );
  assert.throws(() =>
    parseModelResponse({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: '{"revenue":9999}' }],
        },
      ],
    }),
  );
  const result = parseModelResponse({
    status: "completed",
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              steps: [],
              paywall: null,
              blueprint: null,
              limitations: ["Only a landing page was observed"],
            }),
          },
        ],
      },
    ],
  });
  assert.equal(result.blueprint, null);
});
