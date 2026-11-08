// Labels and formatting shared across the app. All product data comes from the API.
export type Stage = "landing" | "signup" | "onboarding" | "activation" | "paywall" | "retention";
export const STAGES: Stage[] = ["landing", "signup", "onboarding", "activation", "paywall", "retention"];
export const STAGE_LABEL: Record<Stage, string> = {
  landing: "Landing", signup: "Signup", onboarding: "Onboarding", activation: "Activation", paywall: "Paywall", retention: "Retention",
};

export type Category = "coding_dev" | "video_creator" | "sales_automation" | "consumer_ai" | "other";
export const CATEGORY_LABEL: Record<Category, string> = { coding_dev: "Dev", video_creator: "Video", sales_automation: "Sales", consumer_ai: "Consumer", other: "Other" };

export type Model = "credit_exhaustion" | "hard_trial_gate" | "watermark_export" | "usage_based" | "free_viral_utility" | "subscription" | "unknown";
export const MODEL_LABEL: Record<Model, string> = {
  credit_exhaustion: "Credit gate", hard_trial_gate: "Hard trial", watermark_export: "Watermark", usage_based: "Usage", free_viral_utility: "Free viral", subscription: "Subscription", unknown: "Unknown",
};

export type ChangeKind = "ads" | "creators" | "paywall" | "flow" | "public_page";
export const CHANGE_LABEL: Record<ChangeKind, string> = { ads: "Ads", creators: "Creators", paywall: "Paywall", flow: "Onboarding", public_page: "Public page" };

/** Shown wherever a value wasn't collected. Unknown never reads as zero or small. */
export const DASH = "—";
/** Tranco rank, compact for table cells: #880, #17.8K, #412K. */
export const compactRank = (rank: number) => "#" + (rank < 1000 ? rank : rank < 100_000 ? `${(rank / 1000).toFixed(1).replace(/.0$/, "")}K` : `${Math.round(rank / 1000)}K`);
export const TIER_LABEL: Record<string, string> = { "top 1K": "Top 1K", "top 10K": "Top 10K", "top 100K": "Top 100K", "top 1M": "Top 1M", "outside top 1M": "Below top 1M" };
export const TRAFFIC_TITLE = "Site popularity rank in the Tranco top-million list, checked daily. Lower is more popular. A popularity tier, not visitor counts or revenue.";
export const PRICE_TITLE = "From the product's public pricing page: the cheapest paid plan as listed, and whether a free plan exists.";

/** The cheapest paid plan as the pricing page shows it, else the kind of plan it lists. */
export function priceLabel(pricing: { freePlan: boolean; usageBased: boolean; customTier: boolean; entry: { displayedPrice: string } | null } | null) {
  if (!pricing) return null;
  // Trailing notes in brackets ("(billed yearly)") stay on the app page's full pricing list.
  if (pricing.entry) return pricing.entry.displayedPrice.replace(/\s*\([^)]*\)\s*$/, "") || pricing.entry.displayedPrice;
  if (pricing.freePlan) return "Free";
  if (pricing.usageBased) return "Usage-based";
  if (pricing.customTier) return "Custom";
  return null;
}

const dollars = (n: number) => (n >= 1_000_000 ? `$${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `$${+(n / 1000).toFixed(1)}k` : `$${n}`);
export const formatRevenue = (low: number | null, high: number | null) => (low === null || high === null ? DASH : low === high ? dollars(low) : `${dollars(low)}–${dollars(high)}`);

export function ago(iso: string | null | undefined) {
  if (!iso) return DASH;
  const minutes = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes)) return DASH;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  const days = minutes / 1440;
  return days < 30 ? `${Math.round(days)}d ago` : days < 365 ? `${Math.round(days / 30)}mo ago` : `${(days / 365).toFixed(1)}y ago`;
}

export const shortDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : DASH);
