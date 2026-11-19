import { useEffect, useMemo, useState } from "react";
import type { Tool } from "@arcex/contracts";
import { Icon } from "./shared.tsx";
import { call } from "./store.ts";

/** The curated toolbox: what each tool is for, what you give up, and a way to have an agent set it up. */
export function ToolboxView({ use, fail }: { use(tool: Tool): void; fail(error: unknown): void }) {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");

  useEffect(() => {
    call("toolbox.list", {}).then(setTools).catch(fail);
  }, []);

  const categories = useMemo(() => ["All", ...new Set((tools ?? []).map((tool) => tool.category))], [tools]);
  const needle = query.trim().toLowerCase();
  const shown = (tools ?? []).filter(
    (tool) => (category === "All" || tool.category === category) && (!needle || Object.values(tool).join(" ").toLowerCase().includes(needle)),
  );

  return (
    <div className="sbody">
      <div className="tcol">
        <h2>Toolbox</h2>
        <p className="sdesc">
          A short list of tools worth knowing, with what each one costs you in trade-offs. Your agents can search this list too, so you can simply ask for
          "payments" or "a database" in any thread.
        </p>
        <div className="tbar">
          <div className="pick" role="group" aria-label="Category">
            {categories.map((name) => (
              <button key={name} aria-pressed={category === name} onClick={() => setCategory(name)}>
                {name}
              </button>
            ))}
          </div>
          <label className="field tfind">
            <Icon name="search" />
            <input value={query} placeholder="Search tools" aria-label="Search tools" onChange={(event) => setQuery(event.target.value)} />
          </label>
        </div>
        {!tools && <p className="muted">Loading…</p>}
        {tools && shown.length === 0 && <p className="muted">Nothing matches. Try another word or category.</p>}
        <div className="tgrid">
          {shown.map((tool) => (
            <article key={tool.id} className="card tool">
              <header>
                <b>{tool.name}</b>
                <span className="tag">{tool.category}</span>
              </header>
              <p>{tool.what}</p>
              <dl>
                <dt>Good for</dt>
                <dd>{tool.goodFor}</dd>
                <dt>Trade-off</dt>
                <dd>{tool.tradeoffs}</dd>
              </dl>
              <footer>
                <span className="mono trunc" title={tool.url}>{tool.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
                <button className="btn" onClick={() => use(tool)}>
                  Draft a request
                </button>
              </footer>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
