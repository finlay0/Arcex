import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "./types";
import { now, later } from "./types";

export function fail(
  status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 502 | 503,
  message: string,
): never {
  throw new HTTPException(status, { message });
}
export async function parse<T>(
  c: Context<AppEnv>,
  schema: z.ZodType<T>,
): Promise<T> {
  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON");
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    return fail(
      422,
      parsed.error.issues
        .map((i) => i.path.join(".") + ": " + i.message)
        .join("; "),
    );
  return parsed.data;
}
export const sha256 = async (value: string | ArrayBuffer) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      ),
    ),
  )
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
export const randomToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
export async function secretsEqual(a: string, b: string) {
  const [ah, bh] = await Promise.all([sha256(a), sha256(b)]);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(bh),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(ah),
  );
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(bh));
}
export async function audit(
  db: D1Database,
  actor: string,
  action: string,
  target: string,
  detail: unknown = {},
) {
  await db
    .prepare("INSERT INTO audit_events VALUES (?,?,?,?,?,?)")
    .bind(
      crypto.randomUUID(),
      actor,
      action,
      target,
      JSON.stringify(detail),
      now(),
    )
    .run();
}
export function page(c: Context<AppEnv>) {
  const limit = Number(c.req.query("limit") ?? 30),
    offset = Number(c.req.query("offset") ?? 0);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10000
  )
    fail(400, "Invalid pagination");
  return { limit, offset };
}
export async function rateLimit(
  db: D1Database,
  key: string,
  max = 60,
  seconds = 60,
) {
  const bucket = `${key}:${Math.floor(Date.now() / (seconds * 1000))}`;
  const row = await db
    .prepare(
      "INSERT INTO rate_limits(key,hits,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits",
    )
    .bind(bucket, later(seconds * 2))
    .first<{ hits: number }>();
  if (!row || row.hits > max) fail(429, "Rate limit exceeded");
}
export const decode = <T>(v: string): T => JSON.parse(v) as T;
export async function boundedText(response: Response, maximum = 1_000_000) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) fail(413, "Response exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const data = new Uint8Array(size);
  let i = 0;
  for (const chunk of chunks) {
    data.set(chunk, i);
    i += chunk.length;
  }
  return new TextDecoder().decode(data);
}
