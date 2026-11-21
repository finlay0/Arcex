import { useEffect, useState } from "react";
import type { DesktopAccount, DesktopLink } from "@arcex/contracts";
import { call } from "./store.ts";

export function Account() {
  const [account, setAccount] = useState<DesktopAccount | null>(null);
  const [link, setLink] = useState<DesktopLink | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  const showError = (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem));
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await call("account.status", {});
      setAccount(result.account);
      setLink(result.link ?? null);
    } catch (problem) {
      showError(problem);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= Date.parse(link.expiresAt)) {
        setLink(null);
        setError("This code expired. Start sign-in again.");
        return;
      }
      try {
        const result = await call("account.finish", {});
        if (cancelled) return;
        if (result.account) {
          setAccount(result.account);
          setLink(null);
          setError("");
          return;
        }
        setError("");
      } catch (problem) {
        if (!cancelled) showError(problem);
      }
      if (!cancelled) timer = setTimeout(poll, link.interval * 1000);
    };
    timer = setTimeout(poll, link.interval * 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [link]);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      setLink(await call("account.start", {}));
    } catch (problem) {
      showError(problem);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    setError("");
    setLink(null);
    try {
      await call("account.disconnect", {});
      setAccount(null);
    } catch (problem) {
      showError(problem);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card arcex-account">
      <b>Arcex account</b>
      {account ? (
        <>
          <p>{account.name} · {account.pro ? "Arcex Pro" : "Free account"}</p>
          <div className="btns">
            <button className="btn" onClick={() => window.arcex?.openExternal(account.devicesUrl)}>Manage devices</button>
            <button className="btn" disabled={busy} onClick={() => void refresh()}>Refresh</button>
            <button className="btn" disabled={busy} onClick={() => void disconnect()}>Sign out</button>
          </div>
        </>
      ) : link ? (
        <>
          <p>Enter this code in your browser, then return here.</p>
          <code className="account-code" aria-label={link.code.split("").join(" ")}>{link.code.slice(0, 5)}-{link.code.slice(5)}</code>
          <div className="btns">
            <button className="btn primary" onClick={() => window.arcex?.openExternal(link.verificationUrl)}>Open browser</button>
            <button className="btn" disabled={busy} onClick={() => void disconnect()}>Cancel</button>
          </div>
          <p role="status">Waiting for you to approve this device…</p>
        </>
      ) : (
        <>
          <p>Use the same Arcex account as on the web. Arcex stores your workspace on this computer.</p>
          <div className="btns">
            <button className="btn primary" disabled={busy || !window.arcex} onClick={() => void start()}>Sign in to Arcex</button>
            {error && <button className="btn" disabled={busy} onClick={() => void refresh()}>Check connection</button>}
          </div>
        </>
      )}
      {error && <p className="oops" role="alert">{error}</p>}
    </div>
  );
}
