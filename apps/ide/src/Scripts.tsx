import { useEffect, useRef, useState } from "react";
import type { ProcessInfo, Project, ProjectScript } from "@arcex/contracts";
import { Icon, Loader } from "./shared.tsx";
import { call, useStore } from "./store.ts";

const SHOWN = 4;

function elapsed(run: ProcessInfo, now: number): string {
  const seconds = Math.max(0, Math.round(((run.endedAt ?? now) - run.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const describe = (run: ProcessInfo, now: number) =>
  run.state === "running" ? (run.url ? `Running at ${run.url.replace(/^https?:\/\//, "")}` : `Running for ${elapsed(run, now)}`)
    : run.state === "stopped" ? "Stopped"
    : run.state === "exited" ? `Finished in ${elapsed(run, now)}`
    : `Failed${run.exitCode !== null ? ` (exit ${run.exitCode})` : ""}`;

/** The project's own scripts (dev server, build, tests) as buttons, with what is running now. */
export function Scripts(props: { project: Project; refresh: string; fail(error: unknown): void; show(runId: string): void; preview(): void }) {
  const { project, fail } = props;
  const processes = useStore().processes;
  const [scripts, setScripts] = useState<ProjectScript[] | null>(null);
  const [all, setAll] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let current = true;
    call("project.scripts", { projectId: project.id })
      .then((result) => current && setScripts(result.scripts))
      .catch(() => current && setScripts([]));
    return () => {
      current = false;
    };
  }, [project.id, props.refresh]);

  const runs = Object.values(processes).filter((run) => run.projectId === project.id);
  const latest = (name: string) => runs.filter((run) => run.name === name).sort((a, b) => b.startedAt - a.startedAt)[0];
  const anyRunning = runs.some((run) => run.state === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  if (!scripts || scripts.length === 0) return null;
  const shown = all ? scripts : scripts.slice(0, SHOWN);
  return (
    <section className="sec scripts">
      <header>
        <b>Run</b>
        {anyRunning && <span className="stat">{runs.filter((run) => run.state === "running").length} running</span>}
      </header>
      {shown.map((script) => {
        const run = latest(script.name);
        const running = run?.state === "running";
        return (
          <div key={script.name} className="script">
            <button
              className="icon"
              aria-label={running ? `Stop ${script.name}` : `Run ${script.name}`}
              title={running ? "Stop" : `Run ${script.command}`}
              onClick={() => {
                if (running) void call("process.stop", { processId: run.id }).catch(fail);
                else void call("process.run", { projectId: project.id, script: script.name }).catch(fail);
              }}
            >
              <Icon name={running ? "stop" : "play"} />
            </button>
            <span className="sname" title={script.command}>
              <b>{script.name}</b>
              <span className={run?.state === "failed" ? "muted bad" : "muted"}>{run ? describe(run, now) : script.command}</span>
            </span>
            {running && !run.url && <Loader />}
            {run?.url && running && (
              <button className="link" onClick={props.preview}>Preview</button>
            )}
            {run && (
              <button className="link" onClick={() => props.show(run.id)}>Output</button>
            )}
          </div>
        );
      })}
      {scripts.length > SHOWN && (
        <button className="link more" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${scripts.length}`}</button>
      )}
    </section>
  );
}

/** What a script printed, kept current while it runs. */
export function RunOutput(props: { runId: string; back(): void; fail(error: unknown): void }) {
  const run = useStore().processes[props.runId];
  const [text, setText] = useState("");
  const box = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    let current = true;
    const read = () =>
      call("process.output", { processId: props.runId })
        .then((result) => current && setText(result.text))
        .catch(() => {});
    void read();
    if (run?.state !== "running") return () => { current = false; };
    const timer = setInterval(read, 1000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [props.runId, run?.state]);
  useEffect(() => {
    if (pinned.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);

  return (
    <div className="fileview">
      <div className="fvtop">
        <button className="icon" aria-label="Back to project details" title="Back" onClick={props.back}><Icon name="back" /></button>
        <span className="fvname trunc"><b>{run?.name ?? "Output"}</b>{run && <span className="muted"> {run.command}</span>}</span>
        {run?.state === "running" && (
          <button className="btn small" onClick={() => void call("process.stop", { processId: run.id }).catch(props.fail)}>Stop</button>
        )}
      </div>
      <pre
        className="runout"
        ref={box}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {text || (run?.state === "running" ? "Waiting for output…" : "Nothing was printed.")}
      </pre>
    </div>
  );
}
