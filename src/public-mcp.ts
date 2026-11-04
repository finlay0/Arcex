import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "../packages/mcp/src/server";
import { app } from "./index";
import { fail, rateLimit } from "./lib";
import type { Bindings } from "./types";

export const PUBLIC_MCP_PATH = "/public/mcp";

const API_KEY = /^Bearer (arcex_[A-Za-z0-9_-]{1,200})$/;

/**
 * Hosted MCP for anyone: paste the URL into an agent and it connects. Tools call the
 * public API routes, so publication and key checks stay in one place. Session cookies
 * are never forwarded, and this is separate from the owner-only collector at /mcp.
 */
export async function publicMcpFetch(
  request: Request,
  env: Bindings,
  ctx: ExecutionContext,
) {
  if (request.method !== "POST")
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  try {
    const origin = request.headers.get("origin");
    if (
      origin &&
      ![
        env.APP_ORIGIN,
        env.API_ORIGIN,
        "https://chatgpt.com",
        "https://claude.ai",
      ].includes(origin)
    )
      fail(403, "Untrusted MCP origin");
    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    await rateLimit(env.DB, "public-mcp:" + ip, 120);
    // Keeps a traffic spike inside the free database allowance.
    await rateLimit(env.DB, "public-mcp:all", 20_000, 86400);
    const server = createMcpServer({
      apiUrl: env.API_ORIGIN,
      apiKey: API_KEY.exec(request.headers.get("authorization") ?? "")?.[1],
      // Workers rejects redirect: "error". These in-process calls never redirect anyway.
      fetch: async (url, init) =>
        app.fetch(new Request(url, { ...init, redirect: "manual" }), env, ctx),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      maxRequestBodySize: 64_000,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : 500;
    return Response.json(
      {
        error:
          status === 500
            ? "MCP request failed"
            : error instanceof Error
              ? error.message
              : "Access denied",
      },
      { status },
    );
  }
}
