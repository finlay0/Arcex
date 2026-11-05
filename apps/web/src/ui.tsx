import { useEffect, useState, type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { Product } from "./data";

export const DAILY_LIMIT = 10;
export const FREE_WATCHES = 3;
export const INSIDER_PRICE = "$12/mo";
export const API_URL = "https://arcex-api.peak-era-avern.workers.dev";
export const MCP_URL = API_URL + "/public/mcp";
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
    <span className="inline-flex gap-[3px]" role="img" aria-label={`Estimate confidence ${level} of 4`} title={`Estimate confidence: ${level} of 4`}>
      {[1, 2, 3, 4].map((i) => <span key={i} className={`size-[5px] rounded-full ${i <= level ? "bg-teal" : "bg-s3"}`} />)}
    </span>
  );
}

export function Sparkline({ data }: { data: number[] }) {
  const max = Math.max(...data), min = Math.min(...data);
  const range = max - min || 1;
  const points = data.map((d, i) => `${(i / (data.length - 1)) * 54 + 1},${17 - ((d - min) / range) * 16}`).join(" ");
  const up = data[data.length - 1] >= data[0];
  return <svg width="56" height="18" viewBox="0 0 56 18" aria-hidden><polyline points={points} fill="none" stroke={up ? "var(--color-teal)" : "var(--color-t3)"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

export function ProductIcon({ p, size = 36 }: { p: Product; size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center font-bold text-white" style={{ width: size, height: size, borderRadius: size * 0.24, background: p.theme.accent, fontSize: size * 0.5 }}>
      {p.name[0]}
    </span>
  );
}

export function XIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor"><path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.3 22H3.2l7.3-8.3L2.8 2h6.4l4.4 5.9L18.9 2Zm-1.1 18h1.7L8.3 3.9H6.5L17.8 20Z" /></svg>;
}

export function GitHubIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2Z" /></svg>;
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
export function GateModal({ product, screens, onSignIn, onClose }: { product?: Product; screens?: number; onSignIn: (via: string) => void; onClose: () => void }) {
  const inApp = IN_APP_BROWSER.test(navigator.userAgent);
  const { copied, copy } = useCopy();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="overflow-hidden rounded-2xl border-line-strong bg-s1 p-0 sm:max-w-[440px]" overlayClassName={OVERLAY}>
        <div className="p-6">
          <div className="text-[11px] font-medium uppercase tracking-[0.05em] text-teal">Arcex access // 100% free</div>
          <DialogTitle className="mt-3 font-display text-[26px] font-semibold leading-[32px] tracking-[-0.02em]">
            {product ? `See all ${screens} screens inside ${product.name} & copy the Agent Blueprint.` : "Sign in to Arcex"}
          </DialogTitle>
          <DialogDescription className="sr-only">Sign in for free with X or GitHub</DialogDescription>
          <ul className="mt-5 flex flex-col gap-2.5 text-t2">
            {["Every screen from sign-up to paywall", "Ads, creators and estimated revenue", "1-click blueprint for Claude and Cursor"].map((x) => <li key={x} className="flex items-center gap-2.5"><Check className="size-4 shrink-0 text-teal" />{x}</li>)}
          </ul>
          {inApp && (
            <div className="mt-5 rounded-xl border border-line-strong bg-s2 p-3 text-[13px] leading-[19px] text-t2">
              Sign-in works best in your normal browser, not this app's built-in one.
              <button className="btn btn-ghost mt-2 w-full" onClick={() => copy(location.href, "link")}>{copied ? "Link copied. Paste it in your browser" : "Copy link"}</button>
            </div>
          )}
          <button className="btn btn-primary mt-6 h-11 w-full" onClick={() => onSignIn("X")}><XIcon className="size-4" />Continue with X</button>
          <button className="btn btn-ghost mt-2 h-11 w-full" onClick={() => onSignIn("GitHub")}><GitHubIcon className="size-4" />Continue with GitHub</button>
          <div className="mt-4 text-center text-[12px] leading-[18px] text-t3">Free account includes {DAILY_LIMIT} apps and {DAILY_LIMIT} blueprint pulls a day. No credit card required.</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function LimitModal({ onClose, onUpgrade }: { onClose: () => void; onUpgrade: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-2xl border-line-strong bg-s1 sm:max-w-[440px]" overlayClassName={OVERLAY}>
        <DialogTitle className="font-display text-[26px] font-semibold leading-[32px] tracking-[-0.02em]">You've opened your {DAILY_LIMIT} free apps for today.</DialogTitle>
        <DialogDescription className="text-t2">Resets in <span className="num text-t1">14h 22m</span>. Apps you've already opened stay free. Insider is unlimited.</DialogDescription>
        <button className="btn btn-primary h-11 w-full" onClick={onUpgrade}>Go Insider ({INSIDER_PRICE})</button>
        <button className="btn btn-ghost h-11 w-full" onClick={onClose}>Come back tomorrow</button>
      </DialogContent>
    </Dialog>
  );
}

export function InsiderModal({ onSubscribe, onClose }: { onSubscribe: () => void; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-2xl border-line-strong bg-s1 sm:max-w-[440px]" overlayClassName={OVERLAY}>
        <div className="text-[11px] font-medium uppercase tracking-[0.05em] text-teal">Arcex Insider</div>
        <DialogTitle className="font-display text-[26px] font-semibold leading-[32px] tracking-[-0.02em]">No daily limits. {INSIDER_PRICE}.</DialogTitle>
        <DialogDescription className="text-t2">Arcex stays free. Insider is for when {DAILY_LIMIT} a day isn't enough.</DialogDescription>
        <ul className="flex flex-col gap-2.5 text-t2">
          {["Unlimited apps", "Unlimited blueprint pulls over MCP", "Unlimited tracking with email alerts", "Collections to organize what you save", "Priority when you request a product"].map((x) => <li key={x} className="flex items-center gap-2.5"><Check className="size-4 shrink-0 text-teal" />{x}</li>)}
        </ul>
        <button className="btn btn-primary h-11 w-full" onClick={onSubscribe}>Go Insider</button>
        <div className="text-center text-[12px] text-t3">Prototype: no payment is taken.</div>
      </DialogContent>
    </Dialog>
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
