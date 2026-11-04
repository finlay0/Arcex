import backend, { app } from "./index";
import { makeOAuthProvider, oauthRoutes } from "./mcp-oauth";
import type { Bindings } from "./types";
import { rateLimit } from "./lib";
import { PUBLIC_MCP_PATH, publicMcpFetch } from "./public-mcp";

const defaultHandler: ExportedHandler<Bindings> = {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (
      path === "/authorize" ||
      path === "/auth/github/callback/mcp" ||
      path.startsWith("/api/v1/admin/mcp/")
    )
      return oauthRoutes.fetch(request, env, ctx);
    return app.fetch(request, env, ctx);
  },
};
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === PUBLIC_MCP_PATH) return publicMcpFetch(request, env, ctx);
    if (path === "/oauth/register" || path === "/authorize") {
      try {
        await rateLimit(
          env.DB,
          "oauth-protocol:" + path,
          path === "/oauth/register" ? 50 : 250,
          86400,
        );
      } catch {
        return Response.json(
          { error: "Authorization rate limit reached" },
          { status: 429 },
        );
      }
    }
    if (
      path === "/mcp" ||
      path.startsWith("/mcp/") ||
      path.startsWith("/.well-known/") ||
      path === "/authorize" ||
      path.startsWith("/oauth/") ||
      path === "/auth/github/callback/mcp" ||
      path.startsWith("/api/v1/admin/mcp/")
    ) {
      return makeOAuthProvider(env, defaultHandler).fetch(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
  scheduled: backend.scheduled,
} satisfies ExportedHandler<Bindings>;
