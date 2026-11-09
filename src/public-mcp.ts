import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "../packages/mcp/src/server";
import { app } from "./index";
import { boundedText, fail, rateLimit } from "./lib";
import type { Bindings } from "./types";

export const PUBLIC_MCP_PATH = "/public/mcp";

const API_KEY = /^Bearer (arcex_[A-Za-z0-9_-]{1,200})$/;
const MAX_BODY = 64_000;

/** True when the JSON-RPC message, or any in a batch, calls a tool. Unparseable bodies are left to the transport. */
function callsTool(body: string) {
  try {
    const parsed: unknown = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).some(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { method?: unknown }).method === "tools/call",
    );
  } catch {
    return false;
  }
}

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
    const ip = request.headers.get("cf-connecting-ip");
    const body = await boundedText(request, MAX_BODY);
    // Only tool calls read the database. Handshakes, tool lists and notifications cost
    // nothing, so they skip the rate-limit writes that would otherwise double per session.
    if (callsTool(body)) {
      const who = ip ?? "local";
      await rateLimit(env.DB, "public-mcp:" + who, 120);
      // One caller can't spend the shared daily allowance on everyone else.
      await rateLimit(env.DB, "public-mcp-day:" + who, 2_000, 86400);
      // Keeps a traffic spike inside the free database allowance.
      await rateLimit(env.DB, "public-mcp:all", 20_000, 86400);
    }
    const server = createMcpServer({
      apiUrl: env.API_ORIGIN,
      apiKey: API_KEY.exec(request.headers.get("authorization") ?? "")?.[1],
      // Workers rejects redirect: "error". These in-process calls never redirect anyway.
      // The caller's address goes along so per-visitor API limits stay per visitor.
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        if (ip) headers.set("cf-connecting-ip", ip);
        return app.fetch(
          new Request(url, { ...init, headers, redirect: "manual" }),
          env,
          ctx,
        );
      },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body,
        }),
      );
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
