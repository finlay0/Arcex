import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import { ArrowLeft, ArrowUpRight, Bookmark, Check, ChevronLeft, ChevronRight, Crosshair, Eye, Layers, Lock, Mail, Share2, Sparkles, Zap } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { blueprint, bySlug, CATEGORY_LABEL, formatRevenue, MODEL_LABEL, modelInfo, postLoginCount, products, SAMPLE_SLUG, STAGES, STAGE_LABEL, type Product, type Step } from "./data";
import { ago, GrowthValue } from "./radar";
import { ScaledScreen } from "./screens";
import { useSession } from "./shell";
import { CodeLine, Confidence, DAILY_LIMIT, GateModal, LimitModal, mcpPrompt, ProductIcon, Sparkline, useCopy } from "./ui";

const SECTIONS = [["overview", "Overview"], ["screens", "Screens"], ["ads", "Ads"], ["creators", "Creators"], ["model", "Model"], ["blueprint", "Blueprint"]];
const SECTION_TITLE = "font-display text-[22px] font-semibold leading-[28px] tracking-[-0.015em]";

/** Facts we captured. Visually distinct from our interpretation, which sits in Analysis. */
function Observed({ onReceipt, children }: { onReceipt?: () => void; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line-strong bg-canvas p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-teal"><Eye className="size-3.5" />Observed</h4>
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

function Note({ title, body }: { title: string; body: string }) {
  return <div><div className="eyebrow mb-1">{title}</div><p className="leading-[21px] text-t2">{body}</p></div>;
}

function Metric({ label, tag, children }: { label: string; tag?: string; children: ReactNode }) {
  return (
    <div className="panel rounded-xl p-3.5">
      <div className="flex items-center justify-between gap-2 text-[12px] text-t2">{label}{tag && <span className="text-[11px] text-t3">{tag}</span>}</div>
      <div className="num mt-1.5 flex min-h-[28px] items-center gap-2 text-[20px] font-semibold leading-[28px] tracking-[-0.01em]">{children}</div>
    </div>
  );
}

function Overview({ p }: { p: Product }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Metric label="Est. revenue/mo" tag="Estimate"><span>{formatRevenue(p.revenue)}</span><Confidence level={p.confidence} /></Metric>
      <Metric label="Distribution activity, 4w" tag="Observed"><GrowthValue value={p.growth} /><Sparkline data={p.spark} /></Metric>
      <Metric label="Active ads" tag="Observed">{p.activeAds}{!!p.adsDelta && <span className={`text-[13px] font-normal ${p.adsDelta > 0 ? "text-teal" : "text-t3"}`}>{p.adsDelta > 0 ? "+" : ""}{p.adsDelta} this week</span>}</Metric>
      <Metric label="Longest ad" tag="Observed">{p.longestAd ? `${p.longestAd} days seen` : "None"}</Metric>
      <Metric label="YT sponsors" tag="Observed">{p.creators}{!!p.creatorsDelta && <span className={`text-[13px] font-normal ${p.creatorsDelta > 0 ? "text-teal" : "text-t3"}`}>{p.creatorsDelta > 0 ? "+" : ""}{p.creatorsDelta} this week</span>}</Metric>
      <Metric label="First seen" tag="Observed">{ago(p.firstSeen)}</Metric>
    </div>
  );
}

function StageRail({ p, index, go }: { p: Product; index: number; go: (i: number) => void }) {
  const current = p.steps[index].stage;
  return (
    <div className="no-scrollbar flex items-stretch overflow-x-auto">
      {STAGES.map((stage, si) => {
        const idxs = p.steps.flatMap((s, i) => (s.stage === stage ? [i] : []));
        const on = stage === current;
        return (
          <div key={stage} className="flex min-w-fit flex-1 items-center">
            {si > 0 && <span className="h-px w-3 shrink-0 bg-line-strong md:flex-1" />}
            <button disabled={!idxs.length} onClick={() => go(on ? index : idxs[0])} aria-current={on ? "step" : undefined} className={`flex flex-col items-start gap-1 rounded-lg px-2.5 py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${on ? "bg-s2" : "hover:bg-s1"}`}>
              <span className={`eyebrow flex items-center gap-1.5 whitespace-nowrap ${on ? "!text-t1" : ""} ${stage === "paywall" ? "!text-teal" : ""}`}><span className="num">{si + 1}</span>{STAGE_LABEL[stage]}</span>
              <span className="flex h-2 items-center gap-1">{idxs.map((i) => <span key={i} className={`size-1.5 rounded-full ${i === index ? (stage === "paywall" ? "bg-teal" : "bg-t1") : "bg-t3/50"}`} />)}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Viewer({ p, step, dir, activePin, setActivePin }: { p: Product; step: Step; dir: number; activePin: number | null; setActivePin: (n: number | null) => void }) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <div key={step.title} className={dir >= 0 ? "step-next" : "step-prev"}>
        <div className="relative overflow-hidden rounded-xl border border-line-strong">
          <button aria-label="Zoom screenshot" onClick={() => setZoom(true)} className="block w-full cursor-zoom-in"><ScaledScreen product={p} step={step} /></button>
          {step.pins.map((pin, i) => (
            <button key={i} aria-label={`Note ${i + 1}: ${pin.note}`} onMouseEnter={() => setActivePin(i)} onMouseLeave={() => setActivePin(null)} onFocus={() => setActivePin(i)} onBlur={() => setActivePin(null)} style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
              className={`num absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-canvas text-[12px] font-semibold text-black shadow-lg transition-transform ${activePin === i ? "scale-125 bg-white" : "bg-teal"}`}>{i + 1}</button>
          ))}
        </div>
      </div>
      <Dialog open={zoom} onOpenChange={setZoom}>
        <DialogContent className="max-w-[92vw] border-line-strong bg-s1 p-2 sm:max-w-[92vw]">
          <DialogTitle className="sr-only">{step.title}</DialogTitle>
          <DialogDescription className="sr-only">Enlarged screenshot</DialogDescription>
          <ScaledScreen product={p} step={step} className="rounded" />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReceiptDialog({ p, step, onClose }: { p: Product; step: Step; onClose: () => void }) {
  const source = step.stage === "landing" ? "Public page" : "Free test account";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-2xl border-line-strong bg-s1 sm:max-w-[420px]">
        <DialogTitle className="font-display text-[22px] font-semibold tracking-[-0.015em]">Receipt</DialogTitle>
        <DialogDescription className="text-t2">Where this screen came from.</DialogDescription>
        <dl className="divide-y divide-line rounded-xl border border-line text-[13px]">
          {[["Product", p.domain], ["Screen", step.title], ["Source", source], ["Captured", step.capturedAt]].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 px-3 py-2"><dt className="text-t2">{k}</dt><dd className="text-right">{v}</dd></div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

function StepNotes({ p, step, index, activePin, setActivePin }: { p: Product; step: Step; index: number; activePin: number | null; setActivePin: (n: number | null) => void }) {
  const [receipt, setReceipt] = useState(false);
  return (
    <aside className="flex flex-col gap-4">
      <div>
        <div className="eyebrow">Screen {index + 1} of {p.steps.length} · {STAGE_LABEL[step.stage]}</div>
        <h3 className="mt-1 font-display text-[20px] font-semibold leading-[26px] tracking-[-0.015em]">{step.title}</h3>
      </div>
      <Observed onReceipt={() => setReceipt(true)}>
        <div className="flex flex-col gap-1">
          {step.pins.map((pin, i) => (
            <div key={i} onMouseEnter={() => setActivePin(i)} onMouseLeave={() => setActivePin(null)} className={`flex gap-2 rounded-md p-1.5 text-[13px] leading-[18px] transition-colors ${activePin === i ? "bg-s3 text-t1" : "text-t2"}`}>
              <span className="num flex size-[18px] shrink-0 items-center justify-center rounded-full bg-teal text-[11px] font-semibold text-black">{i + 1}</span>{pin.note}
            </div>
          ))}
        </div>
        <div className="mt-2 text-[12px] text-t3">Captured {step.capturedAt}</div>
      </Observed>
      <Analysis>
        <Note title="Why it works" body={step.why} />
        <Note title="How it protects AI costs" body={step.cost} />
        <Note title="Pricing trick" body={step.pricing} />
      </Analysis>
      {receipt && <ReceiptDialog p={p} step={step} onClose={() => setReceipt(false)} />}
    </aside>
  );
}

function Ads({ p }: { p: Product }) {
  if (!p.ads.length) return <div className="panel rounded-xl p-6 text-t2">No ads seen for this product. Its growth appears to come from creators and sharing.</div>;
  const sorted = [...p.ads].sort((a, b) => b.end - b.start - (a.end - a.start));
  return (
    <div className="flex flex-col gap-4">
      <div className="panel rounded-xl p-4">
        <div className="mb-3 flex items-center justify-between"><div className="font-medium">Ad timeline</div><div className="num text-[12px] text-t3">Last 90 days</div></div>
        <div className="flex flex-col gap-1.5">
          {sorted.map((a) => (
            <div key={a.id} className="grid grid-cols-[minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,230px)_minmax(0,1fr)]">
              <div className="truncate text-[13px] text-t2">{a.hook}</div>
              <div className="relative h-6 rounded bg-s2">
                <div className="absolute inset-y-0 flex items-center rounded px-2" style={{ left: `${(a.start / 90) * 100}%`, width: `${((a.end - a.start) / 90) * 100}%`, minWidth: 40, background: a.active ? "var(--color-ads)" : "rgba(45,212,191,.22)" }}>
                  <span className={`num text-[11px] font-medium ${a.active ? "text-black" : "text-t1"}`}>{a.end - a.start}d</span>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-4 text-[12px] text-t3">
          <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-ads" />Still running</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-ads/30" />Ended</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {p.ads.map((a) => (
          <div key={a.id} className="panel overflow-hidden rounded-xl">
            <div className="relative flex aspect-[4/5] items-end p-2 text-[12px] font-semibold leading-[15px] text-white" style={{ background: `linear-gradient(160deg, hsl(${a.hue} 70% 45%), hsl(${a.hue + 40} 60% 18%))` }}>
              {a.hook}
              {a.active && <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-teal" />}
            </div>
            <div className="num px-2 py-1.5 text-[11px] text-t3">{a.network} · {a.end - a.start}d</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Creators({ p }: { p: Product }) {
  return (
    <div className="panel rounded-xl">
      {p.creatorItems.map((c, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
          <div className="h-9 w-16 shrink-0 rounded" style={{ background: `linear-gradient(135deg, ${p.theme.accent}, #222)` }} />
          <div className="min-w-0 flex-1"><div className="truncate">{c.title}</div><div className="text-[12px] text-t3">{c.channel} · {c.date}</div></div>
          <span className="num hidden text-[13px] text-t2 sm:block">{c.views} views</span>
          <span className={`rounded px-1.5 py-0.5 text-[11px] ${c.kind === "Sponsored" ? "bg-creator/15 text-creator" : "bg-s3 text-t2"}`}>{c.kind}</span>
        </div>
      ))}
    </div>
  );
}

function BusinessModel({ p }: { p: Product }) {
  const m = modelInfo(p.model);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Observed>
        <dl className="flex flex-col gap-2 text-[13px]">
          {[["Model", MODEL_LABEL[p.model]], ["Paywall", p.mechanic], ["Monthly price", p.price.month], ...(p.price.year ? [["Annual price, per month", p.price.year]] : []), ...(p.price.credits ? [["Credit pack", p.price.credits]] : []), ["Stack", p.stack.join(", ")]].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4"><dt className="text-t2">{k}</dt><dd className="text-right">{v}</dd></div>
          ))}
        </dl>
      </Observed>
      {p.coverage === "full" && <Analysis label="Inferred logic" note="Worked out from how the product behaves. Arcex can't see its code.">
        <div className="flex flex-col">
          {m.transitions.map(([from, event, to], i) => (
            <div key={i}>
              {i === 0 && <div className="rounded-md border border-line-strong bg-s2 px-2.5 py-1.5 text-[13px]">{from}</div>}
              <div className="num ml-3 border-l border-teal/50 py-1.5 pl-3 text-[11px] text-t3">{event} ↓</div>
              <div className={`rounded-md border px-2.5 py-1.5 text-[13px] ${i === m.transitions.length - 1 ? "border-teal/60 bg-teal-dim" : "border-line-strong bg-s2"}`}>{to}</div>
            </div>
          ))}
        </div>
        <div className="rounded-md border border-line">
          {m.rules.map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-b border-line px-2.5 py-1.5 text-[13px] last:border-b-0"><span className="text-t2">{k}</span><span className="text-right">{v}</span></div>)}
        </div>
        <div className="flex flex-col gap-1 rounded-md border border-line bg-canvas p-3">
          {m.logic.map((l, i) => <code key={i} className="font-mono text-[12px] leading-[20px] text-t2">{l}</code>)}
        </div>
      </Analysis>}
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

function BlueprintSection({ p, openAgent }: { p: Product; openAgent: () => void }) {
  return (
    <div className="panel rounded-xl p-4">
      <p className="max-w-[640px] leading-[21px] text-t2">A proposed way to build this pattern, based on what we observed. It isn't their source code. Your agent adapts it to your own product.</p>
      <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3 font-mono text-[12px] leading-[18px] text-t2">{blueprint(p)}</pre>
      <button onClick={openAgent} className="btn btn-primary mt-3 h-11"><Zap className="size-4" />Send to my agent</button>
    </div>
  );
}

const TOOLS = ["Claude Code", "Cursor", "Codex", "Other"] as const;

function AgentDrawer({ p, onClose }: { p: Product; onClose: () => void }) {
  const [tool, setTool] = useState<string>(() => localStorage.getItem("arcex.tool") ?? "Claude Code");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const { copied, copy } = useCopy();
  const s = useSession();
  const share = () => {
    const url = location.href;
    if (navigator.share) void navigator.share({ title: `${p.name} blueprint on Arcex`, url }).catch(() => {});
    else copy(url, "link");
  };
  const prompt = `${tool === "Other" ? "" : `(${tool}) `}Build this onboarding and paywall pattern in my project. Adapt it to my stack and brand, and ask before changing billing code.\n\n${blueprint(p)}`;
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
          <div><h2 className="font-display text-[24px] font-semibold leading-[28px] tracking-[-0.015em]">Send to my agent</h2><div className="mt-1 text-t2">{p.name}: {modelInfo(p.model).title.toLowerCase()}</div></div>
          <button className="px-2 text-xl text-t2 hover:text-t1" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex gap-1 rounded-lg bg-canvas p-1">
            {TOOLS.map((t) => <button key={t} onClick={() => { setTool(t); localStorage.setItem("arcex.tool", t); }} className={`flex-1 rounded-md px-1 py-1.5 text-[13px] transition-colors ${tool === t ? "bg-s3 text-t1" : "text-t2 hover:text-t1"}`}>{t}</button>)}
          </div>
          <div className="eyebrow mb-2 mt-5">Paste this prompt</div>
          <div className="rounded-lg border border-line-strong bg-canvas p-3 text-[13px] leading-[20px] text-t2">Build this onboarding and paywall pattern in my project. Adapt it to my stack and brand, and ask before changing billing code. <span className="text-t3">+ blueprint</span></div>
          <button className="btn btn-primary mt-3 hidden w-full md:flex" onClick={() => { copy(prompt, "prompt"); s.setFirstRun({ blueprint: true }); }}>{copied === "prompt" ? <><Check className="size-4" />Copied. Paste into {tool === "Other" ? "your agent" : tool}</> : "Copy prompt + blueprint"}</button>
          <div className="mt-4 rounded-xl border border-line-strong p-3 md:hidden">
            <div className="font-medium">Send it to your computer</div>
            <p className="mt-0.5 text-[13px] leading-[18px] text-t2">Agents run on your computer, so we'll send the blueprint there.</p>
            {sent ? (
              <div role="status" className="mt-3 flex items-center gap-2 text-[13px]"><Check className="size-4 text-teal" />Sent to {email}</div>
            ) : (
              <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); setSent(true); s.setFirstRun({ blueprint: true }); if (!s.saved.includes(p.slug)) s.toggleSave(p.slug); }}>
                <input required type="email" autoComplete="email" aria-label="Your email" placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} className="h-[38px] min-w-0 flex-1 rounded-[10px] border border-line-strong bg-canvas px-3 outline-none focus:border-teal" />
                <button className="btn btn-primary"><Mail className="size-4" />Email it</button>
              </form>
            )}
            <button className="btn btn-ghost mt-2 w-full" onClick={share}><Share2 className="size-4" />{copied === "link" ? "Link copied" : "Share link"}</button>
          </div>
          <div className="eyebrow mb-2 mt-6">Or connect with MCP</div>
          <button className="btn btn-ghost w-full" onClick={() => { copy(mcpPrompt(), "mcp"); s.setFirstRun({ mcp: true }); }}>{copied === "mcp" ? <><Check className="size-4 text-teal" />Copied. Paste it into your agent</> : "Copy connection instructions"}</button>
          <div className="mt-2"><CodeLine text={`Use Arcex to pull the ${p.name} blueprint`} id="pull" /></div>
          <div className="eyebrow mb-2 mt-6">Recommended stack</div>
          <div className="grid grid-cols-3 gap-2 text-[13px]">
            {[["Auth", "Clerk"], ["Database", "Supabase"], ["Billing", "Stripe"]].map(([k, v]) => <div key={k} className="rounded-lg border border-line p-2"><div className="text-[11px] text-t3">{k}</div><div>{v}</div></div>)}
          </div>
          <div className="mt-2 text-[11px] text-t3">Some links may be partner links.</div>
        </div>
      </div>
    </div>
  );
}

function Locked({ on, onSignIn, children }: { on: boolean; onSignIn: () => void; children: ReactNode }) {
  if (!on) return <>{children}</>;
  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none select-none blur-md">{children}</div>
      <button onClick={onSignIn} className="btn btn-ghost absolute left-1/2 top-6 -translate-x-1/2 bg-s1"><Lock className="size-4" />Sign in to see this</button>
    </div>
  );
}

export function AppPage() {
  const { slug, step: stepParam } = useParams();
  const p = bySlug(slug);
  const nav = useNavigate();
  const { state, hash } = useLocation();
  const s = useSession();
  const fromRow = !!(state as { fromRow?: boolean } | null)?.fromRow;
  const [agent, setAgent] = useState(false);
  const [activePin, setActivePin] = useState<number | null>(null);
  const [gateDismissed, setGateDismissed] = useState(false);
  const [nudge, setNudge] = useState(false);
  const entryIndex = useRef(-1);
  const prevIndex = useRef(0);

  const sample = p?.slug === SAMPLE_SLUG;
  const full = p?.coverage === "full";
  const index = p ? Math.max(0, Math.min(p.steps.length - 1, (Number(stepParam) || 1) - 1)) : 0;
  if (entryIndex.current === -1) entryIndex.current = index;
  const dir = index - prevIndex.current;
  useEffect(() => { prevIndex.current = index; }, [index]);

  // Opening a new fully captured app uses one of the day's free apps. Reopening one is free,
  // and signals-only apps never count.
  const allowed = useMemo(() => (p && s.signedIn ? !full || s.insider || sample || s.unlocked.includes(p.slug) || s.unlocked.length < DAILY_LIMIT : false), [p, full, sample, s.insider, s.signedIn, s.unlocked]);
  useEffect(() => {
    if (p && full && !sample && s.signedIn && allowed && !s.unlocked.includes(p.slug)) s.unlock(p.slug);
  }, [p, full, sample, s, allowed]);
  useEffect(() => {
    if (p && s.signedIn && allowed) s.visit(p.slug);
  }, [p?.slug, s.signedIn, allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Everything is open to signed-in users, and public signals are open to anyone.
  // A shared link to a screen still shows that one screen without sign-in.
  const locked = !s.signedIn && !sample && full;
  const gated = locked && (fromRow || index !== entryIndex.current);
  const showGate = gated && !gateDismissed;
  const limited = s.signedIn && !allowed;

  const list = useMemo<string[]>(() => {
    try { return JSON.parse(sessionStorage.getItem("arcex.radarList") ?? "") as string[]; } catch { return products.slice(0, 50).map((x) => x.slug); }
  }, []);
  const at = p ? list.indexOf(p.slug) : -1;
  const prevApp = bySlug(list[at - 1]);
  const nextApp = bySlug(list[at + 1]);
  const back = () => nav(sessionStorage.getItem("arcex.radarBack") ?? "/");
  const goApp = (x?: Product) => { if (x) nav(`/app/${x.slug}`, { state }); };

  const go = (i: number) => {
    if (!p) return;
    setGateDismissed(false);
    nav(`/app/${p.slug}/${Math.min(p.steps.length - 1, Math.max(0, i)) + 1}`, { replace: true, state, preventScrollReset: true });
  };
  const openAgent = () => {
    if (!full) return;
    if (s.signedIn) setAgent(true);
    else { setGateDismissed(false); setNudge(true); }
  };

  useEffect(() => {
    window.scrollTo(0, 0);
    if (hash) window.setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView());
  }, [p?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!p) return;
    const f = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (agent || el.closest("input, textarea, [role=dialog]") || e.metaKey || e.ctrlKey) return;
      if (e.key === "ArrowRight" && full) go(index + 1);
      else if (e.key === "ArrowLeft" && full) go(index - 1);
      else if (e.key === "Escape") back();
      else if (e.key === "[") goApp(prevApp);
      else if (e.key === "]") goApp(nextApp);
      else if (e.key === "s" && s.signedIn) s.toggleSave(p.slug);
      else if (e.key === "c") openAgent();
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  });

  useEffect(() => setActivePin(null), [index]);

  if (!p) return <Navigate to="/" replace />;
  const step = p.steps[index];
  const requested = s.requested.includes(p.slug);
  const similar = products.filter((x) => x.slug !== p.slug && x.category === p.category).sort((a, b) => b.growth - a.growth).slice(0, 3);
  const blurAll = locked || limited;
  const blurScreens = limited || gated;
  const signIn = () => { setGateDismissed(false); setNudge(true); };
  const saved = s.saved.includes(p.slug);
  const watching = s.watching.includes(p.slug);

  return (
    <main className="mx-auto max-w-[1500px] pb-24">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 pt-5 lg:px-6">
        <button onClick={back} className="flex items-center gap-1.5 text-t2 hover:text-t1"><ArrowLeft className="size-4" />Radar</button>
        <span className="ml-auto flex items-center gap-1 lg:order-last lg:ml-0">
          <button aria-label="Previous app" disabled={!prevApp} onClick={() => goApp(prevApp)} className="flex size-9 items-center justify-center rounded-lg border border-line-strong text-t2 hover:text-t1 disabled:opacity-40"><ChevronLeft className="size-4" /></button>
          <button aria-label="Next app" disabled={!nextApp} onClick={() => goApp(nextApp)} className="flex size-9 items-center justify-center rounded-lg border border-line-strong text-t2 hover:text-t1 disabled:opacity-40"><ChevronRight className="size-4" /></button>
        </span>
        <div className="flex w-full min-w-0 items-center gap-3 lg:w-auto lg:flex-1">
          <ProductIcon p={p} size={48} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-[28px] font-semibold leading-[34px] tracking-[-0.02em]">{p.name}</h1>
              {sample && !s.signedIn && <span className="rounded bg-teal-dim px-1.5 py-0.5 text-[12px] text-teal">No sign-in</span>}
              <span className="pill">{CATEGORY_LABEL[p.category]}</span>
            </div>
            <div className="truncate text-t2">{p.tagline} · <span className="inline-flex items-center gap-0.5 text-t3">{p.domain}<ArrowUpRight className="size-3" /></span></div>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <button aria-pressed={saved} onClick={() => (s.signedIn ? s.toggleSave(p.slug) : full ? signIn() : s.openSignIn())} className="btn btn-ghost"><Bookmark className={`size-4 ${saved ? "fill-t1" : ""}`} />{saved ? "Saved" : "Save"}</button>
          <button aria-pressed={watching} onClick={() => (s.signedIn ? s.toggleWatch(p.slug) : full ? signIn() : s.openSignIn())} className="btn btn-ghost"><Crosshair className={`size-4 ${watching ? "text-teal" : ""}`} />{watching ? "Tracking" : "Track"}</button>
          {full && <button onClick={openAgent} className="btn btn-primary"><Zap className="size-4" />Send to my agent</button>}
        </div>
      </header>

      <nav aria-label="On this page" className="no-scrollbar sticky top-[68px] z-20 mt-4 flex gap-1 overflow-x-auto border-b border-line bg-canvas px-4 lg:px-6">
        {SECTIONS.filter(([id]) => full || id !== "blueprint").map(([id, label]) => <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }); }} className="whitespace-nowrap px-3 py-2.5 text-t2 transition-colors hover:text-t1">{label}</a>)}
      </nav>

      <div className="flex flex-col gap-10 px-4 pt-6 lg:px-6">
        <section id="overview" className="scroll-mt-[120px]">
          <h2 className="sr-only">Overview</h2>
          <Overview p={p} />
        </section>

        {!full && (
          <section id="screens" className="scroll-mt-[120px]">
            <h2 className={`${SECTION_TITLE} mb-3`}>Screens</h2>
            <NotCaptured p={p} requested={requested} onRequest={() => (s.signedIn ? s.requestFull(p.slug) : s.openSignIn())} />
          </section>
        )}

        {full && <section id="screens" className="scroll-mt-[120px]">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className={SECTION_TITLE}>Every screen</h2>
            <span className="hidden text-[12px] text-t3 md:inline"><kbd>←</kbd> <kbd>→</kbd> move between screens · <kbd>[</kbd> <kbd>]</kbd> previous or next app</span>
          </div>
          <div className="mt-3"><StageRail p={p} index={index} go={go} /></div>
          <div className={`mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] ${blurScreens ? "pointer-events-none select-none blur-md" : ""}`}>
            <div>
              <Viewer p={p} step={step} dir={dir} activePin={activePin} setActivePin={setActivePin} />
              <div className="mt-3 flex items-center justify-between">
                <button disabled={index === 0} onClick={() => go(index - 1)} className="btn btn-ghost disabled:opacity-40"><ChevronLeft className="size-4" />Previous</button>
                <span className="num text-[13px] text-t2">{index + 1} of {p.steps.length}</span>
                <button disabled={index === p.steps.length - 1} onClick={() => go(index + 1)} className="btn btn-ghost disabled:opacity-40">Next<ChevronRight className="size-4" /></button>
              </div>
            </div>
            <StepNotes p={p} step={step} index={index} activePin={activePin} setActivePin={setActivePin} />
          </div>
        </section>}

        <section id="ads" className="scroll-mt-[120px]">
          <h2 className={`${SECTION_TITLE} mb-3`}>Ads</h2>
          <Locked on={blurAll} onSignIn={signIn}><Ads p={p} /></Locked>
        </section>
        <section id="creators" className="scroll-mt-[120px]">
          <h2 className={`${SECTION_TITLE} mb-3`}>Creators</h2>
          <Locked on={blurAll} onSignIn={signIn}><Creators p={p} /></Locked>
        </section>
        <section id="model" className="scroll-mt-[120px]">
          <h2 className={`${SECTION_TITLE} mb-3`}>Model</h2>
          <Locked on={blurAll} onSignIn={signIn}><BusinessModel p={p} /></Locked>
        </section>
        {full && <section id="blueprint" className="scroll-mt-[120px]">
          <h2 className={`${SECTION_TITLE} mb-3`}>Blueprint</h2>
          <Locked on={blurAll} onSignIn={signIn}><BlueprintSection p={p} openAgent={openAgent} /></Locked>
        </section>}

        {similar.length > 0 && (
          <section>
            <h2 className={`${SECTION_TITLE} mb-3`}>Similar apps</h2>
            <div className="grid gap-3 md:grid-cols-3">
              {similar.map((x) => (
                <Link key={x.slug} to={`/app/${x.slug}`} state={state} className="panel flex items-center gap-3 rounded-xl p-3 transition-colors hover:border-line-strong">
                  <ProductIcon p={x} />
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium">{x.name}</span><span className="block truncate text-[13px] text-t2">{x.mechanic}</span></span>
                  <GrowthValue value={x.growth} />
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>

      {(showGate || nudge) && !s.signedIn && <GateModal product={p} screens={postLoginCount(p)} onSignIn={(via) => { s.signIn(via); setNudge(false); }} onClose={() => { setNudge(false); if (gated) { if (fromRow) back(); else { setGateDismissed(true); go(entryIndex.current); } } }} />}
      {limited && !s.insiderOpen && <LimitModal onClose={back} onUpgrade={s.openInsider} />}
      {agent && <AgentDrawer p={p} onClose={() => setAgent(false)} />}
    </main>
  );
}
