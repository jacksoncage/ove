import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { TraceStore } from "../trace";
import { TaskQueue } from "../queue";
import type { IncomingEvent } from "./types";

let adapter: any;
let receivedEvents: IncomingEvent[];
const TEST_PORT = 19876;
const API_KEY = "test-key-123";

describe("HttpApiAdapter", () => {
  beforeAll(async () => {
    const { HttpApiAdapter } = await import("./http");
    receivedEvents = [];
    const db = new Database(":memory:");
    const trace = new TraceStore(db);
    const queue = new TaskQueue(db);
    adapter = new HttpApiAdapter(TEST_PORT, API_KEY, trace, queue);
    await adapter.start((event: IncomingEvent) => {
      receivedEvents.push(event);
    });
  });

  afterAll(async () => {
    await adapter.stop();
  });

  test("rejects requests without API key", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  test("accepts message with valid API key", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
      },
      body: JSON.stringify({ text: "fix the bug" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.eventId).toBeDefined();
    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0].text).toBe("fix the bug");
    expect(receivedEvents[0].platform).toBe("http");
  });

  test("get task status returns pending for unknown event", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/message/nonexistent`, {
      headers: { "X-API-Key": API_KEY },
    });
    expect(res.status).toBe(404);
  });

  test("respondToEvent stores result retrievable via GET", async () => {
    // Submit a message first
    const postRes = await fetch(`http://localhost:${TEST_PORT}/api/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
      },
      body: JSON.stringify({ text: "test task" }),
    });
    const { eventId } = await postRes.json();

    // Respond to it
    await adapter.respondToEvent(eventId, "Done. Fixed it.");

    // Retrieve result
    const getRes = await fetch(`http://localhost:${TEST_PORT}/api/message/${eventId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    expect(getRes.status).toBe(200);
    const result = await getRes.json();
    expect(result.status).toBe("completed");
    expect(result.result).toBe("Done. Fixed it.");
  });

  test("serves web UI at /", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<html");
  });
});

// --- Webhook tests ---

const WEBHOOK_PORT = 19877;
const WEBHOOK_API_KEY = "webhook-test-key";
const WEBHOOK_SECRET = "test-webhook-secret-123";
const BOT_NAME = "ove";

function signPayload(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function makeIssueCommentPayload(overrides?: Record<string, any>) {
  return {
    action: "created",
    comment: {
      body: `@${BOT_NAME} fix the flaky test`,
      user: { login: "testuser" },
      id: 12345,
    },
    issue: {
      number: 42,
      pull_request: undefined,
    },
    repository: {
      full_name: "acme/my-app",
    },
    ...overrides,
  };
}

function makePRReviewCommentPayload(overrides?: Record<string, any>) {
  return {
    action: "created",
    comment: {
      body: `@${BOT_NAME} refactor this function`,
      user: { login: "reviewer" },
      id: 67890,
    },
    pull_request: {
      number: 99,
    },
    repository: {
      full_name: "acme/my-app",
    },
    ...overrides,
  };
}

describe("GitHub webhook endpoint", () => {
  let webhookAdapter: any;
  let webhookEvents: IncomingEvent[];

  beforeAll(async () => {
    const { HttpApiAdapter } = await import("./http");
    webhookEvents = [];
    const db = new Database(":memory:");
    const trace = new TraceStore(db);
    const queue = new TaskQueue(db);
    webhookAdapter = new HttpApiAdapter(
      WEBHOOK_PORT, WEBHOOK_API_KEY, trace, queue,
      undefined, "127.0.0.1", WEBHOOK_SECRET, BOT_NAME
    );
    await webhookAdapter.start((event: IncomingEvent) => {
      webhookEvents.push(event);
    });
  });

  afterAll(async () => {
    await webhookAdapter.stop();
  });

  test("accepts issue_comment with valid signature", async () => {
    const payload = makeIssueCommentPayload();
    const body = JSON.stringify(payload);
    const signature = signPayload(WEBHOOK_SECRET, body);

    const res = await fetch(`http://localhost:${WEBHOOK_PORT}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "issue_comment",
      },
      body,
    });

    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.ok).toBe(true);
    expect(result.eventId).toBe("github:acme/my-app:issue:42");

    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0].text).toBe("fix the flaky test");
    expect(webhookEvents[0].userId).toBe("github:testuser");
    expect(webhookEvents[0].platform).toBe("github");
    expect(webhookEvents[0].source).toEqual({ type: "issue", repo: "acme/my-app", number: 42 });
  });

  test("accepts pull_request_review_comment with valid signature", async () => {
    webhookEvents.length = 0;
    const payload = makePRReviewCommentPayload();
    const body = JSON.stringify(payload);
    const signature = signPayload(WEBHOOK_SECRET, body);

    const res = await fetch(`http://localhost:${WEBHOOK_PORT}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "pull_request_review_comment",
      },
      body,
    });

    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.ok).toBe(true);
    expect(result.eventId).toBe("github:acme/my-app:pr:99");

    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0].text).toBe("refactor this function");
    expect(webhookEvents[0].userId).toBe("github:reviewer");
    expect(webhookEvents[0].source).toEqual({ type: "pr", repo: "acme/my-app", number: 99 });
  });

  test("rejects GitHub webhook with invalid signature", async () => {
    webhookEvents.length = 0;
    const payload = makeIssueCommentPayload();
    const body = JSON.stringify(payload);

    const res = await fetch(`http://localhost:${WEBHOOK_PORT}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=invalid_signature_here",
        "X-GitHub-Event": "issue_comment",
      },
      body,
    });

    expect(res.status).toBe(401);
    const result = await res.json();
    expect(result.error).toBe("Invalid signature");
    expect(webhookEvents.length).toBe(0);
  });

  test("rejects GitHub webhook without signature header", async () => {
    const payload = makeIssueCommentPayload();
    const body = JSON.stringify(payload);

    const res = await fetch(`http://localhost:${WEBHOOK_PORT}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issue_comment",
      },
      body,
    });

    expect(res.status).toBe(401);
    const result = await res.json();
    expect(result.error).toBe("Missing signature");
  });

  test("skips comments without @mention", async () => {
    webhookEvents.length = 0;
    const payload = makeIssueCommentPayload({
      comment: { body: "just a regular comment", user: { login: "testuser" }, id: 111 },
    });
    const body = JSON.stringify(payload);
    const signature = signPayload(WEBHOOK_SECRET, body);

    const res = await fetch(`http://localhost:${WEBHOOK_PORT}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "issue_comment",
      },
      body,
    });

    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("No mention found");
    expect(webhookEvents.length).toBe(0);
  });

  test("skips unsupported GitHub event types", async () => {
    const payload = makeIssueCommentPayload();
    const body = JSON.stringify(payload);
    const signature = signPayload(WEBHOOK_SECRET, body);

    const res = await fetch(`http://localhost:${WEBHOOK_PORT}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "push",
      },
      body,
    });

    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("Unsupported event");
  });

  test("skips bot's own comments to prevent infinite loops", async () => {
    webhookEvents.length = 0;
    const payload = makeIssueCommentPayload({
      comment: { body: `@${BOT_NAME} fix the flaky test`, user: { login: BOT_NAME }, id: 99999 },
    });
    const body = JSON.stringify(payload);
    const signature = signPayload(WEBHOOK_SECRET, body);

    const res = await fetch(`http://localhost:${WEBHOOK_PORT}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "issue_comment",
      },
      body,
    });

    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("Own comment");
    expect(webhookEvents.length).toBe(0);
  });

  test("rejects oversized GitHub webhook payload", async () => {
    webhookEvents.length = 0;
    // Create a payload larger than 1MB
    const payload = makeIssueCommentPayload({
      comment: { body: `@${BOT_NAME} ${"x".repeat(1_100_000)}`, user: { login: "testuser" }, id: 88888 },
    });
    const body = JSON.stringify(payload);
    const signature = signPayload(WEBHOOK_SECRET, body);

    const res = await fetch(`http://localhost:${WEBHOOK_PORT}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "issue_comment",
      },
      body,
    });

    expect(res.status).toBe(413);
    const result = await res.json();
    expect(result.error).toContain("Payload too large");
    expect(webhookEvents.length).toBe(0);
  });

  test("detects PR from issue_comment on a pull request", async () => {
    webhookEvents.length = 0;
    const payload = makeIssueCommentPayload({
      issue: { number: 55, pull_request: { url: "https://api.github.com/repos/acme/my-app/pulls/55" } },
    });
    const body = JSON.stringify(payload);
    const signature = signPayload(WEBHOOK_SECRET, body);

    const res = await fetch(`http://localhost:${WEBHOOK_PORT}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "issue_comment",
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(webhookEvents.length).toBe(1);
    expect(webhookEvents[0].source).toEqual({ type: "pr", repo: "acme/my-app", number: 55 });
  });
});

describe("Generic webhook endpoint", () => {
  let genericAdapter: any;
  let genericEvents: IncomingEvent[];
  const GENERIC_PORT = 19878;

  beforeAll(async () => {
    const { HttpApiAdapter } = await import("./http");
    genericEvents = [];
    const db = new Database(":memory:");
    const trace = new TraceStore(db);
    const queue = new TaskQueue(db);
    genericAdapter = new HttpApiAdapter(GENERIC_PORT, WEBHOOK_API_KEY, trace, queue);
    await genericAdapter.start((event: IncomingEvent) => {
      genericEvents.push(event);
    });
  });

  afterAll(async () => {
    await genericAdapter.stop();
  });

  test("accepts generic webhook with valid API key", async () => {
    const res = await fetch(`http://localhost:${GENERIC_PORT}/api/webhooks/generic`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": WEBHOOK_API_KEY,
      },
      body: JSON.stringify({
        repo: "my-app",
        text: "run tests",
        userId: "webhook:ci",
      }),
    });

    expect(res.status).toBe(202);
    const result = await res.json();
    expect(result.ok).toBe(true);
    expect(result.eventId).toBeDefined();

    expect(genericEvents.length).toBe(1);
    expect(genericEvents[0].text).toBe("run tests");
    expect(genericEvents[0].userId).toBe("webhook:ci");
    expect(genericEvents[0].platform).toBe("webhook");
  });

  test("rejects generic webhook without API key", async () => {
    genericEvents.length = 0;
    const res = await fetch(`http://localhost:${GENERIC_PORT}/api/webhooks/generic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: "my-app",
        text: "run tests",
      }),
    });

    expect(res.status).toBe(401);
    expect(genericEvents.length).toBe(0);
  });

  test("rejects generic webhook with missing repo", async () => {
    const res = await fetch(`http://localhost:${GENERIC_PORT}/api/webhooks/generic`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": WEBHOOK_API_KEY,
      },
      body: JSON.stringify({ text: "run tests" }),
    });

    expect(res.status).toBe(400);
    const result = await res.json();
    expect(result.error).toContain("repo");
  });

  test("rejects generic webhook with missing text", async () => {
    const res = await fetch(`http://localhost:${GENERIC_PORT}/api/webhooks/generic`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": WEBHOOK_API_KEY,
      },
      body: JSON.stringify({ repo: "my-app" }),
    });

    expect(res.status).toBe(400);
    const result = await res.json();
    expect(result.error).toContain("text");
  });

  test("passes repo field through in EventSource", async () => {
    genericEvents.length = 0;
    const res = await fetch(`http://localhost:${GENERIC_PORT}/api/webhooks/generic`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": WEBHOOK_API_KEY,
      },
      body: JSON.stringify({
        repo: "acme/my-service",
        text: "deploy to staging",
      }),
    });

    expect(res.status).toBe(202);
    expect(genericEvents.length).toBe(1);
    expect(genericEvents[0].source).toMatchObject({ type: "http", repo: "acme/my-service" });
    expect((genericEvents[0].source as any).repo).toBe("acme/my-service");
  });

  test("rejects oversized generic webhook payload", async () => {
    genericEvents.length = 0;
    const res = await fetch(`http://localhost:${GENERIC_PORT}/api/webhooks/generic`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": WEBHOOK_API_KEY,
      },
      body: JSON.stringify({
        repo: "my-app",
        text: "x".repeat(1_100_000),
      }),
    });

    expect(res.status).toBe(413);
    const result = await res.json();
    expect(result.error).toContain("Payload too large");
    expect(genericEvents.length).toBe(0);
  });

  test("uses default userId when not provided", async () => {
    genericEvents.length = 0;
    const res = await fetch(`http://localhost:${GENERIC_PORT}/api/webhooks/generic`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": WEBHOOK_API_KEY,
      },
      body: JSON.stringify({
        repo: "my-app",
        text: "deploy",
      }),
    });

    expect(res.status).toBe(202);
    expect(genericEvents.length).toBe(1);
    expect(genericEvents[0].userId).toBe("webhook:generic");
  });
});
