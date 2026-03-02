import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createMessageHandler, createEventHandler, OVE_PERSONA, type HandlerDeps } from "./handlers";
import { TaskQueue } from "./queue";
import { SessionStore } from "./sessions";
import { ScheduleStore } from "./schedules";
import { RepoRegistry } from "./repo-registry";
import { TraceStore } from "./trace";
import type { IncomingMessage, IncomingEvent, EventAdapter } from "./adapters/types";
import type { AgentRunner } from "./runner";
import type { Config } from "./config";


// --- Helpers ---

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    repos: { "my-app": { url: "git@github.com:org/my-app.git", defaultBranch: "main" } },
    users: { "slack:U123": { name: "testuser", repos: ["my-app"] } },
    claude: { maxTurns: 25 },
    reposDir: "/tmp/test-repos",
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<HandlerDeps>): HandlerDeps {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode = WAL");
  const queue = new TaskQueue(db);
  const sessions = new SessionStore(db);
  const schedules = new ScheduleStore(db);
  const repoRegistry = new RepoRegistry(db);
  const trace = new TraceStore(db);

  repoRegistry.upsert({
    name: "my-app",
    url: "git@github.com:org/my-app.git",
    source: "config",
    defaultBranch: "main",
  });

  const stubRunner: AgentRunner = {
    name: "stub",
    run: async (prompt: string) => ({
      success: true,
      output: "stub output",
      durationMs: 100,
    }),
  };

  return {
    config: makeConfig(),
    queue,
    sessions,
    schedules,
    repoRegistry,
    trace,
    pendingReplies: new Map(),
    pendingEventReplies: new Map(),
    runningProcesses: new Map(),
    getRunner: () => stubRunner,
    getRunnerForRepo: () => stubRunner,
    getRepoInfo: (name: string) => {
      if (name === "my-app") return { url: "git@github.com:org/my-app.git", defaultBranch: "main" };
      return null;
    },
    ...overrides,
  };
}

function makeMessage(text: string, userId = "slack:U123", platform = "slack"): IncomingMessage & { replies: string[]; statuses: string[] } {
  const replies: string[] = [];
  const statuses: string[] = [];
  return {
    userId,
    platform,
    text,
    replies,
    statuses,
    reply: async (t: string) => { replies.push(t); },
    updateStatus: async (t: string) => { statuses.push(t); },
  };
}

// --- Tests ---

describe("handleSetMode", () => {
  let deps: HandlerDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("sets assistant mode and replies with Swedish flair", async () => {
    const handler = createMessageHandler(deps);
    const msg = makeMessage("mode assistant");

    await handler(msg);

    expect(deps.sessions.getMode("slack:U123")).toBe("assistant");
    expect(msg.replies.length).toBe(1);
    expect(msg.replies[0]).toContain("Assistant mode");
  });

  it("sets strict mode and replies accordingly", async () => {
    const handler = createMessageHandler(deps);
    deps.sessions.setMode("slack:U123", "assistant");

    const msg = makeMessage("mode strict");
    await handler(msg);

    expect(deps.sessions.getMode("slack:U123")).toBe("strict");
    expect(msg.replies.length).toBe(1);
    expect(msg.replies[0]).toContain("code mode");
  });

  it("stores mode reply in session history", async () => {
    const handler = createMessageHandler(deps);
    const msg = makeMessage("mode assistant");

    await handler(msg);

    const history = deps.sessions.getHistory("slack:U123");
    // Should have user message + assistant reply
    expect(history.length).toBe(2);
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("mode assistant");
    expect(history[1].role).toBe("assistant");
    expect(history[1].content).toContain("Assistant mode");
  });

  it("rejects invalid mode values with error message", async () => {
    const handler = createMessageHandler(deps);
    // parseMessage won't match "mode banana" as set-mode — it will be free-form.
    // But we can still test via the handler by checking what parseMessage routes it to.
    // Since parseMessage only matches "assistant" and "strict", "mode banana" becomes free-form.
    // Let's verify the router rejects it at the parse level.
    const { parseMessage } = await import("./router");
    const parsed = parseMessage("mode banana");
    expect(parsed.type).toBe("free-form"); // Not set-mode — router rejects invalid modes
  });

  it("natural language triggers assistant mode", async () => {
    const handler = createMessageHandler(deps);
    const msg = makeMessage("assistant mode");

    await handler(msg);

    expect(deps.sessions.getMode("slack:U123")).toBe("assistant");
    expect(msg.replies[0]).toContain("Assistant mode");
  });

  it("natural language triggers strict mode", async () => {
    const handler = createMessageHandler(deps);
    deps.sessions.setMode("slack:U123", "assistant");

    const msg = makeMessage("back to normal");
    await handler(msg);

    expect(deps.sessions.getMode("slack:U123")).toBe("strict");
    expect(msg.replies[0]).toContain("code mode");
  });
});

describe("getPersona (tested via createMessageHandler discuss path)", () => {
  it("uses base OVE_PERSONA in strict mode (default)", async () => {
    const deps = makeDeps({
      config: makeConfig({
        repos: {},
        users: { "slack:U123": { name: "testuser", repos: [] } },
      }),
    });

    const handler = createMessageHandler(deps);
    const msg = makeMessage("discuss testing strategies");
    await handler(msg);

    const tasks = deps.queue.listByUser("slack:U123", 1);
    expect(tasks.length).toBe(1);
    expect(tasks[0].taskType).toBe("discuss");
    expect(tasks[0].prompt).toContain("grumpy");
    expect(tasks[0].prompt).not.toContain("IMPORTANT MODE OVERRIDE");
  });

  it("appends ASSISTANT_ADDENDUM in assistant mode", async () => {
    const deps = makeDeps({
      config: makeConfig({
        repos: {},
        users: { "slack:U123": { name: "testuser", repos: [] } },
      }),
    });

    // Set assistant mode before sending the discuss message
    deps.sessions.setMode("slack:U123", "assistant");

    const handler = createMessageHandler(deps);
    const msg = makeMessage("discuss testing strategies");
    await handler(msg);

    const tasks = deps.queue.listByUser("slack:U123", 1);
    expect(tasks.length).toBe(1);
    expect(tasks[0].prompt).toContain("grumpy");
    expect(tasks[0].prompt).toContain("IMPORTANT MODE OVERRIDE");
    expect(tasks[0].prompt).toContain("general-purpose assistant");
  });
});

describe("createEventHandler reads mode for event.userId", () => {
  it("uses assistant persona when event user is in assistant mode", async () => {
    const deps = makeDeps();
    let capturedPrompt = "";

    // Track enqueued task prompts by intercepting the queue
    const originalEnqueue = deps.queue.enqueue.bind(deps.queue);
    deps.queue.enqueue = (input) => {
      capturedPrompt = input.prompt;
      return originalEnqueue(input);
    };

    // Set assistant mode for the user
    deps.sessions.setMode("slack:U123", "assistant");

    const handler = createEventHandler(deps);
    const event: IncomingEvent = {
      eventId: "evt-1",
      userId: "slack:U123",
      platform: "github",
      source: { type: "pr", repo: "org/my-app", number: 5 },
      text: "review PR #5 on my-app",
    };

    const adapter: EventAdapter = {
      start: async () => {},
      stop: async () => {},
      respondToEvent: async () => {},
    };

    await handler(event, adapter);

    expect(capturedPrompt).toContain("IMPORTANT MODE OVERRIDE");
    expect(capturedPrompt).toContain("grumpy");
  });

  it("uses strict persona by default for event user", async () => {
    const deps = makeDeps();
    let capturedPrompt = "";

    const originalEnqueue = deps.queue.enqueue.bind(deps.queue);
    deps.queue.enqueue = (input) => {
      capturedPrompt = input.prompt;
      return originalEnqueue(input);
    };

    const handler = createEventHandler(deps);
    const event: IncomingEvent = {
      eventId: "evt-2",
      userId: "slack:U123",
      platform: "github",
      source: { type: "pr", repo: "org/my-app", number: 5 },
      text: "review PR #5 on my-app",
    };

    const adapter: EventAdapter = {
      start: async () => {},
      stop: async () => {},
      respondToEvent: async () => {},
    };

    await handler(event, adapter);

    expect(capturedPrompt).not.toContain("IMPORTANT MODE OVERRIDE");
    expect(capturedPrompt).toContain("grumpy");
  });
});

describe("integration: set mode then send message verifies prompt contains addendum", () => {
  it("set mode → send discuss → enqueued prompt has ASSISTANT_ADDENDUM", async () => {
    const deps = makeDeps({
      config: makeConfig({
        repos: {},
        users: { "slack:U123": { name: "testuser", repos: [] } },
      }),
    });

    const handler = createMessageHandler(deps);

    // Step 1: set assistant mode
    const modeMsg = makeMessage("mode assistant");
    await handler(modeMsg);
    expect(deps.sessions.getMode("slack:U123")).toBe("assistant");

    // Step 2: send a discuss-type message (enqueued as discuss task)
    const chatMsg = makeMessage("discuss best Italian restaurants nearby");
    await handler(chatMsg);

    const tasks = deps.queue.listByUser("slack:U123", 1);
    expect(tasks[0].prompt).toContain("IMPORTANT MODE OVERRIDE");
    expect(tasks[0].prompt).toContain("willing to help with ANY request");
    expect(tasks[0].prompt).toContain("grumpy");
  });

  it("set strict mode → send discuss → enqueued prompt has NO addendum", async () => {
    const deps = makeDeps({
      config: makeConfig({
        repos: {},
        users: { "slack:U123": { name: "testuser", repos: [] } },
      }),
    });

    const handler = createMessageHandler(deps);

    // Step 1: explicitly set strict mode (should be default, but be explicit)
    const modeMsg = makeMessage("mode strict");
    await handler(modeMsg);
    expect(deps.sessions.getMode("slack:U123")).toBe("strict");

    // Step 2: send a discuss-type message
    const chatMsg = makeMessage("discuss architecture patterns");
    await handler(chatMsg);

    const tasks = deps.queue.listByUser("slack:U123", 1);
    expect(tasks[0].prompt).not.toContain("IMPORTANT MODE OVERRIDE");
    expect(tasks[0].prompt).toContain("grumpy");
  });

  it("task enqueue for repo-bound message includes addendum in assistant mode", async () => {
    const deps = makeDeps();

    // Set assistant mode
    deps.sessions.setMode("slack:U123", "assistant");

    const handler = createMessageHandler(deps);
    const msg = makeMessage("review PR #10 on my-app");
    await handler(msg);

    // The task was enqueued — check the prompt in pendingReplies
    // pendingReplies maps taskId → msg, but we need the prompt from the queue
    const tasks = deps.queue.listByUser("slack:U123", 1);
    expect(tasks.length).toBe(1);
    expect(tasks[0].prompt).toContain("IMPORTANT MODE OVERRIDE");
    expect(tasks[0].prompt).toContain("grumpy");
  });
});

describe("mode toggle round-trip", () => {
  it("toggling between modes reflects correctly in persona", async () => {
    const deps = makeDeps({
      config: makeConfig({
        repos: {},
        users: { "slack:U123": { name: "testuser", repos: [] } },
      }),
    });

    const handler = createMessageHandler(deps);

    // Start in strict → discuss → no addendum
    const msg1 = makeMessage("discuss testing");
    await handler(msg1);
    const tasks1 = deps.queue.listByUser("slack:U123", 10);
    expect(tasks1[0].prompt).not.toContain("IMPORTANT MODE OVERRIDE");

    // Toggle to assistant
    const modeMsg = makeMessage("mode assistant");
    await handler(modeMsg);

    // Discuss again → addendum present
    const msg2 = makeMessage("discuss testing again");
    await handler(msg2);
    const tasks2 = deps.queue.listByUser("slack:U123", 10);
    expect(tasks2[0].prompt).toContain("IMPORTANT MODE OVERRIDE");

    // Toggle back to strict
    const strictMsg = makeMessage("mode strict");
    await handler(strictMsg);

    // Discuss again → no addendum
    const msg3 = makeMessage("discuss testing one more time");
    await handler(msg3);
    const tasks3 = deps.queue.listByUser("slack:U123", 10);
    expect(tasks3[0].prompt).not.toContain("IMPORTANT MODE OVERRIDE");
  });
});

describe("handleSetMode stores user message in history", () => {
  it("user's mode command appears in history even for invalid routing", async () => {
    const deps = makeDeps();
    const handler = createMessageHandler(deps);

    // Valid mode command
    const msg = makeMessage("mode assistant");
    await handler(msg);

    const history = deps.sessions.getHistory("slack:U123");
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("mode assistant");
  });
});

describe("OVE_PERSONA export", () => {
  it("OVE_PERSONA contains expected personality traits", () => {
    expect(OVE_PERSONA).toContain("grumpy");
    expect(OVE_PERSONA).toContain("Swedish");
    expect(OVE_PERSONA).toContain("Ove");
    expect(OVE_PERSONA).toContain("meticulous");
  });
});

describe("clear command resets mode to strict", () => {
  it("after setting assistant mode, clear resets mode back to strict", async () => {
    const deps = makeDeps();
    const handler = createMessageHandler(deps);

    // Set assistant mode
    const modeMsg = makeMessage("mode assistant");
    await handler(modeMsg);
    expect(deps.sessions.getMode("slack:U123")).toBe("assistant");

    // Send clear command
    const clearMsg = makeMessage("clear");
    await handler(clearMsg);

    // Mode should be back to strict (default) since clear deletes the mode row
    expect(deps.sessions.getMode("slack:U123")).toBe("strict");
    expect(clearMsg.replies[0]).toContain("Conversation cleared");
  });

  it("after clear, discuss prompt no longer contains ASSISTANT_ADDENDUM", async () => {
    const deps = makeDeps({
      config: makeConfig({
        repos: {},
        users: { "slack:U123": { name: "testuser", repos: [] } },
      }),
    });

    const handler = createMessageHandler(deps);

    // Set assistant mode
    const modeMsg = makeMessage("mode assistant");
    await handler(modeMsg);
    expect(deps.sessions.getMode("slack:U123")).toBe("assistant");

    // Clear session
    const clearMsg = makeMessage("clear");
    await handler(clearMsg);

    // Send discuss message — should NOT have addendum since mode was cleared
    const chatMsg = makeMessage("discuss something fun");
    await handler(chatMsg);

    const tasks = deps.queue.listByUser("slack:U123", 1);
    expect(tasks[0].prompt).toContain("grumpy");
    expect(tasks[0].prompt).not.toContain("IMPORTANT MODE OVERRIDE");
  });
});

describe("multi-user mode isolation", () => {
  it("User A in assistant mode does not affect User B in strict mode", async () => {
    const deps = makeDeps({
      config: makeConfig({
        repos: {},
        users: {
          "slack:U123": { name: "userA", repos: [] },
          "slack:U456": { name: "userB", repos: [] },
        },
      }),
    });

    const handler = createMessageHandler(deps);

    // User A sets assistant mode
    const modeMsg = makeMessage("mode assistant", "slack:U123");
    await handler(modeMsg);
    expect(deps.sessions.getMode("slack:U123")).toBe("assistant");

    // User B stays in default (strict) mode
    expect(deps.sessions.getMode("slack:U456")).toBe("strict");

    // User A sends discuss message — should have ASSISTANT_ADDENDUM
    const msgA = makeMessage("discuss best pizza places", "slack:U123");
    await handler(msgA);

    const tasksA = deps.queue.listByUser("slack:U123", 1);
    expect(tasksA[0].prompt).toContain("IMPORTANT MODE OVERRIDE");
    expect(tasksA[0].prompt).toContain("grumpy");

    // User B sends discuss message — should NOT have ASSISTANT_ADDENDUM
    const msgB = makeMessage("discuss architecture patterns", "slack:U456");
    await handler(msgB);

    const tasksB = deps.queue.listByUser("slack:U456", 1);
    expect(tasksB[0].prompt).not.toContain("IMPORTANT MODE OVERRIDE");
    expect(tasksB[0].prompt).toContain("grumpy");
  });
});
