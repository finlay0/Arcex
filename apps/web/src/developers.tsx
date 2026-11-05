import { useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { McpSetup, useSession } from "./shell";
import { API_URL, DAILY_LIMIT, PageHeading, useCopy } from "./ui";

const CARD_TITLE = "font-display text-[18px] font-semibold leading-[24px] tracking-[-0.01em]";
const EXAMPLES = [
  { label: "Search products", text: `curl "${API_URL}/api/v1/radar?q=paywall&limit=5"` },
  { label: "Get one app's details", text: `curl "${API_URL}/api/v1/vault/APP_SLUG"` },
  { label: "Export a blueprint", text: `curl "${API_URL}/api/v1/blueprints/BLUEPRINT_ID/export" \\\n  -H "Authorization: Bearer YOUR_KEY"` },
];

type Key = { id: string; name: string; secret?: string };

export function Developers() {
  const s = useSession();
  const { copied, copy } = useCopy();
  const [keys, setKeys] = useState<Key[]>([]);
  const [name, setName] = useState("");
  return (
    <main className="px-4 py-5 pb-24 lg:px-6 lg:py-6">
      <PageHeading title="MCP & API" sub="Use Arcex from your coding agent, or build on it directly." />
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <section className="panel rounded-2xl p-4">
          <h2 className={CARD_TITLE}>Connect your agent</h2>
          <p className="mb-3 mt-1 text-[13px] leading-[18px] text-t2">Nothing to install. Paste this into Claude Code, Cursor, Codex or any agent that supports MCP.</p>
          <McpSetup />
        </section>
        <div className="flex min-w-0 flex-col gap-5">
          <section className="panel rounded-2xl p-4">
            <h2 className={CARD_TITLE}>API keys</h2>
            <p className="mt-1 text-[13px] leading-[18px] text-t2">Search is open. A free key gives you {DAILY_LIMIT} blueprint exports a day{s.insider ? ", and yours is unlimited with Insider" : ""}.</p>
            {s.signedIn ? (
              <>
                <form className="mt-3 flex gap-2" onSubmit={(e) => {
                  e.preventDefault();
                  // Prototype only. The real key comes from POST /api/v1/me/api-keys and is shown once.
                  setKeys([{ id: crypto.randomUUID(), name: name.trim(), secret: "arcex_prototype_" + crypto.randomUUID().slice(0, 8) }, ...keys.map(({ id, name: n }) => ({ id, name: n }))]);
                  setName("");
                }}>
                  <input required maxLength={100} aria-label="Key name" placeholder="Key name, like My laptop" value={name} onChange={(e) => setName(e.target.value)} className="h-[38px] min-w-0 flex-1 rounded-[10px] border border-line-strong bg-canvas px-3 outline-none focus:border-teal" />
                  <button className="btn btn-primary">Create key</button>
                </form>
                <div className="mt-2 flex flex-col gap-1">
                  {keys.map((k) => (
                    <div key={k.id} className="rounded-lg bg-s2 px-3 py-2 text-[13px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{k.name}</span>
                        <button aria-label={`Revoke ${k.name}`} onClick={() => setKeys(keys.filter((x) => x.id !== k.id))} className="text-t2 hover:text-t1"><Trash2 className="size-4" /></button>
                      </div>
                      {k.secret && (
                        <button onClick={() => copy(k.secret!, k.id)} className="mt-1 flex w-full items-center justify-between gap-2 text-left">
                          <code className="truncate font-mono text-[12px] text-t2">{k.secret}</code>
                          <span className="eyebrow shrink-0">{copied === k.id ? "Copied" : "Copy"}</span>
                        </button>
                      )}
                      {k.secret && <div className="mt-1 text-[12px] text-t3">Shown once. Keep it private, like a password.</div>}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <button className="btn btn-ghost mt-3 w-full" onClick={s.openSignIn}>Sign in for a free key</button>
            )}
          </section>
          <section className="panel rounded-2xl p-4">
            <h2 className={CARD_TITLE}>API</h2>
            <p className="mt-1 text-[13px] leading-[18px] text-t2">A simple JSON API over HTTPS.</p>
            <div className="mt-3 flex flex-col gap-3">
              {EXAMPLES.map((x) => (
                <div key={x.label}>
                  <div className="eyebrow mb-1">{x.label}</div>
                  <button onClick={() => copy(x.text, x.label)} className="group flex w-full items-start justify-between gap-3 rounded-[10px] border border-line-strong bg-canvas p-3 text-left hover:bg-s2">
                    <code className="min-w-0 whitespace-pre-wrap break-all font-mono text-[12px] leading-[18px] text-t2">{x.text}</code>
                    <span className="eyebrow flex shrink-0 items-center gap-1 group-hover:text-t1">{copied === x.label ? <><Check className="size-3 text-teal" />Copied</> : "Copy"}</span>
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
