import { useEffect, useRef, useState } from "react";
import type { Agent, ModelOption } from "@arcex/contracts";
import { Icon } from "./shared.tsx";
import { call } from "./store.ts";

export type Choice = { agentId: string; model: { value: string; name: string } | null };

// Model lists are read from each agent once and shared by every picker.
const cache = new Map<string, { options: ModelOption[]; current: string | null }>();

/** Hides an agent's own "default" entry, since the picker already offers the agent's default at the top. */
const real = (options: ModelOption[]) => options.filter((option) => option.value !== "default");

/**
 * Picks the agent and model for a thread. Agents are on the left, the chosen agent's models on the right.
 * When `lockAgent` is set (an existing thread), only that agent's models are offered.
 */
export function ModelPicker(props: { agents: Agent[]; value: Choice; lockAgent?: boolean; disabled?: boolean; onChange(choice: Choice): void; manage(): void; nameOf(id: string): string }) {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState(props.value.agentId);
  const [state, setState] = useState<{ loading: boolean; error: string | null; options: ModelOption[] }>({ loading: false, error: null, options: [] });
  const [filter, setFilter] = useState("");
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    const cached = cache.get(agentId);
    if (cached) return setState({ loading: false, error: null, options: cached.options });
    let stale = false;
    setState({ loading: true, error: null, options: [] });
    call("agents.models", { agentId })
      .then((models) => {
        cache.set(agentId, models);
        if (!stale) setState({ loading: false, error: null, options: models.options });
      })
      .catch((error: Error) => !stale && setState({ loading: false, error: error.message, options: [] }));
    return () => {
      stale = true;
    };
  }, [open, agentId]);

  const pick = (model: Choice["model"]) => {
    props.onChange({ agentId, model });
    setOpen(false);
  };
  const needle = filter.trim().toLowerCase();
  const options = real(state.options).filter((option) => !needle || `${option.name} ${option.description}`.toLowerCase().includes(needle));
  const selected = props.value.agentId === agentId ? props.value.model?.value ?? null : undefined;

  return (
    <span className="mpick" ref={root}>
      <button
        className="mbtn"
        disabled={props.disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setAgentId(props.value.agentId);
          setOpen(!open);
        }}
      >
        <b>{props.nameOf(props.value.agentId)}</b>
        <span>{props.value.model?.name ?? "Default model"}</span>
        <Icon name="down" />
      </button>
      {open && (
        <div className="mpop" role="dialog" aria-label="Choose an agent and model">
          {!props.lockAgent && (
            <div className="magents">
              <div className="label">Agent</div>
              {props.agents.map((agent) => (
                <button key={agent.id} className="row" aria-current={agent.id === agentId} onClick={() => setAgentId(agent.id)}>
                  <span className="trunc">{agent.name}</span>
                </button>
              ))}
              <button className="row add" onClick={props.manage}>
                <Icon name="plus" /> Add an agent
              </button>
            </div>
          )}
          <div className="mmodels">
            <div className="mhead">
              <span className="label">{props.nameOf(agentId)} models</span>
              {real(state.options).length > 7 && <input value={filter} placeholder="Filter" aria-label="Filter models" onChange={(event) => setFilter(event.target.value)} />}
            </div>
            <div className="mlist">
              <button className="mrow" aria-current={selected === null} onClick={() => pick(null)}>
                <b>Default</b>
                <span>Whatever {props.nameOf(agentId)} recommends</span>
              </button>
              {state.loading && <p className="muted">Asking {props.nameOf(agentId)} for its models…</p>}
              {state.error && (
                <p className="muted">
                  Couldn't reach {props.nameOf(agentId)}. It may not be installed or signed in. <button className="link" onClick={props.manage}>Open agent settings</button>
                </p>
              )}
              {options.map((option) => (
                <button key={option.value} className="mrow" aria-current={selected === option.value} onClick={() => pick({ value: option.value, name: option.name })}>
                  <b>{option.name}</b>
                  {option.description && <span>{option.description}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
