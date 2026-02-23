import { Database } from "bun:sqlite";
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
