import { useEffect, useState } from "react";
import type { Project, Schedule, ScheduleWhen, Settings } from "@arcex/contracts";
import { Icon, clock, nameOf } from "./shared.tsx";
import { call } from "./store.ts";

/** The engine broadcasts the list whenever it changes; store.ts passes it on as this window event. */
export const SCHEDULES_CHANGED = "arcex:schedules";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function describeWhen(when: ScheduleWhen): string {
  if (when.kind === "hourly") return when.every === 1 ? "Every hour" : `Every ${when.every} hours`;
  if (when.kind !== "weekly") return when.kind === "daily" ? `Every day at ${when.time}` : `Weekdays at ${when.time}`;
  return `Every ${DAYS[when.day]} at ${when.time}`;
}

type Draft = { id?: string; name: string; projectId: string; prompt: string; kind: ScheduleWhen["kind"]; time: string; day: number; every: number; on: boolean };

/** Prompts that run on a schedule, each run as a new thread. */
export function SchedulesView(props: { projects: Project[]; projectId: string | null; settings: Settings; open(threadId: string): void; fail(error: unknown): void }) {
  const [list, setList] = useState<Schedule[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    call("schedules.list", {}).then(setList).catch(props.fail);
    const changed = (event: Event) => setList((event as CustomEvent<Schedule[]>).detail);
    window.addEventListener(SCHEDULES_CHANGED, changed);
    return () => window.removeEventListener(SCHEDULES_CHANGED, changed);
  }, []);
  const fresh = (): Draft => ({ name: "", projectId: props.projectId ?? props.projects[0]?.id ?? "", prompt: "", kind: "daily", time: "09:00", day: 1, every: 4, on: true });
  const edit = (schedule: Schedule): Draft => ({
    id: schedule.id, name: schedule.name, projectId: schedule.projectId, prompt: schedule.prompt, kind: schedule.when.kind, on: schedule.on,
    time: "time" in schedule.when ? schedule.when.time : "09:00", day: schedule.when.kind === "weekly" ? schedule.when.day : 1, every: schedule.when.kind === "hourly" ? schedule.when.every : 4,
  });
  const when = (d: Draft): ScheduleWhen =>
    d.kind === "hourly" ? { kind: "hourly", every: d.every } : d.kind === "weekly" ? { kind: "weekly", day: d.day, time: d.time } : { kind: d.kind, time: d.time };
  const save = () => {
    if (!draft) return;
    setBusy("save");
    call("schedules.save", { schedule: { ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), projectId: draft.projectId, prompt: draft.prompt.trim(), when: when(draft), on: draft.on } })
      .then((next) => { setList(next); setDraft(null); })
      .catch(props.fail)
      .finally(() => setBusy(null));
  };
  const act = (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    run().catch(props.fail).finally(() => setBusy(null));
  };
  const projectName = (id: string) => props.projects.find((p) => p.id === id)?.name ?? "A removed project";
  const where = (schedule: Schedule) =>
    schedule.background === "task" ? "Runs even when Arcex is closed" : schedule.background === "failed" ? (schedule.problem ?? "Runs while Arcex is open") : "Runs while Arcex is open";
  return (
    <div className="settings schedules">
      <div className="sbody">
        <div className="scol">
          <h2>Schedules</h2>
          <p className="sdesc">
            A schedule sends a prompt to an agent at set times, each run as a new thread you can read later. On Windows they run even when Arcex is
            closed, with no window. Each run uses your plan like any thread.
          </p>
          {!list && <p className="muted">Looking…</p>}
          {list && (list.length > 0 || !draft) && (
            <div className="card">
              {list.length === 0 && !draft && (
                <div className="srow"><div><b>No schedules yet</b><p>Such as a morning check of the project, or a weekly tidy-up.</p></div><div className="control"><span /></div></div>
              )}
              {list.map((schedule) => (
                <div key={schedule.id} className="srow cconn">
                  <div>
                    <b>{schedule.name}</b>
                    <p>
                      {describeWhen(schedule.when)} · {projectName(schedule.projectId)} · {nameOf(schedule.provider)}{schedule.model ? ` ${schedule.model.name}` : ""}
                    </p>
                    <p>
                      {schedule.on && schedule.nextRun ? `Next run ${clock(schedule.nextRun)}. ` : "Paused. "}
                      {schedule.lastRun ? (schedule.lastRun.skipped ? `Skipped ${clock(schedule.lastRun.at)}: ${schedule.lastRun.skipped}. ` : `Last ran ${clock(schedule.lastRun.at)}. `) : ""}
                      <span className={schedule.background === "failed" ? "warnnote" : ""}>{where(schedule)}.</span>
                    </p>
                  </div>
                  <div className="control">
                    {schedule.lastRun?.threadId && <button className="link" onClick={() => props.open(schedule.lastRun!.threadId!)}>Last run</button>}
                    <button className="link" disabled={busy === schedule.id} onClick={() => act(schedule.id, () => call("schedules.runNow", { id: schedule.id }).then((thread) => props.open(thread.id)))}>Run now</button>
                    <button className="link" onClick={() => setDraft(edit(schedule))}>Edit</button>
                    <button className="link" disabled={busy === schedule.id} onClick={() => act(schedule.id, () => call("schedules.remove", { id: schedule.id }))}>Remove</button>
                    <button
                      className="switch"
                      role="switch"
                      aria-checked={schedule.on}
                      aria-label={`${schedule.name} schedule`}
                      disabled={busy === schedule.id}
                      onClick={() => act(schedule.id, () => call("schedules.save", { schedule: { id: schedule.id, on: !schedule.on } }))}
                    >
                      <span />
                    </button>
                  </div>
                </div>
              ))}
              {!draft && (
                <div className="srow"><div /><div className="control"><button className="btn primary" disabled={!props.projects.length} onClick={() => setDraft(fresh())}><Icon name="plus" /> New schedule</button></div></div>
              )}
            </div>
          )}
          {draft && (
            <>
              <h2 className="sub2">{draft.id ? `Change ${draft.name || "schedule"}` : "New schedule"}</h2>
              <div className="card">
                <div className="srow"><div><b>Name</b></div><div className="control"><input className="textfield" value={draft.name} maxLength={80} placeholder="Morning check" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div></div>
                <div className="srow"><div><b>Project</b></div><div className="control">
                  <select className="textfield" value={draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}>
                    {props.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div></div>
                <div className="srow"><div><b>Prompt</b><p>What the agent is asked each time.</p></div><div className="control">
                  <textarea className="textfield cpairs schedprompt" value={draft.prompt} rows={4} maxLength={20000} placeholder="Check the project still builds and list anything that looks broken." onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
                </div></div>
                <div className="srow"><div><b>When</b></div><div className="control schedwhen">
                  <select className="textfield" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft["kind"] })}>
                    <option value="daily">Every day</option>
                    <option value="weekdays">Weekdays</option>
                    <option value="weekly">Every week</option>
                    <option value="hourly">Every few hours</option>
                  </select>
                  {draft.kind === "weekly" && (
                    <select className="textfield" value={draft.day} onChange={(e) => setDraft({ ...draft, day: Number(e.target.value) })}>
                      {DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
                    </select>
                  )}
                  {draft.kind === "hourly" ? (
                    <select className="textfield" value={draft.every} onChange={(e) => setDraft({ ...draft, every: Number(e.target.value) })}>
                      {[1, 2, 3, 4, 6, 8, 12].map((n) => <option key={n} value={n}>{n === 1 ? "Every hour" : `Every ${n} hours`}</option>)}
                    </select>
                  ) : (
                    <input className="textfield" type="time" value={draft.time} aria-label="Time" onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
                  )}
                </div></div>
                {!draft.id && (
                  <div className="srow"><div><b>Agent</b><p>Your default agent and model. Change the default from the model menu under any message box.</p></div><div className="control"><span className="mono">{nameOf(props.settings.defaultProvider)} · {props.settings.defaultModel?.name ?? "Default model"}</span></div></div>
                )}
                <div className="srow"><div /><div className="control">
                  <button className="btn" onClick={() => setDraft(null)}>Cancel</button>
                  <button className="btn primary" disabled={busy === "save" || !draft.name.trim() || !draft.prompt.trim() || !draft.projectId} onClick={save}>{busy === "save" ? "Saving…" : draft.id ? "Save" : "Add schedule"}</button>
                </div></div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
