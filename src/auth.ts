import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv, Bindings } from "./types";
import { now, later } from "./types";
import {
  fail,
  parse,
  randomToken,
  secretsEqual,
  sha256,
  rateLimit,
} from "./lib";

export async function isPro(db: D1Database, userId: string) {
  const sub = await db
    .prepare(
      "SELECT status,period_end FROM subscriptions WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM billing_holds WHERE user_id=?)",
    )
    .bind(userId, userId)
    .first<{ status: string; period_end: string | null }>();
  return (
    !!sub &&
    ["active", "trialing"].includes(sub.status) &&
    !!sub.period_end &&
    sub.period_end > now()
  );
}
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.env.ADMIN_TOKEN) fail(503, "Admin access is not configured");
  if (
    !(await secretsEqual(
      c.req.header("authorization") ?? "",
      `Bearer ${c.env.ADMIN_TOKEN}`,
    ))
  )
    fail(401, "Admin authentication required");
  await next();
};
export const requireCollector: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.env.COLLECTOR_TOKEN) fail(503, "Collector access is not configured");
  if (
    !(await secretsEqual(
      c.req.header("authorization") ?? "",
      `Bearer ${c.env.COLLECTOR_TOKEN}`,
    ))
  )
    fail(401, "Collector authentication required");
  await next();
};
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authorization = c.req.header("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : getCookie(c, "arcex_session");
  if (!token) fail(401, "Sign in to continue");
  const hash = await sha256(token);
  if (authorization) {
    const key = await c.env.DB.prepare(
      "SELECT user_id FROM api_keys WHERE token_hash=? AND revoked_at IS NULL",
    )
      .bind(hash)
      .first<{ user_id: string }>();
    if (!key) fail(401, "Invalid API key");
    const pro = await isPro(c.env.DB, key.user_id);
    if (!pro) fail(403, "Active Insider subscription required for API keys");
    c.set("actor", { userId: key.user_id, via: "api_key", pro });
  } else {
    const session = await c.env.DB.prepare(
      "SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?",
    )
      .bind(hash, now())
      .first<{ user_id: string }>();
    if (!session) fail(401, "Session expired");
    // SameSite cookies are supplemented with an Origin check on mutations.
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.req.header("origin") !== c.env.APP_ORIGIN
    )
      fail(403, "Invalid request origin");
    c.set("actor", {
      userId: session.user_id,
      via: "session",
      pro: await isPro(c.env.DB, session.user_id),
    });
  }
  await rateLimit(c.env.DB, "user:" + c.get("actor").userId, 120);
  await next();
};
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("actor").via !== "session")
    fail(403, "Use an interactive sign-in session");
  await next();
};
export const requirePro: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("actor").pro) fail(403, "Insider subscription required");
  await next();
};

async function createSession(db: D1Database, userId: string) {
  const token = randomToken();
  await db
    .prepare("INSERT INTO sessions VALUES (?,?,?)")
    .bind(await sha256(token), userId, later(86400 * 14))
    .run();
  return token;
}
const providers = {
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
  },
  x: {
    authorize: "https://x.com/i/oauth2/authorize",
    token: "https://api.x.com/2/oauth2/token",
    scope: "users.read tweet.read",
  },
} as const;
function providerConfig(env: Bindings, provider: keyof typeof providers) {
  const clientId =
    provider === "github" ? env.GITHUB_CLIENT_ID : env.X_CLIENT_ID;
  const secret =
    provider === "github" ? env.GITHUB_CLIENT_SECRET : env.X_CLIENT_SECRET;
  if (!clientId || !secret) fail(503, `${provider} OAuth is not configured`);
  return {
    ...providers[provider],
    clientId,
    secret,
    callback: `${env.API_ORIGIN}/auth/${provider}/callback`,
  };
}
export const auth = new Hono<AppEnv>();
auth.get("/:provider/start", async (c) => {
  const provider = z.enum(["github", "x"]).parse(c.req.param("provider"));
  const config = providerConfig(c.env, provider);
  await rateLimit(
    c.env.DB,
    "oauth:" + (c.req.header("cf-connecting-ip") ?? "local"),
    20,
  );
  const state = randomToken(),
    verifier = randomToken();
  await c.env.DB.prepare("INSERT INTO oauth_states VALUES (?,?,?,?)")
    .bind(await sha256(state), provider, verifier, later(600))
    .run();
  setCookie(c, "arcex_oauth", state, {
    httpOnly: true,
    secure: c.env.API_ORIGIN.startsWith("https:"),
    sameSite: "Lax",
    path: "/auth",
    maxAge: 600,
  });
  const challenge = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const url = new URL(config.authorize);
  for (const [key, value] of Object.entries({
    client_id: config.clientId,
    redirect_uri: config.callback,
    scope: config.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    response_type: "code",
  }))
    url.searchParams.set(key, value);
  return c.redirect(url.toString());
});
auth.get("/:provider/callback", async (c) => {
  const provider = z.enum(["github", "x"]).parse(c.req.param("provider"));
  const config = providerConfig(c.env, provider),
    state = c.req.query("state"),
    code = c.req.query("code");
  const cookie = getCookie(c, "arcex_oauth");
  if (
    !state ||
    !cookie ||
    !code ||
    state.length > 200 ||
    code.length > 2000 ||
    !(await secretsEqual(state, cookie))
  )
    fail(400, "Invalid OAuth state");
  const record = await c.env.DB.prepare(
    "DELETE FROM oauth_states WHERE state_hash=? AND provider=? AND expires_at>? RETURNING verifier",
  )
    .bind(await sha256(state), provider, now())
    .first<{ verifier: string }>();
  deleteCookie(c, "arcex_oauth", { path: "/auth" });
  if (!record) fail(400, "OAuth state expired or already used");
  const body = new URLSearchParams({
    client_id: config.clientId,
    code,
    redirect_uri: config.callback,
    code_verifier: record.verifier,
    grant_type: "authorization_code",
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (provider === "github") body.set("client_secret", config.secret);
  else
    headers.authorization =
      "Basic " +
      btoa(
        `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.secret)}`,
      );
  const tokenResponse = await fetch(config.token, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!tokenResponse.ok) fail(502, "OAuth token exchange failed");
  const tokens = z
    .object({ access_token: z.string() })
    .safeParse(await tokenResponse.json());
  if (!tokens.success) fail(502, "Provider did not return an access token");
  const profileResponse = await fetch(
    provider === "github"
      ? "https://api.github.com/user"
      : "https://api.x.com/2/users/me?user.fields=profile_image_url,name,username",
    {
      headers: {
        authorization: `Bearer ${tokens.data.access_token}`,
        "user-agent": "Arcex/0.1",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!profileResponse.ok) fail(502, "OAuth profile fetch failed");
  const raw: unknown = await profileResponse.json();
  let providerId: string,
    handle: string,
    name: string,
    email: string | null = null,
    avatar: string | null = null;
  if (provider === "github") {
    const p = z
      .object({
        id: z.number(),
        login: z.string(),
        name: z.string().nullable(),
        avatar_url: z.string().nullable(),
        email: z.string().nullable(),
      })
      .parse(raw);
    providerId = String(p.id);
    handle = p.login;
    name = p.name ?? p.login;
    avatar = p.avatar_url;
    const emailsResponse = await fetch("https://api.github.com/user/emails", {
      headers: {
        authorization: `Bearer ${tokens.data.access_token}`,
        "user-agent": "Arcex/0.1",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (emailsResponse.ok) {
      const emails = z
        .array(
          z.object({
            email: z.string(),
            verified: z.boolean(),
            primary: z.boolean(),
          }),
        )
        .parse(await emailsResponse.json());
      email = emails.find((e) => e.verified && e.primary)?.email ?? null;
    }
  } else {
    const p = z
      .object({
        data: z.object({
          id: z.string(),
          username: z.string(),
          name: z.string(),
          profile_image_url: z.string().optional(),
        }),
      })
      .parse(raw).data;
    providerId = p.id;
    handle = p.username;
    name = p.name;
    avatar = p.profile_image_url ?? null;
  }
  const existing = await c.env.DB.prepare(
    "SELECT user_id FROM identities WHERE provider=? AND provider_id=?",
  )
    .bind(provider, providerId)
    .first<{ user_id: string }>();
  const userId = existing?.user_id ?? `${provider}:${providerId}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO users(id,handle,name,email,avatar_url) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET handle=excluded.handle,name=excluded.name,email=COALESCE(excluded.email,users.email),avatar_url=excluded.avatar_url",
    ).bind(userId, handle, name, email, avatar),
    c.env.DB.prepare(
      "INSERT INTO identities VALUES (?,?,?) ON CONFLICT(provider,provider_id) DO NOTHING",
    ).bind(provider, providerId, userId),
  ]);
  // Provider tokens are deliberately discarded; only an opaque session is retained.
  const token = await createSession(c.env.DB, userId);
  setCookie(c, "arcex_session", token, {
    httpOnly: true,
    secure: c.env.API_ORIGIN.startsWith("https:"),
    sameSite: "Lax",
    path: "/",
    maxAge: 86400 * 14,
  });
  return c.redirect(c.env.APP_ORIGIN);
});
auth.post("/dev/session", async (c) => {
  if (
    c.env.ENVIRONMENT !== "development" ||
    c.env.ENABLE_DEV_AUTH !== "true" ||
    !["localhost", "127.0.0.1"].includes(new URL(c.req.url).hostname)
  )
    fail(404, "Not found");
  if (
    !c.env.DEV_AUTH_TOKEN ||
    !(await secretsEqual(
      c.req.header("authorization") ?? "",
      `Bearer ${c.env.DEV_AUTH_TOKEN}`,
    ))
  )
    fail(401, "Development authentication required");
  const { handle } = await parse(
    c,
    z.object({ handle: z.string().regex(/^[a-z0-9_-]{1,40}$/) }).strict(),
  );
  const userId = "dev:" + handle;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO users(id,handle,name) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
    ).bind(userId, handle, handle),
    c.env.DB.prepare(
      "INSERT INTO identities VALUES ('development',?,?) ON CONFLICT DO NOTHING",
    ).bind(handle, userId),
  ]);
  const token = await createSession(c.env.DB, userId);
  setCookie(c, "arcex_session", token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 86400 * 14,
  });
  return c.json({ userId });
});
auth.post("/logout", requireUser, requireSession, async (c) => {
  const token = getCookie(c, "arcex_session");
  if (token)
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(await sha256(token))
      .run();
  deleteCookie(c, "arcex_session", { path: "/" });
  return c.json({ ok: true });
});
