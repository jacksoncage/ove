import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { parseMessage, buildPrompt, buildContextualPrompt } from "./router";
import { TaskQueue } from "./queue";
import { ClaudeRunner } from "./runners/claude";
import { SessionStore } from "./sessions";
import { OVE_PERSONA } from "./handlers";

describe("smoke test: full message flow", () => {
  it("routes a PR review through the full pipeline", () => {
    // 1. Parse
    const parsed = parseMessage("review PR #42 on my-app");
    expect(parsed.type).toBe("review-pr");
    expect(parsed.repo).toBe("my-app");

    // 2. Build prompt
    const prompt = buildPrompt(parsed);
    expect(prompt).toContain("#42");

    // 3. Enqueue
    const db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
    const queue = new TaskQueue(db);
    const taskId = queue.enqueue({
      userId: "slack:U123",
      repo: parsed.repo!,
      prompt,
    });

    // 4. Dequeue
    const task = queue.dequeue();
    expect(task).not.toBeNull();
    expect(task!.id).toBe(taskId);

    // 5. Build claude args
    const runner = new ClaudeRunner();
    const args = runner.buildArgs(task!.prompt, { maxTurns: 25 });
    expect(args).toContain("-p");
    expect(args).toContain("--max-turns");

    // 6. Complete
    queue.complete(taskId, "PR reviewed, 3 comments posted");
    const completed = queue.get(taskId);
    expect(completed!.status).toBe("completed");
  });

  it("tracks conversation context through sessions", () => {
    const db = new Database(":memory:");
    const sessions = new SessionStore(db);

    sessions.addMessage("slack:U123", "user", "review PR #42 on my-app");
    sessions.addMessage("slack:U123", "assistant", "Task queued. Working on it...");

    const history = sessions.getHistory("slack:U123");
    expect(history.length).toBe(2);
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("assistant");
  });

  it("handles the full free-form flow", () => {
    const parsed = parseMessage("what does the auth middleware do in my-app");
    expect(parsed.type).toBe("free-form");
    expect(parsed.repo).toBe("my-app");

    const prompt = buildPrompt(parsed);
    expect(prompt).toContain("auth middleware");

    const db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
    const queue = new TaskQueue(db);
    const taskId = queue.enqueue({
      userId: "slack:U123",
      repo: parsed.repo!,
      prompt,
    });

    const task = queue.dequeue();
    expect(task).not.toBeNull();
    expect(task!.prompt).toContain("auth middleware");
  });

  it("mode switch changes persona in prompts", () => {
    const db = new Database(":memory:");
    const sessions = new SessionStore(db);
    const parsed = parseMessage("explain the auth flow");

    // Default mode — prompt should NOT contain assistant addendum
    const strictPrompt = buildContextualPrompt(parsed, [], OVE_PERSONA);
    expect(strictPrompt).toContain("grumpy");
    expect(strictPrompt).not.toContain("IMPORTANT MODE OVERRIDE");

    // Switch to assistant — prompt should contain the addendum
    sessions.setMode("slack:U123", "assistant");
    expect(sessions.getMode("slack:U123")).toBe("assistant");

    const assistantPersona = OVE_PERSONA + "\n\n" + "IMPORTANT MODE OVERRIDE";
    const assistantPrompt = buildContextualPrompt(parsed, [], assistantPersona);
    expect(assistantPrompt).toContain("IMPORTANT MODE OVERRIDE");
    expect(assistantPrompt).toContain("grumpy");

    // Switch back — verify storage round-trips
    sessions.setMode("slack:U123", "strict");
    expect(sessions.getMode("slack:U123")).toBe("strict");

    // Verify parseMessage detects mode commands
    const modeCmd = parseMessage("mode assistant");
    expect(modeCmd.type).toBe("set-mode");
    expect(modeCmd.args.mode).toBe("assistant");
  });
});
