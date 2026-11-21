import { useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, errorMessage, fetchProviders, signInUrl, useQuery } from "./api";

type Profile = { user: { name: string; handle: string }; insider: boolean };
type Device = { id: string; created_at: string; expires_at: string };
type Customer = {
  id: string; name: string; handle: string; email: string | null; created_at: string;
  pro: number; subscription_status: string | null; billing_hold: number;
  web_sessions: number; desktop_sessions: number;
};
const base = "/api/v1/accounts";
const date = (value: string) => new Date(value).toLocaleDateString();
const input = "min-w-0 rounded-lg border border-line-strong bg-s1 px-3 py-2 text-t1";
const pageSize = 30;

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-5 px-5 py-12 text-t1">
      <a href="/" className="self-start text-sm text-t2 hover:text-t1">Arcex</a>
      <h1 className="font-display text-3xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

function SignIn({ owner = false }: { owner?: boolean }) {
  const providers = useQuery(() => fetchProviders(), []);
  const available = providers.data?.filter((name) => owner ? name === "github" : name === "google" || name === "github");
  return (
    <div className="flex flex-wrap items-center gap-3">
      {available?.map((name) => <a key={name} className="btn btn-primary" href={signInUrl(name)}>Continue with {name === "google" ? "Google" : "GitHub"}</a>)}
      <p role="status" className="text-t2">{providers.loading ? "Checking sign-in options…" : available?.length ? "" : "Sign-in is unavailable right now."}</p>
    </div>
  );
}

export function DesktopLinkPage() {
  const profile = useQuery((signal) => api<Profile>("/api/v1/me", { signal }), []);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const cleanCode = code.replace(/[\s-]/g, "").toUpperCase();

  const approve = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(base + "/desktop/approve", { method: "POST", body: { code: cleanCode } });
      setDone(true);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame title="Connect Arcex desktop">
      {profile.loading && <p role="status">Checking your account…</p>}
      {profile.error instanceof ApiError && profile.error.status === 401 ? <SignIn /> :
        !!profile.error && <p role="alert">{errorMessage(profile.error)} <button className="btn btn-ghost" onClick={profile.reload}>Retry</button></p>}
      {done ? <p role="status">Device approved. Return to the Arcex desktop app.</p> : profile.data && (
        <form className="flex max-w-lg flex-col gap-4" onSubmit={(event) => void approve(event)}>
          <p>Signed in as <b>{profile.data.user.name}</b>. Enter the code displayed by the Arcex desktop app on your computer.</p>
          <label className="grid gap-2">Device code
            <input className={input + " font-mono"} value={code} maxLength={15} autoComplete="off" spellCheck={false}
              onChange={(event) => setCode(event.target.value)} placeholder="00000-00000" required />
          </label>
          <button className="btn btn-primary self-start" disabled={busy || !/^[0-9A-F]{10}$/.test(cleanCode)}>{busy ? "Approving…" : "Approve this device"}</button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </Frame>
  );
}

export function DevicesPage() {
  const [offset, setOffset] = useState(0);
  const devices = useQuery((signal) => api<{ items: Device[] }>(base + "/devices?limit=" + pageSize + "&offset=" + offset, { signal }), [offset]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revoke = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await api(base + "/devices/" + encodeURIComponent(id), { method: "DELETE" });
      setSelected(null);
      devices.reload();
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Connected desktop devices">
      {devices.loading && <p role="status">Loading devices…</p>}
      {devices.error instanceof ApiError && devices.error.status === 401 ? <SignIn /> :
        !!devices.error && <p role="alert">{errorMessage(devices.error)} <button className="btn btn-ghost" onClick={devices.reload}>Retry</button></p>}
      {error && <p role="alert">{error}</p>}
      {!devices.loading && devices.data?.items.length === 0 && <p>No active desktop sessions.</p>}
      {devices.data && !devices.error && <ul className="divide-y divide-line-strong">
        {devices.data.items.map((item) => (
          <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={item.id}>
            <span className="text-sm">Connected {date(item.created_at)} · Expires {date(item.expires_at)} · {item.id.slice(0, 8)}</span>
            {selected === item.id ? <div className="flex gap-2">
              <button className="btn btn-ghost" disabled={busy} onClick={() => setSelected(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void revoke(item.id)}>Confirm sign out</button>
            </div> : <button className="btn btn-ghost" disabled={busy} onClick={() => setSelected(item.id)}>Sign out device</button>}
          </li>
        ))}
      </ul>}
      {devices.data && !devices.error && <Pager offset={offset} more={devices.data.items.length === pageSize} busy={devices.loading} go={setOffset} />}
    </Frame>
  );
}

function Pager({ offset, more, busy, go }: { offset: number; more: boolean; busy: boolean; go(value: number): void }) {
  if (!offset && !more) return null;
  return (
    <nav className="flex gap-2" aria-label="Pages">
      <button className="btn btn-ghost" disabled={busy || offset === 0} onClick={() => go(offset - pageSize)}>Previous</button>
      <button className="btn btn-ghost" disabled={busy || !more || offset + pageSize > 10000} onClick={() => go(offset + pageSize)}>Next</button>
    </nav>
  );
}

export function CustomersPage() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState({ query: "", offset: 0 });
  const [selected, setSelected] = useState<Customer | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const result = useQuery((signal) => api<{ items: Customer[]; more: boolean }>(
    base + "/owner/customers/search",
    { method: "POST", body: { query: filter.query, offset: filter.offset, limit: pageSize }, signal },
  ), [filter]);
  const login = result.error instanceof ApiError && [401, 403].includes(result.error.status);

  const revoke = async (customer: Customer) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(base + "/owner/customers/" + encodeURIComponent(customer.id) + "/revoke-sessions", { method: "POST" });
      setNotice("Web and desktop sessions revoked for " + customer.name + ".");
      setSelected(null);
      result.reload();
    } catch (problem) {
      setError(errorMessage(problem));
      result.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame title="Customers">
      {login && <><p>Sign in with the owner's GitHub account.</p><SignIn owner /></>}
      {!!result.error && !login && <p role="alert">{errorMessage(result.error)} <button className="btn btn-ghost" onClick={result.reload}>Retry</button></p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {result.loading && <p role="status">Loading customers…</p>}
      {result.data && !result.error && <>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
          event.preventDefault();
          setFilter({ query: search.trim(), offset: 0 });
          setSelected(null);
        }}>
          <label className="grid gap-2">Search by name, handle, or email
            <input className={input} value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <button className="btn btn-ghost">Search</button>
        </form>
        {!result.loading && !result.data.items.length && <p>No matching customers.</p>}
        {result.data.items.length > 0 && <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b border-line-strong"><th className="p-3">Customer</th><th className="p-3">Access</th><th className="p-3">Active sessions</th><th className="p-3">Actions</th></tr></thead>
            <tbody>
              {result.data.items.map((customer) => (
                <tr key={customer.id} className="border-b border-line-strong">
                  <td className="p-3"><b>{customer.name}</b><div className="text-t2">{customer.email ?? customer.handle} · Joined {date(customer.created_at)}</div></td>
                  <td className="p-3">{customer.pro ? "Pro" : "Free"}{customer.billing_hold ? " · Billing hold" : ""}</td>
                  <td className="p-3">{customer.web_sessions} web · {customer.desktop_sessions} desktop</td>
                  <td className="p-3">
                    {selected?.id === customer.id ? <div className="flex gap-2">
                      <button className="btn btn-ghost" disabled={busy} onClick={() => setSelected(null)}>Cancel</button>
                      <button className="btn btn-primary" disabled={busy} onClick={() => void revoke(customer)}>Confirm sign out</button>
                    </div> : <button className="btn btn-ghost" disabled={busy || result.loading} onClick={() => setSelected(customer)}>Revoke sessions</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
        <Pager offset={filter.offset} more={result.data.more} busy={result.loading} go={(offset) => {
          setSelected(null);
          setFilter({ ...filter, offset });
        }} />
      </>}
    </Frame>
  );
}
