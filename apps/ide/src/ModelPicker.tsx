import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Agent, AgentChoice, ModelOption, SlashCommand } from "@arcex/contracts";
import { Icon } from "./shared.tsx";
import { call, useStore } from "./store.ts";

export type Choice = { agentId: string; model: { value: string; name: string } | null; /** Agent settings such as mode and effort, by choice id. */ choices?: Record<string, string> };

// Model lists are read from each agent once and shared by every picker.
const cache = new Map<string, { options: ModelOption[]; current: string | null; choices: AgentChoice[]; commands: SlashCommand[] }>();

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
  const [attempt, setAttempt] = useState(0);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = popover.current;
    const button = trigger.current;
    if (!open || !panel || !button) return;
    const position = () => {
      const rect = button.getBoundingClientRect();
      const above = rect.top - 16;
      const below = window.innerHeight - rect.bottom - 16;
      const height = Math.max(0, Math.min(360, Math.max(above, below)));
      const width = Math.min(props.lockAgent ? 340 : 560, window.innerWidth - 24);
      panel.style.width = `${width}px`;
      panel.style.height = `${height}px`;
      panel.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
      panel.style.top = `${above >= below ? rect.top - height - 8 : rect.bottom + 8}px`;
    };
    position();
    panel.showPopover();
    panel.focus({ preventScroll: true });
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      if (panel.isConnected && panel.matches(":popover-open")) panel.hidePopover();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, props.lockAgent]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
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
    call("agents.models", { agentId, refresh: attempt > 0 })
      .then((models) => {
        cache.set(agentId, models);
        if (!stale) setState({ loading: false, error: null, options: models.options });
      })
      .catch((error: Error) => !stale && setState({ loading: false, error: error.message, options: [] }));
    return () => {
      stale = true;
    };
  }, [open, agentId, attempt]);

  const pick = (model: Choice["model"]) => {
    props.onChange({ ...props.value, agentId, model, choices: agentId === props.value.agentId ? props.value.choices : {} });
    setOpen(false);
    trigger.current?.focus();
  };
  const needle = filter.trim().toLowerCase();
  const options = real(state.options).filter((option) => !needle || `${option.name} ${option.description}`.toLowerCase().includes(needle));
  const selected = props.value.agentId === agentId ? props.value.model?.value ?? null : undefined;

  return (
    <span className="mpick" ref={root}>
      <button
        className="mbtn"
        ref={trigger}
        disabled={props.disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setAgentId(props.value.agentId);
          setAttempt(0);
          setOpen(!open);
        }}
      >
        <b>{props.nameOf(props.value.agentId)}</b>
        <span>{props.value.model?.name ?? "Default model"}</span>
        <Icon name="down" />
      </button>
      {open && (
        <div className={props.lockAgent ? "mpop narrow" : "mpop"} ref={popover} popover="manual" tabIndex={-1} role="dialog" aria-label="Choose an agent and model"
          onBlur={(event) => {
            if (event.relatedTarget && !root.current?.contains(event.relatedTarget)) setOpen(false);
          }}>
          {!props.lockAgent && (
            <div className="magents">
              <div className="label">Agent</div>
              {props.agents.map((agent) => (
                <button key={agent.id} className="row" aria-current={agent.id === agentId} onClick={() => {
                  if (agentId === agent.id) return;
                  setState({ loading: true, error: null, options: [] });
                  setAttempt(0);
                  setAgentId(agent.id);
                  props.onChange({ agentId: agent.id, model: null });
                }}>
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
              {state.loading && <p className="muted" role="status">Asking {props.nameOf(agentId)} for its models…</p>}
              {state.error && (
                <p className="muted">
                  Couldn't reach {props.nameOf(agentId)}. <button className="link" onClick={() => { cache.delete(agentId); setAttempt(attempt + 1); }}>Retry</button>{" "}
                  <button className="link" onClick={props.manage}>Open agent settings</button>
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

/** Reads an agent's settings (mode, effort and so on) once and shares them, like the model list. */
function useAgentChoices(agentId: string) {
  const [choices, setChoices] = useState<AgentChoice[] | null>(cache.get(agentId)?.choices ?? null);
  useEffect(() => {
    const cached = cache.get(agentId);
    if (cached) return setChoices(cached.choices);
    setChoices(null);
    let stale = false;
    call("agents.models", { agentId })
      .then((models) => {
        cache.set(agentId, models);
        if (!stale) setChoices(models.choices);
      })
      .catch(() => !stale && setChoices([]));
    return () => {
      stale = true;
    };
  }, [agentId]);
  return choices;
}

/** An agent's slash commands: the list read when first asked, replaced by any newer list a thread reported. */
export function useAgentCommands(agentId: string): SlashCommand[] {
  const reported = useStore().commands[agentId];
  const [commands, setCommands] = useState<SlashCommand[]>(cache.get(agentId)?.commands ?? []);
  useEffect(() => {
    const cached = cache.get(agentId);
    if (cached) return setCommands(cached.commands ?? []);
    setCommands([]);
    let stale = false;
    call("agents.models", { agentId })
      .then((models) => {
        cache.set(agentId, models);
        if (!stale) setCommands(models.commands ?? []);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [agentId]);
  return reported ?? commands;
}

/** A small menu that opens above or below its button, whichever has more room. */
function Dropdown(props: { label: ReactNode; title: string; disabled?: boolean; children(close: () => void): ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = panel.current;
    const button = trigger.current;
    if (!open || !menu || !button) return;
    const rect = button.getBoundingClientRect();
    menu.showPopover();
    const height = menu.offsetHeight;
    const width = Math.min(300, window.innerWidth - 24);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    menu.style.top = `${rect.top - 16 >= height || rect.top > window.innerHeight - rect.bottom ? rect.top - height - 8 : rect.bottom + 8}px`;
    menu.focus({ preventScroll: true });
    return () => {
      if (menu.isConnected && menu.matches(":popover-open")) menu.hidePopover();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => !root.current?.contains(event.target as Node) && setOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <span className="cpick" ref={root}>
      <button className="mbtn" ref={trigger} title={props.title} disabled={props.disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {props.label}
        <Icon name="down" />
      </button>
      {open && (
        <div className="cpop" ref={panel} popover="manual" tabIndex={-1} role="menu" aria-label={props.title}
          onBlur={(event) => event.relatedTarget && !root.current?.contains(event.relatedTarget) && setOpen(false)}>
          {props.children(close)}
        </div>
      )}
    </span>
  );
}

/** Which value of a two-way setting means "on": not "off", not "default". */
const onValue = (choice: AgentChoice) => choice.values.find((entry) => !["off", "default", "false"].includes(entry.value))?.value;

/**
 * The agent's own settings beside the model: how much it asks before acting, and how hard it thinks (with fast
 * mode and plan-first as switches). Names and descriptions come from the agent itself.
 */
export function AgentChoices(props: { agentId: string; value: Record<string, string>; disabled?: boolean; onChange(id: string, value: string): void }) {
  const choices = useAgentChoices(props.agentId);
  if (!choices?.length) return null;
  const current = (choice: AgentChoice) => props.value[choice.id] ?? choice.current;
  const nameIn = (choice: AgentChoice) => choice.values.find((entry) => entry.value === current(choice))?.name ?? current(choice);
  const mode = choices.find((choice) => choice.category === "mode");
  const effort = choices.find((choice) => choice.category === "thought_level");
  const switches = choices.filter((choice) => choice.category !== "mode" && choice.category !== "thought_level" && choice.values.length === 2 && onValue(choice));
  const onNames = switches.filter((choice) => current(choice) === onValue(choice)).map((choice) => (choice.category === "collaboration_mode" ? "Plan first" : choice.name));
  const effortName = effort && current(effort) !== "default" ? nameIn(effort) : null;
  return (
    <>
      {mode && (
        <Dropdown title="How much the agent asks before acting" disabled={props.disabled} label={<span>{nameIn(mode)}</span>}>
          {(close) => (
            <>
              <div className="label">{mode.name}</div>
              {mode.values.map((entry) => (
                <button key={entry.value} className="mrow" role="menuitemradio" aria-checked={current(mode) === entry.value} aria-current={current(mode) === entry.value}
                  onClick={() => { props.onChange(mode.id, entry.value); close(); }}>
                  <b>{entry.name}</b>
                  {entry.description && <span>{entry.description}</span>}
                </button>
              ))}
            </>
          )}
        </Dropdown>
      )}
      {(effort || switches.length > 0) && (
        <Dropdown title="How hard the agent thinks" disabled={props.disabled}
          label={<span>{[effortName ?? (effort ? "Effort" : null), ...onNames].filter(Boolean).join(" · ") || "Options"}</span>}>
          {() => (
            <>
              {effort && (
                <>
                  <div className="label">{effort.name}</div>
                  <div className="levels" role="radiogroup" aria-label={effort.name}>
                    {effort.values.map((entry) => (
                      <button key={entry.value} role="radio" aria-checked={current(effort) === entry.value} title={entry.description || entry.name}
                        onClick={() => props.onChange(effort.id, entry.value)}>
                        {entry.value === "default" ? "Auto" : entry.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {switches.map((choice) => {
                const on = current(choice) === onValue(choice);
                const off = choice.values.find((entry) => entry.value !== onValue(choice))!.value;
                return (
                  <button key={choice.id} className="switchrow" role="menuitemcheckbox" aria-checked={on} onClick={() => props.onChange(choice.id, on ? off : onValue(choice)!)}>
                    <span>{choice.category === "collaboration_mode" ? "Plan first" : choice.name}</span>
                    <span className="toggle" aria-hidden="true"><i /></span>
                  </button>
                );
              })}
            </>
          )}
        </Dropdown>
      )}
    </>
  );
}
