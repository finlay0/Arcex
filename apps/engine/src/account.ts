import type { DesktopAccount, DesktopLink } from "@arcex/contracts";
import { z } from "zod";

const tokenFormat = z.string().regex(/^[0-9a-f]{64}$/);
const accountFormat = z.object({
  id: z.string(), name: z.string(), handle: z.string(), pro: z.boolean(), expiresAt: z.iso.datetime(), devicesUrl: z.url(),
});
const linkFormat = z.object({
  device: tokenFormat, code: z.string().regex(/^[0-9A-F]{10}$/), expiresAt: z.iso.datetime(),
  verificationUrl: z.url(), interval: z.number().int().min(5).max(60),
});
const exchangeFormat = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("connected"), token: tokenFormat }),
]);

type Vault = {
  read(): Promise<string | null>;
  write(token: string | null): Promise<void>;
};

class AccountError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function createAccountClient(vault?: Vault, origin = "https://api.arcex.dev") {
  const api = new URL(origin);
  const local = api.protocol === "http:" && ["localhost", "127.0.0.1"].includes(api.hostname);
  if (!local && api.origin !== "https://api.arcex.dev") throw new Error("Invalid Arcex account server");
  let token: string | null = null;
  let pending: z.infer<typeof linkFormat> | null = null;
  let loaded = false;
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>) => {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  };
  const website = (address: string, route: string) => {
    const url = new URL(address);
    const valid = local ? url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) : url.origin === "https://arcex.dev";
    if (!valid || url.pathname !== route) throw new Error("Arcex returned an invalid account address.");
    return url.href;
  };

  async function request(endpoint: string, options: { method?: string; body?: object; bearer?: string } = {}) {
    let response: Response;
    try {
      response = await fetch(new URL("/api/v1/accounts/desktop/" + endpoint, api), {
        method: options.method, redirect: "error", signal: AbortSignal.timeout(8000),
        headers: {
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(options.bearer ? { authorization: "Bearer " + options.bearer } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch {
      throw new Error("Couldn't reach Arcex Accounts. Check your connection and try again.");
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = response.status === 429 ? "Wait before checking again."
        : response.status === 404 ? "This sign-in is unavailable or expired."
        : response.status === 401 ? "Your Arcex session expired."
        : "Arcex Accounts is temporarily unavailable.";
      throw new AccountError(response.status, message);
    }
    return body;
  }

  async function loadToken() {
    if (loaded) return;
    token = tokenFormat.safeParse(await vault?.read()).data ?? null;
    loaded = true;
  }
  async function saveToken(value: string | null) {
    await vault?.write(value);
    token = value;
    loaded = true;
  }
  async function profile(): Promise<{ account: DesktopAccount | null }> {
    await loadToken();
    if (!token) return { account: null };
    try {
      const { account } = z.object({ account: accountFormat }).parse(await request("me", { bearer: token }));
      return { account: { ...account, devicesUrl: website(account.devicesUrl, "/account/devices") } };
    } catch (error) {
      if (!(error instanceof AccountError) || error.status !== 401) throw error;
      await saveToken(null);
      return { account: null };
    }
  }

  return {
    status: () => serialize(async (): Promise<{ account: DesktopAccount | null; link?: DesktopLink }> => {
      const result = await profile();
      if (!pending || Date.now() >= Date.parse(pending.expiresAt)) return result;
      const { device: _device, ...link } = pending;
      return { ...result, link };
    }),
    start: () => serialize(async (): Promise<DesktopLink> => {
      await loadToken();
      if (token) throw new Error("Sign out before connecting a different account.");
      const { device, ...link } = linkFormat.parse(await request("link", { method: "POST" }));
      link.verificationUrl = website(link.verificationUrl, "/desktop/link");
      pending = { device, ...link };
      return link;
    }),
    finish: () => serialize(async () => {
      if (!pending) return profile();
      let result: z.infer<typeof exchangeFormat>;
      try {
        result = exchangeFormat.parse(await request("exchange", { method: "POST", body: { device: pending.device } }));
      } catch (error) {
        if (error instanceof AccountError && error.status === 429) return { account: null };
        if (error instanceof AccountError && error.status === 404) pending = null;
        throw error;
      }
      if (result.status === "pending") return { account: null };
      pending = null;
      try {
        await saveToken(result.token);
      } catch (error) {
        await request("session", { method: "DELETE", bearer: result.token }).catch(() => {});
        throw error;
      }
      return profile();
    }),
    disconnect: () => serialize(async () => {
      pending = null;
      await loadToken();
      if (token) {
        await request("session", { method: "DELETE", bearer: token });
        await saveToken(null);
      }
      return { ok: true as const };
    }),
  };
}
