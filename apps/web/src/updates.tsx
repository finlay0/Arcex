import { useEffect, useState } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { CHANGE_LABEL, shortDate, type ChangeKind } from "./data";
import { useOpenProduct, useSession } from "./shell";
import { PageHeading, ProductIcon } from "./ui";

export function Updates() {
  const s = useSession();
  const openProduct = useOpenProduct();
  const [kind, setKind] = useState<ChangeKind | null>(null);
  // Keep the "new" dots for this visit, then count everything as seen.
  const [fresh] = useState(() => new Set(s.unseen.map((c) => c.id)));
  useEffect(() => s.markSeen(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = s.changes.filter((c) => !kind || c.kind === kind);
  const days = [...new Set(shown.map((c) => shortDate(c.observed_at)))];
  return (
    <main className="px-4 py-5 pb-24 lg:px-6 lg:py-6">
      <PageHeading title="What's New" sub="Reviewed changes we've observed across tracked products." />
      {/* Kind filters only help once there is something to filter. */}
      {s.changes.length > 0 && <div className="no-scrollbar -mx-4 mt-5 flex gap-2 overflow-x-auto px-4 lg:mx-0 lg:px-0">
        <button className="chip" data-on={!kind} onClick={() => setKind(null)}>All</button>
        {(Object.keys(CHANGE_LABEL) as ChangeKind[]).map((k) => <button key={k} className="chip" data-on={kind === k} onClick={() => setKind(k)}>{CHANGE_LABEL[k]}</button>)}
      </div>}
      <div className="mt-5 flex max-w-[900px] flex-col gap-5">
        {!shown.length && (kind ? <p className="panel rounded-2xl p-6 text-center text-t2">No changes of this kind yet.</p> : (
          <div className="panel flex flex-col items-start gap-3 rounded-2xl p-6">
            <div className="font-medium">Nothing has changed yet</div>
            <p className="max-w-[560px] text-t2">We check every product daily. When a price, paywall, onboarding step or ad campaign changes, it lands here once we've reviewed it. Track the products you care about to follow their changes in one place.</p>
            <div className="flex flex-wrap gap-2">
              <Link to="/tracking" className="btn btn-primary">Track a product</Link>
              <Link to="/" className="btn btn-ghost">Browse the Radar<ArrowRight className="size-4" /></Link>
            </div>
          </div>
        ))}
        {days.map((day) => (
          <section key={day}>
            <h2 className="eyebrow mb-2">{day}</h2>
            <div className="panel flex flex-col gap-0.5 rounded-2xl p-1.5">
              {shown.filter((c) => shortDate(c.observed_at) === day).map((c) => (
                <button key={c.id} onClick={() => openProduct(c.slug)} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-s2">
                  <ProductIcon p={c} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 font-medium">{c.name}{fresh.has(c.id) && <span title="New since your last visit" className="size-1.5 shrink-0 rounded-full bg-arc" />}</span>
                    <span className="block text-[13px] leading-[18px] text-t2">{c.summary}</span>
                  </span>
                  <span className="pill hidden sm:inline-flex">{CHANGE_LABEL[c.kind] ?? c.kind}</span>
                  <ChevronRight className="size-4 shrink-0 text-t2" />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
