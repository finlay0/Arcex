import { useEffect, useState } from "react";
import type { Category, ChangeKind, Model, Stage } from "./data";

/** Local development goes through the Vite proxy, so the browser stays on one origin. */
const BASE: string = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? "" : "https://api.arcex.dev");
export const PUBLIC_API = "https://api.arcex.dev";
export const MCP_URL = PUBLIC_API + "/public/mcp";
export const apiUrl = (path: string) => BASE + path;

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
  get code() {
    return this.body.code as string | undefined;
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(BASE + path, {
    method: options.method,
    signal: options.signal,
    credentials: "include",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(typeof body.error === "string" ? body.error : "Something went wrong", response.status, body);
  return body as T;
}

export const errorMessage = (error: unknown) => (error instanceof ApiError ? error.message : "We couldn't reach Arcex. Check your connection and try again.");

/** Loads when its dependencies change, cancels stale requests and keeps the last result on screen. */
export function useQuery<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[], enabled = true) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: enabled });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState((s) => ({ ...s, error: undefined, loading: true }));
    load(controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ data, loading: false }); },
      (error) => { if (!controller.signal.aborted) setState((s) => ({ ...s, error, loading: false })); },
    );
    return () => controller.abort();
  }, [enabled, attempt, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: () => setAttempt((n) => n + 1) };
}

/** Null always means not collected. It must never be displayed as zero. */
export type Product = {
  id: string; slug: string; name: string; url: string; domain: string; description: string;
  category: Category; monetization: Model; coverage: "full" | "signals";
  step_count: number; has_blueprint: boolean; open_sample: boolean; observations: number;
  active_ads: number | null; ads_delta_7d: number | null; longest_ad_days: number | null;
  creators: number | null; sponsors: number | null; creators_delta_7d: number | null;
  activity_change_4w: number | null; activity_weekly: (number | null)[];
  first_seen: string | null; last_seen: string | null;
  revenue_low_usd: number | null; revenue_high_usd: number | null; revenue_confidence: number | null;
  /** Null rank with a tier means outside the top million; both null means not ranked yet. */
  traffic_rank: number | null; traffic_tier: string | null; icon_url: string | null;
  /** Summary of the latest published pricing page; null when none is published. */
  pricing: PricingSummary | null;
};

export type PricingSummary = {
  freePlan: boolean; usageBased: boolean; customTier: boolean;
  entry: { name: string; displayedPrice: string; monthlyAmount: number; currency: string | null } | null;
};

type RawProduct = Partial<Omit<Product, "activity_weekly" | "has_blueprint" | "open_sample">> & {
  coverage_level?: Product["coverage"];
  activity_weekly?: (number | null)[] | string | null;
  has_blueprint?: boolean | number;
  open_sample?: boolean | number;
};

export function toProduct(raw: RawProduct): Product {
  const weekly = typeof raw.activity_weekly === "string" ? (JSON.parse(raw.activity_weekly) as (number | null)[]) : raw.activity_weekly;
  return {
    id: raw.id ?? "", slug: raw.slug ?? "", name: raw.name ?? "", url: raw.url ?? "", domain: raw.domain ?? "", description: raw.description ?? "",
    category: raw.category ?? "other", monetization: raw.monetization ?? "unknown", coverage: raw.coverage ?? raw.coverage_level ?? "signals",
    step_count: raw.step_count ?? 0, has_blueprint: !!raw.has_blueprint, open_sample: !!raw.open_sample, observations: raw.observations ?? 0,
    active_ads: raw.active_ads ?? null, ads_delta_7d: raw.ads_delta_7d ?? null, longest_ad_days: raw.longest_ad_days ?? null,
    creators: raw.creators ?? null, sponsors: raw.sponsors ?? null, creators_delta_7d: raw.creators_delta_7d ?? null,
    activity_change_4w: raw.activity_change_4w ?? null, activity_weekly: weekly ?? [],
    first_seen: raw.first_seen ?? null, last_seen: raw.last_seen ?? null,
    revenue_low_usd: raw.revenue_low_usd ?? null, revenue_high_usd: raw.revenue_high_usd ?? null, revenue_confidence: raw.revenue_confidence ?? null,
    traffic_rank: raw.traffic_rank ?? null, traffic_tier: raw.traffic_tier ?? null, icon_url: raw.icon_url ?? null,
    pricing: raw.pricing ?? null,
  };
}

// A short cache keeps back-navigation instant and each page view from re-reading the catalog.
const RADAR_TTL = 60_000;
const radarCache = new Map<string, { at: number; value: { items: Product[]; total: number } }>();

export async function fetchRadar(params: Record<string, string | number>, signal?: AbortSignal) {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const cached = radarCache.get(query);
  if (cached && Date.now() - cached.at < RADAR_TTL) return cached.value;
  const result = await api<{ items: RawProduct[]; total: number }>(`/api/v1/radar?${query}`, { signal });
  const value = { items: result.items.map(toProduct), total: result.total };
  if (radarCache.size >= 100) radarCache.clear();
  radarCache.set(query, { at: Date.now(), value });
  return value;
}

export type Usage = { used: number; limit: number; resetsAt: string };
export type Change = { id: string; kind: ChangeKind; summary: string; observed_at: string; slug: string; name: string };
export type Step = { id: string; evidence_id: string; position: number; title: string; stage: Stage; annotation: string; image_url: string | null };
export type Signal = { id: string; kind: string; external_id: string; observed_at: string; source_url: string; detail: Record<string, unknown> };
export type Evidence = { id: string; source_url: string; observed_at: string; kind: string; summary: string };
export type Offer = { name: string; displayedPrice: string; limits: string[]; sourceUrl: string; amount?: string | null; currency?: string | null; interval?: string };

/** Mirrors the API's Radar summary: the entry plan is only compared within one stated currency. */
export function summarizeOffers(offers: Offer[]): PricingSummary {
  const amount = (o: Offer) => (o.amount == null ? null : Number(o.amount));
  const recurring = offers
    .filter((o) => (o.interval === "month" || o.interval === "year") && (amount(o) ?? 0) > 0)
    .map((o) => ({ o, monthly: o.interval === "year" ? amount(o)! / 12 : amount(o)! }));
  const currency = recurring[0]?.o.currency ?? null;
  const cheapest = recurring.filter((r) => (r.o.currency ?? null) === currency).sort((a, b) => a.monthly - b.monthly)[0];
  return {
    freePlan: offers.some((o) => o.interval === "free" || amount(o) === 0),
    entry: cheapest ? { name: cheapest.o.name, displayedPrice: cheapest.o.displayedPrice, monthlyAmount: Math.round(cheapest.monthly * 100) / 100, currency } : null,
    usageBased: offers.some((o) => o.interval === "usage"),
    customTier: offers.some((o) => o.amount == null && (o.interval === "unknown" || o.interval === "month" || o.interval === "year")),
  };
}

type Share = { products: number; share: number };
export type MarketOverview = {
  scope: { category: string | null; products: number };
  note: string | null;
  categories: (Share & { value: string })[];
  traffic: { meaning: string; ranked: number; tiers: (Share & { tier: string })[] };
  stack: { meaning: string; items: (Share & { technology: string; category: string })[] };
  stores: { store: string; n: number }[];
  pricing: { products: number; freePlan: number; paidPlan: number; usageBased: number; customTier: number; medianEntryUsd: { monthly: number; basis: number } | null; meaning: string };
};
export type RevenueRange = { low_usd: number; high_usd: number; confidence: number; method_version: string; inputs: { basis: string; label: string; value: string; sourceUrl?: string }[]; meaning: string };
export type Traffic = { source: string; meaning: string; latest: { observedOn: string; rank: number | null; tier: string } | null; history: { observed_on: string; rank: number | null }[] };
export type StackItem = { technology: string; category: string; first_seen: string; removed_at: string | null };
export type Vault = {
  product: RawProduct;
  traffic?: Traffic;
  stack?: { meaning: string; items: StackItem[] };
  coverage: Product["coverage"];
  access: "open" | "preview" | "full";
  usage: Usage | null;
  publicPricing: { offers: Offer[]; observed_at: string; meaning: string } | null;
  metrics: (RawProduct & { meaning: string }) | null;
  revenueRange: RevenueRange | null;
  adObservations: { observed_days: number; first_observed: string | null; last_observed: string | null; meaning: string };
  outline?: { position: number; title: string; stage: Stage }[];
  funnel: Step[];
  signals: Signal[];
  paywall: { pattern: Model; states: string[]; transitions: { from: string; to: string; trigger: string }[]; credit_rules: Record<string, unknown>; notes: string } | null;
  blueprints: { id: string; version: number; title: string }[];
  evidence: Evidence[];
};

export function vaultProduct(v: Vault): Product {
  const range = v.revenueRange;
  const latest = v.traffic?.latest;
  return toProduct({ ...v.product, ...v.metrics, coverage: v.coverage, revenue_low_usd: range?.low_usd, revenue_high_usd: range?.high_usd, revenue_confidence: range?.confidence, traffic_rank: latest?.rank ?? null, traffic_tier: latest?.tier ?? null });
}

export type BlueprintExport = { title: string; spec: Record<string, unknown>; partners: { name: string; url: string; relationship: string; disclosure: string; role: string }[] };

// GitHub's callback is on the workers.dev host, so its session wouldn't reach arcex.dev.
const SAME_SITE_PROVIDERS = ["google"];
let providers: Promise<string[]> | undefined;
export function fetchProviders() {
  providers ??= api<{ providers: { id: string; configured: boolean }[] }>("/auth/providers")
    .then((r) => r.providers.filter((p) => p.configured && SAME_SITE_PROVIDERS.includes(p.id)).map((p) => p.id))
    .catch(() => { providers = undefined; return []; });
  return providers;
}
export const signInUrl = (provider: string) => apiUrl(`/auth/${provider}/start?returnTo=${encodeURIComponent(location.pathname + location.search)}`);

export type TrafficMover = { slug: string; name: string; category: Category; rankNow: number | null; rankThen: number | null; comparedOn: string; change: number; tierNow: string };
export type MarketMovers = { meaning: string; historyStartsOn: string | null; since: string | null; until: string | null; items: TrafficMover[] };
