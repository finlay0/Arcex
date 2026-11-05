import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { MODEL_LABEL, products, SAMPLE_SLUG, STAGES, STAGE_LABEL, type Model, type Stage } from "./data";
import { ScaledScreen } from "./screens";
import { useOpenProduct, useSession } from "./shell";
import { FilterMenu, PageHeading, ProductIcon } from "./ui";

const PAGE = "px-4 py-5 pb-24 lg:px-6 lg:py-6";
const PAGE_SIZE = 24;

function usePaged<T>(items: T[]) {
  const [sp, setSp] = useSearchParams();
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number(sp.get("page")) || 1));
  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v); else n.delete(k);
    if (k !== "page") n.delete("page");
    setSp(n, { replace: true });
    if (k === "page") window.scrollTo(0, 0);
  };
  return { sp, set, page, pages, visible: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) };
}

function Pager({ page, pages, total, noun, go }: { page: number; pages: number; total: number; noun: string; go: (n: number) => void }) {
  return (
    <div className="mt-5 flex items-center justify-between">
      <span className="num text-[13px] text-t2" role="status">{total.toLocaleString()} {noun}</span>
      <span className="flex items-center gap-2">
        <button disabled={page <= 1} onClick={() => go(page - 1)} className="btn btn-ghost !h-8 disabled:opacity-40"><ChevronLeft className="size-4" />Prev</button>
        <span className="num text-[13px] text-t2">Page {page} of {pages}</span>
        <button disabled={page >= pages} onClick={() => go(page + 1)} className="btn btn-ghost !h-8 disabled:opacity-40">Next<ChevronRight className="size-4" /></button>
      </span>
    </div>
  );
}

const ALL_ADS = products.flatMap((p) => p.ads.map((ad) => ({ ad, p, days: ad.end - ad.start }))).sort((a, b) => b.days - a.days);

export function AdsLibrary() {
  const [sp] = useSearchParams();
  const status = sp.get("status") ?? "";
  const network = sp.get("network") ?? "";
  const items = useMemo(() => ALL_ADS.filter(({ ad }) => (!status || (status === "running") === ad.active) && (!network || ad.network === network)), [status, network]);
  const { set, page, pages, visible } = usePaged(items);
  const openProduct = useOpenProduct();
  return (
    <main className={PAGE}>
      <PageHeading title="Ads" sub="Every ad we've seen across tracked products, longest-running first." />
      <div className="no-scrollbar -mx-4 mt-5 flex gap-2 overflow-x-auto px-4 lg:mx-0 lg:px-0">
        <FilterMenu label="Status" value={status} onChange={(v) => set("status", v || null)} options={[{ value: "", label: "All Ads" }, { value: "running", label: "Still Running" }, { value: "ended", label: "Ended" }]} />
        <FilterMenu label="Network" value={network} onChange={(v) => set("network", v || null)} options={[{ value: "", label: "All Networks" }, { value: "Meta", label: "Meta" }, { value: "Google", label: "Google" }]} />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6 min-[1700px]:grid-cols-8">
        {visible.map(({ ad, p, days }) => (
          <button key={ad.id} onClick={() => openProduct(p, undefined, "#ads")} className="panel overflow-hidden rounded-xl text-left transition-colors hover:border-line-strong">
            <span className="relative flex aspect-[4/5] items-end p-2 text-[12px] font-semibold leading-[15px] text-white" style={{ background: `linear-gradient(160deg, hsl(${ad.hue} 70% 45%), hsl(${ad.hue + 40} 60% 18%))` }}>
              {ad.hook}
              {ad.active && <span title="Still running" className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-teal" />}
            </span>
            <span className="flex items-center gap-1.5 px-2 pt-2"><ProductIcon p={p} size={18} /><span className="truncate text-[12px] font-medium">{p.name}</span></span>
            <span className="num block px-2 pb-2 pt-0.5 text-[11px] text-t3">{ad.network} · {days} days</span>
          </button>
        ))}
      </div>
      <Pager page={page} pages={pages} total={items.length} noun="ads" go={(n) => set("page", String(n))} />
    </main>
  );
}

const SCREEN_STAGES = STAGES;

export function ScreensLibrary() {
  const s = useSession();
  const [sp] = useSearchParams();
  const stage = (sp.get("stage") as Stage) || "paywall";
  const model = (sp.get("model") as Model) || "";
  const items = useMemo(() => products.filter((p) => !model || p.model === model).flatMap((p) => p.steps.flatMap((step, i) => (step.stage === stage ? [{ p, step, i }] : []))), [stage, model]);
  const { set, page, pages, visible } = usePaged(items);
  const openProduct = useOpenProduct();
  return (
    <main className={PAGE}>
      <PageHeading title="Screens" sub="Compare how products handle the same step, side by side." />
      <div className="no-scrollbar -mx-4 mt-5 flex items-center gap-2 overflow-x-auto px-4 lg:mx-0 lg:px-0">
        {SCREEN_STAGES.map((x) => <button key={x} className="chip" data-on={x === stage} onClick={() => set("stage", x === "paywall" ? null : x)}>{STAGE_LABEL[x]}</button>)}
        <span className="mx-1 h-5 w-px shrink-0 bg-line-strong" />
        <FilterMenu label="Monetization" value={model} onChange={(v) => set("model", v || null)} options={[{ value: "", label: "All Monetization" }, ...(Object.keys(MODEL_LABEL) as Model[]).map((m) => ({ value: m, label: MODEL_LABEL[m] }))]} />
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 min-[1700px]:grid-cols-4">
        {visible.map(({ p, step, i }, n) => {
          // Signed-out visitors see a few clearly. The rest wait behind the gate.
          const locked = !s.signedIn && p.slug !== SAMPLE_SLUG && (page > 1 || n >= 3);
          return (
            <button key={p.slug + i} onClick={() => openProduct(p, i + 1, "#screens")} className="panel overflow-hidden rounded-2xl text-left transition-colors hover:border-line-strong">
              <span className="relative block overflow-hidden">
                <ScaledScreen product={p} step={step} className={locked ? "blur-md" : ""} />
                {locked && <span className="absolute inset-0 flex items-center justify-center gap-2 bg-black/40 font-medium"><Lock className="size-4" />Sign in to view</span>}
              </span>
              <span className="flex items-center gap-3 border-t border-line p-3">
                <ProductIcon p={p} size={32} />
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{p.name}</span><span className="block truncate text-[13px] text-t2">{step.title}</span></span>
              </span>
            </button>
          );
        })}
      </div>
      <Pager page={page} pages={pages} total={items.length} noun="screens" go={(n) => set("page", String(n))} />
    </main>
  );
}
