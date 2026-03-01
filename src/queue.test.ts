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
});
