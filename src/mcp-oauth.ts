import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  OAuthProvider,
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import type { AppEnv, Bindings } from "./types";
import { fail, randomToken, sha256, audit, rateLimit } from "./lib";
import { requireAdmin } from "./auth";
import { COLLECT_SCOPE, remoteMcpFetch } from "./remote-mcp";

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const oauthRoutes = new Hono<AppEnv>();
oauthRoutes.use(
  "*",
  bodyLimit({
    maxSize: 32_768,
    onError: (c) => c.text("Authorization request too large", 413),
  }),
);
oauthRoutes.get("/authorize", async (c) => {
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET)
    fail(503, "GitHub sign-in is not configured yet");
  await rateLimit(
    c.env.DB,
    "oauth-consent:" + (c.req.header("cf-connecting-ip") ?? "local"),
    30,
  );
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) fail(503, "OAuth service unavailable");
  const request = await oauth.parseAuthRequest(c.req.raw),
    details = await oauth.describeConsent(request),
    consent = await oauth.beginConsent(request);
  if (!request.scope.includes(COLLECT_SCOPE))
    fail(400, "Collector scope must be requested");
  consent.headers.set("content-type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Authorize Arcex collection</title><h1>Allow ${escape(details.clientName)} to collect for Arcex?</h1><p>${details.clientDomain ? "Client domain: " + escape(details.clientDomain) : "Client name is self-registered."}</p><p>Authorization returns to <strong>${escape(details.redirectHost)}</strong>.</p><p>Access: read private research, register candidates, and save evidence/funnels/blueprints as drafts. It cannot publish, manage billing, or change permissions.</p>${details.redirectIsLoopback ? "<p>This sends access to a local application.</p>" : ""}<p>Requested scopes: ${details.scope.map(escape).join(", ")}</p><form method="post"><input type="hidden" name="handle" value="${escape(consent.handle)}"><button name="decision" value="approve">Allow and sign in with GitHub</button> <button name="decision" value="deny">Deny</button></form>`,
    { headers: consent.headers },
  );
});
oauthRoutes.post("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) fail(503, "OAuth service unavailable");
  if (c.req.header("origin") !== c.env.API_ORIGIN)
    fail(403, "Invalid consent origin");
  const form = await c.req.formData(),
    handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(c.req.raw, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(c.req.raw, handle);
  if (!approved.request.scope.includes(COLLECT_SCOPE))
    fail(400, "Collector scope required");
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET)
    fail(503, "GitHub sign-in is not configured yet");
  const verifier = randomToken();
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: c.env.API_ORIGIN + "/auth/github/callback/mcp",
    scope: "read:user",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  headers.set("location", "https://github.com/login/oauth/authorize?" + params);
  return new Response(null, { status: 302, headers });
});
oauthRoutes.get("/auth/github/callback/mcp", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth) fail(503, "OAuth service unavailable");
  const upstream = await oauth.finishUpstream<{ verifier: string }>(c.req.raw);
  if (c.req.query("error")) {
    upstream.headers.set(
      "location",
      authorizationErrorRedirect(upstream.request, "access_denied"),
    );
    return new Response(null, { status: 302, headers: upstream.headers });
  }
  const code = c.req.query("code");
  if (!code || code.length > 2000)
    fail(400, "Missing GitHub authorization code");
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET)
    fail(503, "GitHub sign-in is not configured");
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: upstream.data.verifier,
      redirect_uri: c.env.API_ORIGIN + "/auth/github/callback/mcp",
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) fail(502, "GitHub authorization failed");
  const token = z
    .object({ access_token: z.string() })
    .safeParse(await response.json());
  if (!token.success) fail(502, "GitHub authorization failed");
  const profile = await fetch("https://api.github.com/user", {
    headers: {
      authorization: "Bearer " + token.data.access_token,
      "user-agent": "Arcex/0.2",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!profile.ok) fail(502, "GitHub profile lookup failed");
  const user = z
    .object({ id: z.number(), login: z.string() })
    .parse(await profile.json());
  if (String(user.id) !== c.env.MCP_OWNER_GITHUB_ID)
    fail(403, "Only the Arcex owner can authorize this collector");
  const props = {
    userId: "github:" + user.id,
    githubId: String(user.id),
    role: "collector" as const,
  };
  const complete = await oauth.completeAuthorization({
    request: upstream.request,
    userId: encodeURIComponent(props.userId),
    metadata: { label: "Arcex Work collector" },
    scope: upstream.request.scope,
    props,
  });
  await audit(
    c.env.DB,
    props.userId,
    "mcp.authorize",
    upstream.request.clientId,
  );
  upstream.headers.set("location", complete.redirectTo);
  return new Response(null, { status: 302, headers: upstream.headers });
});
oauthRoutes.get("/api/v1/admin/mcp/grants", requireAdmin, async (c) => {
  if (!c.env.OAUTH_PROVIDER) fail(503, "OAuth unavailable");
  return c.json(
    await c.env.OAUTH_PROVIDER.listUserGrants(
      encodeURIComponent("github:" + c.env.MCP_OWNER_GITHUB_ID),
    ),
  );
});
oauthRoutes.delete("/api/v1/admin/mcp/grants/:id", requireAdmin, async (c) => {
  if (!c.env.OAUTH_PROVIDER) fail(503, "OAuth unavailable");
  await c.env.OAUTH_PROVIDER.revokeGrant(
    c.req.param("id"),
    encodeURIComponent("github:" + c.env.MCP_OWNER_GITHUB_ID),
  );
  await audit(c.env.DB, "admin", "mcp.revoke", c.req.param("id"));
  return c.json({ ok: true });
});
oauthRoutes.onError((error, c) => {
  if (error instanceof AuthorizationError && error.redirectTo)
    return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError || error instanceof CimdFetchError)
    return c.text(
      error instanceof AuthorizationError
        ? error.description
        : "Client metadata could not be verified",
      400,
    );
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number(error.status)
      : 500;
  return new Response(status === 500 ? "Authorization failed" : error.message, {
    status,
    headers: { "cache-control": "no-store" },
  });
});

export function makeOAuthProvider(
  env: Bindings,
  defaultHandler: ExportedHandler<Bindings>,
) {
  return new OAuthProvider<Bindings>({
    apiRoute: "/mcp",
    apiHandler: {
      fetch: (req, bindings, ctx) =>
        remoteMcpFetch(req, bindings, ctx as OAuthResourceContext<unknown>),
    },
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [COLLECT_SCOPE, "offline_access"],
    requiredScopes: [COLLECT_SCOPE],
    resourceMetadata: {
      resource: env.API_ORIGIN + "/mcp",
      authorization_servers: [env.API_ORIGIN],
      resource_name: "Arcex private collector",
    },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    refreshTokenTTL: 86400 * 90,
    refreshTokenIdleTTL: 86400 * 90,
    onError: ({ code }) =>
      console.error(JSON.stringify({ event: "oauth.failed", code })),
  });
}
