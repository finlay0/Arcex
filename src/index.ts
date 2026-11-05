import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import type { AppEnv, Bindings } from "./types";
import { auth } from "./auth";
import { catalog, adminCatalog } from "./catalog";
import { community, adminCommunity } from "./community";
import { billing, adminBilling } from "./billing";
import { collector, jobAdmin, enqueueDue, expireAuthState } from "./jobs";
import { media } from "./media";
import {
  adminInsights,
  insights,
  METRICS_CRON,
  refreshMetrics,
} from "./insights";
import { openapi } from "./openapi";
import { researchAdmin } from "./research";
import { distributionAdmin, distributionStatus } from "./distribution";
import { externalSignalsAdmin } from "./external-signals";
import { publicPricing, adminPublicPricing } from "./public-pricing";
import { libraries } from "./libraries";
import {
  emailAlerts,
  adminEmailAlerts,
  deliverOneDigest,
} from "./email-alerts";

export const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  await next();
  c.header("x-request-id", c.get("requestId"));
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  c.header("cache-control", "no-store");
});
app.use(
  "*",
  cors({
    origin: (origin, c) => (origin === c.env.APP_ORIGIN ? origin : ""),
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Evidence-ID"],
  }),
);
app.use(
  "*",
  bodyLimit({
    maxSize: 1_000_000,
    onError: (c) => c.json({ error: "Request exceeds 1 MB" }, 413),
  }),
);
app.get("/", (c) =>
  c.json({
    name: "Arcex",
    version: "0.1.0",
    api: "/api/v1",
    schema: "/openapi.json",
    ui: false,
  }),
);
app.get("/health", async (c) => {
  await c.env.DB.prepare("SELECT 1").first();
  return c.json({ ok: true, service: "arcex-api" });
});
app.get("/openapi.json", (c) => c.json(openapi));
app.route("/auth", auth);
app.route("/api/v1", catalog);
app.route("/api/v1", community);
app.route("/api/v1", insights);
app.route("/api/v1", publicPricing);
app.route("/api/v1", libraries);
app.route("/api/v1", emailAlerts);
app.route("/api/v1/admin", adminCatalog);
app.route("/api/v1/admin", adminCommunity);
app.route("/api/v1/admin", adminBilling);
app.route("/api/v1/admin", jobAdmin);
app.route("/api/v1/admin", researchAdmin);
app.route("/api/v1/admin", distributionAdmin);
app.route("/api/v1/admin", externalSignalsAdmin);
app.route("/api/v1/admin", adminInsights);
app.route("/api/v1/admin", adminPublicPricing);
app.route("/api/v1/admin", adminEmailAlerts);
app.get("/api/v1/distribution/:slug", async (c) => {
  const product = await c.env.DB.prepare(
    "SELECT id FROM products WHERE slug=? AND status='published'",
  )
    .bind(c.req.param("slug"))
    .first<{ id: string }>();
  if (!product) return c.json({ error: "Product not found" }, 404);
  return c.json(await distributionStatus(c.env.DB, product.id, true));
});
app.route("/api/v1/collector/jobs", collector);
app.route("/api/v1/media", media);
app.route("/api/v1/billing", billing);
app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  if (error instanceof HTTPException)
    return c.json(
      { error: error.message, requestId: c.get("requestId") },
      error.status,
    );
  if (error instanceof ZodError)
    return c.json(
      {
        error: "Invalid input",
        issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
      422,
    );
  // Provider errors and SQL may contain sensitive payloads; logs use request IDs and error class only.
  console.error(
    JSON.stringify({
      event: "request.failed",
      requestId: c.get("requestId"),
      type: error.name,
    }),
  );
  return c.json(
    { error: "Internal server error", requestId: c.get("requestId") },
    500,
  );
});
export default {
  fetch: app.fetch,
  async scheduled(
    event: ScheduledController,
    env: Bindings,
    _ctx: ExecutionContext,
  ) {
    // Share one timer within the account's Free cron limit. Metrics run with collection off.
    // At most34 metrics +4 auth cleanup +10 enqueue, or12 delivery statements.
    // Collection and delivery alternate when both are enabled, staying below D1 Free's50 queries.
    await expireAuthState(env.DB);
    if (event.cron === METRICS_CRON) {
      const metrics = await refreshMetrics(env.DB);
      console.log(JSON.stringify({ event: "metrics.refreshed", ...metrics }));
    }
    if (
      env.COLLECTION_ENABLED === "true" &&
      new Date(event.scheduledTime).getUTCMinutes() % 20 === 0
    ) {
      const result = await enqueueDue(env);
      console.log(JSON.stringify({ event: "collection.enqueued", ...result }));
    } else if (env.EMAIL_ALERTS_ENABLED === "true") {
      const result = await deliverOneDigest(env);
      console.log(JSON.stringify({ event: "alerts.dispatched", ...result }));
    }
  },
} satisfies ExportedHandler<Bindings>;
