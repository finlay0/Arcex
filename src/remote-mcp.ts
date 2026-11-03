import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import type { Bindings } from "./types";
import { app } from "./index";
import { audit, fail, rateLimit } from "./lib";
import { candidateInput, registerCandidate } from "./research";
import {
  evidenceInput,
  funnelInput,
  paywallInput,
  blueprintInput,
  id,
} from "./contracts";

export const COLLECT_SCOPE = "arcex:collect";
export type CollectorProps = {
  userId: string;
  githubId: string;
  role: "collector";
};
export function assertCollector(
  env: Bindings,
  props: unknown,
  scopes: string[],
) {
  const parsed = z
    .object({
      userId: z.string(),
      githubId: z.string(),
      role: z.literal("collector"),
    })
    .safeParse(props);
  if (
    !parsed.success ||
    parsed.data.githubId !== env.MCP_OWNER_GITHUB_ID ||
    parsed.data.userId !== `github:${env.MCP_OWNER_GITHUB_ID}` ||
    !scopes.includes(COLLECT_SCOPE)
  )
    fail(403, "Owner collector authorization required");
  return parsed.data;
}
export function collectorServer(env: Bindings, props: CollectorProps) {
  const server = new McpServer({ name: "arcex-collector", version: "0.2.0" });
  const result = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return result(await fn());
    } catch (error) {
      return {
        isError: true,
        ...result({
          error:
            error instanceof Error ? error.message : "Collection action failed",
        }),
      };
    }
  };
  const internal = async (
    method: string,
    path: string,
    body?: unknown,
    collector = false,
  ) => {
    const token = collector ? env.COLLECTOR_TOKEN : env.ADMIN_TOKEN;
    if (!token) fail(503, "Collector backend is not configured");
    const response = await app.request(
      env.API_ORIGIN + path,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      env,
    );
    const data: unknown = await response.json();
    if (!response.ok)
      throw new Error(
        `Arcex ${response.status}: ${typeof data === "object" && data !== null && "error" in data ? String(data.error) : "Request failed"}`,
      );
    return data;
  };
  server.registerTool(
    "collection_status",
    {
      description:
        "Read research candidates, registered sources and durable job status. Sources and drafts are private to the owner connection.",
      inputSchema: {},
    },
    async () =>
      run(async () => ({
        candidates: (
          await env.DB.prepare(
            "SELECT p.id,p.slug,p.name,p.url,p.status,r.maker_name,r.size_status,r.status research_status FROM products p JOIN research_profiles r ON r.product_id=p.id ORDER BY p.updated_at DESC LIMIT 100",
          ).all()
        ).results,
        sources: await internal("GET", "/api/v1/admin/sources?limit=100"),
        jobs: await internal("GET", "/api/v1/admin/jobs?limit=100"),
      })),
  );
  server.registerTool(
    "register_candidate",
    {
      description:
        "Register a small independent AI product with primary maker/ownership evidence. Creates a private draft pending editorial review. Major platforms are excluded. Does not publish.",
      inputSchema: candidateInput,
    },
    async (input) =>
      run(async () => {
        await rateLimit(env.DB, `candidate:${props.userId}`, 30, 86400);
        return registerCandidate(env.DB, props.userId, input);
      }),
  );
  server.registerTool(
    "add_observation",
    {
      description:
        "Save source-backed factual evidence as a private draft. A screenshot observation requires an actually captured image hash and timestamp. Do not invent revenue, traction or unseen funnel steps.",
      inputSchema: evidenceInput,
    },
    async (input) =>
      run(() => internal("POST", "/api/v1/admin/evidence", input)),
  );
  server.registerTool(
    "attach_capture",
    {
      description:
        "Attach an actual captured image to existing evidence as a private, unapproved asset. Send image bytes as base64, at most 700 KB decoded. Do not send secrets or personal information. No publication permission.",
      inputSchema: z
        .object({
          evidenceId: id,
          contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
          base64: z
            .string()
            .min(4)
            .max(933336)
            .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        })
        .strict(),
    },
    async ({ evidenceId, contentType, base64 }) =>
      run(async () => {
        let binary: string;
        try {
          binary = atob(base64);
        } catch {
          fail(422, "Invalid base64 image");
        }
        if (binary.length > 700000) fail(422, "Capture exceeds 700 KB");
        if (!env.COLLECTOR_TOKEN)
          fail(503, "Collector backend is not configured");
        const response = await app.request(
          env.API_ORIGIN + "/api/v1/media/upload",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.COLLECTOR_TOKEN}`,
              "content-type": contentType,
              "x-evidence-id": evidenceId,
            },
            body: Uint8Array.from(binary, (c) => c.charCodeAt(0)),
          },
          env,
        );
        const data = (await response.json()) as { error?: string };
        if (!response.ok)
          throw new Error(data.error ?? "Capture upload failed");
        return data;
      }),
  );
  server.registerTool(
    "save_funnel",
    {
      description:
        "Save observed ordered steps with evidence IDs. This returns the product to draft. Annotation must distinguish observed facts from interpretation.",
      inputSchema: z.object({ productId: id, steps: funnelInput }).strict(),
    },
    async ({ productId, steps }) =>
      run(() =>
        internal(
          "PUT",
          `/api/v1/admin/products/${encodeURIComponent(productId)}/funnel`,
          steps,
        ),
      ),
  );
  server.registerTool(
    "save_paywall",
    {
      description:
        "Save an evidence-backed paywall state machine as a private draft. Only describe actually observed states and triggers.",
      inputSchema: z.object({ productId: id, paywall: paywallInput }).strict(),
    },
    async ({ productId, paywall }) =>
      run(() =>
        internal(
          "PUT",
          `/api/v1/admin/products/${encodeURIComponent(productId)}/paywall`,
          paywall,
        ),
      ),
  );
  server.registerTool(
    "save_blueprint",
    {
      description:
        "Save a proposed implementation blueprint version as a private draft. The design is an inference from observed behavior, never a claim about the target internal code. Cannot publish.",
      inputSchema: z
        .object({ productId: id, blueprint: blueprintInput })
        .strict(),
    },
    async ({ productId, blueprint }) =>
      run(() =>
        internal(
          "POST",
          `/api/v1/admin/products/${encodeURIComponent(productId)}/blueprints`,
          blueprint,
        ),
      ),
  );
  server.registerTool(
    "register_browser_source",
    {
      description:
        "Register a browser-capture source for an existing draft research product. Automatic scheduling stays off until the owner enables it. Only public HTTPS URLs belonging to its domain are accepted.",
      inputSchema: z
        .object({
          productId: id,
          url: z.string().url(),
          name: z.string().min(1).max(200),
        })
        .strict(),
    },
    async (input) =>
      run(async () => {
        const product = await env.DB.prepare(
          "SELECT domain FROM products WHERE id=? AND EXISTS(SELECT 1 FROM research_profiles WHERE product_id=products.id)",
        )
          .bind(input.productId)
          .first<{ domain: string }>();
        if (!product) fail(422, "Register a research candidate first");
        const host = new URL(input.url).hostname.replace(/^www\./, "");
        if (host !== product.domain && !host.endsWith("." + product.domain))
          fail(422, "Source must belong to the candidate domain");
        return internal("POST", "/api/v1/admin/sources", {
          ...input,
          kind: "browser",
          enabled: true,
          intervalHours: 24,
        });
      }),
  );
  server.registerTool(
    "claim_capture_job",
    {
      description:
        "Atomically lease one due browser-capture job. The returned lease lasts ten minutes. Complete or fail it using its scoped lease token; heartbeat for longer captures.",
      inputSchema: {},
    },
    async () =>
      run(() =>
        internal(
          "POST",
          "/api/v1/collector/jobs/claim",
          { kinds: ["browser"] },
          true,
        ),
      ),
  );
  const lease = z.object({
    jobId: id,
    leaseToken: z.string().regex(/^[a-f0-9]{64}$/),
  });
  server.registerTool(
    "complete_capture_job",
    {
      description:
        "Complete the current lease and save observed evidence drafts. This never publishes records.",
      inputSchema: lease
        .extend({
          evidence: z
            .array(evidenceInput.omit({ productId: true }))
            .min(1)
            .max(30),
        })
        .strict(),
    },
    async ({ jobId, ...body }) =>
      run(() =>
        internal(
          "POST",
          `/api/v1/collector/jobs/${encodeURIComponent(jobId)}/complete`,
          body,
          true,
        ),
      ),
  );
  server.registerTool(
    "capture_job_heartbeat",
    {
      description: "Extend an unexpired capture lease.",
      inputSchema: lease.strict(),
    },
    async ({ jobId, ...body }) =>
      run(() =>
        internal(
          "POST",
          `/api/v1/collector/jobs/${encodeURIComponent(jobId)}/heartbeat`,
          body,
          true,
        ),
      ),
  );
  server.registerTool(
    "fail_capture_job",
    {
      description:
        "Record a real capture failure without fabricating evidence. Authentication errors and CAPTCHAs must stay visible.",
      inputSchema: lease
        .extend({ error: z.string().min(1).max(2000) })
        .strict(),
    },
    async ({ jobId, ...body }) =>
      run(() =>
        internal(
          "POST",
          `/api/v1/collector/jobs/${encodeURIComponent(jobId)}/fail`,
          body,
          true,
        ),
      ),
  );
  return server;
}
export async function remoteMcpFetch(
  request: Request,
  env: Bindings,
  ctx: OAuthResourceContext<unknown>,
) {
  try {
    const props = assertCollector(env, ctx.props, ctx.auth.scope);
    const origin = request.headers.get("origin");
    if (
      origin &&
      !["https://chatgpt.com", env.APP_ORIGIN, env.API_ORIGIN].includes(origin)
    )
      fail(403, "Untrusted MCP origin");
    if (new URL(request.url).origin !== env.API_ORIGIN)
      fail(400, "Unexpected MCP resource origin");
    await rateLimit(env.DB, "mcp:" + props.userId, 180);
    const server = collectorServer(env, props);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      maxRequestBodySize: 1_000_000,
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
            ? "Collector request failed"
            : error instanceof Error
              ? error.message
              : "Access denied",
      },
      { status },
    );
  }
}
