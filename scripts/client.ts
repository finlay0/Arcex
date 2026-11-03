import { existsSync } from "node:fs";

// Explicitly selected files let scheduled runners use production without printing credentials.
const envFile = process.env.ARCEX_ENV_FILE ?? ".dev.vars";
if (existsSync(envFile)) process.loadEnvFile(envFile);
export const apiUrl = (
  process.env.ARCEX_API_URL ?? "http://localhost:8791"
).replace(/\/$/, "");
const u = new URL(apiUrl);
if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname))
  throw new Error("Remote API requires HTTPS");
export const adminToken =
  process.env.ARCEX_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN;
export const collectorToken =
  process.env.ARCEX_COLLECTOR_TOKEN ?? process.env.COLLECTOR_TOKEN;
export async function api<T = Record<string, unknown>>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const response = await fetch(apiUrl + path, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  const result = (await response.json()) as T;
  if (!response.ok) {
    const message = (result as { error?: string }).error ?? "Unknown error";
    throw new Error(`Arcex ${response.status}: ${message}`);
  }
  return result;
}
