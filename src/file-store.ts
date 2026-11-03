import { createClient } from "@supabase/supabase-js";
import type { Bindings } from "./types";
import { fail } from "./lib";

export const EVIDENCE_BUCKET = "arcex-evidence";
export const MEDIA_LIMIT_BYTES = 50_000_000;
export function storageClient(env: Bindings) {
  if (!env.SUPABASE_STORAGE_URL || !env.SUPABASE_STORAGE_KEY)
    fail(503, "Private evidence storage is not configured");
  const url = new URL(env.SUPABASE_STORAGE_URL);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".supabase.co") ||
    url.username ||
    url.password
  )
    fail(503, "Invalid storage origin configuration");
  return createClient(url.origin, env.SUPABASE_STORAGE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
export function fileStore(env: Bindings) {
  if (env.MEDIA)
    return {
      put: async (key: string, bytes: ArrayBuffer, type: string) => {
        await env.MEDIA!.put(key, bytes, {
          httpMetadata: { contentType: type },
        });
      },
      get: async (key: string) => {
        const obj = await env.MEDIA!.get(key);
        return obj?.body ?? null;
      },
      delete: async (key: string) => {
        await env.MEDIA!.delete(key);
      },
    };
  const bucket = storageClient(env).storage.from(EVIDENCE_BUCKET);
  return {
    put: async (key: string, bytes: ArrayBuffer, type: string) => {
      const { error } = await bucket.upload(key, bytes, {
        contentType: type,
        upsert: false,
      });
      if (error) fail(502, "Evidence upload failed");
    },
    get: async (key: string) => {
      const { data, error } = await bucket.download(key);
      if (error || !data) return null;
      return data.stream();
    },
    delete: async (key: string) => {
      const { error } = await bucket.remove([key]);
      if (error) fail(502, "Evidence delete failed");
    },
  };
}
export async function setupStorage(env: Bindings) {
  const client = storageClient(env),
    { data, error } = await client.storage.listBuckets();
  if (error) fail(502, "Storage configuration lookup failed");
  const bucket = data.find((b) => b.name === EVIDENCE_BUCKET);
  if (bucket?.public) fail(409, "Arcex evidence bucket must be private");
  if (!bucket) {
    const result = await client.storage.createBucket(EVIDENCE_BUCKET, {
      public: false,
      fileSizeLimit: 1_000_000,
      allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
    });
    if (result.error) fail(502, "Private evidence bucket creation failed");
  }
  return {
    provider: "supabase",
    bucket: EVIDENCE_BUCKET,
    private: true,
    applicationLimitBytes: MEDIA_LIMIT_BYTES,
  };
}
