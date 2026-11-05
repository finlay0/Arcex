import { useEffect, useState, type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { fetchProviders, MCP_URL, signInUrl, type Usage } from "./api";
import { DASH } from "./data";

export const DAILY_LIMIT = 10;
export const FREE_WATCHES = 3;
export const INSIDER_PRICE = "$12/mo";
/** Paste into any agent. It adds the server the way that agent normally does. */
export const mcpPrompt = (key?: string) =>
  `Connect the Arcex MCP server to this agent. It's a remote HTTP (Streamable HTTP) MCP server named "arcex" at ${MCP_URL}${key ? `. Send the header "Authorization: Bearer ${key}" with every request` : ""}. Add it the normal way for this agent, then tell me if I need to restart.`;

export function useMedia(query: string) {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const f = () => setOn(m.matches);
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return on;
}

export function useDebounced<T>(value: T, ms = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  return {
    copied,
    copy: (text: string, id = text) => {
      void navigator.clipboard?.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied(null), 2000);
    },
  };
}

export function CodeLine({ text, id, onCopy }: { text: string; id?: string; onCopy?: () => void }) {
  const { copied, copy } = useCopy();
  return (
    <button onClick={() => { copy(text, id); onCopy?.(); }} className="group flex w-full items-center justify-between gap-3 rounded-[10px] border border-line-strong bg-canvas px-3 py-2.5 text-left hover:bg-s2">
      <code className="min-w-0 truncate font-mono text-[13px]"><span className="text-teal">$ </span>{text}</code>
      <span className="eyebrow shrink-0 group-hover:text-t1">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function CopyBlock({ text, label = "Copy", onCopy }: { text: string; label?: string; onCopy?: () => void }) {
  const { copied, copy } = useCopy();
  return (
    <div className="rounded-[10px] border border-line-strong bg-canvas p-3">
      <p className="break-words font-mono text-[12px] leading-[18px] text-t2">{text}</p>
      <button onClick={() => { copy(text, "block"); onCopy?.(); }} className="btn btn-primary mt-3 w-full">{copied ? <><Check className="size-4" />Copied. Paste it into your agent</> : label}</button>
    </div>
  );
}

export function Confidence({ level }: { level: number }) {
  return (
    <span className="inline-flex gap-[3px]" role="img" aria-label={`Confidence ${level} of 4`} title={`Confidence: ${level} of 4`}>
      {[1, 2, 3, 4].map((i) => <span key={i} className={`size-[5px] rounded-full ${i <= level ? "bg-teal" : "bg-s3"}`} />)}
    </span>
  );
}

/** Weeks with no collection stay as gaps instead of dropping to zero. */
export function Sparkline({ data }: { data: (number | null)[] }) {
  const known = data.filter((d): d is number => d !== null);
  if (known.length < 2) return <span aria-hidden className="block h-[18px] w-14" />;
  const max = Math.max(...known), min = Math.min(...known);
  const range = max - min || 1;
  const runs: [number, number][][] = [[]];
  data.forEach((d, i) => {
    if (d === null) runs.push([]);
    else runs[runs.length - 1].push([(i / (data.length - 1)) * 54 + 1, 17 - ((d - min) / range) * 16]);
  });
  const color = known[known.length - 1] >= known[0] ? "var(--color-teal)" : "var(--color-t3)";
  return (
    <svg width="56" height="18" viewBox="0 0 56 18" aria-hidden>
      {runs.map((run, i) => run.length === 1
        ? <circle key={i} cx={run[0][0]} cy={run[0][1]} r="1" fill={color} />
        : run.length > 1 && <polyline key={i} points={run.map((p) => p.join(",")).join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />)}
    </svg>
  );
}

/** Change in observed ads and creators. Not product or business growth. */
export function GrowthValue({ value }: { value: number | null }) {
  if (value === null) return <span title="Not enough comparable scans yet" className="num text-[13px] text-t3">{DASH}</span>;
  return <span className={`num text-[13px] font-medium ${value > 0 ? "text-teal" : value < 0 ? "text-t3" : "text-t2"}`}>{value > 0 ? "+" : ""}{value}%</span>;
}

const iconHue = (name: string) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export function ProductIcon({ p, size = 36 }: { p: { name: string }; size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center font-bold text-white" style={{ width: size, height: size, borderRadius: size * 0.24, background: `hsl(${iconHue(p.name)} 42% 34%)`, fontSize: size * 0.5 }}>
      {p.name[0]?.toUpperCase()}
    </span>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden className={className}><path fill="#4285F4" d="M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8Z" /><path fill="#34A853" d="M12 23c3 0 5.4-1 7.2-2.7l-3.5-2.7c-1 .7-2.2 1-3.7 1-2.9 0-5.3-1.9-6.2-4.5H2.2v2.8A11 11 0 0 0 12 23Z" /><path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.2a11 11 0 0 0 0 9.8l3.6-2.8Z" /><path fill="#EA4335" d="M12 5.4c1.6 0 3 .6 4.2 1.6l3.1-3.1A11 11 0 0 0 2.2 7.1l3.6 2.8C6.7 7.3 9.1 5.4 12 5.4Z" /></svg>;
}

export function VideoCountIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 16 16" aria-hidden className={className}><rect x="1" y="3" width="14" height="10" rx="3" fill="currentColor" /><path d="M6.5 5.8v4.4L10.3 8 6.5 5.8Z" fill="#000" /></svg>;
}

export type MenuOption = { value: string; label: string };

export function FilterMenu({ label, options, value, onChange }: { label: string; options: MenuOption[]; value: string; onChange: (v: string) => void }) {
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger aria-label={label} className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-line-strong bg-canvas px-3 text-[13px] text-t1 outline-none transition-colors hover:bg-s2 focus-visible:border-teal data-[state=open]:bg-s2">
        {current.label}<ChevronDown className="size-3.5 text-t2" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="fade-in z-50 min-w-[200px] rounded-xl border border-line-strong bg-s2 p-1 shadow-2xl">
          {options.map((o) => (
            <DropdownMenu.Item key={o.value} onSelect={() => onChange(o.value)} className="flex cursor-pointer items-center justify-between gap-4 rounded-lg px-2.5 py-2 text-[13px] text-t2 outline-none data-[highlighted]:bg-s3 data-[highlighted]:text-t1">
              {o.label}{o.value === value && <Check className="size-3.5 text-teal" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const OVERLAY = "bg-black/60 backdrop-blur-[6px]";
// X, Facebook, Instagram and LinkedIn open links in their own browser, where OAuth often fails.
const IN_APP_BROWSER = /Twitter|FBAN|FBAV|Instagram|LinkedInApp/i;

/** Sign-in dialog. With a product it is the app page gate; without one it is plain sign-in. */
export function GateModal({ product, screens, onClose }: { product?: { name: string }; screens?: number; onClose: () => void }) {
  const inApp = IN_APP_BROWSER.test(navigator.userAgent);
  const { copied, copy } = useCopy();
  const [providers, setProviders] = useState<string[] | null>(null);
  useEffect(() => { void fetchProviders().then(setProviders); }, []);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="overflow-hidden rounded-2xl border-line-strong bg-s1 p-0 sm:max-w-[440px]" overlayClassName={OVERLAY}>
        <div className="p-6">
          <div className="text-[11px] font-medium uppercase tracking-[0.05em] text-teal">Arcex access // 100% free</div>
          <DialogTitle className="mt-3 font-display text-[26px] font-semibold leading-[32px] tracking-[-0.02em]">
            {product ? `See ${screens ? `all ${screens} screens` : "everything"} inside ${product.name} & copy the Agent Blueprint.` : "Sign in to Arcex"}
          </DialogTitle>
          <DialogDescription className="sr-only">Sign in for free</DialogDescription>
          <ul className="mt-5 flex flex-col gap-2.5 text-t2">
            {["Every screen from sign-up to paywall", "Ads, creators and sourced revenue ranges", "1-click blueprint for Claude and Cursor"].map((x) => <li key={x} className="flex items-center gap-2.5"><Check className="size-4 shrink-0 text-teal" />{x}</li>)}
          </ul>
          {inApp && (
            <div className="mt-5 rounded-xl border border-line-strong bg-s2 p-3 text-[13px] leading-[19px] text-t2">
              Sign-in works best in your normal browser, not this app's built-in one.
              <button className="btn btn-ghost mt-2 w-full" onClick={() => copy(location.href, "link")}>{copied ? "Link copied. Paste it in your browser" : "Copy link"}</button>
            </div>
          )}
          <div className="mt-6 flex min-h-11 flex-col gap-2">
            {providers?.includes("google") && <a className="btn btn-primary h-11 w-full" href={signInUrl("google")}><GoogleIcon className="size-4" />Continue with Google</a>}
            {providers?.length === 0 && <p role="status" className="text-center text-t2">Sign-in isn't available right now. Please try again soon.</p>}
          </div>
          <div className="mt-4 text-center text-[12px] leading-[18px] text-t3">Free account includes {DAILY_LIMIT} apps and {DAILY_LIMIT} blueprint pulls a day. No credit card required.</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const untilReset = (iso?: string) => {
  const minutes = iso ? Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000)) : null;
  return minutes === null ? "tomorrow" : `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export function LimitModal({ usage, onClose, onUpgrade }: { usage?: Usage | null; onClose: () => void; onUpgrade: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-2xl border-line-strong bg-s1 sm:max-w-[440px]" overlayClassName={OVERLAY}>
        <DialogTitle className="font-display text-[26px] font-semibold leading-[32px] tracking-[-0.02em]">You've opened your {DAILY_LIMIT} free apps for today.</DialogTitle>
        <DialogDescription className="text-t2">Resets <span className="num text-t1">{untilReset(usage?.resetsAt)}</span>. Apps you've already opened today stay free. Insider is unlimited.</DialogDescription>
        <button className="btn btn-primary h-11 w-full" onClick={onUpgrade}>Go Insider ({INSIDER_PRICE})</button>
        <button className="btn btn-ghost h-11 w-full" onClick={onClose}>Come back tomorrow</button>
      </DialogContent>
    </Dialog>
  );
}

export function InsiderModal({ onSubscribe, onClose }: { onSubscribe: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-2xl border-line-strong bg-s1 sm:max-w-[440px]" overlayClassName={OVERLAY}>
        <div className="text-[11px] font-medium uppercase tracking-[0.05em] text-teal">Arcex Insider</div>
        <DialogTitle className="font-display text-[26px] font-semibold leading-[32px] tracking-[-0.02em]">No daily limits. {INSIDER_PRICE}.</DialogTitle>
        <DialogDescription className="text-t2">Arcex stays free. Insider is for when {DAILY_LIMIT} a day isn't enough.</DialogDescription>
        <ul className="flex flex-col gap-2.5 text-t2">
          {["Unlimited apps", "Unlimited blueprint pulls over MCP", "Unlimited tracking with email alerts", "Priority on full-breakdown requests"].map((x) => <li key={x} className="flex items-center gap-2.5"><Check className="size-4 shrink-0 text-teal" />{x}</li>)}
        </ul>
        <button disabled={busy} className="btn btn-primary h-11 w-full disabled:opacity-60" onClick={() => { setBusy(true); void onSubscribe().finally(() => setBusy(false)); }}>{busy ? "Opening checkout..." : "Go Insider"}</button>
      </DialogContent>
    </Dialog>
  );
}

/** A failed request, with a way to try again. */
export function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex min-h-[280px] flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-t2">{message}</div>
      <button className="btn btn-ghost" onClick={onRetry}>Try again</button>
    </div>
  );
}

export function PageHeading({ title, sub, children }: { title: string; sub: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-[30px] font-semibold leading-[36px] tracking-[-0.025em] md:text-[34px] md:leading-[40px]">{title}</h1>
        <p className="mt-1.5 text-[15px] leading-[22px] text-t2">{sub}</p>
      </div>
      {children}
    </div>
  );
}
