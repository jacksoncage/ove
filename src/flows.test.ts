import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { parseMessage, buildPrompt, buildContextualPrompt, type ParsedMessage } from "./router";
import { TaskQueue } from "./queue";
import { SessionStore } from "./sessions";

describe("Conversational flow routing", () => {
  describe("discuss flows", () => {
    it("routes 'I have a new idea' to discuss", () => {
      const result = parseMessage("I have a new idea");
      expect(result.type).toBe("discuss");
    });

    it("routes 'I have an idea about X' to discuss", () => {
      const result = parseMessage("I have an idea about notifications");
      expect(result.type).toBe("discuss");
    });

    it("routes 'discuss notification service' to discuss with topic", () => {
      const result = parseMessage("discuss notification service");
      expect(result.type).toBe("discuss");
      expect(result.args.topic).toBe("notification service");
    });

    it("routes 'brainstorm auth flow' to discuss", () => {
      const result = parseMessage("brainstorm auth flow");
      expect(result.type).toBe("discuss");
      expect(result.args.topic).toBe("auth flow");
    });
  });

  describe("create-project flows", () => {
    it("routes 'create project my-api' correctly", () => {
      const result = parseMessage("create project my-api");
      expect(result.type).toBe("create-project");
      expect(result.args.name).toBe("my-api");
      expect(result.args.template).toBeUndefined();
    });

    it("routes 'new project my-api with template express' correctly", () => {
      const result = parseMessage("new project my-api with template express");
      expect(result.type).toBe("create-project");
      expect(result.args.name).toBe("my-api");
      expect(result.args.template).toBe("express");
    });

    it("routes 'Create project my-service' (capitalized)", () => {
      const result = parseMessage("Create project my-service");
      expect(result.type).toBe("create-project");
      expect(result.args.name).toBe("my-service");
    });
  });

  describe("existing task type flows", () => {
    it("routes 'validate infra-salming-ai'", () => {
      const result = parseMessage("validate infra-salming-ai");
      expect(result.type).toBe("validate");
      expect(result.repo).toBe("infra-salming-ai");
    });

    it("routes 'simplify src/auth.ts in my-app'", () => {
      const result = parseMessage("simplify src/auth.ts in my-app");
      expect(result.type).toBe("simplify");
      expect(result.repo).toBe("my-app");
      expect(result.args.filePath).toBe("src/auth.ts");
    });

    it("routes 'review PR #42 on my-app'", () => {
      const result = parseMessage("review PR #42 on my-app");
      expect(result.type).toBe("review-pr");
      expect(result.repo).toBe("my-app");
      expect(result.args.prNumber).toBe(42);
    });

    it("routes 'fix issue #15 on infra'", () => {
      const result = parseMessage("fix issue #15 on infra");
      expect(result.type).toBe("fix-issue");
      expect(result.repo).toBe("infra");
      expect(result.args.issueNumber).toBe(15);
    });

    it("routes 'what does this function do in my-app' as free-form with repo hint", () => {
      const result = parseMessage("what does this function do in my-app");
      expect(result.type).toBe("free-form");
      expect(result.repo).toBe("my-app");
    });
  });

  describe("meta commands", () => {
    it("routes 'status'", () => {
      expect(parseMessage("status").type).toBe("status");
    });

    it("routes 'history'", () => {
      expect(parseMessage("history").type).toBe("history");
    });

    it("routes 'my tasks' as history", () => {
      expect(parseMessage("my tasks").type).toBe("history");
    });

    it("routes 'help'", () => {
      expect(parseMessage("help").type).toBe("help");
    });

    it("routes 'clear'", () => {
      expect(parseMessage("clear").type).toBe("clear");
    });

    it("routes 'reset' as clear", () => {
      expect(parseMessage("reset").type).toBe("clear");
    });
  });
});

describe("buildPrompt produces reasonable prompts", () => {
  it("review-pr prompt mentions PR number and gh pr review", () => {
    const prompt = buildPrompt({ type: "review-pr", repo: "x", args: { prNumber: 42 }, rawText: "" });
    expect(prompt).toContain("#42");
    expect(prompt).toContain("gh pr review");
    expect(prompt).toContain("bugs");
  });

  it("fix-issue prompt mentions issue number and PR", () => {
    const prompt = buildPrompt({ type: "fix-issue", repo: "x", args: { issueNumber: 15 }, rawText: "" });
    expect(prompt).toContain("#15");
    expect(prompt).toContain("fix");
    expect(prompt).toContain("PR");
  });

  it("simplify prompt mentions file path", () => {
    const prompt = buildPrompt({ type: "simplify", repo: "x", args: { filePath: "src/auth.ts" }, rawText: "" });
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("readability");
  });

  it("validate prompt says not to modify files", () => {
    const prompt = buildPrompt({ type: "validate", repo: "x", args: {}, rawText: "" });
    expect(prompt).toContain("test suite");
    expect(prompt).toContain("Do not modify");
  });

  it("create-project prompt includes project name and gh repo create", () => {
    const prompt = buildPrompt({ type: "create-project", args: { name: "my-api" }, rawText: "" });
    expect(prompt).toContain("my-api");
    expect(prompt).toContain("gh repo create");
  });

  it("create-project prompt with template", () => {
    const prompt = buildPrompt({ type: "create-project", args: { name: "x", template: "express" }, rawText: "" });
    expect(prompt).toContain("express template");
  });

  it("discuss prompt mentions brainstorming and no code changes", () => {
    const prompt = buildPrompt({ type: "discuss", args: { topic: "notifications" }, rawText: "" });
    expect(prompt).toContain("brainstorming");
    expect(prompt).toContain("notifications");
    expect(prompt).toContain("Do not make any code changes");
  });

  it("free-form prompt is the raw text", () => {
    const prompt = buildPrompt({ type: "free-form", args: {}, rawText: "explain the auth flow" });
    expect(prompt).toBe("explain the auth flow");
  });
});

describe("Conversation context prepending", () => {
  it("context prefix format is correct", () => {
    // Simulate what index.ts does
    const history = [
      { role: "user", content: "what is this codebase about", timestamp: "" },
      { role: "assistant", content: "It's a web framework", timestamp: "" },
      { role: "user", content: "explain the auth middleware", timestamp: "" },
    ];
    const contextPrefix = history.length > 1
      ? "Previous conversation:\n" +
        history.slice(0, -1).map((m) => `${m.role}: ${m.content}`).join("\n") +
        "\n\nCurrent request:\n"
      : "";
    const parsed = parseMessage("explain the auth middleware");
    const prompt = contextPrefix + buildPrompt(parsed);

    expect(prompt).toContain("Previous conversation:");
    expect(prompt).toContain("user: what is this codebase about");
    expect(prompt).toContain("assistant: It's a web framework");
    expect(prompt).toContain("Current request:");
    expect(prompt).toContain("explain the auth middleware");
  });

  it("no context prefix for first message", () => {
    const history = [
      { role: "user", content: "hello", timestamp: "" },
    ];
    const contextPrefix = history.length > 1
      ? "Previous conversation:\n" +
        history.slice(0, -1).map((m) => `${m.role}: ${m.content}`).join("\n") +
        "\n\nCurrent request:\n"
      : "";
    expect(contextPrefix).toBe("");
  });
});

describe("buildContextualPrompt", () => {
  it("prepends persona and context for message with history", () => {
    const history = [
      { role: "user" as const, content: "hello", timestamp: "" },
      { role: "assistant" as const, content: "hi", timestamp: "" },
      { role: "user" as const, content: "fix the bug", timestamp: "" },
    ];
    const parsed = parseMessage("fix the login bug in my-app");
    const persona = "You are Ove";
    const result = buildContextualPrompt(parsed, history, persona);

    expect(result).toContain("You are Ove");
    expect(result).toContain("Previous conversation:");
    expect(result).toContain("user: hello");
    expect(result).toContain("assistant: hi");
    expect(result).toContain("Current request:");
  });

  it("skips context prefix when history has only one message", () => {
    const history = [
      { role: "user" as const, content: "fix the bug", timestamp: "" },
    ];
    const parsed = parseMessage("fix the bug in my-app");
    const result = buildContextualPrompt(parsed, history, "You are Ove");

    expect(result).toContain("You are Ove");
    expect(result).not.toContain("Previous conversation:");
    expect(result).toContain("fix the bug");
  });

  it("works with empty history", () => {
    const parsed = parseMessage("fix the bug in my-app");
    const result = buildContextualPrompt(parsed, [], "You are Ove");

    expect(result).toContain("You are Ove");
    expect(result).not.toContain("Previous conversation:");
  });
});

describe("Conversation-aware repo resolution", () => {
  it("derives lastRepo from recent task history", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
    const queue = new TaskQueue(db);

    const taskId = queue.enqueue({
      userId: "telegram:U1",
      repo: "iris",
      prompt: "check the roadmap",
    });
    queue.dequeue();
    queue.complete(taskId, "Here's the roadmap...");

    const recent = queue.listByUser("telegram:U1", 1);
    expect(recent.length).toBe(1);
    expect(recent[0].repo).toBe("iris");
  });
});

describe("Queue round-trip with taskType", () => {
  let queue: TaskQueue;

  beforeEach(() => {
    const db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
    queue = new TaskQueue(db);
  });

  it("enqueue → dequeue → complete for create-project", () => {
    const id = queue.enqueue({
      userId: "slack:U123",
      repo: "my-api",
      prompt: 'Create a new project called "my-api"',
      taskType: "create-project",
    });

    const task = queue.dequeue();
    expect(task).not.toBeNull();
    expect(task!.id).toBe(id);
    expect(task!.taskType).toBe("create-project");
    expect(task!.status).toBe("running");

    queue.complete(id, "Project created");
    const completed = queue.get(id);
    expect(completed!.status).toBe("completed");
    expect(completed!.result).toBe("Project created");
    expect(completed!.taskType).toBe("create-project");
  });

  it("enqueue → dequeue → complete for discuss", () => {
    const id = queue.enqueue({
      userId: "slack:U123",
      repo: "_discuss",
      prompt: "Act as a brainstorming partner",
      taskType: "discuss",
    });

    const task = queue.dequeue();
    expect(task!.taskType).toBe("discuss");

    queue.complete(id, "Great discussion");
    const completed = queue.get(id);
    expect(completed!.status).toBe("completed");
  });

  it("enqueue → dequeue → fail preserves taskType", () => {
    const id = queue.enqueue({
      userId: "slack:U123",
      repo: "my-api",
      prompt: "test",
      taskType: "create-project",
    });

    queue.dequeue();
    queue.fail(id, "Something went wrong");
    const failed = queue.get(id);
    expect(failed!.status).toBe("failed");
    expect(failed!.taskType).toBe("create-project");
  });

  it("regular tasks have null taskType", () => {
    const id = queue.enqueue({
      userId: "slack:U123",
      repo: "my-app",
      prompt: "Review PR #1",
    });

    const task = queue.dequeue();
    expect(task!.taskType).toBeNull();
  });
});

describe("Full follow-up conversation flow", () => {
  it("follow-up message without repo uses last task's repo", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
    const queue = new TaskQueue(db);
    const sessions = new SessionStore(db);

    // Simulate conversation: user talked about iris
    sessions.addMessage("telegram:U1", "user", "check the roadmap on iris");
    sessions.addMessage("telegram:U1", "assistant", "Here's the iris roadmap...");
    sessions.addMessage("telegram:U1", "user", "what about tomorrow's plan");

    // Simulate a completed task on iris
    const taskId = queue.enqueue({
      userId: "telegram:U1",
      repo: "iris",
      prompt: "check the roadmap",
    });
    queue.dequeue();
    queue.complete(taskId, "Here's the roadmap...");

    // Now a follow-up: "what about tomorrow" — no repo mentioned
    const parsed = parseMessage("what about tomorrow's plan");
    expect(parsed.type).toBe("free-form");
    expect(parsed.repo).toBeUndefined(); // Router can't find repo in text

    // But the last task was on iris
    const recentTasks = queue.listByUser("telegram:U1", 5);
    const lastRepo = recentTasks.find(t => t.status === "completed" || t.status === "failed")?.repo;
    expect(lastRepo).toBe("iris");

    // And the conversation history mentions iris
    const history = sessions.getHistory("telegram:U1", 6);
    expect(history.some(m => m.content.includes("iris"))).toBe(true);
  });

  it("explicit repo in message overrides last task repo", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
    const queue = new TaskQueue(db);

    // Last task was on iris
    const taskId = queue.enqueue({
      userId: "telegram:U1",
      repo: "iris",
      prompt: "check roadmap",
    });
    queue.dequeue();
    queue.complete(taskId, "done");

    // But new message explicitly says "on docs"
    const parsed = parseMessage("check the tests on docs");
    expect(parsed.repo).toBe("docs"); // Regex hint takes priority
  });

  it("lastRepo only considers completed/failed tasks, not pending", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
    const queue = new TaskQueue(db);

    // Completed task on iris
    const task1 = queue.enqueue({
      userId: "telegram:U1",
      repo: "iris",
      prompt: "check roadmap",
    });
    queue.dequeue();
    queue.complete(task1, "done");

    // Pending task on docs (enqueued but not completed)
    queue.enqueue({
      userId: "telegram:U1",
      repo: "docs",
      prompt: "pending work",
    });

    // lastRepo should be iris (completed), not docs (pending)
    const recentTasks = queue.listByUser("telegram:U1", 5);
    const lastRepo = recentTasks.find(t => t.status === "completed" || t.status === "failed")?.repo;
    expect(lastRepo).toBe("iris");
  });

  it("LLM resolver prompt includes conversation history", () => {
    const db = new Database(":memory:");
    const sessions = new SessionStore(db);

    sessions.addMessage("telegram:U1", "user", "check the roadmap on iris");
    sessions.addMessage("telegram:U1", "assistant", "Here's the iris roadmap...");
    sessions.addMessage("telegram:U1", "user", "what about tomorrow");

    const history = sessions.getHistory("telegram:U1", 6);
    const historyContext = history.length > 1
      ? "Recent conversation:\n" + history.slice(0, -1).map(m => `${m.role}: ${m.content}`).join("\n") + "\n\n"
      : "";
    const resolvePrompt = `You are a repo-name resolver. ${historyContext}The user's latest message:\n"what about tomorrow"\n\nAvailable repos: iris, docs, my-app\n\nRespond with ONLY the repo name that best matches their request. Consider the conversation context if the current message doesn't mention a specific repo. Nothing else — just the exact repo name from the list. If you cannot determine which repo, respond with "UNKNOWN".`;

    expect(resolvePrompt).toContain("Recent conversation:");
    expect(resolvePrompt).toContain("check the roadmap on iris");
    expect(resolvePrompt).toContain("Here's the iris roadmap");
    expect(resolvePrompt).toContain("what about tomorrow");
    expect(resolvePrompt).toContain("iris, docs, my-app");
    expect(resolvePrompt).toContain("Consider the conversation context");
  });
});
