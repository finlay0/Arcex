import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { modelInfo, type Product, type Step } from "./data";

const W = 1280;
const H = 800;

/** Renders a 1280x800 mock product screen, scaled to fit its container. Stands in for real captures. */
export function ScaledScreen({ product, step, className, children }: { product: Product; step: Step; className?: string; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new ResizeObserver(([e]) => setScale(e.contentRect.width / W));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return (
    <div ref={ref} className={className} style={{ position: "relative", aspectRatio: `${W} / ${H}`, overflow: "hidden", background: product.theme.bg }}>
      {scale > 0 && (
        <div aria-hidden style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: "top left", pointerEvents: "none", userSelect: "none" }}>
          <Screen product={product} step={step} />
        </div>
      )}
      {children}
    </div>
  );
}

function Logo({ p }: { p: Product }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 650, fontSize: 20 }}>
      <span style={{ width: 26, height: 26, borderRadius: 8, background: p.theme.accent, display: "block" }} />
      {p.name}
    </div>
  );
}

function Art({ p, style, label }: { p: Product; style?: CSSProperties; label?: string }) {
  const a = p.theme.accent;
  return (
    <div style={{ borderRadius: p.theme.radius, background: `linear-gradient(135deg, ${a}, ${a}55 55%, ${p.theme.surface})`, position: "relative", overflow: "hidden", ...style }}>
      <div style={{ position: "absolute", width: "70%", height: "70%", right: "-14%", top: "-16%", borderRadius: 999, background: "rgba(255,255,255,.22)" }} />
      <div style={{ position: "absolute", width: "48%", height: "48%", left: "-8%", bottom: "-12%", borderRadius: 999, background: "rgba(0,0,0,.22)" }} />
      {label && <div style={{ position: "absolute", left: 18, bottom: 14, color: "#fff", fontSize: 18, fontWeight: 600 }}>{label}</div>}
    </div>
  );
}

function Screen({ product: p, step }: { product: Product; step: Step }) {
  const th = p.theme;
  const base: CSSProperties = { width: W, height: H, background: th.bg, color: th.fg, fontFamily: "var(--font-sans)", lineHeight: 1.25, position: "relative", overflow: "hidden" };
  const button: CSSProperties = { background: th.accent, color: "#fff", borderRadius: th.radius, padding: "16px 26px", fontWeight: 650, fontSize: 20, display: "inline-block", textAlign: "center" };
  const center: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", textAlign: "center" };

  switch (step.screen) {
    case "landing":
      return (
        <div style={base}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "28px 56px", alignItems: "center" }}>
            <Logo p={p} />
            <div style={{ display: "flex", gap: 30, color: th.muted, fontSize: 17 }}><span>Examples</span><span>Reviews</span><span>Sign in</span></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.05fr", gap: 48, padding: "64px 56px" }}>
            <div>
              <div style={{ fontSize: 66, lineHeight: "70px", fontWeight: 700, letterSpacing: "-0.03em" }}>{p.tagline}.</div>
              <div style={{ fontSize: 22, lineHeight: "32px", color: th.muted, marginTop: 24 }}>Get your first {p.product.noun} in under a minute. No skills needed.</div>
              <div style={{ ...button, marginTop: 32 }}>Try it free →</div>
              <div style={{ marginTop: 22, color: th.muted, fontSize: 16 }}>★★★★★ Loved by 40,000+ people</div>
            </div>
            <Art p={p} style={{ height: 470 }} label="Demo: finished result" />
          </div>
        </div>
      );
    case "signup":
      return (
        <div style={{ ...base, ...center, background: th.surface }}>
          <div style={{ background: th.bg, border: `1px solid ${th.line}`, borderRadius: 22, padding: "52px 64px", width: 560 }}>
            <div style={{ display: "flex", justifyContent: "center" }}><Logo p={p} /></div>
            <div style={{ fontSize: 34, fontWeight: 700, marginTop: 26, letterSpacing: "-0.02em" }}>Create your free account</div>
            <div style={{ ...button, display: "block", marginTop: 32 }}>Continue with Google</div>
            <div style={{ border: `1px solid ${th.line}`, borderRadius: th.radius, padding: 15, fontSize: 19, fontWeight: 600, marginTop: 12 }}>Continue with Apple</div>
            <div style={{ color: th.muted, marginTop: 24, fontSize: 17 }}>No card required · Cancel anytime</div>
          </div>
        </div>
      );
    case "quiz": {
      const q = step.quiz!;
      return (
        <div style={base}>
          <div style={{ padding: "34px 56px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><Logo p={p} /><span style={{ color: th.muted, fontSize: 17 }}>Step {q.n} of {q.of}</span></div>
            <div style={{ height: 8, borderRadius: 8, background: th.surface, marginTop: 22 }}><div style={{ width: `${(q.n / q.of) * 100}%`, height: "100%", background: th.accent, borderRadius: 8 }} /></div>
          </div>
          <div style={{ maxWidth: 780, margin: "64px auto 0", textAlign: "center" }}>
            <div style={{ fontSize: 48, fontWeight: 700, letterSpacing: "-0.025em", lineHeight: "54px" }}>{q.q}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 44 }}>
              {q.options.map((o, i) => (
                <div key={o} style={{ padding: "34px 20px", borderRadius: th.radius, border: `2px solid ${i === 0 ? th.accent : th.line}`, background: i === 0 ? `${th.accent}18` : th.surface, fontSize: 23, fontWeight: 600 }}>{o}</div>
              ))}
            </div>
          </div>
        </div>
      );
    }
    case "loading":
      return (
        <div style={{ ...base, ...center }}>
          <div style={{ width: 150, height: 150, borderRadius: 999, border: `12px solid ${th.surface}`, borderTopColor: th.accent, borderRightColor: th.accent }} />
          <div style={{ fontSize: 44, fontWeight: 700, marginTop: 38, letterSpacing: "-0.02em" }}>Building your {p.product.noun}…</div>
          <div style={{ fontSize: 22, color: th.muted, marginTop: 14 }}>Matching your goals and how you like to learn</div>
          <div style={{ width: 460, height: 10, background: th.surface, borderRadius: 10, marginTop: 34 }}><div style={{ width: "86%", height: "100%", background: th.accent, borderRadius: 10 }} /></div>
          <div style={{ color: th.muted, marginTop: 20, fontSize: 18 }}>86% · Almost ready</div>
        </div>
      );
    case "aha":
      return (
        <div style={base}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "24px 40px", borderBottom: `1px solid ${th.line}`, alignItems: "center" }}>
            <Logo p={p} />
            <div style={{ background: th.surface, padding: "8px 14px", borderRadius: 99, fontSize: 16 }}>{p.model === "credit" ? "9 credits left" : p.model === "usage" ? "1 of 100 used" : "Free plan"}</div>
          </div>
          <div style={{ padding: "30px 40px", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.02em" }}>Your {p.product.noun} is ready 🎉</div>
            <Art p={p} style={{ width: 830, height: 440, marginTop: 24 }} label={`Your first ${p.product.noun}`} />
            <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
              <div style={button}>Make another</div>
              <div style={{ border: `1px solid ${th.line}`, borderRadius: th.radius, padding: "16px 26px", fontSize: 20, fontWeight: 600 }}>Export</div>
            </div>
          </div>
        </div>
      );
    case "paywall":
      return <Paywall p={p} base={base} button={button} />;
    case "retention":
      return (
        <div style={{ ...base, ...center, background: th.surface }}>
          <div style={{ background: th.bg, border: `1px solid ${th.line}`, borderRadius: 22, padding: "44px 56px", width: 640 }}>
            <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: "-0.02em" }}>Before you go…</div>
            <div style={{ color: th.muted, fontSize: 20, marginTop: 10 }}>What made you want to cancel?</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 24 }}>
              {["Too expensive", "Not using it", "Missing a feature"].map((o, i) => <div key={o} style={{ padding: "11px 15px", borderRadius: 10, fontSize: 17, border: `2px solid ${i === 0 ? th.accent : th.line}` }}>{o}</div>)}
            </div>
            <div style={{ ...button, display: "block", marginTop: 30 }}>Stay and get 50% off</div>
            <div style={{ color: th.muted, marginTop: 18, fontSize: 16 }}>Cancel anyway</div>
          </div>
        </div>
      );
    default:
      return <div style={base} />;
  }
}

function Paywall({ p, base, button }: { p: Product; base: CSSProperties; button: CSSProperties }) {
  const th = p.theme;
  const copy: Record<Product["model"], { h: string; sub: string; left: [string, string, string]; right: [string, string, string] }> = {
    credit: { h: "You're out of credits", sub: `Your next ${p.product.noun} is one click away.`, left: ["Pro", `${p.price.month}/mo`, "200 credits every month"], right: ["Credit pack", p.price.credits ?? "$9", "One-time top-up"] },
    hard: { h: "Your plan is ready", sub: "Built around your answers. Start today.", left: ["Weekly", `${p.price.week}/wk`, "Cancel anytime"], right: ["Annual", `${p.price.year}/yr`, "Save 84%"] },
    watermark: { h: "Export without the watermark", sub: "This clip is ready to post in 4K.", left: ["Keep free", "$0", "720p with watermark"], right: ["Pro", `${p.price.month}/mo`, "4K, no watermark"] },
    usage: { h: "Your queue is paused", sub: `38 ${p.product.noun}s are waiting. You've used 100 of 100.`, left: ["Starter", `${p.price.month}/mo`, "1,000 actions"], right: ["Scale", "$149/mo", "5,000 actions · Recommended"] },
    free: { h: "You've hit today's limit", sub: "Keep going with Pro, or share to unlock more.", left: ["Pro", `${p.price.month}/mo`, "Unlimited use"], right: ["Share", "Free", "Share a link for 5 more"] },
    subscription: { h: "Ready for your second project?", sub: "Annual billing is selected. Save 20%.", left: ["Pro", `${p.price.year}/mo`, "Billed annually"], right: ["Teams", "$50/mo", "Recommended · 5 seats"] },
  };
  const c = copy[p.model];
  const card = (col: [string, string, string], hi: boolean) => (
    <div style={{ width: 400, padding: "30px 32px", borderRadius: th.radius + 6, border: `2px solid ${hi ? th.accent : th.line}`, background: hi ? `${th.accent}14` : th.bg, textAlign: "left" }}>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{col[0]}</div>
      <div style={{ fontSize: 52, fontWeight: 750, letterSpacing: "-0.03em", marginTop: 8 }}>{col[1]}</div>
      <div style={{ color: th.muted, fontSize: 18, marginTop: 8 }}>{col[2]}</div>
    </div>
  );
  return (
    <div style={{ ...base, background: th.surface, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 80 }}>
      <div style={{ position: "absolute", right: 40, top: 32, width: 36, height: 36, lineHeight: "32px", textAlign: "center", borderRadius: 99, border: `1px solid ${th.line}`, color: th.muted, fontSize: 22 }}>×</div>
      <Logo p={p} />
      <div style={{ fontSize: 52, fontWeight: 750, letterSpacing: "-0.03em", marginTop: 24 }}>{c.h}</div>
      <div style={{ fontSize: 22, color: th.muted, marginTop: 10 }}>{c.sub}</div>
      <div style={{ display: "flex", gap: 20, marginTop: 40 }}>{card(c.left, p.model !== "usage" && p.model !== "subscription")}{card(c.right, p.model === "usage" || p.model === "subscription")}</div>
      <div style={{ ...button, width: 460, marginTop: 34 }}>Continue</div>
      <div style={{ color: th.muted, fontSize: 16, marginTop: 16 }}>{modelInfo(p.model).rules[0].join(": ")} · Secure checkout with {p.stack.find((s) => ["Stripe", "Paddle", "Polar", "Lemon Squeezy"].includes(s))}</div>
    </div>
  );
}
