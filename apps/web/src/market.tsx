import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowUpRight } from "lucide-react";
import { api, errorMessage, useQuery, type MarketMovers, type MarketOverview } from "./api";
import { CATEGORY_LABEL, compactRank, shortDate, STACK_LABEL, TIER_LABEL, TRAFFIC_TITLE, type Category } from "./data";
import { ErrorPanel, PageHeading } from "./ui";

const TIER_ORDER = ["top 1K", "top 10K", "top 100K", "top 1M", "outside top 1M"];
const pct = (share: number) => `${Math.round(share * 100)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Bar = { key: string; label: ReactNode; share: number; detail: string; onClick?: () => void };

/** Share of products as a thin single-hue bar, value in text beside it and counts on hover. */
function Bars({ rows }: { rows: Bar[] }) {
  return (
    <div className="flex flex-col">
      {rows.map((r) => {
        const body = (
          <>
            <span className="min-w-0 truncate text-[13px]">{r.label}</span>
            <span className="h-2 overflow-hidden rounded-full bg-s3">
              <span className="block h-full rounded-full bg-arc" style={{ width: `${Math.max(r.share * 100, r.share > 0 ? 1.5 : 0)}%` }} />
            </span>
            <span className="num text-right text-[13px] text-t2">{pct(r.share)}</span>
          </>
        );
        const cls = "grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_44px] items-center gap-3 rounded-lg px-2 py-1.5";
        return r.onClick ? (
          <button key={r.key} title={r.detail} onClick={r.onClick} className={`${cls} text-left transition-colors hover:bg-s2`}>{body}</button>
        ) : (
          <div key={r.key} title={r.detail} className={`${cls} hover:bg-s2/60`}>{body}</div>
        );
      })}
    </div>
  );
}

function Panel({ title, note, className = "", children }: { title: string; note?: string; className?: string; children: ReactNode }) {
  return (
    <section className={`panel flex flex-col rounded-2xl p-4 ${className}`}>
      <h2 className="mb-3 px-2 font-medium">{title}</h2>
      <div className="flex-1">{children}</div>
      {note && <p className="mt-3 px-2 text-[12px] leading-[17px] text-t3">{note}</p>}
    </section>
  );
}

function Tile({ label, value, detail }: { label: string; value: ReactNode; detail: string }) {
  return (
    <div className="panel min-w-0 rounded-xl p-4">
      <div className="text-[12px] text-t2">{label}</div>
      <div className="num mt-1 text-[28px] font-semibold leading-[34px] tracking-[-0.02em]">{value}</div>
      <div className="mt-0.5 text-[12px] leading-[17px] text-t3">{detail}</div>
    </div>
  );
}

function Movers({ data }: { data?: MarketMovers }) {
  if (!data) return <div className="h-24 animate-pulse rounded-lg bg-s2" />;
  if (!data.items.length) {
    const first = data.historyStartsOn ? shortDate(new Date(Date.parse(`${data.historyStartsOn}T12:00:00Z`) + 7 * 86_400_000).toISOString()) : null;
    return (
      <p className="px-2 text-[13px] leading-[19px] text-t2">
        {first ? `Weekly movers start around ${first}, once a full week of daily ranks exists. Ranks have been tracked since ${shortDate(`${data.historyStartsOn}T12:00:00Z`)}.` : "No product climbed in the top-million ranking this week."}
      </p>
    );
  }
  return (
    <div className="flex flex-col">
      {data.items.map((m) => (
        <Link key={m.slug} to={`/app/${m.slug}`} className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-s2">
          <span className="min-w-0 flex-1 truncate">{m.name}</span>
          <span className="num text-[13px] text-t3">{m.rankThen === null ? "1M+" : compactRank(m.rankThen)} →</span>
          <span className="num w-16 text-right text-[13px] font-medium">{m.rankNow === null ? "1M+" : compactRank(m.rankNow)}</span>
          <ArrowUpRight className="size-3.5 text-arc" />
        </Link>
      ))}
    </div>
  );
}

export function Market() {
  const [sp, setSp] = useSearchParams();
  const cat = (sp.get("cat") ?? "") as Category | "";
  const scope = cat ? `category=${cat}` : "";
  const overview = useQuery((signal) => api<MarketOverview>(`/api/v1/market/overview${scope ? `?${scope}` : ""}`, { signal }), [cat]);
  const movers = useQuery((signal) => api<MarketMovers>(`/api/v1/market/movers?metric=traffic&window=7&limit=8${scope ? `&${scope}` : ""}`, { signal }), [cat]);
  const setCat = (value: string) => setSp(value ? { cat: value } : {}, { replace: true, preventScrollReset: true });
  const o = overview.data;
  const tiers = o ? TIER_ORDER.map((tier) => o.traffic.tiers.find((t) => t.tier === tier) ?? { tier, products: 0, share: 0 }) : [];
  const top100k = tiers.filter((t) => ["top 1K", "top 10K", "top 100K"].includes(t.tier));
  const ranked = o?.traffic.ranked ?? 0;
  const pricing = o?.pricing;
  // Same floor as the app page: a middle price from one or two products isn't a market figure.
  const median = pricing?.medianEntryUsd && pricing.medianEntryUsd.basis >= 3 ? pricing.medianEntryUsd : null;

  return (
    <main className="px-4 py-5 pb-24 lg:px-6 lg:py-6">
      <PageHeading title="Market" sub="How the software we track is priced, built and found, from public signals across every published product." />
      <div className="no-scrollbar -mx-4 mt-5 flex gap-2 overflow-x-auto px-4 lg:mx-0 lg:px-0">
        <button className="chip" data-on={!cat} onClick={() => setCat("")}>All categories</button>
        {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => <button key={c} className="chip" data-on={cat === c} onClick={() => setCat(c)}>{CATEGORY_LABEL[c]}</button>)}
      </div>

      {overview.error && !o ? (
        <div className="mt-5"><ErrorPanel message={errorMessage(overview.error)} onRetry={overview.reload} /></div>
      ) : !o || !pricing ? (
        <div aria-busy="true" className="mt-5 grid gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl bg-s2" />)}</div>
      ) : (
        <div className={`mt-5 flex flex-col gap-4 transition-opacity ${overview.loading ? "opacity-60" : ""}`}>
          <p className="text-[13px] text-t2">
            <span className="num text-t1">{o.scope.products}</span> published {o.scope.products === 1 ? "product" : "products"}{cat && ` in ${CATEGORY_LABEL[cat]}`}.{o.note && ` ${o.note}`}
          </p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="List a free plan" value={pricing.products ? pct(pricing.freePlan) : "—"} detail={`of ${plural(pricing.products, "product")} with published pricing`} />
            <Tile label="Offer a custom tier" value={pricing.products ? pct(pricing.customTier) : "—"} detail="Contact-sales or unpriced plans" />
            <Tile label="Middle USD entry price" value={median ? `$${median.monthly}/mo` : "—"} detail={median ? `Cheapest paid plan, from ${plural(median.basis, "product")} stating USD` : "Too few products state a USD price"} />
            <Tile label="In the top 100K sites" value={ranked ? pct(top100k.reduce((n, t) => n + t.products, 0) / ranked) : "—"} detail={`of ${plural(ranked, "product")} with a site checked, by Tranco rank`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="How they price" note={pricing.meaning}>
              <Bars rows={[
                { key: "free", label: "Free plan", share: pricing.freePlan, detail: `${Math.round(pricing.freePlan * pricing.products)} of ${pricing.products}` },
                { key: "paid", label: "Paid plan", share: pricing.paidPlan, detail: `${Math.round(pricing.paidPlan * pricing.products)} of ${pricing.products}` },
                { key: "custom", label: "Custom tier", share: pricing.customTier, detail: `${Math.round(pricing.customTier * pricing.products)} of ${pricing.products}` },
                { key: "usage", label: "Usage-based", share: pricing.usageBased, detail: `${Math.round(pricing.usageBased * pricing.products)} of ${pricing.products}` },
              ]} />
            </Panel>
            <Panel title="How much traffic they get" note={`${TRAFFIC_TITLE} Shares are of ${plural(ranked, "product")} with a site checked.`}>
              <Bars rows={tiers.map((t) => ({ key: t.tier, label: TIER_LABEL[t.tier] ?? t.tier, share: t.share, detail: `${t.products} of ${ranked}` }))} />
            </Panel>
            <Panel title="What they're built with" note={o.stack.meaning}>
              {o.stack.items.length ? (
                <Bars rows={o.stack.items.slice(0, 12).map((x) => ({ key: x.technology, label: <>{x.technology} <span className="text-t3 max-sm:hidden">· {STACK_LABEL[x.category] ?? x.category}</span></>, share: x.share, detail: `${x.products} of ${o.scope.products} products` }))} />
              ) : <p className="px-2 text-[13px] text-t2">No technologies detected yet.</p>}
            </Panel>
            <div className="flex flex-col gap-4">
              <Panel title="Biggest traffic climbers this week" note={movers.data?.items.length ? movers.data.meaning : undefined}>
                <Movers data={movers.data} />
              </Panel>
              {!cat && (
                <Panel title="Categories">
                  <Bars rows={o.categories.map((c) => ({ key: c.value, label: CATEGORY_LABEL[c.value as Category] ?? c.value, share: c.share, detail: `${c.products} products · show only this category`, onClick: () => setCat(c.value) }))} />
                </Panel>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
