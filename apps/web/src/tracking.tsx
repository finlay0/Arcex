import { useEffect, useState } from "react";
import { Bell, ChevronRight, Crosshair, Search, X } from "lucide-react";
import { api, errorMessage, fetchRadar, toProduct, useQuery, type Change } from "./api";
import { CHANGE_LABEL, DASH } from "./data";
import { useOpenProduct, useSession } from "./shell";
import { FREE_WATCHES, GrowthValue, INSIDER_PRICE, PageHeading, ProductIcon, useDebounced } from "./ui";

const CARD_TITLE = "font-display text-[18px] font-semibold leading-[24px] tracking-[-0.01em]";

type OwnProduct = { id: string; url: string };

function YourProducts() {
  const s = useSession();
  const [url, setUrl] = useState("");
  const mine = useQuery((signal) => api<{ items: OwnProduct[] }>("/api/v1/me/products", { signal }), []);
  const add = async () => {
    try {
      await api("/api/v1/me/products", { method: "POST", body: { url: url.trim() } });
      setUrl("");
      mine.reload();
    } catch (error) {
      s.notify(errorMessage(error));
    }
  };
  const remove = (id: string) => api(`/api/v1/me/products/${encodeURIComponent(id)}`, { method: "DELETE" }).then(mine.reload, (error) => s.notify(errorMessage(error)));
  return (
    <section className="panel rounded-2xl p-4">
      <h2 className={CARD_TITLE}>Your products</h2>
      <p className="mt-1 text-[13px] leading-[18px] text-t2">Add yours so it's on file for when side-by-side comparison opens.</p>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input required type="url" pattern="https://.*" maxLength={500} aria-label="Your product's URL" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} className="h-[38px] min-w-0 flex-1 rounded-[10px] border border-line-strong bg-canvas px-3 outline-none focus:border-arc" />
        <button className="btn btn-primary">Add</button>
      </form>
      <div className="mt-2 flex flex-col gap-1">
        {mine.data?.items.map((m) => (
          <div key={m.id} className="flex items-center gap-2 rounded-lg bg-s2 px-3 py-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate">{m.url}</span>
            <button aria-label={`Remove ${m.url}`} onClick={() => void remove(m.id)} className="text-t2 hover:text-t1"><X className="size-4" /></button>
          </div>
        ))}
      </div>
    </section>
  );
}

function EmailAlerts() {
  const s = useSession();
  const [on, setOn] = useState(false);
  const alerts = useQuery((signal) => api<{ emailAlerts: boolean }>("/api/v1/me/alerts", { signal }), [], s.insider);
  useEffect(() => {
    if (alerts.data) setOn(alerts.data.emailAlerts);
  }, [alerts.data]);
  const change = (next: boolean) => {
    setOn(next);
    api("/api/v1/me/alerts", { method: "PUT", body: { emailAlerts: next } }).catch((error) => {
      setOn(!next);
      s.notify(errorMessage(error));
    });
  };
  return (
    <section className="panel rounded-2xl p-4">
      <h2 className={`${CARD_TITLE} flex items-center gap-2`}><Bell className="size-4 text-t2" />Email alerts</h2>
      <p className="mt-1 text-[13px] leading-[18px] text-t2">Get an email when a tracked product has a reviewed change to its paywall, pricing page, onboarding or ads.</p>
      {s.insider ? (
        <label className="mt-3 flex items-center gap-2"><input type="checkbox" className="accent-arc" checked={on} disabled={!alerts.data} onChange={(e) => change(e.target.checked)} />Email me about changes</label>
      ) : (
        <button onClick={s.openInsider} className="btn btn-ghost mt-3 w-full">Go Insider ({INSIDER_PRICE})</button>
      )}
    </section>
  );
}

export function Tracking() {
  const s = useSession();
  const openProduct = useOpenProduct();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim());
  const search = useQuery((signal) => fetchRadar({ q, limit: 8 }, signal), [q], s.signedIn && q.length > 0);
  const watchIds = s.watches.map((p) => p.id).join();
  const changes = useQuery((signal) => api<{ items: Change[] }>("/api/v1/me/watches/changes?limit=30", { signal }), [watchIds], s.signedIn);

  if (!s.signedIn) {
    return (
      <main className="px-4 py-5 lg:px-6 lg:py-6">
        <PageHeading title="Tracking" sub="Add your product, watch your competitors and see every change they make." />
        <div className="panel mt-5 flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-2xl p-6 text-center">
          <Crosshair className="size-6 text-t2" />
          {s.status === "loading" ? <div className="text-t2">Loading...</div> : (
            <>
              <div className="text-t2">Sign in to start tracking competitors. It's free for up to {FREE_WATCHES}.</div>
              <button className="btn btn-primary" onClick={s.openSignIn}>Sign in</button>
            </>
          )}
        </div>
      </main>
    );
  }

  const matches = q ? (search.data?.items ?? []).filter((p) => !s.isWatching(p.id)).slice(0, 5) : [];
  const atCap = !s.insider && s.watches.length >= FREE_WATCHES;

  return (
    <main className="px-4 py-5 pb-24 lg:px-6 lg:py-6">
      <PageHeading title="Tracking" sub="Add your product, watch your competitors and see every change they make." />
      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="panel rounded-2xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className={CARD_TITLE}>Competitors</h2>
              <span className="num text-[13px] text-t2">{s.insider ? `${s.watches.length} tracked` : `${s.watches.length} of ${FREE_WATCHES} free`}</span>
            </div>
            <label className="facet-frame mt-3 flex h-11 items-center gap-2 px-3">
              <Search className="size-4 shrink-0 text-t2" />
              <input aria-label="Find a product to track" maxLength={120} value={text} onChange={(e) => setText(e.target.value)} placeholder="Find a product to track..." className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-t2" />
            </label>
            {matches.length > 0 && (
              <div className="mt-2 flex flex-col gap-0.5">
                {matches.map((p) => (
                  <div key={p.slug} className="flex items-center gap-3 rounded-lg px-2 py-2">
                    <ProductIcon p={p} size={28} />
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{p.name}</span><span className="block truncate text-[12px] text-t2">{p.description}</span></span>
                    <button onClick={() => { if (atCap) s.openInsider(); else { s.toggleWatch(p); setText(""); } }} className="btn btn-ghost !h-8">{atCap ? "Go Insider to add" : "Track"}</button>
                  </div>
                ))}
              </div>
            )}
            {q && !search.loading && !matches.length && <p className="mt-3 text-[13px] text-t2">No matches.</p>}
            <div className="mt-3 flex flex-col gap-0.5">
              {s.watches.map((raw) => {
                const p = toProduct(raw);
                return (
                  <div key={p.slug} className="flex items-center gap-1 rounded-lg transition-colors hover:bg-s2">
                    <button onClick={() => openProduct(p.slug)} className="flex min-w-0 flex-1 items-center gap-3 p-2 text-left">
                      <ProductIcon p={p} />
                      <span className="min-w-0 flex-1"><span className="block truncate font-medium">{p.name}</span><span className="block truncate text-[13px] text-t2">{p.active_ads ?? DASH} active ads · {p.description}</span></span>
                      <GrowthValue value={p.activity_change_4w} />
                    </button>
                    <button aria-label={`Stop tracking ${p.name}`} onClick={() => s.toggleWatch(p)} className="flex size-9 shrink-0 items-center justify-center rounded-lg text-t2 hover:text-t1"><X className="size-4" /></button>
                  </div>
                );
              })}
              {!s.watches.length && !q && <p className="py-4 text-center text-[13px] text-t2">Nothing tracked yet. Search above, or press Track on any app's page.</p>}
            </div>
          </section>

          <section className="panel rounded-2xl p-4">
            <h2 className={CARD_TITLE}>Their latest changes</h2>
            <div className="mt-2 flex flex-col gap-0.5">
              {changes.data?.items.map((c) => (
                <button key={c.id} onClick={() => openProduct(c.slug)} className="flex items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-s2">
                  <ProductIcon p={c} size={28} />
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium">{c.name}</span><span className="block text-[13px] leading-[18px] text-t2">{c.summary}</span></span>
                  <span className="pill hidden sm:inline-flex">{CHANGE_LABEL[c.kind] ?? c.kind}</span>
                  <ChevronRight className="size-4 shrink-0 text-t2" />
                </button>
              ))}
              {changes.error ? <p className="py-4 text-center text-[13px] text-t2">{errorMessage(changes.error)}</p>
                : changes.data && !changes.data.items.length && <p className="py-4 text-center text-[13px] text-t2">{s.watches.length ? "No changes published yet for these products." : "Changes show up here once you track a product."}</p>}
            </div>
          </section>
        </div>

        <div className="flex flex-col gap-5">
          <YourProducts />
          <EmailAlerts />
        </div>
      </div>
    </main>
  );
}
