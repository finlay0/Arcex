import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowDown, ArrowRight, ArrowUp, ChartNoAxesColumnIncreasing, Check, ChevronLeft, ChevronRight, Circle, Lock, Search, X } from "lucide-react";
import { bySlug, CATEGORY_LABEL, CHANGES, formatRevenue, hasBlueprint, MODEL_LABEL, postLoginCount, products, SAMPLE_SLUG, verdict, type Category, type Model, type Product } from "./data";
import { ScaledScreen } from "./screens";
import { useOpenProduct, useSession } from "./shell";
import { Confidence, FilterMenu, PageHeading, ProductIcon, Sparkline, useMedia, VideoCountIcon } from "./ui";

const PAGE_SIZE = 50;
const SIGNALS = [
  { value: "", label: "All Signals" },
  { value: "ads30", label: "30d+ Active Ads" },
  { value: "sponsored", label: "YT Sponsored" },
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
const PRESETS = [
  { value: "", label: "All", sort: "growth", test: () => true },
  { value: "trending", label: "Trending", sort: "growth", test: (p: Product) => p.growth >= 25 },
  { value: "rising", label: "Rising", sort: "growth", test: (p: Product) => p.firstSeen <= 120 && p.growth > 0 },
  { value: "new", label: "New", sort: "first", test: (p: Product) => p.firstSeen <= 30 },
];
const SORT: Record<string, { value: (p: Product) => number; asc?: boolean }> = {
  revenue: { value: (p) => p.revenue[1] },
  growth: { value: (p) => p.growth },
  ads: { value: (p) => p.activeAds },
  sponsors: { value: (p) => p.creators },
  first: { value: (p) => p.firstSeen, asc: true },
  seen: { value: (p) => p.lastSeen, asc: true },
};

export const ago = (days: number) => (days < 30 ? `${days}d ago` : days < 365 ? `${Math.round(days / 30)}mo ago` : `${(days / 365).toFixed(1)}y ago`);
const seenAgo = (minutes: number) => (minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`);

function Delta({ n }: { n: number }) {
  if (!n) return null;
  return <span title="Change in the last 7 days" className={`hidden text-[12px] font-normal md:inline ${n > 0 ? "text-teal" : "text-t3"}`}>{n > 0 ? `+${n}` : n}</span>;
}

export function GrowthValue({ value }: { value: number }) {
  return <span className={`num text-[13px] font-medium ${value > 0 ? "text-teal" : value < 0 ? "text-t3" : "text-t2"}`}>{value > 0 ? "+" : ""}{value}%</span>;
}

function Row({ p, fresh, onOpen }: { p: Product; fresh: boolean; onOpen: () => void }) {
  const s = useSession();
  const paywall = p.steps.find((x) => x.stage === "paywall");
  const open = !s.signedIn && p.slug === SAMPLE_SLUG;
  return (
    <button data-radar-row data-slug={p.slug} onClick={onOpen} className="radar-grid w-full rounded-lg px-4 py-[13px] text-left transition-colors hover:bg-s2 focus-visible:bg-s2">
      <span className="flex min-w-0 items-center gap-3">
        <ProductIcon p={p} />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-[15px] font-medium leading-[20px]">
            <span className="truncate">{p.name}</span>
            {fresh && <span title="Changed since your last visit" className="size-1.5 shrink-0 rounded-full bg-teal" />}
            {open && <span className="shrink-0 rounded bg-teal-dim px-1.5 text-[11px] font-medium leading-[18px] text-teal">No sign-in</span>}
          </span>
          <span className="line-clamp-2 text-[13px] leading-[18px] text-t2">{p.what} <span className="text-t1">{verdict(p)}</span></span>
        </span>
      </span>
      <span className="col-thumb">
        {paywall ? (
          <span className="relative block w-[72px] overflow-hidden rounded-md border border-line-strong">
            <ScaledScreen product={p} step={paywall} />
            <span title={`${postLoginCount(p)} screens inside`} className="num absolute bottom-0.5 right-0.5 flex items-center gap-0.5 rounded bg-black/80 px-1 text-[10px] leading-[14px] text-t1">{!open && !s.signedIn && <Lock className="size-2.5" />}{p.steps.length}</span>
          </span>
        ) : (
          <span title="We track this app's public signals. Its screens aren't captured yet." className="flex aspect-[1280/800] w-[72px] items-center justify-center rounded-md border border-dashed border-line-strong text-[10px] text-t3">Signals</span>
        )}
      </span>
      <span className="col-cat"><span className="pill">{CATEGORY_LABEL[p.category]}</span></span>
      <span className="col-rev"><span className="num block text-[13px] font-medium">{formatRevenue(p.revenue)}</span><span className="flex items-center gap-1.5 text-[11px] text-t3">Est. <Confidence level={p.confidence} /></span></span>
      <span className="flex items-center gap-2"><GrowthValue value={p.growth} /><span className="hidden md:block"><Sparkline data={p.spark} /></span></span>
      <span className="num flex items-center gap-1.5 font-medium"><ChartNoAxesColumnIncreasing className={`hidden size-4 md:block ${p.activeAds ? "text-teal" : "text-t3"}`} />{p.activeAds}<Delta n={p.adsDelta} /></span>
      <span className="col-yt num flex items-center gap-1.5 font-medium"><VideoCountIcon className="size-4 text-t2" />{p.creators}<Delta n={p.creatorsDelta} /></span>
      <span className="col-mon min-w-0"><span className="pill"><span className="truncate">{p.mechanic}</span></span></span>
      <span className="col-first num whitespace-nowrap text-[13px] text-t2">{ago(p.firstSeen)}</span>
      <span className="col-seen num whitespace-nowrap text-[13px] text-t2">{seenAgo(p.lastSeen)}</span>
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
    <span className="flex h-7 items-center gap-1.5 rounded-lg bg-teal-dim pl-2.5 pr-1 text-[12px] text-teal">
      {label}
      <button aria-label={`Remove filter: ${label}`} onClick={onClear} className="flex size-5 items-center justify-center rounded hover:bg-s3"><X className="size-3" /></button>
    </span>
  );
}

function FirstRunSteps({ onFirstApp }: { onFirstApp: () => void }) {
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
        <button key={x.label} onClick={x.go} disabled={x.done} className={`flex items-center gap-1.5 text-[13px] ${x.done ? "text-t3 line-through" : "text-t2 hover:text-t1"}`}>
          {x.done ? <Check className="size-3.5 text-teal" /> : <Circle className="size-3.5" />}{x.label}
        </button>
      ))}
      <button aria-label="Dismiss getting started" onClick={() => s.setFirstRun({ dismissed: true })} className="text-t3 hover:text-t1"><X className="size-3.5" /></button>
    </div>
  );
}

const SCOPE = {
  radar: { title: "AI Product Radar", sub: "Discover emerging AI products, track their distribution, and reverse-engineer what's working.", empty: "No products match those filters." },
  saved: { title: "Saved", sub: "Products you're keeping an eye on.", empty: "Nothing saved yet. Press S on any row, or use the Save button on an app's page." },
  history: { title: "History", sub: "The apps you've opened, most recent first.", empty: "Nothing here yet. Open an app and it will show up here." },
};

export function Radar({ scope = "radar" }: { scope?: keyof typeof SCOPE }) {
  const s = useSession();
  const nav = useNavigate();
  const openProduct = useOpenProduct();
  const [sp, setSp] = useSearchParams();
  const tableRef = useRef<HTMLDivElement>(null);
  const wide = useMedia("(min-width: 1280px)");
  const cat = sp.get("cat") ?? "";
  const model = sp.get("model") ?? "";
  const signal = sp.get("signal") ?? "";
  const added = sp.get("added") ?? "";
  const coverage = sp.get("coverage") ?? "";
  const q = sp.get("q") ?? "";
  const presetId = scope === "radar" ? sp.get("preset") ?? "" : "";
  const preset = PRESETS.find((x) => x.value === presetId) ?? PRESETS[0];
  const sort = SORT[sp.get("sort") ?? ""] ? sp.get("sort")! : preset.sort;
  const dir: "asc" | "desc" = (sp.get("dir") as "asc" | "desc") || (SORT[sort].asc ? "asc" : "desc");
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const update = (changes: Record<string, string | null>, keepPage = false) => {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(changes)) {
      if (v) n.set(k, v); else n.delete(k);
    }
    if (!keepPage) n.delete("page");
    setSp(n, { replace: true, preventScrollReset: true });
  };
  const onSort = (id: string) => {
    const natural = SORT[id].asc ? "asc" : "desc";
    if (sort !== id) update({ sort: id, dir: null });
    else update({ sort: id, dir: dir === natural ? (natural === "asc" ? "desc" : "asc") : null });
  };

  const rows = useMemo(() => {
    const pool = scope === "saved" ? s.saved.flatMap((x) => bySlug(x) ?? [])
      : scope === "history" ? s.history.flatMap((x) => bySlug(x) ?? []) : products;
    const needle = q.trim().toLowerCase();
    const out = pool.filter((p) =>
      preset.test(p) && (!cat || p.category === cat) && (!model || p.model === model) && (!coverage || p.coverage === coverage) &&
      (!added || p.firstSeen <= Number(added)) &&
      (signal !== "ads30" || (p.activeAds > 0 && p.longestAd >= 30)) &&
      (signal !== "sponsored" || p.creatorItems.some((c) => c.kind === "Sponsored")) &&
      (signal !== "blueprint" || hasBlueprint(p)) &&
      (signal !== "changed" || CHANGES.some((c) => c.slug === p.slug && c.daysAgo < 7)) &&
      (!needle || `${p.name} ${p.what} ${p.tagline} ${p.mechanic} ${p.stack.join(" ")}`.toLowerCase().includes(needle)));
    if (scope === "history" && !sp.get("sort")) return out;
    const value = SORT[sort].value;
    const sign = dir === "asc" ? 1 : -1;
    return [...out].sort((a, b) => (value(a) - value(b)) * sign);
  }, [scope, s.saved, s.history, cat, model, signal, added, coverage, q, preset, sort, dir, sp]);

  const fullCount = rows.filter((p) => p.coverage === "full").length;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const unseenSlugs = useMemo(() => new Set(s.unseen.map((c) => c.slug)), [s.unseen]);
  const open = (p: Product) => {
    sessionStorage.setItem("arcex.radarList", JSON.stringify(rows.map((r) => r.slug)));
    sessionStorage.setItem("arcex.radarScroll", String(wide ? tableRef.current?.scrollTop ?? 0 : window.scrollY));
    openProduct(p);
  };

  // Coming back from an app's page returns you to the same spot in the table.
  useLayoutEffect(() => {
    const saved = Number(sessionStorage.getItem("arcex.radarScroll"));
    if (!saved) return;
    sessionStorage.removeItem("arcex.radarScroll");
    if (wide && tableRef.current) tableRef.current.scrollTop = saved;
    // The shell resets the window's scroll after this runs, so wait for that.
    else window.setTimeout(() => window.scrollTo(0, saved));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        if (slug) s.toggleSave(slug);
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  });

  const chips = [
    q && { label: `Search: ${q}`, key: "q" },
    cat && { label: `Category: ${CATEGORY_LABEL[cat as Category]}`, key: "cat" },
    model && { label: `Monetization: ${MODEL_LABEL[model as Model]}`, key: "model" },
    signal && { label: SIGNALS.find((x) => x.value === signal)?.label ?? signal, key: "signal" },
    added && { label: ADDED.find((x) => x.value === added)?.label ?? added, key: "added" },
    coverage && { label: COVERAGE.find((x) => x.value === coverage)?.label ?? coverage, key: "coverage" },
  ].filter(Boolean) as { label: string; key: string }[];
  const clearFilters = () => update(Object.fromEntries(chips.map((c) => [c.key, null])));
  const sampleProduct = bySlug(SAMPLE_SLUG)!;
  const onboardingDone = !!s.firstRun.dismissed || (s.history.length > 0 && !!s.firstRun.blueprint && !!s.firstRun.mcp);
  const lockedList = !s.signedIn && scope !== "radar";

  return (
    <div className="px-4 py-5 lg:px-6 lg:py-6 xl:h-[calc(100dvh-68px)]">
      <main className="flex h-full min-w-0 flex-col">
        <PageHeading title={SCOPE[scope].title} sub={SCOPE[scope].sub} />
        {scope === "radar" && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
            <div role="group" aria-label="Views" className="flex items-center gap-1">
              {PRESETS.map((x) => (
                <button key={x.value} aria-pressed={x.value === presetId} onClick={() => update({ preset: x.value || null, sort: null, dir: null })} className={`flex h-9 items-center rounded-xl px-3.5 font-medium transition-colors ${x.value === presetId ? "bg-s3 text-t1" : "text-t2 hover:text-t1"}`}>{x.label}</button>
              ))}
            </div>
            {!s.signedIn ? (
              <button onClick={() => open(sampleProduct)} className="group flex min-w-0 items-center gap-2 text-left">
                <span className="shrink-0 rounded bg-teal-dim px-1.5 text-[12px] font-medium leading-[20px] text-teal">No sign-in</span>
                <span className="text-t2 group-hover:text-t1">See everything about {sampleProduct.name}</span>
                <ArrowRight className="size-3.5 shrink-0 text-t2" />
              </button>
            ) : !onboardingDone ? (
              <FirstRunSteps onFirstApp={() => open(rows.find((p) => p.coverage === "full") ?? sampleProduct)} />
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
          <label className="flex h-11 min-w-[160px] flex-1 items-center gap-2 rounded-xl border border-line-strong px-3 transition-colors focus-within:border-teal">
            <Search className="size-4 shrink-0 text-t2" />
            <input id="radar-search" aria-label="Search products" value={q} onChange={(e) => update({ q: e.target.value || null })} placeholder="Search products..." className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-t2" />
            <kbd className="hidden min-[1400px]:block">/</kbd>
          </label>
          <FilterMenu label="Category" value={cat} onChange={(v) => update({ cat: v || null })} options={[{ value: "", label: "All Categories" }, ...(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))]} />
          <FilterMenu label="Monetization" value={model} onChange={(v) => update({ model: v || null })} options={[{ value: "", label: "All Monetization" }, ...(Object.keys(MODEL_LABEL) as Model[]).map((m) => ({ value: m, label: MODEL_LABEL[m] }))]} />
          <FilterMenu label="Signals" value={signal} onChange={(v) => update({ signal: v || null })} options={SIGNALS} />
          <FilterMenu label="First seen" value={added} onChange={(v) => update({ added: v || null })} options={ADDED} />
          <FilterMenu label="Coverage" value={coverage} onChange={(v) => update({ coverage: v || null })} options={COVERAGE} />
        </div>
        <div className="mt-3 flex min-h-7 flex-wrap items-center gap-2">
          <span className="num mr-1 text-[13px] text-t2" role="status">
            {rows.length ? <>Showing {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, rows.length)} of {rows.length} products · {fullCount} with full screens</> : "0 products"}
          </span>
          {chips.map((c) => <Chip key={c.key} label={c.label} onClear={() => update({ [c.key]: null })} />)}
          {chips.length > 1 && <button onClick={clearFilters} className="text-[12px] text-t2 underline underline-offset-2 hover:text-t1">Clear all</button>}
          {pages > 1 && (
            <span className="ml-auto flex items-center gap-2">
              <button disabled={current <= 1} onClick={() => { update({ page: String(current - 1) }, true); tableRef.current?.scrollTo(0, 0); }} className="btn btn-ghost !h-7 !px-2 text-[12px] disabled:opacity-40"><ChevronLeft className="size-3.5" />Prev</button>
              <span className="num text-[12px] text-t2">Page {current} of {pages}</span>
              <button disabled={current >= pages} onClick={() => { update({ page: String(current + 1) }, true); tableRef.current?.scrollTo(0, 0); }} className="btn btn-ghost !h-7 !px-2 text-[12px] disabled:opacity-40">Next<ChevronRight className="size-3.5" /></button>
            </span>
          )}
        </div>

        <div ref={tableRef} className="panel mt-3 min-h-0 flex-1 overflow-y-auto rounded-2xl p-1.5">
          {lockedList ? (
            <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="text-t2">Sign in to keep your {scope === "saved" ? "saved products" : "history"} here.</div>
              <button className="btn btn-primary" onClick={s.openSignIn}>Sign in</button>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="text-t2">{chips.length || presetId ? SCOPE.radar.empty : SCOPE[scope].empty}</div>
              {chips.length || presetId ? <button className="btn btn-ghost" onClick={() => nav(scope === "radar" ? "/" : "/" + scope, { replace: true })}>Clear filters</button>
                : scope !== "radar" && <Link to="/" className="btn btn-ghost">Go to Radar</Link>}
            </div>
          ) : (
            <>
              <div className="radar-grid radar-head eyebrow sticky top-0 z-10 bg-s1 px-4 pb-3 pt-3">
                <span>Product</span>
                <span className="col-thumb">Screens</span>
                <span className="col-cat">Category</span>
                <SortHead id="revenue" sort={sort} dir={dir} onSort={onSort} className="col-rev">Est. rev/mo</SortHead>
                <SortHead id="growth" sort={sort} dir={dir} onSort={onSort}><span className="md:hidden">4w</span><span className="hidden md:inline" title="Change in ads and creators we observed. Not product or business growth.">Activity 4w</span></SortHead>
                <SortHead id="ads" sort={sort} dir={dir} onSort={onSort}><span className="md:hidden">Ads</span><span className="hidden md:inline">Active ads</span></SortHead>
                <SortHead id="sponsors" sort={sort} dir={dir} onSort={onSort} className="col-yt">YT sponsors</SortHead>
                <span className="col-mon">Monetization</span>
                <SortHead id="first" sort={sort} dir={dir} onSort={onSort} className="col-first">First seen</SortHead>
                <SortHead id="seen" sort={sort} dir={dir} onSort={onSort} className="col-seen">Last seen</SortHead>
                <span />
              </div>
              <div className="flex flex-col gap-0.5">
                {visible.map((p) => <Row key={p.slug} p={p} fresh={unseenSlugs.has(p.slug)} onOpen={() => open(p)} />)}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
