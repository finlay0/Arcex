import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, ArrowUpRight, Bookmark, Check, ChevronLeft, ChevronRight, Crosshair, Eye, ImageOff, Layers, Lock, Mail, Share2, Sparkles, Zap } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError, apiUrl, errorMessage, fetchRadar, useQuery, vaultProduct, type BlueprintExport, type Evidence, type Product, type RevenueRange, type Signal, type StackItem, type Step, type Traffic, type Usage, type Vault } from "./api";
import { ago, CATEGORY_LABEL, compactRank, DASH, formatRevenue, MODEL_LABEL, priceLabel, shortDate, STAGES, STAGE_LABEL, TIER_LABEL, TRAFFIC_TITLE } from "./data";
import { useSession } from "./shell";
import { CodeLine, Confidence, ErrorPanel, GateModal, LimitModal, mcpPrompt, ProductIcon, useCopy } from "./ui";

const SECTIONS = [["overview", "Overview"], ["traffic", "Traffic"], ["stack", "Stack"], ["screens", "Screens"], ["ads", "Ads"], ["creators", "Creators"], ["model", "Pricing"], ["blueprint", "Blueprint"]];
const SECTION_TITLE = "font-display text-[22px] font-semibold leading-[28px] tracking-[-0.015em]";

/** Facts we captured. Visually distinct from our interpretation, which sits in Analysis. */
function Observed({ onReceipt, children }: { onReceipt?: () => void; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line-strong bg-canvas p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-arc"><Eye className="size-3.5" />Observed</h4>
        {onReceipt && <button onClick={onReceipt} className="text-[12px] text-t2 underline underline-offset-2 hover:text-t1">View receipt</button>}
      </div>
      {children}
    </section>
  );
}

function Analysis({ label = "Arcex analysis", note = "Our interpretation. Not confirmed by the company.", children }: { label?: string; note?: string; children: ReactNode }) {
  return (
    <section className="border-l-2 border-dashed border-line-strong pl-3">
      <h4 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-t2"><Sparkles className="size-3.5" />{label}</h4>
      <p className="mt-1 text-[12px] leading-[17px] text-t3">{note}</p>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function SourceLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-t2 underline underline-offset-2 hover:text-t1">{children}<ArrowUpRight className="size-3" /></a>;
}

function Metric({ label, tag, children }: { label: string; tag?: string; children: ReactNode }) {
  return (
    <div className="panel rounded-xl p-3.5">
      <div className="flex items-center justify-between gap-2 text-[12px] text-t2">{label}{tag && <span className="text-[11px] text-t3">{tag}</span>}</div>
      <div className="num mt-1.5 flex min-h-[28px] items-center gap-2 text-[20px] font-semibold leading-[28px] tracking-[-0.01em]">{children}</div>
    </div>
  );
}

function ThisWeek({ n }: { n: number | null }) {
  if (!n) return null;
  return <span className={`text-[13px] font-normal ${n > 0 ? "text-arc" : "text-t3"}`}>{n > 0 ? "+" : ""}{n} this week</span>;
}

function Overview({ p, adsSeen }: { p: Product; adsSeen: number }) {
  const longest = p.longest_ad_days;
  // Longest ad counts days an ad was seen active, so inactive sightings read as "none active".
  const longestLabel = longest === null ? DASH : longest ? `${longest} days seen` : adsSeen ? "None active" : "None seen";
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Metric label="Revenue range/mo" tag="Manual"><span>{formatRevenue(p.revenue_low_usd, p.revenue_high_usd)}</span>{p.revenue_confidence !== null && <Confidence level={p.revenue_confidence} />}</Metric>
        <Metric label="Traffic rank" tag="Daily">{p.traffic_tier ? <span title={TRAFFIC_TITLE}>{p.traffic_rank === null ? "1M+" : p.traffic_rank.toLocaleString()}<span className="ml-2 text-[13px] font-normal text-t3">{TIER_LABEL[p.traffic_tier] ?? p.traffic_tier}</span></span> : DASH}</Metric>
        <Metric label="Active ads" tag="Observed">{p.active_ads ?? DASH}{adsSeen > 0 && <span className="text-[13px] font-normal text-t3">of {adsSeen} seen</span>}<ThisWeek n={p.ads_delta_7d} /></Metric>
        <Metric label="Longest ad" tag="Observed">{longestLabel}</Metric>
        <Metric label="Creator sponsors" tag="Observed">{p.sponsors ?? DASH}{p.creators !== null && <span className="text-[13px] font-normal text-t3">of {p.creators} {p.creators === 1 ? "creator" : "creators"}</span>}</Metric>
        <Metric label="First seen" tag="Observed">{ago(p.first_seen)}</Metric>
      </div>
      <p className="mt-2 text-[12px] leading-[17px] text-t3">Observed public signals, not product or business growth. A dash means not collected yet.</p>
    </>
  );
}

/** Rank history on a log scale, so a climb from #90K to #9K reads as far as #9K to #900. */
function TrafficSection({ traffic }: { traffic?: Traffic }) {
  const history = traffic?.history ?? [];
  if (!traffic?.latest) return <div className="panel rounded-xl p-6 text-t2">This site isn't ranked yet. Products on shared hosting or app stores have no site of their own to rank.</div>;
  const ranked = history.filter((h): h is { observed_on: string; rank: number } => h.rank !== null);
  const first = ranked[0], last = ranked[ranked.length - 1];
  const W = 640, H = 120, PAD = 6;
  const logs = ranked.map((h) => Math.log10(h.rank));
  // At least a 2x rank range on the axis, so day-to-day noise stays flat instead of looking like a surge.
  const span = Math.max(Math.max(...logs) - Math.min(...logs), 0.3), lo = (Math.max(...logs) + Math.min(...logs)) / 2 - span / 2;
  const t0 = Date.parse(history[0].observed_on), t1 = Date.parse(history[history.length - 1].observed_on), tSpan = t1 - t0 || 1;
  const points = ranked.map((h) => [PAD + ((Date.parse(h.observed_on) - t0) / tSpan) * (W - 2 * PAD), PAD + ((Math.log10(h.rank) - lo) / span) * (H - 2 * PAD)]);
  const moved = first && last && first !== last ? Math.log10(first.rank / last.rank) : 0;
  // Ranks are dated by UTC day; noon keeps the label on the same day in every time zone.
  const day = (d: string) => shortDate(d + "T12:00:00Z");
  return (
    <div className="panel rounded-xl p-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="num text-[28px] font-semibold leading-[34px] tracking-[-0.02em]">{traffic.latest.rank === null ? "Outside top 1M" : `#${traffic.latest.rank.toLocaleString()}`}</span>
        <span className="pill">{TIER_LABEL[traffic.latest.tier] ?? traffic.latest.tier}</span>
        {Math.abs(moved) >= 0.04 && <span className={`num text-[13px] font-medium ${moved > 0 ? "text-arc" : "text-t3"}`}>{moved > 0 ? "Up" : "Down"} from {compactRank(first.rank)} on {day(first.observed_on)}</span>}
        <span className="ml-auto text-[12px] text-t3">Tracked daily since {day(history[0].observed_on)}</span>
      </div>
      {points.length > 1 ? (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-4 h-[120px] w-full" role="img" aria-label="Traffic rank over time">
          <polyline points={points.map((x) => x.join(",")).join(" ")} fill="none" stroke="var(--color-arc)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
      ) : (
        <p className="mt-3 text-[13px] text-t2">The chart fills in as daily ranks come in.</p>
      )}
      <p className="mt-3 text-[12px] leading-[17px] text-t3">{traffic.meaning}</p>
    </div>
  );
}

const STACK_LABEL: Record<string, string> = { framework: "Framework", site_builder: "Site builder", payments: "Payments", analytics: "Analytics", ad_pixel: "Ad pixels", support: "Support", auth: "Auth", backend: "Backend", marketing: "Marketing" };

function StackSection({ stack }: { stack?: { meaning: string; items: StackItem[] } }) {
  const items = stack?.items ?? [];
  if (!items.length) return <div className="panel rounded-xl p-6 text-t2">No known technologies detected in this site's public homepage code yet.</div>;
  const groups = Object.entries(items.reduce<Record<string, StackItem[]>>((acc, x) => ((acc[x.category] ??= []).push(x), acc), {}));
  return (
    <>
      <div className="panel grid gap-px overflow-hidden rounded-xl sm:grid-cols-2 lg:grid-cols-3">
        {groups.map(([category, list]) => (
          <div key={category} className="p-3.5">
            <div className="eyebrow mb-2">{STACK_LABEL[category] ?? category}</div>
            <div className="flex flex-wrap gap-1.5">
              {list.map((x) => (
                <span key={x.technology} title={x.removed_at ? `Seen from ${shortDate(x.first_seen)}, gone since ${shortDate(x.removed_at)}` : `Seen since ${shortDate(x.first_seen)}`} className={`rounded-md border px-2 py-0.5 text-[13px] ${x.removed_at ? "border-dashed border-line text-t3 line-through" : "border-line-strong"}`}>{x.technology}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[12px] leading-[17px] text-t3">{stack!.meaning}</p>
    </>
  );
}

function StageRail({ steps, index, go }: { steps: Step[]; index: number; go: (i: number) => void }) {
  const current = steps[index]?.stage;
  return (
    <div className="no-scrollbar flex items-stretch overflow-x-auto">
      {STAGES.map((stage, si) => {
        const idxs = steps.flatMap((s, i) => (s.stage === stage ? [i] : []));
        const on = stage === current;
        return (
          <div key={stage} className="flex min-w-fit flex-1 items-center">
            {si > 0 && <span className="h-px w-3 shrink-0 bg-line-strong md:flex-1" />}
            <button disabled={!idxs.length} onClick={() => go(on ? index : idxs[0])} aria-current={on ? "step" : undefined} className={`flex flex-col items-start gap-1 rounded-lg px-2.5 py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${on ? "bg-s2" : "hover:bg-s1"}`}>
              <span className={`eyebrow flex items-center gap-1.5 whitespace-nowrap ${on ? "!text-t1" : ""} ${stage === "paywall" ? "!text-arc" : ""}`}><span className="num">{si + 1}</span>{STAGE_LABEL[stage]}</span>
              <span className="flex h-2 items-center gap-1">{idxs.map((i) => <span key={i} className={`size-1.5 rounded-full ${i === index ? (stage === "paywall" ? "bg-arc" : "bg-t1") : "bg-t3/50"}`} />)}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Image links last 15 minutes, so an old tab can reload for fresh ones. */
function ScreenImage({ step, className, onExpired }: { step: Step; className?: string; onExpired: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [step.image_url]);
  if (!step.image_url || failed) {
    return (
      <div className="flex aspect-[1280/800] w-full flex-col items-center justify-center gap-2 bg-s2 text-t2">
        <ImageOff className="size-5" />
        {step.image_url ? <button className="btn btn-ghost" onClick={onExpired}>Reload this screen</button> : "No approved image for this screen"}
      </div>
    );
  }
  return <img src={apiUrl(step.image_url)} alt={step.title} loading="lazy" onError={() => setFailed(true)} className={`block w-full ${className ?? ""}`} />;
}

function Viewer({ step, dir, onExpired }: { step: Step; dir: number; onExpired: () => void }) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <div key={step.id} className={dir >= 0 ? "step-next" : "step-prev"}>
        <div className="relative overflow-hidden rounded-xl border border-line-strong">
          {step.image_url
            ? <button aria-label="Zoom screenshot" onClick={() => setZoom(true)} className="block w-full cursor-zoom-in"><ScreenImage step={step} onExpired={onExpired} /></button>
            : <ScreenImage step={step} onExpired={onExpired} />}
        </div>
      </div>
      <Dialog open={zoom} onOpenChange={setZoom}>
        <DialogContent className="max-w-[92vw] border-line-strong bg-s1 p-2 sm:max-w-[92vw]">
          <DialogTitle className="sr-only">{step.title}</DialogTitle>
          <DialogDescription className="sr-only">Enlarged screenshot</DialogDescription>
          <ScreenImage step={step} className="rounded" onExpired={onExpired} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReceiptDialog({ evidence, step, onClose }: { evidence?: Evidence; step: Step; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-2xl border-line-strong bg-s1 sm:max-w-[420px]">
        <DialogTitle className="font-display text-[22px] font-semibold tracking-[-0.015em]">Receipt</DialogTitle>
        <DialogDescription className="text-t2">Where this screen came from.</DialogDescription>
        <dl className="divide-y divide-line rounded-xl border border-line text-[13px]">
          <div className="flex justify-between gap-4 px-3 py-2"><dt className="text-t2">Screen</dt><dd className="text-right">{step.title}</dd></div>
          <div className="flex justify-between gap-4 px-3 py-2"><dt className="text-t2">Captured</dt><dd className="text-right">{shortDate(evidence?.observed_at)}</dd></div>
          <div className="flex justify-between gap-4 px-3 py-2"><dt className="text-t2">Source</dt><dd className="min-w-0 truncate text-right">{evidence ? <SourceLink href={evidence.source_url}>{new URL(evidence.source_url).hostname}</SourceLink> : DASH}</dd></div>
        </dl>
        {evidence && <p className="text-[13px] leading-[19px] text-t2">{evidence.summary}</p>}
      </DialogContent>
    </Dialog>
  );
}

function StepNotes({ slug, step, index, count, evidence, canShare }: { slug: string; step: Step; index: number; count: number; evidence?: Evidence; canShare: boolean }) {
  const s = useSession();
  const [receipt, setReceipt] = useState(false);
  const { copied, copy } = useCopy();
  const share = async () => {
    try {
      const { url } = await api<{ url: string }>(`/api/v1/vault/${encodeURIComponent(slug)}/share`, { method: "POST", body: { position: step.position } });
      const signed = new URLSearchParams(url.split("?")[1]);
      copy(`${location.origin}/app/${slug}/${index + 1}?share=${step.position}&expires=${signed.get("expires")}&signature=${signed.get("signature")}`, "share");
    } catch (error) {
      s.notify(errorMessage(error));
    }
  };
  return (
    <aside className="flex flex-col gap-4">
      <div>
        <div className="eyebrow">Screen {index + 1} of {count} · {STAGE_LABEL[step.stage] ?? step.stage}</div>
        <h3 className="mt-1 font-display text-[20px] font-semibold leading-[26px] tracking-[-0.015em]">{step.title}</h3>
      </div>
      <Observed onReceipt={() => setReceipt(true)}>
        <p className="whitespace-pre-line text-[13px] leading-[19px] text-t2">{step.annotation || "No notes on this screen."}</p>
        <div className="mt-2 text-[12px] text-t3">Captured {shortDate(evidence?.observed_at)}</div>
      </Observed>
      {canShare && <button onClick={() => void share()} className="btn btn-ghost"><Share2 className="size-4" />{copied === "share" ? "Link copied" : "Share this screen"}</button>}
      {receipt && <ReceiptDialog evidence={evidence} step={step} onClose={() => setReceipt(false)} />}
    </aside>
  );
}

const text = (v: unknown) => (typeof v === "string" ? v : undefined);

/** One row per distinct item, from its repeated sightings. */
function latestByExternalId(signals: Signal[], kind: string) {
  const groups = new Map<string, Signal[]>();
  for (const signal of signals) {
    if (signal.kind !== kind) continue;
    groups.set(signal.external_id, [...(groups.get(signal.external_id) ?? []), signal]);
  }
  return [...groups.values()].map((sightings) => {
    const sorted = [...sightings].sort((a, b) => b.observed_at.localeCompare(a.observed_at));
    return { latest: sorted[0], first: sorted[sorted.length - 1], days: new Set(sorted.map((x) => x.observed_at.slice(0, 10))).size };
  });
}

// Research notes sometimes land where ad copy belongs when a Transparency page hides the text.
const AD_NOTE = /simgad|googlesyndication|static html|creative page|not (?:present|extracted|exported)|playwright|grid item|transparency listing|archive image/i;
const dayDate = (day?: string) => (day ? shortDate(`${day}T12:00:00Z`) : undefined);

type AdGroup = {
  key: string; platform: "google" | "meta"; copy: string | null; format?: string; versions: number;
  active: boolean | null; started?: string; lastShown?: string; lastSeen: string; days: number; source: string;
};

/** One row per distinct ad, with identical copy across library IDs folded into versions. */
function adGroups(signals: Signal[]) {
  const groups = new Map<string, AdGroup>();
  for (const { latest, days } of latestByExternalId(signals, "ad_observed")) {
    const d = latest.detail;
    const platform = text(d.platform) === "google" ? "google" : "meta";
    const raw = text(d.creativeText)?.trim() || null;
    const copy = raw && !AD_NOTE.test(raw) ? raw : null;
    const activity = text(d.activity);
    const active = activity === "active" ? true : activity === "inactive" ? false : null;
    const started = text(d.reportedStartDate), lastShown = text(d.reportedLastShownDate);
    // Same copy folds into versions; ads whose text we couldn't read fold together per platform.
    const key = copy ? `${platform}:${copy.replace(/\s+/g, " ").toLowerCase()}` : `${platform}:${text(d.format) ?? ""}:unreadable`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { key, platform, copy, format: text(d.format), versions: 1, active, started, lastShown, lastSeen: latest.observed_at, days, source: latest.source_url });
      continue;
    }
    g.versions++;
    g.active = g.active || active ? true : g.active === false || active === false ? false : null;
    if (started && (!g.started || started < g.started)) g.started = started;
    if (lastShown && (!g.lastShown || lastShown > g.lastShown)) g.lastShown = lastShown;
    if (latest.observed_at > g.lastSeen) g.lastSeen = latest.observed_at;
    g.days = Math.max(g.days, days);
  }
  const rank = (g: AdGroup) => (g.active ? 0 : g.copy ? 1 : 2);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || (a.started ?? "9").localeCompare(b.started ?? "9") || b.days - a.days);
}

function Ads({ v, p }: { v: Vault; p: Product }) {
  const groups = useMemo(() => adGroups(v.signals), [v.signals]);
  const total = groups.reduce((n, g) => n + g.versions, 0);
  if (!groups.length) return <div className="panel rounded-xl p-6 text-t2">{p.active_ads === null ? "We haven't collected ad data for this product yet." : "No ads seen in our scans. That doesn't prove it isn't advertising."}</div>;
  const active = groups.filter((g) => g.active).reduce((n, g) => n + g.versions, 0);
  const earliest = groups.map((g) => g.started).filter(Boolean).sort()[0];
  return (
    <>
      <p className="mb-2 text-[13px] text-t2">
        <span className="num text-t1">{total}</span> {total === 1 ? "ad" : "ads"} seen · <span className="num text-t1">{active}</span> active when last checked{earliest && <> · earliest started {dayDate(earliest)}</>}
      </p>
      <div className="panel rounded-xl">
        {groups.map((g) => (
          <div key={g.key} className="flex items-start gap-3 border-b border-line px-3.5 py-3 last:border-b-0">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                {g.active !== null && <span className={`rounded-full px-2 text-[11px] font-medium leading-[20px] ${g.active ? "bg-arc-dim text-arc" : "bg-s3 text-t2"}`}>{g.active ? "Active" : "Inactive"}</span>}
                <span className="text-[12px] text-t2">{g.platform === "google" ? "Google" : "Meta"}{g.format && g.format !== "unknown" ? ` ${g.format} ad` : " ad"}</span>
                {g.versions > 1 && <span className="text-[12px] text-t3">· {g.versions} {g.copy ? "versions" : "ads"}</span>}
              </div>
              {g.copy ? <div className="line-clamp-3 whitespace-pre-line leading-[20px]">{g.copy}</div> : <div className="text-[13px] text-t3">{g.versions > 1 ? "Their text wasn't readable on the public listing. The source link opens one of them." : "Ad text wasn't readable on the public listing. Open the source to view it."}</div>}
              <div className="num mt-1 text-[12px] text-t3">
                {[g.started && `Started ${dayDate(g.started)}`, g.lastShown && `Last shown ${dayDate(g.lastShown)}`, `Seen by us ${shortDate(g.lastSeen)}${g.days > 1 ? ` (${g.days} days)` : ""}`].filter(Boolean).join(" · ")}
              </div>
            </div>
            <SourceLink href={g.source}>Source</SourceLink>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[12px] leading-[17px] text-t3">{v.adObservations.meaning} Start and last-shown dates are as the ad library reports them.</p>
    </>
  );
}

const PLACEMENT: Record<string, string> = { sponsored: "Sponsored", affiliate: "Affiliate", organic: "Mention", unknown: "Mention" };

function Creators({ v, p }: { v: Vault; p: Product }) {
  const items = useMemo(() => latestByExternalId(v.signals, "creator_mention"), [v.signals]);
  if (!items.length) return <div className="panel rounded-xl p-6 text-t2">{p.creators === null ? "We haven't collected creator data for this product yet." : "No creator mentions found in our scans."}</div>;
  return (
    <div className="panel rounded-xl">
      {items.map(({ latest }) => {
        const d = latest.detail;
        const video = d.videoMetadata as { snippet?: { title?: string }; statistics?: { viewCount?: string } } | undefined;
        const placement = text(d.placement) ?? "unknown";
        const views = Number(video?.statistics?.viewCount);
        return (
          <div key={latest.external_id} className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
            <div className="min-w-0 flex-1">
              <div className="truncate">{video?.snippet?.title ?? text(d.hook) ?? text(d.summary) ?? "Creator mention"}</div>
              <div className="text-[12px] text-t3">{text(d.creator) ?? DASH} · {shortDate(latest.observed_at)}</div>
            </div>
            {Number.isFinite(views) && <span className="num hidden text-[13px] text-t2 sm:block">{views.toLocaleString()} views</span>}
            <span className={`rounded px-1.5 py-0.5 text-[11px] ${placement === "sponsored" ? "bg-creator/15 text-creator" : "bg-s3 text-t2"}`}>{PLACEMENT[placement] ?? "Mention"}</span>
            <SourceLink href={latest.source_url}>Source</SourceLink>
          </div>
        );
      })}
    </div>
  );
}

function RevenueNotes({ range }: { range: RevenueRange }) {
  return (
    <Analysis label="Revenue range" note={range.meaning}>
      <div className="flex items-center gap-2 text-[13px]"><span className="num font-medium">{formatRevenue(range.low_usd, range.high_usd)} a month</span><Confidence level={range.confidence} /><span className="text-t3">Method {range.method_version}</span></div>
      <div className="rounded-md border border-line">
        {range.inputs.map((input, i) => (
          <div key={i} className="border-b border-line px-2.5 py-1.5 text-[13px] last:border-b-0">
            <div className="flex justify-between gap-3"><span className="text-t2">{input.label}</span><span className="text-right">{input.value}</span></div>
            <div className="mt-0.5 flex justify-between gap-3 text-[12px] text-t3"><span>{input.basis === "assumption" ? "Assumption" : "Sourced"}</span>{input.sourceUrl && <SourceLink href={input.sourceUrl}>Source</SourceLink>}</div>
          </div>
        ))}
      </div>
    </Analysis>
  );
}

function BusinessModel({ v, p, locked, onSignIn }: { v: Vault; p: Product; locked: boolean; onSignIn: () => void }) {
  const pricing = v.publicPricing;
  const paywall = v.paywall;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Observed>
          <dl className="flex flex-col gap-2 text-[13px]">
            {p.monetization !== "unknown" && <div className="flex justify-between gap-4"><dt className="text-t2">Model</dt><dd className="text-right">{MODEL_LABEL[p.monetization]}</dd></div>}
            {pricing?.offers.map((offer, i) => (
              <div key={i}>
                <div className="flex justify-between gap-4"><dt className="text-t2">{offer.name}</dt><dd className="text-right">{offer.displayedPrice}</dd></div>
                {offer.limits.length > 0 && <div className="mt-0.5 text-[12px] leading-[17px] text-t3">{offer.limits.join(" · ")}</div>}
                <div className="mt-0.5 text-[12px]"><SourceLink href={offer.sourceUrl}>Source</SourceLink></div>
              </div>
            ))}
          </dl>
          {pricing ? <p className="mt-2 text-[12px] leading-[17px] text-t3">Seen {shortDate(pricing.observed_at)}. {pricing.meaning}</p> : <p className="mt-2 text-[12px] text-t3">No public pricing collected yet.</p>}
        </Observed>
        {v.revenueRange && <RevenueNotes range={v.revenueRange} />}
      </div>
      {locked ? <LockedCard label="Sign in to see the paywall logic" onSignIn={onSignIn} /> : paywall && (
        <Analysis label="Inferred logic" note="Worked out from how the product behaves. Arcex can't see its code.">
          {paywall.transitions.length > 0 && (
            <div className="flex flex-col">
              {paywall.transitions.map((t, i) => (
                <div key={i}>
                  {(i === 0 || paywall.transitions[i - 1].to !== t.from) && <div className="rounded-md border border-line-strong bg-s2 px-2.5 py-1.5 text-[13px]">{t.from}</div>}
                  <div className="num ml-3 border-l border-arc/50 py-1.5 pl-3 text-[11px] text-t3">{t.trigger} ↓</div>
                  <div className={`rounded-md border px-2.5 py-1.5 text-[13px] ${i === paywall.transitions.length - 1 ? "border-arc/60 bg-arc-dim" : "border-line-strong bg-s2"}`}>{t.to}</div>
                </div>
              ))}
            </div>
          )}
          {Object.keys(paywall.credit_rules).length > 0 && (
            <div className="rounded-md border border-line">
              {Object.entries(paywall.credit_rules).map(([k, value]) => <div key={k} className="flex justify-between gap-3 border-b border-line px-2.5 py-1.5 text-[13px] last:border-b-0"><span className="text-t2">{k}</span><span className="text-right">{typeof value === "string" ? value : JSON.stringify(value)}</span></div>)}
            </div>
          )}
          {paywall.notes && <p className="whitespace-pre-line leading-[21px] text-t2">{paywall.notes}</p>}
        </Analysis>
      )}
    </div>
  );
}

/** Shown in place of screens when we only track an app's public signals. */
function NotCaptured({ p, requested, onRequest }: { p: Product; requested: boolean; onRequest: () => void }) {
  return (
    <div className="panel flex flex-col items-start gap-3 rounded-xl p-5 md:flex-row md:items-center">
      <Layers className="size-5 shrink-0 text-t2" />
      <div className="min-w-0 flex-1">
        <h3 className="font-medium">We haven't captured {p.name}'s screens yet</h3>
        <p className="mt-0.5 text-[13px] leading-[18px] text-t2">We track its public ads, creators and pricing. Request it and we'll prioritize its full walkthrough and blueprint.</p>
      </div>
      <button disabled={requested} onClick={onRequest} className="btn btn-primary shrink-0 disabled:opacity-60">{requested ? <><Check className="size-4" />Requested</> : "Request full breakdown"}</button>
    </div>
  );
}

function BlueprintSection({ v, openAgent }: { v: Vault; openAgent: () => void }) {
  const latest = v.blueprints[0];
  return (
    <div className="panel rounded-xl p-4">
      {latest ? (
        <>
          <div className="font-medium">{latest.title} <span className="num text-[12px] font-normal text-t3">v{latest.version}</span></div>
          <p className="mt-1 max-w-[640px] leading-[21px] text-t2">A proposed way to build this pattern, based on what we observed. It isn't their source code. Your agent adapts it to your own product.</p>
          <button onClick={openAgent} className="btn btn-primary mt-3 h-11"><Zap className="size-4" />Send to my agent</button>
        </>
      ) : <p className="text-t2">No blueprint has been published for this product yet.</p>}
    </div>
  );
}

const TOOLS = ["Claude Code", "Cursor", "Codex", "Other"] as const;

function AgentDrawer({ p, blueprintId, onClose }: { p: Product; blueprintId: string; onClose: () => void }) {
  const [tool, setTool] = useState<string>(() => localStorage.getItem("arcex.tool") ?? "Claude Code");
  const { copied, copy } = useCopy();
  const s = useSession();
  // Each export counts toward the daily limit, so it only runs once the drawer opens.
  const blueprint = useQuery((signal) => api<BlueprintExport>(`/api/v1/blueprints/${encodeURIComponent(blueprintId)}/export`, { signal }), [blueprintId]);
  const share = () => {
    const url = location.href;
    if (navigator.share) void navigator.share({ title: `${p.name} blueprint on Arcex`, url }).catch(() => {});
    else copy(url, "link");
  };
  const body = blueprint.data ? JSON.stringify({ title: blueprint.data.title, ...blueprint.data.spec }, null, 2) : "";
  const prompt = `${tool === "Other" ? "" : `(${tool}) `}Build this onboarding and paywall pattern in my project. Adapt it to my stack and brand, and ask before changing billing code. This is a proposed implementation from observed behavior, not the product's source code.\n\n${body}`;
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Send to my agent">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="drawer absolute inset-y-0 right-0 flex w-full max-w-[520px] flex-col border-l border-line-strong bg-s1 shadow-2xl">
        <div className="flex items-start justify-between border-b border-line p-4">
          <div><h2 className="font-display text-[24px] font-semibold leading-[28px] tracking-[-0.015em]">Send to my agent</h2><div className="mt-1 text-t2">{p.name}{blueprint.data ? `: ${blueprint.data.title}` : ""}</div></div>
          <button className="px-2 text-xl text-t2 hover:text-t1" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {blueprint.error ? (
            <ErrorPanel message={blueprint.error instanceof ApiError && blueprint.error.status === 429 ? "You've used today's free blueprint pulls. They reset tomorrow, and Insider is unlimited." : errorMessage(blueprint.error)} onRetry={blueprint.reload} />
          ) : !blueprint.data ? (
            <div aria-hidden className="h-40 animate-pulse rounded-lg bg-s2" />
          ) : (
            <>
              <div className="flex gap-1 rounded-lg bg-canvas p-1">
                {TOOLS.map((t) => <button key={t} onClick={() => { setTool(t); localStorage.setItem("arcex.tool", t); }} className={`flex-1 rounded-md px-1 py-1.5 text-[13px] transition-colors ${tool === t ? "bg-s3 text-t1" : "text-t2 hover:text-t1"}`}>{t}</button>)}
              </div>
              <div className="eyebrow mb-2 mt-5">Paste this prompt</div>
              <div className="rounded-lg border border-line-strong bg-canvas p-3 text-[13px] leading-[20px] text-t2">Build this onboarding and paywall pattern in my project. Adapt it to my stack and brand, and ask before changing billing code. <span className="text-t3">+ blueprint</span></div>
              <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3 font-mono text-[12px] leading-[18px] text-t2">{body}</pre>
              <button className="btn btn-primary mt-3 hidden w-full md:flex" onClick={() => { copy(prompt, "prompt"); s.setFirstRun({ blueprint: true }); }}>{copied === "prompt" ? <><Check className="size-4" />Copied. Paste into {tool === "Other" ? "your agent" : tool}</> : "Copy prompt + blueprint"}</button>
              <div className="mt-4 rounded-xl border border-line-strong p-3 md:hidden">
                <div className="font-medium">Send it to your computer</div>
                <p className="mt-0.5 text-[13px] leading-[18px] text-t2">Agents run on your computer, so send yourself this page and open it there.</p>
                <a className="btn btn-primary mt-3 w-full" href={`mailto:?subject=${encodeURIComponent(`${p.name} blueprint on Arcex`)}&body=${encodeURIComponent(location.href)}`}><Mail className="size-4" />Email it to myself</a>
                <button className="btn btn-ghost mt-2 w-full" onClick={share}><Share2 className="size-4" />{copied === "link" ? "Link copied" : "Share link"}</button>
              </div>
              {blueprint.data.partners.length > 0 && (
                <>
                  <div className="eyebrow mb-2 mt-6">Recommended stack</div>
                  <div className="grid grid-cols-3 gap-2 text-[13px]">
                    {blueprint.data.partners.map((partner) => <a key={partner.name} href={partner.url} target="_blank" rel="noopener noreferrer sponsored" className="rounded-lg border border-line p-2 hover:bg-s2"><div className="text-[11px] text-t3">{partner.role}</div><div>{partner.name}</div></a>)}
                  </div>
                  <div className="mt-2 text-[11px] leading-[16px] text-t3">{blueprint.data.partners.map((partner) => partner.disclosure).join(" ")}</div>
                </>
              )}
            </>
          )}
          <div className="eyebrow mb-2 mt-6">Or connect with MCP</div>
          <button className="btn btn-ghost w-full" onClick={() => { copy(mcpPrompt(), "mcp"); s.setFirstRun({ mcp: true }); }}>{copied === "mcp" ? <><Check className="size-4 text-arc" />Copied. Paste it into your agent</> : "Copy connection instructions"}</button>
          <div className="mt-2"><CodeLine text={`Use Arcex to pull the ${p.name} blueprint`} id="pull" /></div>
        </div>
      </div>
    </div>
  );
}

/** The server sends nothing for these until sign-in, so there's nothing to blur. */
function LockedCard({ label, onSignIn }: { label: string; onSignIn: () => void }) {
  return (
    <div className="panel flex min-h-[120px] items-center justify-center rounded-xl p-5">
      <button onClick={onSignIn} className="btn btn-ghost"><Lock className="size-4" />{label}</button>
    </div>
  );
}

function Outline({ items, onSignIn }: { items: NonNullable<Vault["outline"]>; onSignIn: () => void }) {
  return (
    <div className="panel rounded-xl">
      {items.map((item, i) => (
        <button key={item.position} onClick={onSignIn} className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-s2">
          <span className="num w-5 text-[12px] text-t3">{i + 1}</span>
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          <span className="pill">{STAGE_LABEL[item.stage] ?? item.stage}</span>
          <Lock className="size-3.5 shrink-0 text-t2" />
        </button>
      ))}
      {!items.length && <p className="p-5 text-t2">Sign in to see this app's screens.</p>}
    </div>
  );
}

export function AppPage() {
  const { slug = "", step: stepParam } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { state, hash } = useLocation();
  const s = useSession();
  const fromRow = !!(state as { fromRow?: boolean } | null)?.fromRow;
  const [agent, setAgent] = useState(false);
  const [gateDismissed, setGateDismissed] = useState(false);
  const [nudge, setNudge] = useState(false);
  const prevIndex = useRef(0);

  // A shared link carries a signed position, which unlocks that one screen.
  const shared = sp.get("share") && sp.get("expires") && sp.get("signature") ? `?step=${sp.get("share")}&expires=${sp.get("expires")}&signature=${sp.get("signature")}` : "";
  // Opening a captured app uses one of today's free apps on the server. Reopening one doesn't.
  const vault = useQuery((signal) => api<Vault>(`/api/v1/vault/${encodeURIComponent(slug)}${shared}`, { signal }), [slug, shared, s.status], s.status !== "loading");
  const v = vault.data?.product.slug === slug ? vault.data : undefined;
  const p = useMemo(() => (v ? vaultProduct(v) : undefined), [v]);
  const adsSeen = useMemo(() => (v ? adGroups(v.signals).reduce((n, g) => n + g.versions, 0) : 0), [v]);
  const limitError = vault.error instanceof ApiError && vault.error.code === "daily_limit" ? vault.error : undefined;
  const limitUsage = limitError ? (limitError.body as unknown as Usage) : null;

  const { setUsage, visit } = s;
  useEffect(() => {
    if (v?.usage) setUsage(v.usage);
    else if (limitUsage) setUsage(limitUsage);
  }, [v?.usage, limitUsage?.used]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (p && s.signedIn && v?.access !== "preview") visit(p);
  }, [p?.id, s.signedIn, v?.access]); // eslint-disable-line react-hooks/exhaustive-deps

  const steps = v?.funnel ?? [];
  const full = v?.coverage === "full";
  const locked = v?.access === "preview";
  const index = Math.max(0, Math.min(steps.length - 1, (Number(stepParam) || 1) - 1));
  const dir = index - prevIndex.current;
  useEffect(() => { prevIndex.current = index; }, [index]);

  const list = useMemo<string[]>(() => {
    try { return JSON.parse(sessionStorage.getItem("arcex.radarList") ?? "[]") as string[]; } catch { return []; }
  }, []);
  const at = list.indexOf(slug);
  const prevApp = at > 0 ? list[at - 1] : undefined;
  const nextApp = at >= 0 ? list[at + 1] : undefined;
  const back = () => nav(sessionStorage.getItem("arcex.radarBack") ?? "/");
  const goApp = (x?: string) => { if (x) nav(`/app/${x}`, { state }); };

  const go = (i: number) => {
    if (!steps.length) return;
    nav(`/app/${slug}/${Math.min(steps.length - 1, Math.max(0, i)) + 1}${location.search}`, { replace: true, state, preventScrollReset: true });
  };
  const blueprintId = v?.blueprints[0]?.id;
  const openAgent = () => {
    if (locked) setNudge(true);
    else if (blueprintId) { if (s.signedIn) setAgent(true); else s.openSignIn(); }
  };
  const signIn = () => setNudge(true);

  useEffect(() => {
    window.scrollTo(0, 0);
    if (hash) window.setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView());
  }, [slug, !!v]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!p) return;
    const f = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (agent || el.closest("input, textarea, [role=dialog]") || e.metaKey || e.ctrlKey) return;
      if (e.key === "ArrowRight" && steps.length) go(index + 1);
      else if (e.key === "ArrowLeft" && steps.length) go(index - 1);
      else if (e.key === "Escape") back();
      else if (e.key === "[") goApp(prevApp);
      else if (e.key === "]") goApp(nextApp);
      else if (e.key === "s" && s.signedIn) s.toggleSave(p);
      else if (e.key === "c") openAgent();
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  });

  const similar = useQuery(async (signal) => {
    const result = await fetchRadar({ category: p!.category, sort: "traffic", dir: "desc", limit: 4 }, signal);
    return result.items.filter((x) => x.id !== p!.id).slice(0, 3);
  }, [p?.category, p?.id], !!p);

  if (limitError) {
    return (
      <main className="mx-auto max-w-[1500px] px-4 pt-5 lg:px-6">
        <button onClick={back} className="flex items-center gap-1.5 text-t2 hover:text-t1"><ArrowLeft className="size-4" />Radar</button>
        {!s.insiderOpen && <LimitModal usage={limitUsage} onClose={back} onUpgrade={s.openInsider} />}
      </main>
    );
  }
  if (vault.error) {
    const missing = vault.error instanceof ApiError && vault.error.status === 404;
    return (
      <main className="mx-auto max-w-[1500px] px-4 pt-5 lg:px-6">
        <button onClick={back} className="flex items-center gap-1.5 text-t2 hover:text-t1"><ArrowLeft className="size-4" />Radar</button>
        {missing
          ? <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 text-center"><div className="text-t2">We couldn't find that product. It may not be published.</div><Link to="/" className="btn btn-ghost">Go to Radar</Link></div>
          : <ErrorPanel message={errorMessage(vault.error)} onRetry={vault.reload} />}
      </main>
    );
  }
  if (!v || !p) {
    return (
      <main aria-busy="true" className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 pt-5 lg:px-6">
        <div className="h-[48px] w-64 animate-pulse rounded-lg bg-s2" />
        <div className="h-24 animate-pulse rounded-xl bg-s2" />
        <div className="h-96 animate-pulse rounded-xl bg-s2" />
      </main>
    );
  }

  const step = steps[index];
  const requested = s.requested.includes(p.id);
  const saved = s.isSaved(p.id);
  const watching = s.isWatching(p.id);
  const openToAll = !s.signedIn && !locked && full;
  const showGate = locked && fromRow && !shared && !gateDismissed;
  const closeGate = () => {
    setNudge(false);
    if (showGate) back();
    setGateDismissed(true);
  };

  return (
    <main className="mx-auto max-w-[1500px] pb-24">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 pt-5 lg:px-6">
        <button onClick={back} className="flex items-center gap-1.5 text-t2 hover:text-t1"><ArrowLeft className="size-4" />Radar</button>
        <span className="ml-auto flex items-center gap-1 lg:order-last lg:ml-0">
          <button aria-label="Previous app" disabled={!prevApp} onClick={() => goApp(prevApp)} className="field flex size-9 items-center justify-center text-t2 hover:text-t1 disabled:opacity-40"><ChevronLeft className="size-4" /></button>
          <button aria-label="Next app" disabled={!nextApp} onClick={() => goApp(nextApp)} className="field flex size-9 items-center justify-center text-t2 hover:text-t1 disabled:opacity-40"><ChevronRight className="size-4" /></button>
        </span>
        <div className="flex w-full min-w-0 items-center gap-3 lg:w-auto lg:flex-1">
          <ProductIcon p={p} size={48} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-[28px] font-semibold leading-[34px] tracking-[-0.02em]">{p.name}</h1>
              {openToAll && <span className="rounded bg-arc-dim px-1.5 py-0.5 text-[12px] text-arc">No sign-in</span>}
              <span className="pill">{CATEGORY_LABEL[p.category]}</span>
            </div>
            <div className="truncate text-t2"><a href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-t3 hover:text-t1">{p.domain}<ArrowUpRight className="size-3" /></a></div>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <button aria-pressed={saved} onClick={() => (s.signedIn ? s.toggleSave(p) : locked ? signIn() : s.openSignIn())} className="btn btn-ghost"><Bookmark className={`size-4 ${saved ? "fill-t1" : ""}`} />{saved ? "Saved" : "Save"}</button>
          <button aria-pressed={watching} onClick={() => (s.signedIn ? s.toggleWatch(p) : locked ? signIn() : s.openSignIn())} className="btn btn-ghost"><Crosshair className={`size-4 ${watching ? "text-arc" : ""}`} />{watching ? "Tracking" : "Track"}</button>
          {full && (locked || blueprintId) && <button onClick={openAgent} className="btn btn-primary"><Zap className="size-4" />Send to my agent</button>}
        </div>
      </header>
      <p className="max-w-[900px] px-4 pt-3 leading-[21px] text-t2 lg:px-6">{p.description}</p>

      <nav aria-label="On this page" className="no-scrollbar sticky top-[68px] z-20 mt-4 flex gap-1 overflow-x-auto border-b border-line bg-canvas px-4 lg:px-6">
        {SECTIONS.filter(([id]) => full || id !== "blueprint").map(([id, label]) => <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }); }} className="whitespace-nowrap px-3 py-2.5 text-t2 transition-colors hover:text-t1">{label}</a>)}
      </nav>

      <div className="flex flex-col gap-10 px-4 pt-6 lg:px-6">
        <section id="overview" className="scroll-mt-[120px]">
          <h2 className="sr-only">Overview</h2>
          <Overview p={p} adsSeen={adsSeen} />
        </section>

        <section id="traffic" className="scroll-mt-[120px]">
          <h2 className={`${SECTION_TITLE} mb-3`}>Traffic</h2>
          <TrafficSection traffic={v.traffic} />
        </section>
        <section id="stack" className="scroll-mt-[120px]">
          <h2 className={`${SECTION_TITLE} mb-3`}>Tech stack</h2>
          <StackSection stack={v.stack} />
        </section>

        {!full && (
          <section id="screens" className="scroll-mt-[120px]">
            <h2 className={`${SECTION_TITLE} mb-3`}>Screens</h2>
            <NotCaptured p={p} requested={requested} onRequest={() => (s.signedIn ? s.requestFull(p) : s.openSignIn())} />
          </section>
        )}

        {full && <section id="screens" className="scroll-mt-[120px]">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className={SECTION_TITLE}>Every screen</h2>
            {steps.length > 1 && <span className="hidden text-[12px] text-t3 md:inline"><kbd>←</kbd> <kbd>→</kbd> move between screens · <kbd>[</kbd> <kbd>]</kbd> previous or next app</span>}
          </div>
          {step ? (
            <>
              <div className="mt-3"><StageRail steps={steps} index={index} go={go} /></div>
              <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div>
                  <Viewer step={step} dir={dir} onExpired={vault.reload} />
                  {steps.length > 1 && (
                    <div className="mt-3 flex items-center justify-between">
                      <button disabled={index === 0} onClick={() => go(index - 1)} className="btn btn-ghost disabled:opacity-40"><ChevronLeft className="size-4" />Previous</button>
                      <span className="num text-[13px] text-t2">{index + 1} of {steps.length}</span>
                      <button disabled={index === steps.length - 1} onClick={() => go(index + 1)} className="btn btn-ghost disabled:opacity-40">Next<ChevronRight className="size-4" /></button>
                    </div>
                  )}
                </div>
                <StepNotes slug={slug} step={step} index={index} count={steps.length} evidence={v.evidence.find((e) => e.id === step.evidence_id)} canShare={s.signedIn} />
              </div>
              {locked && <div className="mt-4"><LockedCard label={`Sign in to see all ${v.outline?.length ?? ""} screens`} onSignIn={signIn} /></div>}
            </>
          ) : locked ? (
            <div className="mt-3"><Outline items={v.outline ?? []} onSignIn={signIn} /></div>
          ) : (
            <p className="panel mt-3 rounded-xl p-5 text-t2">No screens have been published for this app yet.</p>
          )}
        </section>}

        <section id="ads" className="scroll-mt-[120px]">
          <h2 className={`${SECTION_TITLE} mb-3`}>Ads</h2>
          {locked ? <LockedCard label="Sign in to see the ads" onSignIn={signIn} /> : <Ads v={v} p={p} />}
        </section>
        <section id="creators" className="scroll-mt-[120px]">
          <h2 className={`${SECTION_TITLE} mb-3`}>Creators</h2>
          {locked ? <LockedCard label="Sign in to see the creators" onSignIn={signIn} /> : <Creators v={v} p={p} />}
        </section>
        <section id="model" className="scroll-mt-[120px]">
          <h2 className={`${SECTION_TITLE} mb-3`}>Pricing</h2>
          <BusinessModel v={v} p={p} locked={locked} onSignIn={signIn} />
        </section>
        {full && <section id="blueprint" className="scroll-mt-[120px]">
          <h2 className={`${SECTION_TITLE} mb-3`}>Blueprint</h2>
          {locked ? <LockedCard label="Sign in to get the blueprint" onSignIn={signIn} /> : <BlueprintSection v={v} openAgent={openAgent} />}
        </section>}

        {!!similar.data?.length && (
          <section>
            <h2 className={`${SECTION_TITLE} mb-3`}>Similar apps</h2>
            <div className="grid gap-3 md:grid-cols-3">
              {similar.data.map((x) => (
                <Link key={x.slug} to={`/app/${x.slug}`} state={state} className="panel flex items-center gap-3 rounded-xl p-3 transition-colors hover:border-line-strong">
                  <ProductIcon p={x} />
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium">{x.name}</span><span className="block truncate text-[13px] text-t2">{priceLabel(x.pricing) ?? CATEGORY_LABEL[x.category]}</span></span>
                  {x.traffic_tier && <span title={TRAFFIC_TITLE} className="num text-[13px] text-t2">{x.traffic_rank === null ? "1M+" : compactRank(x.traffic_rank)}</span>}
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>

      {(showGate || nudge) && s.status === "out" && <GateModal product={p} screens={v.outline?.length} onClose={closeGate} />}
      {agent && blueprintId && <AgentDrawer p={p} blueprintId={blueprintId} onClose={() => setAgent(false)} />}
    </main>
  );
}
