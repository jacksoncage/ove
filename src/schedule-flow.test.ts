import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ScheduleStore } from "./schedules";
import { parseMessage } from "./router";
import { checkCron, type CronTask } from "./cron";

describe("schedule flow", () => {
  let db: Database;
  let store: ScheduleStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new ScheduleStore(db);
  });

  it("router detects schedule intent", () => {
    const parsed = parseMessage("lint every day at 9 on my-app");
    expect(parsed.type).toBe("schedule");
  });

  it("stored schedule is picked up by cron", () => {
    store.create({
      userId: "slack:U123",
      repo: "my-app",
      prompt: "run lint",
      schedule: "0 9 * * *",
      description: "daily at 09:00",
    });

    const all = store.getAll();
    const cronTasks: CronTask[] = all.map((s) => ({
      schedule: s.schedule,
      repo: s.repo,
      prompt: s.prompt,
      userId: s.userId,
    }));

    const triggered: string[] = [];
    const now = new Date("2026-03-01T09:00:00");
    checkCron(cronTasks, (t) => triggered.push(t.prompt), now, new Set());

    expect(triggered).toEqual(["run lint"]);
  });

  it("removed schedule is no longer triggered", () => {
    const id = store.create({
      userId: "slack:U123",
      repo: "my-app",
      prompt: "run lint",
      schedule: "0 9 * * *",
      description: "daily at 09:00",
    });
    store.remove("slack:U123", id);

    const cronTasks: CronTask[] = store.getAll().map((s) => ({
      schedule: s.schedule,
      repo: s.repo,
      prompt: s.prompt,
      userId: s.userId,
    }));

    const triggered: string[] = [];
    checkCron(cronTasks, (t) => triggered.push(t.prompt), new Date("2026-03-01T09:00:00"), new Set());

    expect(triggered).toHaveLength(0);
  });
});
