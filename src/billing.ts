import Stripe from "stripe";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "./types";
import { now } from "./types";
import { audit, fail, rateLimit } from "./lib";
import { requireAdmin, requireSession, requireUser } from "./auth";

export function stripeClient(env: Bindings) {
  if (!env.STRIPE_SECRET_KEY) fail(503, "Billing is not configured");
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
  });
}
async function customer(env: Bindings, userId: string, stripe: Stripe) {
  const row = await env.DB.prepare(
    "SELECT customer_id FROM subscriptions WHERE user_id=?",
  )
    .bind(userId)
    .first<{ customer_id: string | null }>();
  if (row?.customer_id) return row.customer_id;
  const created = await stripe.customers.create(
    { metadata: { arcex_user_id: userId } },
    { idempotencyKey: `arcex-customer-${userId}` },
  );
  await env.DB.prepare(
    "INSERT INTO subscriptions(user_id,customer_id,status,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET customer_id=excluded.customer_id,updated_at=excluded.updated_at",
  )
    .bind(userId, created.id, "inactive", now())
    .run();
  return created.id;
}
const objectId = (v: string | { id: string } | null | undefined) =>
  typeof v === "string" ? v : v?.id;
const PRO_NAME = "ArcX Pro";
const PRO_AMOUNT = 1199;
function regionalOffer(request: Request) {
  return {
    planName: PRO_NAME,
    currency: request.cf?.country === "CA" ? "cad" : "usd",
    unitAmount: PRO_AMOUNT,
    interval: "month" as const,
  };
}
function regionalPriceReady(price: Stripe.Price) {
  const product = price.product;
  return (
    price.active &&
    price.currency === "usd" &&
    price.unit_amount === PRO_AMOUNT &&
    price.currency_options?.cad?.unit_amount === PRO_AMOUNT &&
    price.recurring?.interval === "month" &&
    price.recurring.interval_count === 1 &&
    typeof product !== "string" &&
    !product.deleted &&
    product.active &&
    product.name === PRO_NAME
  );
}
export const billing = new Hono<AppEnv>();
billing.get("/price", (c) => c.json(regionalOffer(c.req.raw)));
billing.post("/checkout", requireUser, requireSession, async (c) => {
  if (!c.env.STRIPE_PRICE_ID) fail(503, "ArcX Pro price is not configured");
  if (c.get("actor").pro) fail(409, "ArcX Pro is already active");
  const userId = c.get("actor").userId;
  if (
    await c.env.DB.prepare("SELECT user_id FROM billing_holds WHERE user_id=?")
      .bind(userId)
      .first()
  )
    fail(403, "Billing account requires review");
  await rateLimit(c.env.DB, "checkout:" + userId, 5, 3600);
  const stripe = stripeClient(c.env),
    offer = regionalOffer(c.req.raw);
  const price = await stripe.prices.retrieve(c.env.STRIPE_PRICE_ID, {
    expand: ["currency_options", "product"],
  });
  if (!regionalPriceReady(price))
    fail(503, "ArcX Pro regional pricing is not configured");
  const customerId = await customer(c.env, userId, stripe);
  // Reconcile remote state before offering a new subscription when webhook delivery is delayed.
  const existing = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  });
  if (
    existing.data.some(
      (s) =>
        !["canceled", "incomplete_expired"].includes(s.status) &&
        s.items.data.some((i) => i.price.id === c.env.STRIPE_PRICE_ID),
    )
  )
    fail(409, "Subscription already exists; use the billing portal");
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) =>
    String.fromCharCode(97 + (n % 26)),
  ).join("");
  const bucket = Math.floor(Date.now() / 1800000);
  await c.env.DB.prepare(
    "INSERT INTO checkout_attempts VALUES (?,?,?) ON CONFLICT DO NOTHING",
  )
    .bind(userId, bucket, suffix)
    .run();
  const attempt = await c.env.DB.prepare(
    "SELECT suffix FROM checkout_attempts WHERE user_id=? AND bucket=?",
  )
    .bind(userId, bucket)
    .first<{ suffix: string }>();
  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      currency: offer.currency,
      adaptive_pricing: { enabled: false },
      customer: customerId,
      line_items: [{ price: c.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: userId,
      subscription_data: { metadata: { arcex_user_id: userId } },
      success_url: c.env.APP_ORIGIN + "/?checkout=success",
      cancel_url: c.env.APP_ORIGIN + "/?checkout=canceled",
      integration_identifier: "arcex_" + attempt!.suffix,
    },
    {
      idempotencyKey: `arcex-checkout-${userId}-${c.env.STRIPE_PRICE_ID}-${offer.currency}-${bucket}`,
    },
  );
  return c.json({ url: session.url });
});
billing.post("/portal", requireUser, requireSession, async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT customer_id FROM subscriptions WHERE user_id=?",
  )
    .bind(c.get("actor").userId)
    .first<{ customer_id: string | null }>();
  if (!row?.customer_id) fail(409, "No billing account exists");
  const session = await stripeClient(c.env).billingPortal.sessions.create({
    customer: row.customer_id,
    return_url: c.env.APP_ORIGIN,
  });
  return c.json({ url: session.url });
});
billing.get("/status", requireUser, async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT status,price_id,period_end,updated_at FROM subscriptions WHERE user_id=?",
  )
    .bind(c.get("actor").userId)
    .first();
  return c.json({ subscription: row ?? null, insider: c.get("actor").pro });
});

const subscriptionEvents = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);
const invoiceEvents = new Set(["invoice.paid", "invoice.payment_failed"]);
const riskEvents = new Set([
  "charge.dispute.created",
  "charge.refunded",
  "radar.early_fraud_warning.created",
]);

export async function processStripeEvent(
  env: Bindings,
  event: Stripe.Event,
  stripe: Stripe,
) {
  if (
    await env.DB.prepare("SELECT id FROM webhook_receipts WHERE id=?")
      .bind(event.id)
      .first()
  )
    return { duplicate: true };
  let subscriptionId: string | undefined, customerId: string | undefined;
  const statements: D1PreparedStatement[] = [];
  if (subscriptionEvents.has(event.type)) {
    const sub = event.data.object as Stripe.Subscription;
    subscriptionId = sub.id;
    customerId = objectId(sub.customer);
  } else if (invoiceEvents.has(event.type)) {
    const invoice = event.data.object as Stripe.Invoice;
    subscriptionId = objectId(
      invoice.parent?.subscription_details?.subscription,
    );
    customerId = objectId(invoice.customer);
  } else if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const session = event.data.object as Stripe.Checkout.Session;
    subscriptionId = objectId(session.subscription);
    customerId = objectId(session.customer);
  } else if (riskEvents.has(event.type)) {
    let charge: Stripe.Charge;
    if (event.type === "charge.refunded")
      charge = event.data.object as Stripe.Charge;
    else {
      const obj = event.data.object as
        Stripe.Dispute | Stripe.Radar.EarlyFraudWarning;
      const chargeId = objectId(obj.charge);
      if (!chargeId) fail(422, "Risk event has no charge");
      charge = await stripe.charges.retrieve(chargeId);
    }
    customerId = objectId(charge.customer);
  }
  if (customerId) {
    const local = await env.DB.prepare(
      "SELECT user_id,subscription_id FROM subscriptions WHERE customer_id=?",
    )
      .bind(customerId)
      .first<{ user_id: string; subscription_id: string | null }>();
    if (local && riskEvents.has(event.type)) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO billing_holds VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET reason=excluded.reason,event_id=excluded.event_id,created_at=excluded.created_at",
        ).bind(local.user_id, event.type, event.id, now()),
      );
      statements.push(
        env.DB.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?,?)").bind(
          crypto.randomUUID(),
          "stripe",
          "billing.risk_hold",
          local.user_id,
          JSON.stringify({ eventId: event.id, type: event.type }),
          now(),
        ),
      );
    } else if (local && subscriptionId) {
      // Fetch authoritative current state; an older delivered event must not restore a canceled subscription.
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      if (objectId(sub.customer) !== customerId)
        fail(422, "Subscription customer mismatch");
      const item = sub.items.data.find(
        (i) => i.price.id === env.STRIPE_PRICE_ID,
      );
      if (item)
        statements.push(
          env.DB.prepare(
            "UPDATE subscriptions SET subscription_id=?,status=?,price_id=?,period_end=?,updated_at=?,subscription_created=?,last_event_created=? WHERE user_id=? AND customer_id=? AND subscription_created<=? AND last_event_created<=? AND NOT (subscription_id=? AND status='canceled' AND ?<>'canceled')",
          ).bind(
            sub.id,
            sub.status,
            item.price.id,
            new Date(item.current_period_end * 1000).toISOString(),
            now(),
            sub.created,
            event.created,
            local.user_id,
            customerId,
            sub.created,
            event.created,
            sub.id,
            sub.status,
          ),
        );
      else if (local.subscription_id === sub.id)
        statements.push(
          env.DB.prepare(
            "UPDATE subscriptions SET status='inactive',price_id=NULL,period_end=NULL,updated_at=?,last_event_created=? WHERE user_id=? AND subscription_id=? AND last_event_created<=?",
          ).bind(now(), event.created, local.user_id, sub.id, event.created),
        );
    }
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO webhook_receipts VALUES (?,?) ON CONFLICT(id) DO NOTHING",
    ).bind(event.id, now()),
  );
  await env.DB.batch(statements);
  return { duplicate: false };
}
billing.post("/webhook", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET)
    fail(503, "Stripe webhook is not configured");
  const stripe = stripeClient(c.env),
    signature = c.req.header("stripe-signature");
  if (!signature) fail(400, "Missing webhook signature");
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await c.req.text(),
      signature,
      c.env.STRIPE_WEBHOOK_SECRET,
      300,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    fail(400, "Invalid webhook signature");
  }
  const result = await processStripeEvent(c.env, event, stripe);
  return c.json({ received: true, ...result });
});
export const adminBilling = new Hono<AppEnv>();
adminBilling.use("*", requireAdmin);
adminBilling.get("/billing/readiness", async (c) => {
  if (!c.env.STRIPE_PRICE_ID || !c.env.STRIPE_WEBHOOK_SECRET)
    fail(503, "Billing secrets are incomplete");
  const stripe = stripeClient(c.env);
  const [price, webhooks, portals] = await Promise.all([
    stripe.prices.retrieve(c.env.STRIPE_PRICE_ID, {
      expand: ["currency_options", "product"],
    }),
    stripe.webhookEndpoints.list({ limit: 100 }),
    stripe.billingPortal.configurations.list({ limit: 100 }),
  ]);
  const target = c.env.API_ORIGIN + "/api/v1/billing/webhook";
  const endpoint = webhooks.data.find((w) => w.url === target);
  return c.json({
    mode: price.livemode ? "live" : "sandbox",
    price: {
      active: price.active,
      currency: price.currency,
      unitAmount: price.unit_amount,
      interval: price.recurring?.interval ?? null,
      cadUnitAmount: price.currency_options?.cad?.unit_amount ?? null,
      planName:
        typeof price.product !== "string" && !price.product.deleted
          ? price.product.name
          : null,
      regionalPricingReady: regionalPriceReady(price),
    },
    webhook: {
      exists: !!endpoint,
      enabled: endpoint?.status === "enabled",
      events: endpoint?.enabled_events ?? [],
    },
    portalConfigured: portals.data.some((p) => p.active),
    credentialsConfigured: true,
  });
});
adminBilling.get("/billing/holds", async (c) =>
  c.json({
    items: (
      await c.env.DB.prepare(
        "SELECT * FROM billing_holds ORDER BY created_at DESC LIMIT 100",
      ).all()
    ).results,
  }),
);
adminBilling.delete("/billing/holds/:userId", async (c) => {
  await c.env.DB.prepare("DELETE FROM billing_holds WHERE user_id=?")
    .bind(c.req.param("userId"))
    .run();
  await audit(c.env.DB, "admin", "billing.hold.clear", c.req.param("userId"));
  return c.json({ ok: true });
});
