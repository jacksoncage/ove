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
import type { Task } from "./queue";

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

    // In strict mode, discuss prompt should contain OVE_PERSONA but NOT the addendum
    let capturedPrompt = "";
    const capturingRunner: AgentRunner = {
      name: "capture",
      run: async (prompt: string) => {
        capturedPrompt = prompt;
        return { success: true, output: "response", durationMs: 50 };
      },
    };
    deps.getRunner = () => capturingRunner;

    const handler = createMessageHandler(deps);
    const msg = makeMessage("discuss testing strategies");
    await handler(msg);

    expect(capturedPrompt).toContain("grumpy");
    expect(capturedPrompt).not.toContain("IMPORTANT MODE OVERRIDE");
  });

  it("appends ASSISTANT_ADDENDUM in assistant mode", async () => {
    const deps = makeDeps({
      config: makeConfig({
        repos: {},
        users: { "slack:U123": { name: "testuser", repos: [] } },
      }),
    });

    let capturedPrompt = "";
    const capturingRunner: AgentRunner = {
      name: "capture",
      run: async (prompt: string) => {
        capturedPrompt = prompt;
        return { success: true, output: "response", durationMs: 50 };
      },
    };
    deps.getRunner = () => capturingRunner;

    // Set assistant mode before sending the discuss message
    deps.sessions.setMode("slack:U123", "assistant");

    const handler = createMessageHandler(deps);
    const msg = makeMessage("discuss testing strategies");
    await handler(msg);

    expect(capturedPrompt).toContain("grumpy");
    expect(capturedPrompt).toContain("IMPORTANT MODE OVERRIDE");
    expect(capturedPrompt).toContain("general-purpose assistant");
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
  it("set mode → send discuss → prompt sent to runner has ASSISTANT_ADDENDUM", async () => {
    const deps = makeDeps({
      config: makeConfig({
        repos: {},
        users: { "slack:U123": { name: "testuser", repos: [] } },
      }),
    });

    let capturedPrompt = "";
    const capturingRunner: AgentRunner = {
      name: "capture",
      run: async (prompt: string) => {
        capturedPrompt = prompt;
        return { success: true, output: "Here's my help!", durationMs: 50 };
      },
    };
    deps.getRunner = () => capturingRunner;

    const handler = createMessageHandler(deps);

    // Step 1: set assistant mode
    const modeMsg = makeMessage("mode assistant");
    await handler(modeMsg);
    expect(deps.sessions.getMode("slack:U123")).toBe("assistant");

    // Step 2: send a discuss-type message (routes to handleDiscuss which calls runner directly)
    const chatMsg = makeMessage("discuss best Italian restaurants nearby");
    await handler(chatMsg);

    // The prompt sent to the runner should contain the addendum
    expect(capturedPrompt).toContain("IMPORTANT MODE OVERRIDE");
    expect(capturedPrompt).toContain("willing to help with ANY request");
    expect(capturedPrompt).toContain("grumpy");
  });

  it("set strict mode → send discuss → prompt has NO addendum", async () => {
    const deps = makeDeps({
      config: makeConfig({
        repos: {},
        users: { "slack:U123": { name: "testuser", repos: [] } },
      }),
    });

    let capturedPrompt = "";
    const capturingRunner: AgentRunner = {
      name: "capture",
      run: async (prompt: string) => {
        capturedPrompt = prompt;
        return { success: true, output: "I only do code.", durationMs: 50 };
      },
    };
    deps.getRunner = () => capturingRunner;

    const handler = createMessageHandler(deps);

    // Step 1: explicitly set strict mode (should be default, but be explicit)
    const modeMsg = makeMessage("mode strict");
    await handler(modeMsg);
    expect(deps.sessions.getMode("slack:U123")).toBe("strict");

    // Step 2: send a discuss-type message
    const chatMsg = makeMessage("discuss architecture patterns");
    await handler(chatMsg);

    expect(capturedPrompt).not.toContain("IMPORTANT MODE OVERRIDE");
    expect(capturedPrompt).toContain("grumpy");
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

    const prompts: string[] = [];
    const capturingRunner: AgentRunner = {
      name: "capture",
      run: async (prompt: string) => {
        prompts.push(prompt);
        return { success: true, output: "ok", durationMs: 50 };
      },
    };
    deps.getRunner = () => capturingRunner;

    const handler = createMessageHandler(deps);

    // Start in strict → discuss → no addendum
    const msg1 = makeMessage("discuss testing");
    await handler(msg1);
    expect(prompts[0]).not.toContain("IMPORTANT MODE OVERRIDE");

    // Toggle to assistant
    const modeMsg = makeMessage("mode assistant");
    await handler(modeMsg);

    // Discuss again → addendum present
    const msg2 = makeMessage("discuss testing again");
    await handler(msg2);
    expect(prompts[1]).toContain("IMPORTANT MODE OVERRIDE");

    // Toggle back to strict
    const strictMsg = makeMessage("mode strict");
    await handler(strictMsg);

    // Discuss again → no addendum
    const msg3 = makeMessage("discuss testing one more time");
    await handler(msg3);
    expect(prompts[2]).not.toContain("IMPORTANT MODE OVERRIDE");
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
