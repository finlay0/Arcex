import { useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { api, errorMessage, PUBLIC_API, useQuery } from "./api";
import { McpSetup, useSession } from "./shell";
import { DAILY_LIMIT, PageHeading, useCopy } from "./ui";

const CARD_TITLE = "font-display text-[18px] font-semibold leading-[24px] tracking-[-0.01em]";
const EXAMPLES = [
  { label: "Search products", text: `curl "${PUBLIC_API}/api/v1/radar?q=paywall&limit=5"` },
  { label: "Get one app's details", text: `curl "${PUBLIC_API}/api/v1/vault/APP_SLUG"` },
  { label: "Export a blueprint", text: `curl "${PUBLIC_API}/api/v1/blueprints/BLUEPRINT_ID/export" \\\n  -H "Authorization: Bearer YOUR_KEY"` },
];

type Key = { id: string; name: string; revoked_at: string | null };

function ApiKeys() {
  const s = useSession();
  const { copied, copy } = useCopy();
  const [name, setName] = useState("");
  // A new key is only ever returned once, so it lives here and nowhere else.
  const [secret, setSecret] = useState<{ id: string; token: string } | null>(null);
  const keys = useQuery((signal) => api<{ items: Key[] }>("/api/v1/me/api-keys", { signal }), []);
  const create = async () => {
    try {
      const created = await api<{ id: string; token: string }>("/api/v1/me/api-keys", { method: "POST", body: { name: name.trim() } });
      setSecret(created);
      setName("");
      keys.reload();
    } catch (error) {
      s.notify(errorMessage(error));
    }
  };
  const revoke = (id: string) => api(`/api/v1/me/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => {
    if (secret?.id === id) setSecret(null);
    keys.reload();
  }, (error) => s.notify(errorMessage(error)));
  return (
    <>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input required maxLength={100} aria-label="Key name" placeholder="Key name, like My laptop" value={name} onChange={(e) => setName(e.target.value)} className="h-[38px] min-w-0 flex-1 rounded-[10px] border border-line-strong bg-canvas px-3 outline-none focus:border-teal" />
        <button className="btn btn-primary">Create key</button>
      </form>
      {keys.error ? <p className="mt-2 text-[13px] text-t2">{errorMessage(keys.error)}</p> : null}
      <div className="mt-2 flex flex-col gap-1">
        {keys.data?.items.filter((k) => !k.revoked_at).map((k) => (
          <div key={k.id} className="rounded-lg bg-s2 px-3 py-2 text-[13px]">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{k.name}</span>
              <button aria-label={`Revoke ${k.name}`} onClick={() => void revoke(k.id)} className="text-t2 hover:text-t1"><Trash2 className="size-4" /></button>
            </div>
            {secret?.id === k.id && (
              <>
                <button onClick={() => copy(secret.token, k.id)} className="mt-1 flex w-full items-center justify-between gap-2 text-left">
                  <code className="truncate font-mono text-[12px] text-t2">{secret.token}</code>
                  <span className="eyebrow shrink-0">{copied === k.id ? "Copied" : "Copy"}</span>
                </button>
                <div className="mt-1 text-[12px] text-t3">Shown once. Keep it private, like a password.</div>
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export function Developers() {
  const s = useSession();
  const { copied, copy } = useCopy();
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
            {s.signedIn ? <ApiKeys /> : s.status === "out" && <button className="btn btn-ghost mt-3 w-full" onClick={s.openSignIn}>Sign in for a free key</button>}
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
