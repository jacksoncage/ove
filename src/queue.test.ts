import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { TaskQueue, type Task } from "./queue";

describe("TaskQueue", () => {
  let queue: TaskQueue;

  beforeEach(() => {
    const db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
    queue = new TaskQueue(db);
  });

  it("enqueues and dequeues a task", () => {
    const id = queue.enqueue({
      userId: "slack:U123",
      repo: "my-app",
      prompt: "fix the login bug",
    });
    expect(id).toBeDefined();

    const task = queue.dequeue();
    expect(task).not.toBeNull();
    expect(task!.prompt).toBe("fix the login bug");
    expect(task!.status).toBe("running");
  });

  it("returns null when queue is empty", () => {
    const task = queue.dequeue();
    expect(task).toBeNull();
  });

  it("completes a task with result", () => {
    const id = queue.enqueue({
      userId: "slack:U123",
      repo: "my-app",
      prompt: "test",
    });
    queue.dequeue();
    queue.complete(id, "Done successfully");

    const task = queue.get(id);
    expect(task!.status).toBe("completed");
    expect(task!.result).toBe("Done successfully");
    expect(task!.completedAt).toBeDefined();
  });

  it("fails a task with error", () => {
    const id = queue.enqueue({
      userId: "slack:U123",
      repo: "my-app",
      prompt: "test",
    });
    queue.dequeue();
    queue.fail(id, "Something broke");

    const task = queue.get(id);
    expect(task!.status).toBe("failed");
    expect(task!.result).toBe("Something broke");
  });

  it("lists recent tasks for a user", () => {
    queue.enqueue({ userId: "slack:U123", repo: "a", prompt: "task 1" });
    queue.enqueue({ userId: "slack:U123", repo: "b", prompt: "task 2" });
    queue.enqueue({ userId: "slack:U456", repo: "a", prompt: "task 3" });

    const tasks = queue.listByUser("slack:U123", 10);
    expect(tasks.length).toBe(2);
  });

  it("skips repo if another task is running on it", () => {
    queue.enqueue({ userId: "slack:U123", repo: "my-app", prompt: "task 1" });
    queue.enqueue({ userId: "slack:U123", repo: "my-app", prompt: "task 2" });

    const first = queue.dequeue();
    expect(first).not.toBeNull();

    const second = queue.dequeue();
    expect(second).toBeNull();
  });

  it("stores and retrieves taskType", () => {
    const id = queue.enqueue({
      userId: "slack:U123",
      repo: "my-app",
      prompt: "create it",
      taskType: "create-project",
    });
    const task = queue.get(id);
    expect(task!.taskType).toBe("create-project");
  });

  it("taskType defaults to null when not provided", () => {
    const id = queue.enqueue({
      userId: "slack:U123",
      repo: "my-app",
      prompt: "do something",
    });
    const task = queue.get(id);
    expect(task!.taskType).toBeNull();
  });

  it("preserves taskType through dequeue", () => {
    queue.enqueue({
      userId: "slack:U123",
      repo: "my-app",
      prompt: "discuss this",
      taskType: "discuss",
    });
    const task = queue.dequeue();
    expect(task!.taskType).toBe("discuss");
  });

  it("default priority is 0", () => {
    const id = queue.enqueue({
      userId: "slack:U123",
      repo: "my-app",
      prompt: "normal task",
    });
    const task = queue.get(id);
    expect(task!.priority).toBe(0);
  });

  it("stores and retrieves priority", () => {
    const id = queue.enqueue({
      userId: "slack:U123",
      repo: "my-app",
      prompt: "urgent task",
      priority: 2,
    });
    const task = queue.get(id);
    expect(task!.priority).toBe(2);
  });

  it("preserves priority through dequeue", () => {
    queue.enqueue({
      userId: "slack:U123",
      repo: "my-app",
      prompt: "high priority task",
      priority: 1,
    });
    const task = queue.dequeue();
    expect(task!.priority).toBe(1);
  });

  it("dequeues higher priority tasks before lower priority", () => {
    // Enqueue low priority first, then high priority
    queue.enqueue({
      userId: "slack:U123",
      repo: "repo-a",
      prompt: "normal task",
      priority: 0,
    });
    queue.enqueue({
      userId: "slack:U123",
      repo: "repo-b",
      prompt: "urgent task",
      priority: 2,
    });
    queue.enqueue({
      userId: "slack:U123",
      repo: "repo-c",
      prompt: "high task",
      priority: 1,
    });

    // Should dequeue urgent (2) first, then high (1), then normal (0)
    const first = queue.dequeue();
    expect(first!.prompt).toBe("urgent task");
    expect(first!.priority).toBe(2);

    const second = queue.dequeue();
    expect(second!.prompt).toBe("high task");
    expect(second!.priority).toBe(1);

    const third = queue.dequeue();
    expect(third!.prompt).toBe("normal task");
    expect(third!.priority).toBe(0);
  });

  it("dequeues by FIFO within same priority", () => {
    queue.enqueue({
      userId: "slack:U123",
      repo: "repo-a",
      prompt: "first normal",
      priority: 0,
    });
    queue.enqueue({
      userId: "slack:U123",
      repo: "repo-b",
      prompt: "second normal",
      priority: 0,
    });

    const first = queue.dequeue();
    expect(first!.prompt).toBe("first normal");

    const second = queue.dequeue();
    expect(second!.prompt).toBe("second normal");
  });

  describe("metrics()", () => {
    it("returns zeroes on empty queue", () => {
      const m = queue.metrics();
      expect(m.counts).toEqual({ pending: 0, running: 0, completed: 0, failed: 0 });
      expect(m.avgDurationByRepo).toEqual([]);
      expect(m.throughput.lastHour).toBe(0);
      expect(m.throughput.last24h).toBe(0);
      expect(m.errorRate).toBe(0);
      expect(m.repoBreakdown).toEqual([]);
    });

    it("returns correct counts by status", () => {
      queue.enqueue({ userId: "u1", repo: "a", prompt: "p1" });
      const id2 = queue.enqueue({ userId: "u1", repo: "b", prompt: "p2" });
      queue.dequeue(); // dequeues repo "a" -> running
      // repo "b" is still pending since "a" is running but different repo, so dequeue "b"
      const task2 = queue.dequeue();
      if (task2) queue.complete(task2.id, "done");

      const m = queue.metrics();
      expect(m.counts.running).toBe(1);
      expect(m.counts.completed).toBe(1);
    });

    it("computes average duration by repo", () => {
      const id1 = queue.enqueue({ userId: "u1", repo: "app-a", prompt: "p1" });
      queue.dequeue();
      queue.complete(id1, "ok");

      const id2 = queue.enqueue({ userId: "u1", repo: "app-a", prompt: "p2" });
      queue.dequeue();
      queue.complete(id2, "ok");

      const m = queue.metrics();
      expect(m.avgDurationByRepo.length).toBe(1);
      expect(m.avgDurationByRepo[0].repo).toBe("app-a");
      expect(m.avgDurationByRepo[0].count).toBe(2);
      expect(m.avgDurationByRepo[0].avgMs).toBeGreaterThanOrEqual(0);
    });

    it("computes throughput for recent tasks", () => {
      const id = queue.enqueue({ userId: "u1", repo: "x", prompt: "p" });
      queue.dequeue();
      queue.complete(id, "done");

      const m = queue.metrics();
      expect(m.throughput.lastHour).toBe(1);
      expect(m.throughput.last24h).toBe(1);
    });

    it("computes error rate", () => {
      const id1 = queue.enqueue({ userId: "u1", repo: "a", prompt: "p1" });
      queue.dequeue();
      queue.complete(id1, "ok");

      const id2 = queue.enqueue({ userId: "u1", repo: "a", prompt: "p2" });
      queue.dequeue();
      queue.fail(id2, "broken");

      const m = queue.metrics();
      // 1 failed out of 2 finished = 0.5
      expect(m.errorRate).toBe(0.5);
    });

    it("returns per-repo breakdown", () => {
      queue.enqueue({ userId: "u1", repo: "alpha", prompt: "p1" });
      queue.enqueue({ userId: "u1", repo: "beta", prompt: "p2" });
      queue.enqueue({ userId: "u2", repo: "alpha", prompt: "p3" });

      const m = queue.metrics();
      expect(m.repoBreakdown.length).toBe(2);
      const alpha = m.repoBreakdown.find((r) => r.repo === "alpha");
      expect(alpha).toBeDefined();
      expect(alpha!.pending).toBe(2);
      const beta = m.repoBreakdown.find((r) => r.repo === "beta");
      expect(beta).toBeDefined();
      expect(beta!.pending).toBe(1);
    });

    it("error rate is zero when no finished tasks", () => {
      queue.enqueue({ userId: "u1", repo: "x", prompt: "p" });
      const m = queue.metrics();
      expect(m.errorRate).toBe(0);
    });
  });
});
