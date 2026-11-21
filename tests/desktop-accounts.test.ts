import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createAccountClient } from "../apps/engine/src/account";
import { app } from "../src/index";
import { randomToken, sha256 } from "../src/lib";
import { later, type Bindings } from "../src/types";

test("desktop and browser share customers while account approval and owner controls stay scoped", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ["DB"],
    compatibilityDate: "2026-11-03",
  }));
  const originalFetch = globalThis.fetch;
  try {
    const DB = await mf.getD1Database("DB");
    for (const file of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
      const sql = await readFile("migrations/" + file, "utf8");
      for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean))
        await DB.prepare(statement).run();
    }
    const origin = "http://localhost:8791";
    const env = { DB, APP_ORIGIN: origin, API_ORIGIN: origin, MCP_OWNER_GITHUB_ID: "42", ENVIRONMENT: "development" } as Bindings;
    const userId = "google:customer";
    const browserToken = randomToken();
    const ownerToken = randomToken();
    const otherToken = randomToken();
    await DB.batch([
      DB.prepare("INSERT INTO users(id,handle,name,email) VALUES(?,?,?,?)").bind(userId, "customer", "Customer_One", "customer@example.test"),
      DB.prepare("INSERT INTO users(id,handle,name) VALUES('github:owner','owner','Owner'),('github:other','other','Other')"),
      DB.prepare("INSERT INTO identities VALUES ('github','42','github:owner'),('github','43','github:other')"),
      DB.prepare("INSERT INTO sessions VALUES (?,?,?),(?,?,?),(?,?,?)").bind(
        await sha256(browserToken), userId, later(3000),
        await sha256(ownerToken), "github:owner", later(3000),
        await sha256(otherToken), "github:other", later(3000),
      ),
      DB.prepare("INSERT INTO subscriptions(user_id,status,period_end,updated_at) VALUES(?, 'active', ?, ?)").bind(userId, later(4000), later(0)),
    ]);
    const accounts = "/api/v1/accounts";
    const request = (method: string, route: string, body?: object, session?: string, site = origin) =>
      app.request(origin + accounts + route, {
        method,
        headers: {
          origin: site,
          ...(body && { "content-type": "application/json" }),
          ...(session && { cookie: "arcex_session=" + session }),
        },
        body: body && JSON.stringify(body),
      }, env);
    let exchangedDevice: string | undefined;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== origin) return originalFetch(input, init);
      if (url.pathname.endsWith("/exchange")) exchangedDevice = JSON.parse(String(init?.body)).device;
      return app.request(url.href, init, env);
    };
    let saved: string | null = null;
    const vault = { read: async () => saved, write: async (token: string | null) => { saved = token; } };
    const desktop = createAccountClient(vault, origin);
    assert.equal((await desktop.status()).account, null);
    const link = await desktop.start();
    assert.equal(link.verificationUrl, origin + "/desktop/link");
    assert.equal("device" in link, false);
    assert.deepEqual((await desktop.status()).link, link);
    assert.equal((await desktop.finish()).account, null);
    assert.ok(exchangedDevice);
    assert.equal((await request("POST", "/desktop/exchange", { device: exchangedDevice })).status, 429);
    assert.equal((await request("POST", "/desktop/approve", { code: link.code })).status, 401);
    assert.equal((await request("POST", "/desktop/approve", { code: link.code }, browserToken, "https://elsewhere.test")).status, 403);
    assert.equal((await request("POST", "/desktop/approve", { code: link.code }, browserToken)).status, 200);
    assert.equal((await request("POST", "/desktop/approve", { code: link.code }, otherToken)).status, 404);
    await DB.prepare("UPDATE desktop_links SET next_poll_at=? WHERE device_hash=?").bind(later(-1), await sha256(exchangedDevice)).run();
    const [connected, replay] = await Promise.all([
      desktop.finish(),
      // The visible code is never an exchange credential.
      request("POST", "/desktop/exchange", { device: link.code }),
    ]);
    assert.equal(replay.status, 422);
    assert.equal(connected.account?.id, userId);
    assert.equal(connected.account?.pro, true);
    assert.ok(saved);
    assert.equal((await request("POST", "/desktop/exchange", { device: exchangedDevice })).status, 404);
    assert.equal((await createAccountClient(vault, origin).status()).account?.id, userId);
    const wrongScope = await app.request(origin + "/api/v1/me", { headers: { authorization: "Bearer " + saved } }, env);
    assert.equal(wrongScope.status, 401);

    const devices = await (await request("GET", "/devices", undefined, browserToken)).json() as { items: { id: string }[] };
    assert.equal(devices.items.length, 1);
    assert.equal((await request("DELETE", "/devices/" + devices.items[0]!.id, undefined, otherToken)).status, 404);
    assert.equal((await request("POST", "/owner/customers/search", {}, otherToken)).status, 403);
    const customers = await request("POST", "/owner/customers/search", { query: "customer_" }, ownerToken);
    assert.equal(customers.status, 200);
    const rows = await customers.json() as { items: { id: string; desktop_sessions: number }[] };
    assert.deepEqual(rows.items.map((item) => [item.id, item.desktop_sessions]), [[userId, 1]]);
    const revoke = "/owner/customers/" + encodeURIComponent(userId) + "/revoke-sessions";
    assert.equal((await request("POST", revoke, undefined, otherToken)).status, 403);
    assert.equal((await request("POST", revoke, undefined, ownerToken)).status, 200);
    assert.equal((await request("GET", "/devices", undefined, browserToken)).status, 401);
    assert.equal((await desktop.status()).account, null);
    assert.equal(saved, null);
    assert.equal((await DB.prepare("SELECT actor FROM audit_events WHERE action='account.sessions.revoke'").first())?.actor, "github:owner");

    const expired = await desktop.start();
    await DB.prepare("UPDATE desktop_links SET expires_at=?").bind(later(-1)).run();
    assert.equal((await request("POST", "/desktop/approve", { code: expired.code }, otherToken)).status, 404);
  } finally {
    globalThis.fetch = originalFetch;
    await mf.dispose();
  }
});
