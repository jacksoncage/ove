import { describe, it, expect } from "bun:test";
import { parseCronField, shouldRun, checkCron, startCronLoop, type CronTask } from "./cron";

describe("cron", () => {
  it("matches a simple schedule", () => {
    const now = new Date("2026-02-21T09:00:00");
    expect(shouldRun("0 9 * * *", now)).toBe(true);
  });

  it("does not match wrong hour", () => {
    const now = new Date("2026-02-21T10:00:00");
    expect(shouldRun("0 9 * * *", now)).toBe(false);
  });

  it("matches weekday filter", () => {
    const sat = new Date("2026-02-21T09:00:00");
    expect(shouldRun("0 9 * * 1-5", sat)).toBe(false);

    const mon = new Date("2026-02-23T09:00:00");
    expect(shouldRun("0 9 * * 1-5", mon)).toBe(true);
  });

  it("parses cron field with ranges", () => {
    expect(parseCronField("1-5", 0, 6)).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses wildcard", () => {
    expect(parseCronField("*", 0, 23).length).toBe(24);
  });

  it("does not double-trigger within the same minute", () => {
    const triggers: string[] = [];
    const task: CronTask = { schedule: "* * * * *", repo: "test", prompt: "run", userId: "u1" };

    const now = new Date("2026-01-15T10:30:00");
    const firedMinutes = new Set<string>();
    checkCron([task], (t) => triggers.push(t.repo), now, firedMinutes);
    checkCron([task], (t) => triggers.push(t.repo), now, firedMinutes);

    expect(triggers.length).toBe(1);
  });

  it("triggers again in the next minute", () => {
    const triggers: string[] = [];
    const task: CronTask = { schedule: "* * * * *", repo: "test", prompt: "run", userId: "u1" };
    const firedMinutes = new Set<string>();

    const t1 = new Date("2026-01-15T10:30:00");
    const t2 = new Date("2026-01-15T10:31:00");

    checkCron([task], (t) => triggers.push(t.repo), t1, firedMinutes);
    checkCron([task], (t) => triggers.push(t.repo), t2, firedMinutes);

    expect(triggers.length).toBe(2);
  });

  it("accepts a task provider function", () => {
    const triggers: string[] = [];
    const task: CronTask = { schedule: "* * * * *", repo: "test", prompt: "run", userId: "u1" };

    const timer = startCronLoop(() => [task], (t) => triggers.push(t.repo));
    clearInterval(timer);
    // Just verify it doesn't throw — the function signature is the test
  });
});
