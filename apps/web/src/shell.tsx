import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router";
import { BarChart3, Bell, Bookmark, Cable, Check, CircleUser, Crosshair, History, Layers, Megaphone, Radio, Search, Trophy, type LucideIcon } from "lucide-react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, ApiError, errorMessage, fetchRadar, MCP_URL, toProduct, useQuery, type Change, type Product, type Usage } from "./api";
import { MODEL_LABEL } from "./data";
import { CodeLine, CopyBlock, DAILY_LIMIT, GateModal, INSIDER_PRICE, InsiderModal, mcpPrompt, ProductIcon, useCopy, useDebounced } from "./ui";

export type FirstRun = { mcp?: boolean; blueprint?: boolean; dismissed?: boolean };
type Session = {
  status: "loading" | "in" | "out"; signedIn: boolean; userName: string | null; insider: boolean;
  signOut: () => void; checkout: () => Promise<void>; portal: () => Promise<void>; notify: (message: string) => void;
  usage: Usage | null; setUsage: (usage: Usage) => void;
  saved: Product[]; isSaved: (id: string) => boolean; toggleSave: (p: Product) => void;
  history: Product[]; visit: (p: Product) => void;
  requested: string[]; requestFull: (p: Product) => void;
  watches: Product[]; isWatching: (id: string) => boolean; toggleWatch: (p: Product) => void;
  changes: Change[]; unseen: Change[]; markSeen: () => void;
  firstRun: FirstRun; setFirstRun: (patch: FirstRun) => void;
  insiderOpen: boolean;
  openMcp: () => void; openPalette: () => void; openSignIn: () => void; openInsider: () => void;
};
const Ctx = createContext<Session | null>(null);
export const useSession = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("Session missing");
  return v;
};

/** Opens an app's page. Signed-out visitors meet the gate there, unless it's open to everyone. */
export function useOpenProduct() {
  const nav = useNavigate();
  const { pathname, search } = useLocation();
  return (slug: string, step?: number, hash = "") => {
    sessionStorage.setItem("arcex.radarBack", pathname + search);
    nav(`/app/${slug}${step ? `/${step}` : ""}${hash}`, { state: { fromRow: true } });
  };
}

function usePersisted<T>(key: string, initial: T) {
  const [v, set] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => localStorage.setItem(key, JSON.stringify(v)), [key, v]);
  return [v, set] as const;
}

function Palette({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  const nav = useNavigate();
  const s = useSession();
  const { copy } = useCopy();
  const openProduct = useOpenProduct();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim());
  const { data } = useQuery((signal) => fetchRadar({ limit: 8, ...(q ? { q } : {}) }, signal), [q], open);
  const go = (fn: () => void) => { setOpen(false); setText(""); fn(); };
  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Search Arcex" description="Search products and actions">
      <CommandInput placeholder="Search products..." value={text} onValueChange={setText} />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {!!data?.items.length && (
          <CommandGroup heading="Products">
            {data.items.map((p) => (
              <CommandItem key={p.slug} value={`${p.name} ${p.description} ${MODEL_LABEL[p.monetization]}`} onSelect={() => go(() => openProduct(p.slug))}>
                <ProductIcon p={p} size={18} />
                <span>{p.name}</span><span className="truncate text-t3">{p.description}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Actions">
          <CommandItem value="what's new changes updates" onSelect={() => go(() => nav("/updates"))}>See what's new</CommandItem>
          <CommandItem value="tracking competitors" onSelect={() => go(() => nav("/tracking"))}>Track competitors</CommandItem>
          <CommandItem value="copy mcp setup" onSelect={() => go(() => { copy(mcpPrompt()); s.setFirstRun({ mcp: true }); })}>Copy MCP setup</CommandItem>
          <CommandItem value="filter hard paywall" onSelect={() => go(() => nav("/?model=hard_trial_gate"))}>Filter: hard paywall</CommandItem>
          <CommandItem value="filter credit gate" onSelect={() => go(() => nav("/?model=credit_exhaustion"))}>Filter: credit gate</CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

const DIALOG = "rounded-2xl border-line-strong bg-s1";
const DIALOG_TITLE = "font-display text-[24px] font-semibold leading-[30px] tracking-[-0.02em]";

const CLIENT_SETUP = [
  { name: "Claude Code", text: `claude mcp add --transport http arcex ${MCP_URL}` },
  { name: "Codex", text: `codex mcp add arcex --url ${MCP_URL}` },
  { name: "Cursor", text: JSON.stringify({ mcpServers: { arcex: { url: MCP_URL } } }) },
];

/** The paste-in connection flow. Used by the MCP dialog and the MCP & API page. */
export function McpSetup({ onClose }: { onClose?: () => void }) {
  const s = useSession();
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const markDone = () => s.setFirstRun({ mcp: true });
  const createKey = async () => {
    setBusy(true);
    try {
      const created = await api<{ token: string }>("/api/v1/me/api-keys", { method: "POST", body: { name: "Agent setup" } });
      setKey(created.token);
    } catch (error) {
      s.notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
        <CopyBlock text={mcpPrompt(key ?? undefined)} label="Copy instructions" onCopy={markDone} />
        <div className="rounded-[10px] border border-line p-3">
          <div className="font-medium">Blueprints need a free key</div>
          <p className="mt-0.5 text-[13px] leading-[18px] text-t2">Search works without one. A key gives you {DAILY_LIMIT} blueprint pulls a day, and Insider is unlimited.</p>
          {key ? (
            <p role="status" className="mt-2 flex items-start gap-2 text-[13px] leading-[18px] text-t2"><Check className="mt-px size-4 shrink-0 text-arc" />Your key is in the instructions above. It's only shown this once, so copy it now and keep it private, like a password.</p>
          ) : s.signedIn ? (
            <button disabled={busy} className="btn btn-ghost mt-2 w-full disabled:opacity-60" onClick={() => void createKey()}>{busy ? "Creating key..." : "Add my key to the instructions"}</button>
          ) : (
            <button className="btn btn-ghost mt-2 w-full" onClick={() => { onClose?.(); s.openSignIn(); }}>Sign in for a free key</button>
          )}
        </div>
        <button onClick={() => setManual(!manual)} aria-expanded={manual} className="flex items-center justify-between text-left text-[13px] text-t2 hover:text-t1">Set it up manually<span>{manual ? "Hide" : "Show"}</span></button>
        {manual && (
          <div className="flex flex-col gap-2">
            {CLIENT_SETUP.map((c) => (
              <div key={c.name}>
                <div className="eyebrow mb-1">{c.name}</div>
                <CodeLine text={c.text} id={c.name} onCopy={markDone} />
              </div>
            ))}
          </div>
        )}
        <div className="eyebrow mt-1">Then ask your agent</div>
        <CodeLine text="Use Arcex to find apps with a credit gate paywall" />
    </div>
  );
}

function McpDialog({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className={`${DIALOG} sm:max-w-[480px]`}>
        <DialogTitle className={DIALOG_TITLE}>Connect your agent</DialogTitle>
        <DialogDescription className="text-t2">Nothing to install. Paste this into Claude Code, Cursor, Codex or any agent that supports MCP.</DialogDescription>
        <McpSetup onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

type RawRow = Parameters<typeof toProduct>[0];
const STARTED_AT = new Date().toISOString();

function SessionProvider({ children, openers, insiderOpen }: { children: ReactNode; insiderOpen: boolean; openers: Pick<Session, "openMcp" | "openPalette" | "openSignIn" | "openInsider"> }) {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [status, setStatus] = useState<Session["status"]>("loading");
  const [userName, setUserName] = useState<string | null>(null);
  const [insider, setInsider] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [saved, setSaved] = useState<Product[]>([]);
  const [watches, setWatches] = useState<Product[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // The API has no read route for these, so they stay on this browser.
  const [history, setHistory] = usePersisted<Product[]>("arcex.history", []);
  const [requested, setRequested] = usePersisted<string[]>("arcex.requested", []);
  const [seenAt, setSeenAt] = usePersisted<string>("arcex.changesSeenAt", STARTED_AT);
  const [firstRun, setFirstRunState] = usePersisted<FirstRun>("arcex.firstRun", {});
  const [loads, setLoads] = useState(0);

  const notify = useCallback((message: string) => setNotice(message), []);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    (async () => {
      try {
        const me = await api<{ user: { name: string } | null; insider: boolean }>("/api/v1/me", { signal });
        const [nextUsage, nextSaved, nextWatches] = await Promise.all([
          api<Usage | { unlimited: true }>("/api/v1/me/usage", { signal }),
          api<{ items: RawRow[] }>("/api/v1/me/saves?limit=100", { signal }),
          api<{ items: RawRow[] }>("/api/v1/me/watches?limit=100", { signal }),
        ]);
        if (signal.aborted) return;
        setUserName(me.user?.name ?? null);
        setInsider(me.insider);
        setUsage("used" in nextUsage ? nextUsage : null);
        setSaved(nextSaved.items.map(toProduct));
        setWatches(nextWatches.items.map(toProduct));
        setStatus("in");
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof ApiError) || error.status !== 401) notify(errorMessage(error));
        setStatus("out");
      }
    })();
    return () => controller.abort();
  }, [loads, notify]);

  useEffect(() => {
    const controller = new AbortController();
    api<{ items: Change[] }>("/api/v1/changes?limit=50", { signal: controller.signal }).then((r) => setChanges(r.items), () => {});
    return () => controller.abort();
  }, []);

  // Stripe sends people back here. The webhook may land a moment later, so reload the session.
  const checkoutResult = sp.get("checkout");
  useEffect(() => {
    if (!checkoutResult) return;
    if (checkoutResult === "success") {
      notify("Thanks. Insider turns on as soon as Stripe confirms your payment.");
      setLoads((n) => n + 1);
    }
    nav(pathname, { replace: true });
  }, [checkoutResult]); // eslint-disable-line react-hooks/exhaustive-deps

  const redirectTo = async (path: string) => {
    try {
      const { url } = await api<{ url: string }>(path, { method: "POST" });
      location.assign(url);
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const value: Session = {
    status, signedIn: status === "in", userName, insider, notify,
    signOut: () => {
      api("/auth/logout", { method: "POST" }).then(() => {
        setStatus("out");
        setUserName(null);
        setInsider(false);
        setUsage(null);
        setSaved([]);
        setWatches([]);
        setHistory([]);
      }, (error) => notify(errorMessage(error)));
    },
    checkout: () => redirectTo("/api/v1/billing/checkout"),
    portal: () => redirectTo("/api/v1/billing/portal"),
    usage, setUsage,
    saved,
    isSaved: (id) => saved.some((p) => p.id === id),
    toggleSave: (p) => {
      const on = saved.some((x) => x.id === p.id);
      setSaved(on ? saved.filter((x) => x.id !== p.id) : [p, ...saved]);
      api(`/api/v1/me/saves/${encodeURIComponent(p.id)}`, { method: on ? "DELETE" : "PUT" }).catch((error) => {
        setSaved((list) => (on ? [p, ...list] : list.filter((x) => x.id !== p.id)));
        notify(errorMessage(error));
      });
    },
    history,
    visit: (p) => setHistory((h) => (h[0]?.id === p.id ? h : [p, ...h.filter((x) => x.id !== p.id)].slice(0, 50))),
    requested,
    requestFull: (p) => {
      setRequested((r) => (r.includes(p.id) ? r : [...r, p.id]));
      api(`/api/v1/me/requests/${encodeURIComponent(p.id)}`, { method: "PUT" }).catch((error) => {
        setRequested((r) => r.filter((x) => x !== p.id));
        notify(errorMessage(error));
      });
    },
    watches,
    isWatching: (id) => watches.some((p) => p.id === id),
    toggleWatch: (p) => {
      const on = watches.some((x) => x.id === p.id);
      setWatches(on ? watches.filter((x) => x.id !== p.id) : [p, ...watches]);
      api(`/api/v1/me/watches/${encodeURIComponent(p.id)}`, { method: on ? "DELETE" : "PUT" }).catch((error) => {
        setWatches((list) => (on ? [p, ...list] : list.filter((x) => x.id !== p.id)));
        if (error instanceof ApiError && error.code === "watch_limit") openers.openInsider();
        else notify(errorMessage(error));
      });
    },
    changes,
    unseen: changes.filter((c) => c.observed_at > seenAt),
    markSeen: () => setSeenAt(new Date().toISOString()),
    insiderOpen,
    firstRun,
    setFirstRun: (patch) => setFirstRunState((f) => ({ ...f, ...patch })),
    ...openers,
  };
  return (
    <Ctx.Provider value={value}>
      {children}
      {notice && <div role="status" className="fade-in fixed bottom-5 left-1/2 z-[60] max-w-[90vw] -translate-x-1/2 rounded-xl border border-line-strong bg-s2 px-4 py-2.5 text-[13px] shadow-2xl">{notice}</div>}
    </Ctx.Provider>
  );
}

function AccountMenu() {
  const s = useSession();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button aria-label="Account menu" aria-expanded={open} className="field flex size-10 items-center justify-center" onClick={() => setOpen(!open)}><CircleUser className="size-[18px]" /></button>
      {open && (
        <div className="fade-in absolute right-0 top-12 z-50 w-56 rounded-xl border border-line-strong bg-s2 p-1 shadow-2xl" onMouseLeave={() => setOpen(false)}>
          {s.userName && <div className="truncate px-3 pt-2 font-medium">{s.userName}</div>}
          <div className="px-3 py-2 text-t2">{s.insider ? <span className="text-arc">Insider: unlimited</span> : s.usage ? <><span className="num text-t1">{Math.min(s.usage.used, s.usage.limit)} of {s.usage.limit}</span> apps today</> : null}</div>
          {s.insider
            ? <button className="w-full rounded-lg px-3 py-2 text-left hover:bg-s3" onClick={() => { void s.portal(); setOpen(false); }}>Manage billing</button>
            : <button className="w-full rounded-lg px-3 py-2 text-left hover:bg-s3" onClick={() => { s.openInsider(); setOpen(false); }}>Go Insider ({INSIDER_PRICE})</button>}
          <button className="w-full rounded-lg px-3 py-2 text-left hover:bg-s3" onClick={() => { s.signOut(); setOpen(false); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function SoonItem({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-disabled="true" className="flex h-11 cursor-default items-center gap-3 rounded-xl px-3.5 text-[15px] text-t3"><Icon className="size-[18px]" />{label}<span className="eyebrow ml-auto bg-s3 px-1.5 py-0.5 text-[9.5px] leading-[14px] text-t3 rounded">Soon</span></span>
      </TooltipTrigger>
      <TooltipContent>{label} is coming soon</TooltipContent>
    </Tooltip>
  );
}

function TopNav() {
  const s = useSession();
  const { pathname } = useLocation();
  const item = ({ isActive }: { isActive: boolean }) => `flex h-10 items-center rounded-xl px-2.5 text-[15px] font-medium transition-colors md:px-5 ${isActive ? "nav-on" : "text-t2 hover:text-t1"}`;
  return (
    <header className="sticky top-0 z-40 grid h-[68px] grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-line bg-canvas/70 px-4 backdrop-blur-xl lg:grid-cols-[1fr_auto_1fr] lg:px-6">
      <Link to="/" aria-label="Arcex home" className="flex items-center justify-self-start">
        <img src="/brand/arcex-icon.png" alt="Arcex" width={1024} height={991} className="h-8 w-auto sm:hidden" />
        <img src="/brand/arcex-logo.png" alt="Arcex" width={2000} height={770} className="hidden h-10 w-auto sm:block" />
      </Link>
      {/* The rail carries navigation where it exists; this covers phones and the app page. */}
      <nav aria-label="Main" className={`flex items-center justify-self-center ${pathname.startsWith("/app/") ? "" : "lg:invisible"}`}>
        <NavLink to="/" end className={item}>Radar</NavLink>
        <NavLink to="/market" className={item}>Market</NavLink>
        <NavLink to="/tracking" className={item}>Track</NavLink>
        <NavLink to="/updates" className={item}><span className="relative">New{s.unseen.length > 0 && <span aria-label={`${s.unseen.length} unseen changes`} className="absolute -right-2 top-0 size-1.5 rounded-full bg-arc" />}</span></NavLink>
      </nav>
      <div className="flex items-center gap-2 justify-self-end">
        <button onClick={s.openPalette} aria-label="Search" className="field hidden h-10 items-center gap-2.5 px-3 text-t2 transition-colors hover:text-t1 sm:flex lg:w-[150px]">
          <Search className="size-4" /><kbd className="hidden lg:inline">⌘K</kbd>
        </button>
        <button onClick={s.openMcp} className="hidden h-10 items-center gap-2 rounded-xl px-3 font-medium text-t1 transition-colors hover:bg-s2 md:flex"><Cable className="size-4 text-t2" />MCP</button>
        {s.status === "loading" ? <span className="size-10" /> : s.signedIn ? <AccountMenu /> : <button onClick={s.openSignIn} className="btn btn-primary h-10 px-3.5 md:px-4">Sign in</button>}
      </div>
    </header>
  );
}

function RailLink({ to, icon: Icon, label, end, badge }: { to: string; icon: LucideIcon; label: string; end?: boolean; badge?: number }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `flex h-11 items-center gap-3 rounded-xl px-3.5 text-[15px] transition-colors ${isActive ? "nav-on" : "text-t2 hover:bg-s1/70 hover:text-t1"}`}>
      <Icon className="size-[18px]" />{label}
      {!!badge && <span aria-label={`${badge} unseen`} className="num ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-arc px-1.5 text-[11px] font-semibold text-canvas">{badge}</span>}
    </NavLink>
  );
}

function Rail() {
  const s = useSession();
  return (
    <aside className="sticky top-[68px] hidden h-[calc(100dvh-68px)] w-[200px] shrink-0 flex-col border-r border-line bg-canvas/40 p-3 lg:flex 2xl:w-[232px] 2xl:p-4">
      <nav aria-label="Workspace" className="flex flex-col gap-1">
        <RailLink to="/" end icon={Radio} label="Radar" />
        <RailLink to="/market" icon={BarChart3} label="Market" />
        <RailLink to="/updates" icon={Bell} label="What's New" badge={s.unseen.length} />
        <RailLink to="/tracking" icon={Crosshair} label="Tracking" />
        <div className="my-3 h-px bg-line" />
        <SoonItem icon={Megaphone} label="Ads" />
        <SoonItem icon={Layers} label="Screens" />
        <RailLink to="/developers" icon={Cable} label="MCP & API" />
        <SoonItem icon={Trophy} label="Arena" />
        <div className="my-3 h-px bg-line" />
        <RailLink to="/saved" icon={Bookmark} label="Saved" />
        <RailLink to="/history" icon={History} label="History" />
      </nav>
      <div className="flex-1" />
      {s.signedIn && !s.insider && (
        <button onClick={s.openInsider} className="rounded-xl px-3 py-2 text-left text-[13px] text-t2 transition-colors hover:bg-s1 hover:text-t1">Go Insider <span className="text-t3">{INSIDER_PRICE}</span></button>
      )}
    </aside>
  );
}

export function Shell() {
  const [palette, setPalette] = useState(false);
  const [mcp, setMcp] = useState(false);
  const [signIn, setSignIn] = useState(false);
  const [insiderOpen, setInsiderOpen] = useState(false);
  const { pathname } = useLocation();
  const openers = useMemo(() => ({ openMcp: () => setMcp(true), openPalette: () => setPalette(true), openSignIn: () => setSignIn(true), openInsider: () => setInsiderOpen(true) }), []);
  const workspace = pathname.startsWith("/app/");

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPalette(true);
        return;
      }
      const el = e.target as HTMLElement;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || el.closest("input, textarea, [contenteditable], [role=dialog]")) return;
      e.preventDefault();
      const search = document.getElementById("radar-search");
      if (search) search.focus();
      else setPalette(true);
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  useEffect(() => {
    if (!workspace) window.scrollTo(0, 0);
  }, [pathname, workspace]);

  return (
    <SessionProvider openers={openers} insiderOpen={insiderOpen}>
      <div className="relative z-[1]">
        <TopNav />
        <div className="flex">
          {!workspace && <Rail />}
          <div className="min-w-0 flex-1"><Outlet /></div>
        </div>
      </div>
      <Palette open={palette} setOpen={setPalette} />
      <McpDialog open={mcp} setOpen={setMcp} />
      {signIn && <GateModal onClose={() => setSignIn(false)} />}
      {insiderOpen && <InsiderDialog onClose={() => setInsiderOpen(false)} />}
    </SessionProvider>
  );
}

function InsiderDialog({ onClose }: { onClose: () => void }) {
  const s = useSession();
  return <InsiderModal onSubscribe={s.checkout} onClose={onClose} />;
}
