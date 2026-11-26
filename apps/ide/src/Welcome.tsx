import { useEffect, useState } from "react";
import type { Agent, ProviderStatus } from "@arcex/contracts";
import { Art } from "./Art.tsx";
import { setupGuides } from "./Settings.tsx";
import { Icon } from "./shared.tsx";
import { call } from "./store.ts";

/**
 * The first screen a new user sees: which agents are already on this computer, a sign-in for any that need one, and
 * then on to the first project. Shown once, while there are no projects; Continue or Skip marks it seen.
 */
export function Welcome({ agents, defaultAgent, done, fail }: { agents: Agent[]; defaultAgent: string; done(): void; fail(error: unknown): void }) {
  const [status, setStatus] = useState<ProviderStatus[] | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const check = () => {
    setStatus(null);
    call("providers.status", {}).then(setStatus).catch(fail);
  };
  useEffect(check, []);
  const builtins = agents.filter((agent) => agent.builtin);
  const ready = (id: string) => {
    const state = status?.find((entry) => entry.id === id);
    return !!state?.installed && state.signedIn === true;
  };
  const anyReady = builtins.some((agent) => ready(agent.id));

  const finish = () => {
    // Start new threads with an agent that works: keep the current default if it's ready, otherwise the first one that is.
    const first = builtins.find((agent) => ready(agent.id));
    const update = { welcomed: true, ...(first && !ready(defaultAgent) ? { defaultProvider: first.id, defaultModel: null } : {}) };
    call("settings.set", update).then(done).catch(fail);
  };
  const openGuide = (url: string) => (window.arcex ? window.arcex.openExternal(url) : void window.open(url, "_blank", "noopener"));

  return (
    <div className="hero welcome">
      <Art />
      <div className="inner">
        <img className="mark logo" src="./mark.png" alt="" />
        <h2>Welcome to Arcex</h2>
        <p className="lead">Arcex builds with the AI agents you already use, signed in with your own accounts. Here's what's ready on this computer.</p>
        <div className="wagents" aria-busy={!status}>
          {builtins.map((agent) => {
            const state = status?.find((entry) => entry.id === agent.id);
            const guide = Object.hasOwn(setupGuides, agent.id) ? setupGuides[agent.id] : undefined;
            const label = !state ? "Checking…" : !state.installed ? "Not installed" : state.signedIn === false ? "Sign in needed" : state.signedIn === true ? "Ready" : "Installed";
            return (
              <div key={agent.id} className="wagent">
                <div className="wname">
                  <strong>{agent.name}</strong>
                  <span className={`pillstate ${ready(agent.id) ? "ok" : state ? "warn" : ""}`}>{label}</span>
                </div>
                <div className="wact">
                  {state && !state.installed && guide && (
                    <button className="btn" onClick={() => openGuide(guide)}>
                      How to install <Icon name="out" />
                    </button>
                  )}
                  {state?.installed && state.signedIn === false &&
                    ((state.signInMethods?.length ?? 0) > 0 ? (
                      state.signInMethods!.slice(0, 1).map((method) => (
                        <button
                          key={method.id}
                          className="btn"
                          disabled={signingIn !== null}
                          onClick={() => {
                            setSigningIn(agent.id);
                            call("agents.signIn", { agentId: agent.id, methodId: method.id })
                              .then(check)
                              .catch(fail)
                              .finally(() => setSigningIn(null));
                          }}
                        >
                          {signingIn === agent.id ? "Finish in your browser…" : method.name}
                        </button>
                      ))
                    ) : (
                      <button className="btn" onClick={() => void call("agents.openTerminal", { agentId: agent.id, purpose: "signIn" }).catch(fail)}>
                        Sign in
                      </button>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
        <p className="wnote">
          {status && !anyReady
            ? "None are ready yet. Install one of these (each is free to install and signs in with its own account), then check again."
            : "Each agent keeps its own sign-in. Arcex never sees your passwords or keys. You can add more agents later in Settings › Agents."}
        </p>
        <div className="wbuttons">
          <button className="btn" onClick={check} disabled={!status}>
            <Icon name="reload" /> Check again
          </button>
          <button className="btn primary" onClick={finish} disabled={!status}>
            {anyReady || !status ? "Continue" : "Continue anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}
