import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Bell, Bookmark, Cable, Check, ChartNoAxesColumn, CircleUser, Crosshair, HardDrive, History, Layers, Megaphone, Radio, Search, Trophy, type LucideIcon } from "lucide-react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CHANGES, MODEL_LABEL, products, type Change, type Product } from "./data";
import { CodeLine, CopyBlock, DAILY_LIMIT, FREE_WATCHES, GateModal, INSIDER_PRICE, InsiderModal, MCP_URL, mcpPrompt, ProductIcon, useCopy } from "./ui";

export type FirstRun = { mcp?: boolean; blueprint?: boolean; dismissed?: boolean };
type Session = {
  signedIn: boolean; signIn: (via: string) => void; signOut: () => void; via: string | null;
  unlocked: string[]; unlock: (slug: string) => boolean; resetLimit: () => void; fillLimit: () => void;
  saved: string[]; toggleSave: (slug: string) => void;
  history: string[]; visit: (slug: string) => void;
  requested: string[]; requestFull: (slug: string) => void;
  watching: string[]; toggleWatch: (slug: string) => void;
  mine: string[]; addMine: (url: string) => void; removeMine: (url: string) => void;
  alerts: boolean; setAlerts: (on: boolean) => void;
  unseen: Change[]; markSeen: () => void;
  firstRun: FirstRun; setFirstRun: (patch: FirstRun) => void;
  insider: boolean; subscribe: () => void; cancelInsider: () => void; insiderOpen: boolean;
  openMcp: () => void; openRequest: () => void; openPalette: () => void; openSignIn: () => void; openInsider: () => void;
};
const Ctx = createContext<Session | null>(null);
export const useSession = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("Session missing");
  return v;
};

/** Opens an app's page. Signed-out visitors meet the gate there, unless it's the open sample. */
export function useOpenProduct() {
  const nav = useNavigate();
  const { pathname, search } = useLocation();
  return (p: Product, step?: number, hash = "") => {
    sessionStorage.setItem("arcex.radarBack", pathname + search);
    nav(`/app/${p.slug}${step ? `/${step}` : ""}${hash}`, { state: { fromRow: true } });
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
  const go = (fn: () => void) => { setOpen(false); fn(); };
  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Search Arcex" description="Search products, patterns and actions">
      <CommandInput placeholder="Search products, paywalls, patterns..." />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        <CommandGroup heading="Products">
          {products.map((p) => (
            <CommandItem key={p.slug} value={`${p.name} ${p.tagline} ${MODEL_LABEL[p.model]}`} onSelect={() => go(() => openProduct(p))}>
              <ProductIcon p={p} size={18} />
              <span>{p.name}</span><span className="truncate text-t3">{p.tagline}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Actions">
          <CommandItem value="what's new changes updates" onSelect={() => go(() => nav("/updates"))}>See what's new</CommandItem>
          <CommandItem value="all paywall screens" onSelect={() => go(() => nav("/screens"))}>Browse all paywalls</CommandItem>
          <CommandItem value="ads library" onSelect={() => go(() => nav("/ads"))}>Browse all ads</CommandItem>
          <CommandItem value="tracking competitors" onSelect={() => go(() => nav("/tracking"))}>Track competitors</CommandItem>
          <CommandItem value="copy mcp setup" onSelect={() => go(() => { copy(mcpPrompt()); s.setFirstRun({ mcp: true }); })}>Copy MCP setup</CommandItem>
          <CommandItem value="request a product" onSelect={() => go(s.openRequest)}>Request a product</CommandItem>
          <CommandItem value="filter hard paywall" onSelect={() => go(() => nav("/?model=hard"))}>Filter: hard paywall</CommandItem>
          <CommandItem value="filter credit gate" onSelect={() => go(() => nav("/?model=credit"))}>Filter: credit gate</CommandItem>
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
  // Prototype only. The real key comes from POST /api/v1/me/api-keys and is shown once.
  const [key, setKey] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const markDone = () => s.setFirstRun({ mcp: true });
  return (
    <div className="flex flex-col gap-3">
        <CopyBlock text={mcpPrompt(key ?? undefined)} label="Copy instructions" onCopy={markDone} />
        <div className="rounded-[10px] border border-line p-3">
          <div className="font-medium">Blueprints need a free key</div>
          <p className="mt-0.5 text-[13px] leading-[18px] text-t2">Search works without one. A key gives you {DAILY_LIMIT} blueprint pulls a day, and Insider is unlimited.</p>
          {key ? (
            <p role="status" className="mt-2 flex items-start gap-2 text-[13px] leading-[18px] text-t2"><Check className="mt-px size-4 shrink-0 text-teal" />Your key is in the instructions above. Keep it private, like a password.</p>
          ) : s.signedIn ? (
            <button className="btn btn-ghost mt-2 w-full" onClick={() => setKey("arcex_prototype_" + crypto.randomUUID().slice(0, 8))}>Add my key to the instructions</button>
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

function RequestDialog({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  const [sent, setSent] = useState(false);
  const change = (o: boolean) => { setOpen(o); if (!o) setSent(false); };
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className={`${DIALOG} sm:max-w-[440px]`}>
        <DialogTitle className={DIALOG_TITLE}>{sent ? "It's in the queue" : "Request a product"}</DialogTitle>
        <DialogDescription className="text-t2">{sent ? "We pick from this list live on stream." : "Paste any AI product you want us to break down."}</DialogDescription>
        {sent ? <button className="btn btn-ghost" onClick={() => change(false)}>Done</button> : (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); setSent(true); }}>
            <input required type="url" aria-label="Product URL" placeholder="https://" className="h-11 rounded-xl border border-line-strong bg-canvas px-3 outline-none focus:border-teal" />
            <label className="flex items-center gap-2 text-t2"><input type="checkbox" className="accent-teal" /> It's my product</label>
            <button className="btn btn-primary h-11">Add to queue</button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SessionProvider({ children, openers, insiderOpen }: { children: ReactNode; insiderOpen: boolean; openers: Pick<Session, "openMcp" | "openRequest" | "openPalette" | "openSignIn" | "openInsider"> }) {
  const [via, setVia] = usePersisted<string | null>("arcex.via", null);
  const [unlocked, setUnlocked] = usePersisted<string[]>("arcex.unlocked", []);
  const [saved, setSaved] = usePersisted<string[]>("arcex.saved", []);
  const [history, setHistory] = usePersisted<string[]>("arcex.history", []);
  const [insider, setInsider] = usePersisted<boolean>("arcex.insider", false);
  const [requested, setRequested] = usePersisted<string[]>("arcex.requested", []);
  const [watching, setWatching] = usePersisted<string[]>("arcex.watching", []);
  const [mine, setMine] = usePersisted<string[]>("arcex.mine", []);
  const [alerts, setAlerts] = usePersisted<boolean>("arcex.alerts", false);
  const [seen, setSeen] = usePersisted<string[]>("arcex.seenChanges", CHANGES.filter((c) => c.daysAgo > 1).map((c) => c.id));
  const [firstRun, setFirstRunState] = usePersisted<FirstRun>("arcex.firstRun", {});
  const value = useMemo<Session>(() => ({
    via, signedIn: !!via,
    signIn: setVia,
    signOut: () => setVia(null),
    unlocked,
    unlock: (slug) => {
      if (insider || unlocked.includes(slug)) return true;
      if (unlocked.length >= DAILY_LIMIT) return false;
      setUnlocked([...unlocked, slug]);
      return true;
    },
    resetLimit: () => setUnlocked([]),
    fillLimit: () => setUnlocked(Array.from({ length: DAILY_LIMIT }, (_, i) => `used-${i}`)),
    saved,
    toggleSave: (slug) => setSaved(saved.includes(slug) ? saved.filter((s) => s !== slug) : [...saved, slug]),
    history,
    visit: (slug) => setHistory((h) => (h[0] === slug ? h : [slug, ...h.filter((x) => x !== slug)].slice(0, 50))),
    unseen: CHANGES.filter((c) => !seen.includes(c.id)),
    markSeen: () => setSeen(CHANGES.map((c) => c.id)),
    requested,
    requestFull: (slug) => setRequested((r) => (r.includes(slug) ? r : [...r, slug])),
    watching,
    toggleWatch: (slug) => {
      if (watching.includes(slug)) setWatching(watching.filter((x) => x !== slug));
      else if (!insider && watching.length >= FREE_WATCHES) openers.openInsider();
      else setWatching([...watching, slug]);
    },
    mine,
    addMine: (url) => setMine(mine.includes(url) ? mine : [...mine, url]),
    removeMine: (url) => setMine(mine.filter((x) => x !== url)),
    alerts,
    setAlerts,
    insider,
    subscribe: () => setInsider(true),
    cancelInsider: () => setInsider(false),
    insiderOpen,
    firstRun,
    setFirstRun: (patch) => setFirstRunState((f) => ({ ...f, ...patch })),
    ...openers,
  }), [via, unlocked, saved, history, seen, firstRun, insider, insiderOpen, requested, watching, mine, alerts, openers, setVia, setUnlocked, setSaved, setHistory, setSeen, setFirstRunState, setInsider, setRequested, setWatching, setMine, setAlerts]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function AccountMenu() {
  const s = useSession();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button aria-label="Account menu" aria-expanded={open} className="flex size-10 items-center justify-center rounded-xl border border-line-strong hover:bg-s2" onClick={() => setOpen(!open)}><CircleUser className="size-[18px]" /></button>
      {open && (
        <div className="fade-in absolute right-0 top-12 z-50 w-56 rounded-xl border border-line-strong bg-s2 p-1 shadow-2xl" onMouseLeave={() => setOpen(false)}>
          <div className="px-3 py-2 text-t2">{s.insider ? <span className="text-teal">Insider: unlimited</span> : <><span className="num text-t1">{Math.min(s.unlocked.length, DAILY_LIMIT)} of {DAILY_LIMIT}</span> apps today</>}</div>
          {!s.insider && <button className="w-full rounded-lg px-3 py-2 text-left hover:bg-s3" onClick={() => { s.openInsider(); setOpen(false); }}>Go Insider ({INSIDER_PRICE})</button>}
          <button className="w-full rounded-lg px-3 py-2 text-left hover:bg-s3" onClick={() => { s.openRequest(); setOpen(false); }}>Request a product</button>
          <button className="w-full rounded-lg px-3 py-2 text-left hover:bg-s3" onClick={() => { s.signOut(); setOpen(false); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function SoonBadge() {
  return <span className="rounded-md bg-s3 px-1.5 py-0.5 text-[12px] leading-[16px] text-t2">Soon</span>;
}

function Soon({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>Arena is coming soon</TooltipContent>
    </Tooltip>
  );
}

function TopNav() {
  const s = useSession();
  const { pathname } = useLocation();
  const item = ({ isActive }: { isActive: boolean }) => `flex h-10 items-center rounded-xl px-2.5 text-[15px] font-medium transition-colors md:px-5 ${isActive ? "bg-s3 text-t1" : "text-t2 hover:text-t1"}`;
  return (
    <header className="sticky top-0 z-40 grid h-[68px] grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-line bg-canvas px-4 lg:grid-cols-[1fr_auto_1fr] lg:px-6">
      <Link to="/" aria-label="Arcex home" className="flex w-[46px] items-center justify-self-start overflow-hidden sm:w-auto">
        <img src="/brand/arcex-logo.webp" alt="Arcex" width={172} height={48} className="h-9 w-auto max-w-none md:h-12" />
      </Link>
      {/* The rail carries navigation where it exists; this covers phones and the app page. */}
      <nav aria-label="Main" className={`flex items-center justify-self-center ${pathname.startsWith("/app/") ? "" : "lg:invisible"}`}>
        <NavLink to="/" end className={item}>Radar</NavLink>
        <NavLink to="/tracking" className={item}>Track</NavLink>
        <NavLink to="/updates" className={item}><span className="relative">New{s.unseen.length > 0 && <span aria-label={`${s.unseen.length} unseen changes`} className="absolute -right-2 top-0 size-1.5 rounded-full bg-teal" />}</span></NavLink>
      </nav>
      <div className="flex items-center gap-2 justify-self-end">
        <button onClick={s.openPalette} aria-label="Search" className="hidden h-10 items-center gap-2.5 rounded-xl border border-line-strong px-3 text-t2 transition-colors hover:bg-s2 hover:text-t1 sm:flex lg:w-[150px]">
          <Search className="size-4" /><kbd className="hidden lg:inline">⌘K</kbd>
        </button>
        <button onClick={s.openMcp} className="hidden h-10 items-center gap-2 rounded-xl px-3 font-medium text-t1 transition-colors hover:bg-s2 md:flex"><Cable className="size-4 text-t2" />MCP</button>
        {s.signedIn ? <AccountMenu /> : <button onClick={s.openSignIn} className="h-10 rounded-xl border border-line-strong px-3.5 font-medium transition-colors hover:bg-s2 md:px-4">Sign in</button>}
      </div>
    </header>
  );
}

function RailLink({ to, icon: Icon, label, end, badge }: { to: string; icon: LucideIcon; label: string; end?: boolean; badge?: number }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `flex h-11 items-center gap-3 rounded-xl px-3.5 text-[15px] transition-colors ${isActive ? "bg-s2 text-t1" : "text-t2 hover:bg-s1 hover:text-t1"}`}>
      <Icon className="size-[18px]" />{label}
      {!!badge && <span aria-label={`${badge} unseen`} className="num ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-teal px-1.5 text-[11px] font-semibold text-black">{badge}</span>}
    </NavLink>
  );
}

function PrototypeMenu() {
  const s = useSession();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative mb-2">
      {open && (
        <div className="fade-in absolute bottom-full left-0 mb-1 flex w-full flex-col rounded-xl border border-line-strong bg-s2 p-1 text-[12px] shadow-xl">
          <button className="rounded-lg px-2 py-1.5 text-left hover:bg-s3" onClick={() => (s.signedIn ? s.signOut() : s.signIn("X"))}>{s.signedIn ? "Sign out" : "Sign in instantly"}</button>
          <button className="rounded-lg px-2 py-1.5 text-left hover:bg-s3" onClick={s.fillLimit}>Use up daily limit</button>
          <button className="rounded-lg px-2 py-1.5 text-left hover:bg-s3" onClick={s.resetLimit}>Reset daily limit</button>
          {s.insider && <button className="rounded-lg px-2 py-1.5 text-left hover:bg-s3" onClick={s.cancelInsider}>Cancel Insider</button>}
        </div>
      )}
      <button onClick={() => setOpen(!open)} className="w-full rounded-lg px-2 py-1 text-left text-[11px] text-t3 hover:text-t2">Prototype · sample data</button>
    </div>
  );
}

function Rail() {
  const s = useSession();
  return (
    <aside className="sticky top-[68px] hidden h-[calc(100dvh-68px)] w-[200px] shrink-0 flex-col border-r border-line p-3 lg:flex 2xl:w-[232px] 2xl:p-4">
      <nav aria-label="Workspace" className="flex flex-col gap-1">
        <RailLink to="/" end icon={Radio} label="Radar" />
        <RailLink to="/updates" icon={Bell} label="What's New" badge={s.unseen.length} />
        <RailLink to="/tracking" icon={Crosshair} label="Tracking" />
        <div className="my-3 h-px bg-line" />
        <RailLink to="/ads" icon={Megaphone} label="Ads" />
        <RailLink to="/screens" icon={Layers} label="Screens" />
        <RailLink to="/developers" icon={Cable} label="MCP & API" />
        <Soon>
          <span tabIndex={0} aria-disabled="true" className="flex h-11 cursor-default items-center gap-3 rounded-xl px-3.5 text-[15px] text-t3"><Trophy className="size-[18px]" />Arena<span className="ml-auto"><SoonBadge /></span></span>
        </Soon>
        <div className="my-3 h-px bg-line" />
        <RailLink to="/saved" icon={Bookmark} label="Saved" />
        <RailLink to="/history" icon={History} label="History" />
      </nav>
      <div className="flex-1" />
      <PrototypeMenu />
      {s.signedIn && !s.insider && (
        <button onClick={s.openInsider} className="mb-2 rounded-xl px-3 py-2 text-left text-[13px] text-t2 transition-colors hover:bg-s1 hover:text-t1">Go Insider <span className="text-t3">{INSIDER_PRICE}</span></button>
      )}
      <div className="panel flex items-center justify-between rounded-xl p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><span className="live-dot" />Live scan</div>
          <div className="mt-1 flex items-center gap-2 whitespace-nowrap text-[12px] text-t2"><HardDrive className="size-3" />Updated 3m ago</div>
        </div>
        <ChartNoAxesColumn className="size-5 shrink-0 text-t3" />
      </div>
    </aside>
  );
}

export function Shell() {
  const [palette, setPalette] = useState(false);
  const [mcp, setMcp] = useState(false);
  const [request, setRequest] = useState(false);
  const [signIn, setSignIn] = useState(false);
  const [insiderOpen, setInsiderOpen] = useState(false);
  const { pathname } = useLocation();
  const openers = useMemo(() => ({ openMcp: () => setMcp(true), openRequest: () => setRequest(true), openPalette: () => setPalette(true), openSignIn: () => setSignIn(true), openInsider: () => setInsiderOpen(true) }), []);
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
      <TopNav />
      <div className="flex">
        {!workspace && <Rail />}
        <div className="min-w-0 flex-1"><Outlet /></div>
      </div>
      <Palette open={palette} setOpen={setPalette} />
      <McpDialog open={mcp} setOpen={setMcp} />
      <RequestDialog open={request} setOpen={setRequest} />
      {signIn && <SignInGate onClose={() => setSignIn(false)} />}
      {insiderOpen && <InsiderDialog onClose={() => setInsiderOpen(false)} />}
    </SessionProvider>
  );
}

function InsiderDialog({ onClose }: { onClose: () => void }) {
  const s = useSession();
  return <InsiderModal onSubscribe={() => { s.subscribe(); onClose(); }} onClose={onClose} />;
}

function SignInGate({ onClose }: { onClose: () => void }) {
  const s = useSession();
  return <GateModal onSignIn={(via) => { s.signIn(via); onClose(); }} onClose={onClose} />;
}
