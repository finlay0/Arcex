import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { app } from "../src/index";
import { googleIdentity, safeReturnTo } from "../src/google-identity";
import type { Bindings } from "../src/types";

test("Google sign-in verifies signature, audience, nonce and state; preserves identities and safe return paths", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ["DB"],
      compatibilityDate: "2026-11-03",
    }),
  );
  const originalFetch = globalThis.fetch;
  try {
    const DB = await mf.getD1Database("DB");
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (file.startsWith("0010")) {
        await DB.prepare(
          "INSERT INTO users(id,handle,name) VALUES ('github:existing','existing','Existing')",
        ).run();
        await DB.prepare(
          "INSERT INTO identities VALUES ('github','existing','github:existing')",
        ).run();
      }
      for (const sql of (await readFile("migrations/" + file, "utf8"))
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await DB.prepare(sql).run();
    }
    assert.equal(
      (await DB.prepare(
        "SELECT user_id FROM identities WHERE provider='github'",
      ).first())!.user_id,
      "github:existing",
    );
    const env = {
      DB,
      ENVIRONMENT: "development",
      APP_ORIGIN: "http://localhost:8791",
      API_ORIGIN: "http://localhost:8791",
      GOOGLE_CLIENT_ID: "fixture-client",
      GOOGLE_CLIENT_SECRET: "fixture-secret",
    } as Bindings;
    const origin = env.API_ORIGIN;
    const sameSiteEnv = { ...env, GOOGLE_AUTH_ORIGIN: "https://api.arcex.dev" };
    const move = await app.request(
      origin + "/auth/google/start?returnTo=%2Fapp",
      {},
      sameSiteEnv,
    );
    assert.equal(
      move.headers.get("location"),
      "https://api.arcex.dev/auth/google/start?returnTo=%2Fapp",
    );
    assert.equal(
      move.headers.get("set-cookie"),
      null,
      "State must be created on the callback's origin",
    );
    const sameSiteStart = await app.request(
      "https://api.arcex.dev/auth/google/start",
      {},
      sameSiteEnv,
    );
    assert.equal(
      new URL(sameSiteStart.headers.get("location")!).searchParams.get(
        "redirect_uri",
      ),
      "https://api.arcex.dev/auth/google/callback",
    );
    const start = await app.request(
      origin + "/auth/google/start?returnTo=%2Fapp%2Ffixture%3Fstep%3Dpaywall",
      {},
      env,
    );
    assert.equal(start.status, 302);
    const login = new URL(start.headers.get("location")!);
    assert.equal(login.origin, "https://accounts.google.com");
    assert.equal(login.searchParams.get("scope"), "openid email profile");
    assert.equal(login.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      login.searchParams.get("redirect_uri"),
      origin + "/auth/google/callback",
    );
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: "fixture",
      alg: "RS256",
      use: "sig",
    };
    const nonce = login.searchParams.get("nonce")!;
    const signed = (overrides: Record<string, unknown> = {}) =>
      new SignJWT({
        sub: "google-fixture",
        email: "member@example.com",
        email_verified: true,
        name: "Member",
        nonce,
        ...overrides,
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setIssuer("https://accounts.google.com")
        .setAudience("fixture-client")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    const token = await signed();
    let exchanges = 0,
      verifierFromExchange = "";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [jwk] });
      assert.equal(url, "https://oauth2.googleapis.com/token");
      const body = new URLSearchParams(String(init?.body));
      verifierFromExchange = body.get("code_verifier")!;
      assert.equal(body.get("client_secret"), "fixture-secret");
      const challenge = Buffer.from(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(body.get("code_verifier")!),
        ),
      ).toString("base64url");
      assert.equal(challenge, login.searchParams.get("code_challenge"));
      exchanges++;
      return Response.json({
        access_token: "unused-provider-token",
        id_token: token,
      });
    };
    const callback =
      origin +
      "/auth/google/callback?code=fixture&state=" +
      login.searchParams.get("state");
    assert.equal((await app.request(callback, {}, env)).status, 400);
    assert.equal(exchanges, 0);
    const response = await app.request(callback, { headers: { cookie } }, env);
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      origin + "/app/fixture?step=paywall",
    );
    assert.match(response.headers.get("set-cookie")!, /arcex_session=/);
    assert.equal(
      (await DB.prepare(
        "SELECT user_id FROM identities WHERE provider='google'",
      ).first())!.user_id,
      "google:google-fixture",
    );
    assert.equal(
      (await app.request(callback, { headers: { cookie } }, env)).status,
      400,
    );
    assert.equal(exchanges, 1, "OAuth state is single use");
    assert.equal(
      (await googleIdentity(token, "fixture-client", verifierFromExchange)).sub,
      "google-fixture",
    );
    const damaged = token.split(".");
    damaged[2] = "AAAAAAAA" + damaged[2].slice(8);
    await assert.rejects(
      googleIdentity(damaged.join("."), "fixture-client", verifierFromExchange),
    );
    for (const overrides of [
      { nonce: "wrong" },
      { azp: "wrong" },
      { email_verified: false },
    ])
      await assert.rejects(
        googleIdentity(
          await signed(overrides),
          "fixture-client",
          verifierFromExchange,
        ),
      );
    await assert.rejects(
      googleIdentity(token, "wrong-client", verifierFromExchange),
    );
    for (const path of [
      "https://evil.test/",
      "//evil.test/",
      "/\\evil.test/",
      "/\r\nevil",
    ])
      assert.throws(() => safeReturnTo(path, origin));
    assert.equal(
      safeReturnTo("/app/fixture?step=2", origin),
      "/app/fixture?step=2",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});
