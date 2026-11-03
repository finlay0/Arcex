import { test } from "node:test";
import assert from "node:assert/strict";
import { fileStore, setupStorage, EVIDENCE_BUCKET } from "../src/file-store";
import type { Bindings } from "../src/types";

test("Supabase evidence storage uses a private bucket and surfaces provider failures", async (t) => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let publicBucket = false;
  let exists = false;
  let uploadFailure = false;
  const origin = "https://storage-fixture.supabase.co";
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      assert.equal(url.origin, origin);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === "/storage/v1/bucket" && method === "GET")
        return Response.json(
          exists ? [{ name: EVIDENCE_BUCKET, public: publicBucket }] : [],
        );
      if (url.pathname === "/storage/v1/bucket" && method === "POST") {
        assert.equal(body.public, false);
        assert.equal(body.file_size_limit, 1000000);
        exists = true;
        return Response.json({ name: EVIDENCE_BUCKET });
      }
      if (url.pathname.includes("/object/") && method === "POST")
        return uploadFailure
          ? Response.json(
              { message: "fixture failure", error: "fixture", statusCode: 500 },
              { status: 500 },
            )
          : Response.json({ Key: "capture" });
      if (url.pathname.includes("/object/") && method === "GET")
        return new Response(new Uint8Array([137, 80, 78, 71]));
      if (url.pathname.includes("/object/") && method === "DELETE")
        return Response.json([]);
      throw new Error(
        "Unexpected storage request: " + method + " " + url.pathname,
      );
    },
  );
  const env = {
    SUPABASE_STORAGE_URL: origin,
    SUPABASE_STORAGE_KEY: "fixture-server-key",
  } as Bindings;
  await setupStorage(env);
  assert.equal(
    calls.filter((c) => c.method === "POST" && c.path.endsWith("/bucket"))
      .length,
    1,
  );
  await setupStorage(env);
  assert.equal(
    calls.filter((c) => c.method === "POST" && c.path.endsWith("/bucket"))
      .length,
    1,
  );
  const store = fileStore(env);
  await store.put(
    "evidence/capture",
    new Uint8Array([137, 80, 78, 71]).buffer,
    "image/png",
  );
  const body = await store.get("evidence/capture");
  assert.ok(body);
  assert.deepEqual(
    [...new Uint8Array(await new Response(body).arrayBuffer())],
    [137, 80, 78, 71],
  );
  await store.delete("evidence/capture");
  uploadFailure = true;
  await assert.rejects(
    store.put("evidence/failed", new ArrayBuffer(4), "image/png"),
    /upload failed/,
  );
  publicBucket = true;
  await assert.rejects(setupStorage(env), /must be private/);
  assert.throws(() => fileStore({} as Bindings), /not configured/);
});
