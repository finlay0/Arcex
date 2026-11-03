import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createHash } from "node:crypto";

test("Worker OAuth discovery, PKCE, browser-bound consent and MCP rejection", async () => {
  const bundle = await build({
    entryPoints: ["src/worker.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "browser"],
    external: ["cloudflare:workers", "node:*"],
    write: false,
  });
  const origin = "https://arcex-fixture.com";
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-11-03",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      d1Databases: ["DB"],
      kvNamespaces: ["OAUTH_KV"],
      bindings: {
        ENVIRONMENT: "production",
        APP_ORIGIN: origin,
        API_ORIGIN: origin,
        MCP_OWNER_GITHUB_ID: "42",
        ENABLE_DEV_AUTH: "false",
        COLLECTION_ENABLED: "false",
        GITHUB_CLIENT_ID: "github-client-fixture",
        GITHUB_CLIENT_SECRET: "github-secret-fixture",
        ADMIN_TOKEN: "admin-fixture",
        COLLECTOR_TOKEN: "collector-fixture",
      },
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
    const call = (
      path: string,
      init?: Parameters<typeof mf.dispatchFetch>[1],
    ) => mf.dispatchFetch(origin + path, { redirect: "manual", ...init });
    const discovery = await call("/.well-known/oauth-protected-resource/mcp");
    assert.equal(discovery.status, 200);
    const resource = (await discovery.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    assert.equal(resource.resource, origin + "/mcp");
    assert.deepEqual(resource.authorization_servers, [origin]);
    const authorization = await call("/.well-known/oauth-authorization-server");
    assert.equal(authorization.status, 200);
    const metadata = (await authorization.json()) as {
      code_challenge_methods_supported: string[];
      grant_types_supported: string[];
    };
    assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
    assert.ok(metadata.grant_types_supported.includes("refresh_token"));
    const anonymous = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(anonymous.status, 401);
    assert.match(
      anonymous.headers.get("www-authenticate") ?? "",
      /resource_metadata/,
    );
    const badToken = await call("/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer not-a-real-token",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(badToken.status, 401);
    const registered = await call("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "<script>untrusted</script>",
        redirect_uris: [
          "https://chatgpt.com/connector_platform_oauth_redirect",
        ],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert.equal(registered.status, 201);
    const client = (await registered.json()) as { client_id: string };
    const verifier = "a".repeat(64),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      response_type: "code",
      scope: "arcex:collect offline_access",
      resource: origin + "/mcp",
      state: "state-fixture",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const missingPkce = new URLSearchParams(params);
    missingPkce.delete("code_challenge");
    assert.notEqual((await call("/authorize?" + missingPkce)).status, 200);
    const consent = await call("/authorize?" + params);
    assert.equal(consent.status, 200);
    const html = await consent.text();
    assert.ok(!html.includes("<script>untrusted</script>"));
    assert.match(html, /chatgpt.com/);
    assert.match(html, /cannot publish/);
    const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
    assert.ok(handle);
    const forged = await call("/authorize", {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, decision: "approve" }).toString(),
    });
    assert.equal(forged.status, 400);
    const cookies = consent.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join("; ");
    const denied = await call("/authorize", {
      method: "POST",
      headers: {
        origin,
        cookie: cookies,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ handle, decision: "deny" }).toString(),
    });
    assert.equal(denied.status, 302, await denied.text());
    const redirect = new URL(denied.headers.get("location")!);
    assert.equal(redirect.hostname, "chatgpt.com");
    assert.equal(redirect.searchParams.get("error"), "access_denied");
    assert.equal(redirect.searchParams.get("state"), "state-fixture");
    const invalidCallback = await call(
      "/auth/github/callback/mcp?state=forged&code=forged",
    );
    assert.equal(invalidCallback.status, 400);
  } finally {
    await mf.dispose();
  }
});
