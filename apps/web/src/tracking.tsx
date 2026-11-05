import { useState } from "react";
import { Bell, ChevronRight, Crosshair, Search, X } from "lucide-react";
import { bySlug, CHANGE_LABEL, CHANGES, products } from "./data";
import { GrowthValue } from "./radar";
import { useOpenProduct, useSession } from "./shell";
import { FREE_WATCHES, INSIDER_PRICE, PageHeading, ProductIcon } from "./ui";

const CARD_TITLE = "font-display text-[18px] font-semibold leading-[24px] tracking-[-0.01em]";

export function Tracking() {
  const s = useSession();
  const openProduct = useOpenProduct();
  const [url, setUrl] = useState("");
  const [q, setQ] = useState("");

  if (!s.signedIn) {
    return (
      <main className="px-4 py-5 lg:px-6 lg:py-6">
        <PageHeading title="Tracking" sub="Add your product, watch your competitors and see every change they make." />
        <div className="panel mt-5 flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-2xl p-6 text-center">
          <Crosshair className="size-6 text-t2" />
          <div className="text-t2">Sign in to start tracking competitors. It's free for up to {FREE_WATCHES}.</div>
          <button className="btn btn-primary" onClick={s.openSignIn}>Sign in</button>
        </div>
      </main>
    );
  }

  const watched = s.watching.flatMap((x) => bySlug(x) ?? []);
  const changes = CHANGES.filter((c) => s.watching.includes(c.slug));
  const needle = q.trim().toLowerCase();
  const matches = needle ? products.filter((p) => !s.watching.includes(p.slug) && `${p.name} ${p.what} ${p.domain}`.toLowerCase().includes(needle)).slice(0, 5) : [];
  const atCap = !s.insider && s.watching.length >= FREE_WATCHES;

  return (
    <main className="px-4 py-5 pb-24 lg:px-6 lg:py-6">
      <PageHeading title="Tracking" sub="Add your product, watch your competitors and see every change they make." />
      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="panel rounded-2xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className={CARD_TITLE}>Competitors</h2>
              <span className="num text-[13px] text-t2">{s.insider ? `${watched.length} tracked` : `${watched.length} of ${FREE_WATCHES} free`}</span>
            </div>
            <label className="mt-3 flex h-11 items-center gap-2 rounded-xl border border-line-strong px-3 transition-colors focus-within:border-teal">
              <Search className="size-4 shrink-0 text-t2" />
              <input aria-label="Find a product to track" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a product to track..." className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-t2" />
            </label>
            {matches.length > 0 && (
              <div className="mt-2 flex flex-col gap-0.5">
                {matches.map((p) => (
                  <div key={p.slug} className="flex items-center gap-3 rounded-lg px-2 py-2">
                    <ProductIcon p={p} size={28} />
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{p.name}</span><span className="block truncate text-[12px] text-t2">{p.what}</span></span>
                    <button onClick={() => { s.toggleWatch(p.slug); setQ(""); }} className="btn btn-ghost !h-8">{atCap ? "Go Insider to add" : "Track"}</button>
                  </div>
                ))}
              </div>
            )}
            {needle && !matches.length && <p className="mt-3 text-[13px] text-t2">No matches. <button onClick={s.openRequest} className="text-t1 underline underline-offset-2">Request this product</button></p>}
            <div className="mt-3 flex flex-col gap-0.5">
              {watched.map((p) => (
                <div key={p.slug} className="flex items-center gap-1 rounded-lg transition-colors hover:bg-s2">
                  <button onClick={() => openProduct(p)} className="flex min-w-0 flex-1 items-center gap-3 p-2 text-left">
                    <ProductIcon p={p} />
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{p.name}</span><span className="block truncate text-[13px] text-t2">{p.mechanic} · {p.activeAds} active ads</span></span>
                    <GrowthValue value={p.growth} />
                  </button>
                  <button aria-label={`Stop tracking ${p.name}`} onClick={() => s.toggleWatch(p.slug)} className="flex size-9 shrink-0 items-center justify-center rounded-lg text-t2 hover:text-t1"><X className="size-4" /></button>
                </div>
              ))}
              {!watched.length && !needle && <p className="py-4 text-center text-[13px] text-t2">Nothing tracked yet. Search above, or press Track on any app's page.</p>}
            </div>
          </section>

          <section className="panel rounded-2xl p-4">
            <h2 className={CARD_TITLE}>Their latest changes</h2>
            <div className="mt-2 flex flex-col gap-0.5">
              {changes.map((c) => {
                const p = bySlug(c.slug)!;
                return (
                  <button key={c.id} onClick={() => openProduct(p)} className="flex items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-s2">
                    <ProductIcon p={p} size={28} />
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{p.name}</span><span className="block text-[13px] leading-[18px] text-t2">{c.text}</span></span>
                    <span className="pill hidden sm:inline-flex">{CHANGE_LABEL[c.kind]}</span>
                    <ChevronRight className="size-4 shrink-0 text-t2" />
                  </button>
                );
              })}
              {!changes.length && <p className="py-4 text-center text-[13px] text-t2">{watched.length ? "No changes seen yet for these products." : "Changes show up here once you track a product."}</p>}
            </div>
          </section>
        </div>

        <div className="flex flex-col gap-5">
          <section className="panel rounded-2xl p-4">
            <h2 className={CARD_TITLE}>Your products</h2>
            <p className="mt-1 text-[13px] leading-[18px] text-t2">Add yours so you can compare it with the products you track.</p>
            <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); s.addMine(url.trim()); setUrl(""); }}>
              <input required type="url" aria-label="Your product's URL" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} className="h-[38px] min-w-0 flex-1 rounded-[10px] border border-line-strong bg-canvas px-3 outline-none focus:border-teal" />
              <button className="btn btn-primary">Add</button>
            </form>
            <div className="mt-2 flex flex-col gap-1">
              {s.mine.map((m) => (
                <div key={m} className="flex items-center gap-2 rounded-lg bg-s2 px-3 py-2 text-[13px]">
                  <span className="min-w-0 flex-1"><span className="block truncate">{m}</span><span className="block text-[12px] text-t3">Tracking starts within 24 hours</span></span>
                  <button aria-label={`Remove ${m}`} onClick={() => s.removeMine(m)} className="text-t2 hover:text-t1"><X className="size-4" /></button>
                </div>
              ))}
            </div>
          </section>

          <section className="panel rounded-2xl p-4">
            <h2 className={`${CARD_TITLE} flex items-center gap-2`}><Bell className="size-4 text-t2" />Email alerts</h2>
            <p className="mt-1 text-[13px] leading-[18px] text-t2">Get an email when a tracked product changes its paywall, pricing, onboarding or ads.</p>
            {s.insider ? (
              <label className="mt-3 flex items-center gap-2"><input type="checkbox" className="accent-teal" checked={s.alerts} onChange={(e) => s.setAlerts(e.target.checked)} />Email me about changes</label>
            ) : (
              <button onClick={s.openInsider} className="btn btn-ghost mt-3 w-full">Go Insider ({INSIDER_PRICE})</button>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
