import { describe, test, expect } from "bun:test";
import type { IncomingMessage, ChatAdapter, IncomingEvent, EventAdapter } from "./types";

describe("adapter types", () => {
  test("IncomingMessage accepts any string as platform", () => {
    const msg: IncomingMessage = {
      userId: "telegram:123",
      platform: "telegram",
      text: "hello",
      reply: async () => {},
      updateStatus: async () => {},
    };
    expect(msg.platform).toBe("telegram");
  });

  test("IncomingEvent has expected shape", () => {
    const event: IncomingEvent = {
      eventId: "evt-1",
      userId: "github:user",
      platform: "github",
      source: { type: "issue", repo: "my-repo", number: 42 },
      text: "fix this",
    };
    expect(event.source.type).toBe("issue");
    expect(event.eventId).toBe("evt-1");
  });

  test("IncomingEvent supports http source", () => {
    const event: IncomingEvent = {
      eventId: "evt-2",
      userId: "http:anon",
      platform: "http",
      source: { type: "http", requestId: "req-abc" },
      text: "do something",
    };
    expect(event.source.type).toBe("http");
  });
});
