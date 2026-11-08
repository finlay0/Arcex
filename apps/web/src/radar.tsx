import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowDown, ArrowRight, ArrowUp, ChartNoAxesColumnIncreasing, Check, ChevronLeft, ChevronRight, Circle, Layers, Lock, Search, X } from "lucide-react";
import { errorMessage, fetchRadar, useQuery, type Product } from "./api";
import { ago, CATEGORY_LABEL, compactRank, DASH, formatRevenue, PRICE_TITLE, priceLabel, TIER_LABEL, TRAFFIC_TITLE, type Category } from "./data";
import { useOpenProduct, useSession } from "./shell";
import { Confidence, ErrorPanel, FilterMenu, PageHeading, ProductIcon, useDebounced, useMedia, VideoCountIcon } from "./ui";

const PAGE_SIZE = 50;
const DAY = 86_400_000;
const SIGNALS = [
  { value: "", label: "All Signals" },
  { value: "ads30", label: "Ads Seen 30+ Days" },
  { value: "sponsored", label: "Sponsored Creators" },
  { value: "blueprint", label: "Has MCP Blueprint" },
  { value: "changed", label: "Changed This Week" },
];
const ADDED = [
  { value: "", label: "Any First Seen" },
  { value: "7", label: "First Seen: 7 Days" },
  { value: "30", label: "First Seen: 30 Days" },
  { value: "90", label: "First Seen: 90 Days" },
];
const COVERAGE = [
  { value: "", label: "Any Coverage" },
  { value: "full", label: "Full Screens" },
  { value: "signals", label: "Signals Only" },
];
// Views sort on data collected for every product. Ad and creator trends join when those scans are live.
const PRESETS = [
  { value: "", label: "All", sort: "", firstSeenDays: 0 },
  { value: "popular", label: "Most visited", sort: "traffic", firstSeenDays: 0 },
  { value: "new", label: "New", sort: "first", firstSeenDays: 30 },
];
const SORT_VALUE: Record<string, (p: Product) => number | string | null> = {
  revenue: (p) => p.revenue_high_usd,
  activity: (p) => p.activity_change_4w,
  // Negated so "descending" means most popular first, matching the server.
  traffic: (p) => (p.traffic_rank === null ? null : -p.traffic_rank),
  ads: (p) => p.active_ads,
  sponsors: (p) => p.sponsors,
  first: (p) => p.first_seen,
  seen: (p) => p.last_seen,
};

function Delta({ n }: { n: number | null }) {
  if (!n) return null;
  return <span title="Change in the last 7 days" className={`hidden text-[12px] font-normal md:inline ${n > 0 ? "text-arc" : "text-t3"}`}>{n > 0 ? `+${n}` : n}</span>;
}

function TrafficCell({ p }: { p: Product }) {
  if (!p.traffic_tier) return <span title="Not ranked yet" className="num text-[13px] text-t3">{DASH}</span>;
  return (
    <span title={TRAFFIC_TITLE} className="min-w-0">
      <span className="num block text-[13px] font-medium">{p.traffic_rank === null ? "1M+" : compactRank(p.traffic_rank)}</span>
      <span className="hidden truncate text-[11px] text-t3 md:block">{TIER_LABEL[p.traffic_tier] ?? p.traffic_tier}</span>
    </span>
  );
}

const PRICES = [
  { value: "", label: "Any Price" },
  { value: "free", label: "Has a free plan" },
  { value: "paid_only", label: "Paid plans only" },
];
const hasFree = (p: Product) => !!p.pricing?.freePlan;
const paidOnly = (p: Product) => !!p.pricing?.entry && !p.pricing.freePlan;

function PriceCell({ p }: { p: Product }) {
  const label = priceLabel(p.pricing);
  if (!label) return <span title="No published pricing yet" className="col-mon num text-[13px] text-t3">{DASH}</span>;
  return (
    <span title={`${label}${p.pricing?.entry && p.pricing.freePlan ? " · free plan available" : ""}`} className="col-mon min-w-0">
      <span className="num block truncate text-[13px] font-medium">{label}</span>
      {p.pricing?.entry && p.pricing.freePlan && <span className="block truncate text-[11px] text-arc">Free plan</span>}
    </span>
  );
}

function Row({ p, fresh, onOpen }: { p: Product; fresh: boolean; onOpen: () => void }) {
  const s = useSession();
  const open = !s.signedIn && p.open_sample && p.coverage === "full";
  return (
    <button data-radar-row data-slug={p.slug} onClick={onOpen} className="radar-grid radar-row w-full rounded-lg px-4 py-[13px] text-left transition-colors">
      <span className="flex min-w-0 items-center gap-3">
        <ProductIcon p={p} />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-[15px] font-medium leading-[20px]">
            <span className="truncate">{p.name}</span>
            {fresh && <span title="Changed since your last visit" className="size-1.5 shrink-0 rounded-full bg-arc" />}
            {open && <span className="shrink-0 rounded bg-arc-dim px-1.5 text-[11px] font-medium leading-[18px] text-arc">No sign-in</span>}
          </span>
          <span className="line-clamp-2 text-[13px] leading-[18px] text-t2">{p.description}</span>
        </span>
      </span>
      <span className={`col-thumb ${p.coverage === "full" ? "" : "max-md:hidden"}`}>
        {p.coverage === "full" ? (
          <span title={`${p.step_count} screens captured`} className="num flex aspect-[1280/800] w-[72px] items-center justify-center gap-1 rounded-md border border-line-strong bg-s2 text-[12px] text-t1">{s.signedIn || open ? <Layers className="size-3" /> : <Lock className="size-3" />}{p.step_count}</span>
        ) : (
          <span title="We track this app's public signals. Its screens aren't captured yet." className="flex aspect-[1280/800] w-[72px] items-center justify-center rounded-md border border-dashed border-line-strong text-[10px] text-t3">Signals</span>
        )}
      </span>
      <span className="col-cat"><span className="pill">{CATEGORY_LABEL[p.category]}</span></span>
      <span className="col-rev"><span className="num block text-[13px] font-medium">{formatRevenue(p.revenue_low_usd, p.revenue_high_usd)}</span>{p.revenue_confidence !== null && <span className="flex items-center gap-1.5 text-[11px] text-t3">Range <Confidence level={p.revenue_confidence} /></span>}</span>
      <TrafficCell p={p} />
      <span className="num flex items-center gap-1.5 font-medium"><ChartNoAxesColumnIncreasing className={`hidden size-4 md:block ${p.active_ads ? "text-arc" : "text-t3"}`} />{p.active_ads ?? DASH}<Delta n={p.ads_delta_7d} /></span>
      <span className="col-yt"><span className="num flex items-center gap-1.5 font-medium"><VideoCountIcon className="size-4 text-t2" />{p.sponsors ?? DASH}</span></span>
      <PriceCell p={p} />
      <span className="col-first num whitespace-nowrap text-[13px] text-t2">{ago(p.first_seen)}</span>
      <span className="col-seen num whitespace-nowrap text-[13px] text-t2">{ago(p.last_seen)}</span>
      <ChevronRight className="size-4 text-t2" />
    </button>
  );
}

function SortHead({ id, sort, dir, onSort, className, children }: { id: string; sort: string; dir: "asc" | "desc"; onSort: (id: string) => void; className?: string; children: ReactNode }) {
  const on = sort === id;
  return (
    <span className={className} aria-sort={on ? (dir === "asc" ? "ascending" : "descending") : "none"} role="columnheader">
      <button onClick={() => onSort(id)} className={`flex items-center gap-1 whitespace-nowrap uppercase tracking-[0.05em] hover:text-t1 ${on ? "text-t1" : ""}`}>
        {children}{on && (dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </span>
  );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="flex h-7 items-center gap-1.5 rounded-lg bg-arc-dim pl-2.5 pr-1 text-[12px] text-arc">
      {label}
      <button aria-label={`Remove filter: ${label}`} onClick={onClear} className="flex size-5 items-center justify-center rounded hover:bg-s3"><X className="size-3" /></button>
    </span>
  );
}

function FirstRunSteps({ onFirstApp }: { onFirstApp?: () => void }) {
  const s = useSession();
  const steps = [
    { label: "Open your first app", done: s.history.length > 0, go: onFirstApp },
    { label: "Send a blueprint to your agent", done: !!s.firstRun.blueprint, go: onFirstApp },
    { label: "Connect MCP", done: !!s.firstRun.mcp, go: s.openMcp },
  ];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-medium">Get started</span>
      {steps.map((x) => (
        <button key={x.label} onClick={x.go} disabled={x.done || !x.go} className={`flex items-center gap-1.5 text-[13px] ${x.done ? "text-t3 line-through" : "text-t2 hover:text-t1"}`}>
          {x.done ? <Check className="size-3.5 text-arc" /> : <Circle className="size-3.5" />}{x.label}
        </button>
      ))}
      <button aria-label="Dismiss getting started" onClick={() => s.setFirstRun({ dismissed: true })} className="text-t3 hover:text-t1"><X className="size-3.5" /></button>
    </div>
  );
}

const SCOPE = {
  radar: { title: "Radar", sub: "See what's working in software. Every product's traffic, pricing, stack and distribution, tracked daily.", empty: "No products are published yet. We're reviewing the first batch, and only products with approved evidence appear here." },
  saved: { title: "Saved", sub: "Products you're keeping an eye on.", empty: "Nothing saved yet. Press S on any row, or use the Save button on an app's page." },
  history: { title: "History", sub: "The apps you've opened on this browser, most recent first.", empty: "Nothing here yet. Open an app and it will show up here." },
};

export function Radar({ scope = "radar" }: { scope?: keyof typeof SCOPE }) {
  const s = useSession();
  const nav = useNavigate();
  const openProduct = useOpenProduct();
  const [sp, setSp] = useSearchParams();
  const tableRef = useRef<HTMLDivElement>(null);
  const wide = useMedia("(min-width: 1280px)");
  const cat = sp.get("cat") ?? "";
  const price = sp.get("price") ?? "";
  const signal = sp.get("signal") ?? "";
  const added = sp.get("added") ?? "";
  const coverage = sp.get("coverage") ?? "";
  const q = sp.get("q") ?? "";
  const presetId = scope === "radar" ? sp.get("preset") ?? "" : "";
  const preset = PRESETS.find((x) => x.value === presetId) ?? PRESETS[0];
  const sort = SORT_VALUE[sp.get("sort") ?? ""] ? sp.get("sort")! : preset.sort;
  const dir: "asc" | "desc" = sp.get("dir") === "asc" ? "asc" : "desc";
  const page = Math.max(1, Math.floor(Number(sp.get("page"))) || 1);
  const update = (changes: Record<string, string | null>, keepPage = false) => {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(changes)) {
      if (v) n.set(k, v); else n.delete(k);
    }
    if (!keepPage) n.delete("page");
    setSp(n, { replace: true, preventScrollReset: true });
  };
  const onSort = (id: string) => update(sort !== id ? { sort: id, dir: null } : { sort: id, dir: dir === "desc" ? "asc" : null });

  // Filtering and sorting run on the server. Search waits for a pause in typing.
  const query = useDebounced(q.trim());
  const params = useMemo(() => {
    const firstSeen = Number(added) || preset.firstSeenDays;
    return {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      ...(query && { q: query }),
      ...(cat && { category: cat }),
      ...(price && { price }),
      ...(coverage && { coverage }),
      ...(firstSeen && { firstSeenDays: firstSeen }),
      ...(signal === "ads30" && { minObservedAdDays: 30 }),
      ...(signal === "sponsored" && { sponsored: "true" }),
      ...(signal === "blueprint" && { hasBlueprint: "true" }),
      ...(signal === "changed" && { changedDays: 7 }),
      ...(sort && { sort, dir }),
    };
  }, [query, cat, price, coverage, added, preset, signal, sort, dir, page]);
  const remote = useQuery((abort) => fetchRadar(params, abort), [JSON.stringify(params)], scope === "radar");

  // Saved and history are short lists the session already holds.
  const local = useMemo(() => {
    if (scope === "radar") return [];
    const needle = q.trim().toLowerCase();
    const pool = scope === "saved" ? s.saved : s.history;
    const out = pool.filter((p) =>
      (!cat || p.category === cat) && (price !== "free" || hasFree(p)) && (price !== "paid_only" || paidOnly(p)) && (!coverage || p.coverage === coverage) &&
      (!added || (!!p.first_seen && Date.now() - Date.parse(p.first_seen) <= Number(added) * DAY)) &&
      (signal !== "ads30" || (p.longest_ad_days ?? 0) >= 30) &&
      (signal !== "sponsored" || (p.sponsors ?? 0) > 0) &&
      (signal !== "blueprint" || p.has_blueprint) &&
      (signal !== "changed" || s.changes.some((c) => c.slug === p.slug && Date.now() - Date.parse(c.observed_at) < 7 * DAY)) &&
      (!needle || `${p.name} ${p.description}`.toLowerCase().includes(needle)));
    const value = SORT_VALUE[sort];
    if (!value) return out;
    const sign = dir === "asc" ? 1 : -1;
    return [...out].sort((a, b) => {
      const x = value(a), y = value(b);
      // Unknown values stay at the bottom in both directions.
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sign;
    });
  }, [scope, s.saved, s.history, s.changes, cat, price, signal, added, coverage, q, sort, dir]);

  const total = scope === "radar" ? remote.data?.total ?? 0 : local.length;
  const rows = useMemo(() => (scope === "radar" ? remote.data?.items ?? [] : local.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)), [scope, remote.data, local, page]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstLoad = scope === "radar" ? remote.loading && !remote.data : s.status === "loading";
  const failed = scope === "radar" && !!remote.error;
  const unseenSlugs = useMemo(() => new Set(s.unseen.map((c) => c.slug)), [s.unseen]);
  const open = (p: Product) => {
    sessionStorage.setItem("arcex.radarList", JSON.stringify(rows.map((r) => r.slug)));
    sessionStorage.setItem("arcex.radarScroll", String(wide ? tableRef.current?.scrollTop ?? 0 : window.scrollY));
    openProduct(p.slug);
  };

  // Coming back from an app's page returns you to the same spot, once the rows are back.
  const pendingScroll = useRef(Number(sessionStorage.getItem("arcex.radarScroll")) || 0);
  useLayoutEffect(() => {
    if (!rows.length) return;
    sessionStorage.removeItem("arcex.radarScroll");
    const saved = pendingScroll.current;
    if (!saved) return;
    pendingScroll.current = 0;
    if (wide && tableRef.current) tableRef.current.scrollTop = saved;
    // The shell resets the window's scroll after this runs, so wait for that.
    else window.setTimeout(() => window.scrollTo(0, saved));
  }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, [role=dialog], [role=menu]") || e.metaKey || e.ctrlKey) return;
      const delta = e.key === "j" || e.key === "ArrowDown" ? 1 : e.key === "k" || e.key === "ArrowUp" ? -1 : 0;
      if (delta) {
        e.preventDefault();
        const items = [...document.querySelectorAll<HTMLElement>("[data-radar-row]")];
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[Math.min(items.length - 1, Math.max(0, at + delta))]?.focus();
      } else if (e.key === "s" && s.signedIn) {
        const slug = el.closest<HTMLElement>("[data-radar-row]")?.dataset.slug;
        const product = rows.find((p) => p.slug === slug);
        if (product) s.toggleSave(product);
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  });

  const chips = [
    q && { label: `Search: ${q}`, key: "q" },
    cat && { label: `Category: ${CATEGORY_LABEL[cat as Category] ?? cat}`, key: "cat" },
    price && { label: PRICES.find((x) => x.value === price)?.label ?? price, key: "price" },
    signal && { label: SIGNALS.find((x) => x.value === signal)?.label ?? signal, key: "signal" },
    added && { label: ADDED.find((x) => x.value === added)?.label ?? added, key: "added" },
    coverage && { label: COVERAGE.find((x) => x.value === coverage)?.label ?? coverage, key: "coverage" },
  ].filter(Boolean) as { label: string; key: string }[];
  const clearFilters = () => update(Object.fromEntries(chips.map((c) => [c.key, null])));
  const sampleProduct = rows.find((p) => p.open_sample && p.coverage === "full");
  const firstApp = rows.find((p) => p.coverage === "full") ?? rows[0];
  const onboardingDone = !!s.firstRun.dismissed || (s.history.length > 0 && !!s.firstRun.blueprint && !!s.firstRun.mcp);
  const lockedList = s.status === "out" && scope === "saved";

  return (
    <div className="px-4 py-5 lg:px-6 lg:py-6 xl:h-[calc(100dvh-68px)]">
      <main className="flex h-full min-w-0 flex-col">
        <PageHeading title={SCOPE[scope].title} sub={SCOPE[scope].sub} />
        {scope === "radar" && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
            <div role="group" aria-label="Views" className="flex items-center gap-1">
              {PRESETS.map((x) => (
                <button key={x.value} aria-pressed={x.value === presetId} onClick={() => update({ preset: x.value || null, sort: null, dir: null })} className={`flex h-9 items-center rounded-xl px-3.5 font-medium transition-colors ${x.value === presetId ? "nav-on" : "text-t2 hover:text-t1"}`}>{x.label}</button>
              ))}
            </div>
            {s.status === "out" ? sampleProduct && (
              <button onClick={() => open(sampleProduct)} className="group flex min-w-0 items-center gap-2 text-left">
                <span className="shrink-0 rounded bg-arc-dim px-1.5 text-[12px] font-medium leading-[20px] text-arc">No sign-in</span>
                <span className="text-t2 group-hover:text-t1">See everything about {sampleProduct.name}</span>
                <ArrowRight className="size-3.5 shrink-0 text-t2" />
              </button>
            ) : s.signedIn && !onboardingDone ? (
              <FirstRunSteps onFirstApp={firstApp ? () => open(firstApp) : undefined} />
            ) : s.unseen.length > 0 ? (
              <Link to="/updates" className="group flex min-w-0 items-center gap-2">
                <span className="live-dot shrink-0" />
                <span className="text-t2 group-hover:text-t1"><span className="num text-t1">{s.unseen.length}</span> changes since your last visit</span>
                <ArrowRight className="size-3.5 shrink-0 text-t2" />
              </Link>
            ) : null}
          </div>
        )}
        <div className="no-scrollbar -mx-4 mt-4 flex items-center gap-2 overflow-x-auto px-4 lg:mx-0 lg:px-0">
          <label className="facet-frame flex h-11 min-w-[160px] flex-1 items-center gap-2 px-3">
            <Search className="size-4 shrink-0 text-t2" />
            <input id="radar-search" aria-label="Search products" maxLength={120} value={q} onChange={(e) => update({ q: e.target.value || null })} placeholder="Search products..." className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-t2" />
            <kbd className="hidden min-[1400px]:block">/</kbd>
          </label>
          <FilterMenu label="Category" value={cat} onChange={(v) => update({ cat: v || null })} options={[{ value: "", label: "All Categories" }, ...(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))]} />
          <FilterMenu label="Price" value={price} onChange={(v) => update({ price: v || null })} options={PRICES} />
          <FilterMenu label="Signals" value={signal} onChange={(v) => update({ signal: v || null })} options={SIGNALS} />
          <FilterMenu label="First seen" value={added} onChange={(v) => update({ added: v || null })} options={ADDED} />
          <FilterMenu label="Coverage" value={coverage} onChange={(v) => update({ coverage: v || null })} options={COVERAGE} />
        </div>
        <div className="mt-3 flex min-h-7 flex-wrap items-center gap-2">
          <span className="num mr-1 text-[13px] text-t2" role="status">
            {firstLoad ? "Loading products..." : total ? <>Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()} {total === 1 ? "product" : "products"}</> : "0 products"}
          </span>
          {chips.map((c) => <Chip key={c.key} label={c.label} onClear={() => update({ [c.key]: null })} />)}
          {chips.length > 1 && <button onClick={clearFilters} className="text-[12px] text-t2 underline underline-offset-2 hover:text-t1">Clear all</button>}
          {pages > 1 && (
            <span className="ml-auto flex items-center gap-2">
              <button disabled={page <= 1} onClick={() => { update({ page: String(page - 1) }, true); tableRef.current?.scrollTo(0, 0); }} className="btn btn-ghost !h-7 !px-2 text-[12px] disabled:opacity-40"><ChevronLeft className="size-3.5" />Prev</button>
              <span className="num text-[12px] text-t2">Page {page} of {pages}</span>
              <button disabled={page >= pages} onClick={() => { update({ page: String(page + 1) }, true); tableRef.current?.scrollTo(0, 0); }} className="btn btn-ghost !h-7 !px-2 text-[12px] disabled:opacity-40">Next<ChevronRight className="size-3.5" /></button>
            </span>
          )}
        </div>

        <div ref={tableRef} className="panel arc-edge mt-3 min-h-0 flex-1 overflow-y-auto rounded-2xl p-1.5">
          {lockedList ? (
            <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="text-t2">Sign in to keep your saved products here.</div>
              <button className="btn btn-primary" onClick={s.openSignIn}>Sign in</button>
            </div>
          ) : failed ? (
            <ErrorPanel message={errorMessage(remote.error)} onRetry={remote.reload} />
          ) : firstLoad ? (
            <div aria-hidden className="flex flex-col gap-1.5 p-2">
              {Array.from({ length: 8 }, (_, i) => <div key={i} className="h-[62px] animate-pulse rounded-lg bg-s2" />)}
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="max-w-[460px] text-t2">{chips.length || presetId ? "No products match those filters." : SCOPE[scope].empty}</div>
              {chips.length || presetId ? <button className="btn btn-ghost" onClick={() => nav(scope === "radar" ? "/" : "/" + scope, { replace: true })}>Clear filters</button>
                : scope !== "radar" && <Link to="/" className="btn btn-ghost">Go to Radar</Link>}
            </div>
          ) : (
            <div className={remote.loading ? "opacity-60 transition-opacity" : ""}>
              <div className="radar-grid radar-head eyebrow sticky top-0 z-10 border-b border-line bg-[#0a1120]/90 px-4 pb-3 pt-3 backdrop-blur-md">
                <span>Product</span>
                <span className="col-thumb">Screens</span>
                <span className="col-cat">Category</span>
                <SortHead id="revenue" sort={sort} dir={dir} onSort={onSort} className="col-rev"><span title="A manually entered range from listed sources. Not reported revenue.">Rev. range/mo</span></SortHead>
                <SortHead id="traffic" sort={sort} dir={dir} onSort={onSort}><span title={TRAFFIC_TITLE}>Traffic</span></SortHead>
                <SortHead id="ads" sort={sort} dir={dir} onSort={onSort}><span className="md:hidden">Ads</span><span className="hidden md:inline">Active ads</span></SortHead>
                <SortHead id="sponsors" sort={sort} dir={dir} onSort={onSort} className="col-yt">Sponsors</SortHead>
                <span className="col-mon" title={PRICE_TITLE}>Price</span>
                <SortHead id="first" sort={sort} dir={dir} onSort={onSort} className="col-first">First seen</SortHead>
                <SortHead id="seen" sort={sort} dir={dir} onSort={onSort} className="col-seen">Last seen</SortHead>
                <span />
              </div>
              <div className="flex flex-col gap-0.5">
                {rows.map((p) => <Row key={p.slug} p={p} fresh={unseenSlugs.has(p.slug)} onOpen={() => open(p)} />)}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
