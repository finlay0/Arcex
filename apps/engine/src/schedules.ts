import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Schedule, ScheduleWhen } from "@arcex/contracts";

/**
 * Prompts that run on a schedule. Finlay chose (November 22) to have them run even when Arcex is closed: on Windows,
 * each schedule gets a task in Task Scheduler that starts the engine with no window, runs the prompt as a normal
 * thread, and exits when it's done. When Arcex is open, the run goes to the open engine instead. Elsewhere, or if the
 * task can't be made, the open engine runs schedules itself.
 */

/** How to start this engine from a scheduled task. */
/** How a task starts the engine: `node` with `args` before the schedule's own flags (from source: tsx and src/main.ts; installed: Arcex.exe alone). */
export type Launch = { node: string; args: string[]; cwd: string; dataDir: string };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function cleanWhen(raw: unknown): ScheduleWhen {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (input.kind === "hourly") {
    const every = Number(input.every);
    if (!Number.isInteger(every) || every < 1 || every > 12) throw new Error("run it every 1 to 12 hours");
    return { kind: "hourly", every };
  }
  const time = String(input.time ?? "");
  if (!TIME.test(time)) throw new Error("choose a time, such as 09:00");
  if (input.kind === "daily" || input.kind === "weekdays") return { kind: input.kind, time };
  if (input.kind === "weekly") {
    const day = Number(input.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error("choose a day of the week");
    return { kind: "weekly", day, time };
  }
  throw new Error("choose when it runs");
}

/** The next time the schedule is due after `from`, in local time. */
export function nextRun(when: ScheduleWhen, from: number, anchor: number): number {
  if (when.kind === "hourly") {
    const step = when.every * 3_600_000;
    return anchor + Math.max(1, Math.ceil((from - anchor + 1) / step)) * step;
  }
  const [hours, minutes] = when.time.split(":").map(Number) as [number, number];
  const day = new Date(from);
  for (let offset = 0; offset < 8; offset++) {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset, hours, minutes, 0, 0);
    if (at.getTime() <= from) continue;
    const weekday = at.getDay();
    if (when.kind === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (when.kind === "weekly" && weekday !== when.day) continue;
    return at.getTime();
  }
  return from + 86_400_000;
}

export function describeWhen(when: ScheduleWhen): string {
  if (when.kind === "hourly") return when.every === 1 ? "Every hour" : `Every ${when.every} hours`;
  if (when.kind !== "weekly") return when.kind === "daily" ? `Every day at ${when.time}` : `Weekdays at ${when.time}`;
  return `Every ${DAYS[when.day]} at ${when.time}`;
}

const taskName = (id: string) => `\\Arcex\\schedule-${id}`;
const xmlText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const local = (time: number) => {
  const at = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:00`;
};

function trigger(when: ScheduleWhen, anchor: number): string {
  if (when.kind === "hourly") {
    return `<TimeTrigger><StartBoundary>${local(anchor + when.every * 3_600_000)}</StartBoundary><Enabled>true</Enabled><Repetition><Interval>PT${when.every}H</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>`;
  }
  const start = local(nextRun(when, Date.now(), anchor));
  if (when.kind === "daily") return `<CalendarTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`;
  const days = when.kind === "weekly" ? [DAYS[when.day]] : DAYS.slice(1, 6);
  return `<CalendarTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek>${days.map((day) => `<${day} />`).join("")}</DaysOfWeek></ScheduleByWeek></CalendarTrigger>`;
}

/** The task: start the engine for this schedule with no window, catch up once after a missed time, stop after 3 hours. */
export function taskXml(schedule: Schedule, launch: Launch): string {
  const args = `--headless "${launch.node}" ${launch.args.map((arg) => `"${arg}"`).join(" ")} --run-schedule ${schedule.id} --data-dir "${launch.dataDir}"`.replace(/  +/g, " ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xmlText(`Arcex: ${schedule.name}`)}</Description></RegistrationInfo>
  <Triggers>${trigger(schedule.when, schedule.createdAt)}</Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT3H</ExecutionTimeLimit>
    <Enabled>${schedule.on ? "true" : "false"}</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>conhost.exe</Command><Arguments>${xmlText(args)}</Arguments><WorkingDirectory>${xmlText(launch.cwd)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

function schtasks(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("schtasks.exe", args, { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ ok: false, output: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

/** Creates or replaces the schedule's task. Throws with Task Scheduler's reason when it can't. */
export async function saveTask(schedule: Schedule, launch: Launch): Promise<void> {
  const file = path.join(os.tmpdir(), `arcex-task-${schedule.id}.xml`);
  // Task Scheduler reads its XML as UTF-16.
  await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(schedule, launch), "utf16le")]));
  try {
    const result = await schtasks(["/Create", "/F", "/TN", taskName(schedule.id), "/XML", file]);
    if (!result.ok) throw new Error(result.output.split(/\r?\n/).pop()?.replace(/^ERROR:\s*/i, "").slice(0, 300) || "Task Scheduler refused it");
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}

export async function removeTask(id: string): Promise<void> {
  await schtasks(["/Delete", "/F", "/TN", taskName(id)]);
}
