import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ScheduleStore, type Schedule } from "./schedules";

describe("ScheduleStore", () => {
  let db: Database;
  let store: ScheduleStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
    store = new ScheduleStore(db);
  });

  it("creates a schedule and returns its id", () => {
    const id = store.create({
      userId: "slack:U123",
      repo: "my-app",
      prompt: "run lint and tests",
      schedule: "0 9 * * *",
      description: "every day at 09:00",
    });
    expect(id).toBeGreaterThan(0);
  });

  it("lists schedules for a user", () => {
    store.create({ userId: "slack:U123", repo: "my-app", prompt: "lint", schedule: "0 9 * * *", description: "daily 9" });
    store.create({ userId: "slack:U999", repo: "other", prompt: "test", schedule: "0 17 * * *", description: "daily 17" });

    const list = store.listByUser("slack:U123");
    expect(list).toHaveLength(1);
    expect(list[0].prompt).toBe("lint");
  });

  it("removes a schedule owned by the user", () => {
    const id = store.create({ userId: "slack:U123", repo: "my-app", prompt: "lint", schedule: "0 9 * * *", description: "daily 9" });
    const removed = store.remove("slack:U123", id);
    expect(removed).toBe(true);
    expect(store.listByUser("slack:U123")).toHaveLength(0);
  });

  it("does not remove another user's schedule", () => {
    const id = store.create({ userId: "slack:U123", repo: "my-app", prompt: "lint", schedule: "0 9 * * *", description: "daily 9" });
    const removed = store.remove("slack:U999", id);
    expect(removed).toBe(false);
    expect(store.listByUser("slack:U123")).toHaveLength(1);
  });

  it("getAll returns all schedules", () => {
    store.create({ userId: "slack:U123", repo: "a", prompt: "lint", schedule: "0 9 * * *", description: "daily 9" });
    store.create({ userId: "slack:U999", repo: "b", prompt: "test", schedule: "0 17 * * *", description: "daily 17" });
    expect(store.getAll()).toHaveLength(2);
  });
});
