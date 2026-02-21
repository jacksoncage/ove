import { logger } from "./logger";
import type { CronTaskConfig } from "./config";

export function parseCronField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }

  const values: number[] = [];
  for (const part of field.split(",")) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let i = start; i <= end; i++) values.push(i);
    } else if (part.includes("/")) {
      const [, step] = part.split("/").map(Number);
      for (let i = min; i <= max; i += step) values.push(i);
    } else {
      values.push(Number(part));
    }
  }
  return values;
}

export function shouldRun(cronExpr: string, now: Date): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cronExpr.split(" ");

  const minutes = parseCronField(minute, 0, 59);
  const hours = parseCronField(hour, 0, 23);
  const doms = parseCronField(dayOfMonth, 1, 31);
  const months = parseCronField(month, 1, 12);
  const dows = parseCronField(dayOfWeek, 0, 6);

  return (
    minutes.includes(now.getMinutes()) &&
    hours.includes(now.getHours()) &&
    doms.includes(now.getDate()) &&
    months.includes(now.getMonth() + 1) &&
    dows.includes(now.getDay())
  );
}

export type CronTask = CronTaskConfig;

export function checkCron(
  tasks: CronTask[],
  onTrigger: (task: CronTask) => void,
  now: Date,
  firedMinutes: Set<string>
): void {
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  if (firedMinutes.has(minuteKey)) return;

  let triggered = false;
  for (const task of tasks) {
    if (shouldRun(task.schedule, now)) {
      logger.info("cron triggered", { schedule: task.schedule, repo: task.repo });
      onTrigger(task);
      triggered = true;
    }
  }
  if (triggered) {
    firedMinutes.add(minuteKey);
    // Keep set from growing forever
    if (firedMinutes.size > 5) {
      const first = firedMinutes.values().next().value;
      if (first) firedMinutes.delete(first);
    }
  }
}

export function startCronLoop(
  tasks: CronTask[] | (() => CronTask[]),
  onTrigger: (task: CronTask) => void
): NodeJS.Timeout {
  const firedMinutes = new Set<string>();
  return setInterval(() => {
    const taskList = typeof tasks === "function" ? tasks() : tasks;
    checkCron(taskList, onTrigger, new Date(), firedMinutes);
  }, 10_000);
}
