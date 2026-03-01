import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { IncomingMessage } from "./types";

// Capture registered handlers so we can invoke them in tests
let messageHandler: Function;
let appMentionHandler: Function;
let mockStart: ReturnType<typeof mock>;
let mockStop: ReturnType<typeof mock>;
let mockConversationsOpen: ReturnType<typeof mock>;
let mockChatPostMessage: ReturnType<typeof mock>;
let mockChatUpdate: ReturnType<typeof mock>;

// Mock @slack/bolt before importing the adapter
mock.module("@slack/bolt", () => ({
  App: class FakeApp {
    client = {
      conversations: { open: (...args: any[]) => mockConversationsOpen(...args) },
      chat: {
        postMessage: (...args: any[]) => mockChatPostMessage(...args),
        update: (...args: any[]) => mockChatUpdate(...args),
      },
    };
    message(handler: Function) {
      messageHandler = handler;
    }
    event(name: string, handler: Function) {
      if (name === "app_mention") appMentionHandler = handler;
    }
    start() {
      mockStart();
      return Promise.resolve();
    }
    stop() {
      mockStop();
      return Promise.resolve();
    }
  },
}));

// Import after mocking
const { SlackAdapter } = await import("./slack");

describe("SlackAdapter", () => {
  beforeEach(() => {
    mockStart = mock(() => {});
    mockStop = mock(() => {});
    mockConversationsOpen = mock(() =>
      Promise.resolve({ channel: { id: "C_DM_CHANNEL" } })
    );
    mockChatPostMessage = mock(() => Promise.resolve({ ok: true }));
    mockChatUpdate = mock(() => Promise.resolve({ ok: true }));
  });

  test("module exports SlackAdapter class", async () => {
    const mod = await import("./slack");
    expect(mod.SlackAdapter).toBeDefined();
  });

  test("constructor creates instance without throwing", () => {
    expect(() => new SlackAdapter()).not.toThrow();
  });

  test("getStatus() returns disconnected before start", () => {
    const adapter = new SlackAdapter();
    const status = adapter.getStatus();
    expect(status.name).toBe("slack");
    expect(status.type).toBe("chat");
    expect(status.status).toBe("disconnected");
    expect(status.startedAt).toBeUndefined();
  });

  test("getStatus() returns connected after start", async () => {
    const adapter = new SlackAdapter();
    await adapter.start(() => {});
    const status = adapter.getStatus();
    expect(status.status).toBe("connected");
    expect(status.startedAt).toBeDefined();
  });

  test("start() registers handlers and calls app.start", async () => {
    const adapter = new SlackAdapter();
    await adapter.start(() => {});
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(messageHandler).toBeDefined();
    expect(appMentionHandler).toBeDefined();
  });

  test("message handler ignores messages with subtype", async () => {
    const received: IncomingMessage[] = [];
    const adapter = new SlackAdapter();
    await adapter.start((msg) => received.push(msg));

    await messageHandler({
      message: { subtype: "bot_message", text: "hello", user: "U123", channel: "C1" },
      say: mock(() => Promise.resolve()),
    });

    expect(received).toHaveLength(0);
  });

  test("message handler ignores messages without text", async () => {
    const received: IncomingMessage[] = [];
    const adapter = new SlackAdapter();
    await adapter.start((msg) => received.push(msg));

    await messageHandler({
      message: { user: "U123", channel: "C1" },
      say: mock(() => Promise.resolve()),
    });

    expect(received).toHaveLength(0);
  });

  test("message handler ignores messages without user", async () => {
    const received: IncomingMessage[] = [];
    const adapter = new SlackAdapter();
    await adapter.start((msg) => received.push(msg));

    await messageHandler({
      message: { text: "hello", channel: "C1" },
      say: mock(() => Promise.resolve()),
    });

    expect(received).toHaveLength(0);
  });

  test("message handler delivers valid DM with slack: prefix on userId", async () => {
    const received: IncomingMessage[] = [];
    const adapter = new SlackAdapter();
    await adapter.start((msg) => received.push(msg));

    await messageHandler({
      message: { text: "fix the bug", user: "U42", channel: "C1" },
      say: mock(() => Promise.resolve()),
    });

    expect(received).toHaveLength(1);
    expect(received[0].userId).toBe("slack:U42");
    expect(received[0].platform).toBe("slack");
    expect(received[0].text).toBe("fix the bug");
  });

  test("app_mention handler strips <@MENTION> tags from text", async () => {
    const received: IncomingMessage[] = [];
    const adapter = new SlackAdapter();
    await adapter.start((msg) => received.push(msg));

    await appMentionHandler({
      event: { text: "<@U00BOT> deploy to prod", user: "U99", channel: "C2" },
      say: mock(() => Promise.resolve()),
    });

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("deploy to prod");
    expect(received[0].userId).toBe("slack:U99");
  });

  test("app_mention strips multiple <@MENTION> tags", async () => {
    const received: IncomingMessage[] = [];
    const adapter = new SlackAdapter();
    await adapter.start((msg) => received.push(msg));

    await appMentionHandler({
      event: { text: "<@U00BOT> hey <@U00OTHER> help", user: "U99", channel: "C2" },
      say: mock(() => Promise.resolve()),
    });

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("hey  help");
  });

  test("sendToUser strips slack: prefix and opens conversation", async () => {
    const adapter = new SlackAdapter();
    await adapter.start(() => {});
    await adapter.sendToUser("slack:U42", "task done");

    expect(mockConversationsOpen).toHaveBeenCalledWith({ users: "U42" });
    expect(mockChatPostMessage).toHaveBeenCalledWith({
      channel: "C_DM_CHANNEL",
      text: "task done",
    });
  });

  test("reply callback calls say", async () => {
    const received: IncomingMessage[] = [];
    const saySpy = mock(() => Promise.resolve());
    const adapter = new SlackAdapter();
    await adapter.start((msg) => received.push(msg));

    await messageHandler({
      message: { text: "hello", user: "U1", channel: "C1" },
      say: saySpy,
    });

    expect(received).toHaveLength(1);
    await received[0].reply("response text");
    expect(saySpy).toHaveBeenCalledWith("response text");
  });

  test("updateStatus debounces calls", async () => {
    const received: IncomingMessage[] = [];
    const saySpy = mock(() => Promise.resolve({ ts: "1234.5678" }));
    const adapter = new SlackAdapter();
    await adapter.start((msg) => received.push(msg));

    await messageHandler({
      message: { text: "work", user: "U1", channel: "C1" },
      say: saySpy,
    });

    expect(received).toHaveLength(1);

    // Fire multiple rapid status updates - debounce should collapse them
    received[0].updateStatus("step 1");
    received[0].updateStatus("step 2");
    received[0].updateStatus("step 3");

    // say should not have been called yet (debounce delay is 3000ms)
    // Only the initial message handler call to say happened (0 times for status)
    // The debounce timer hasn't fired yet
    expect(saySpy).toHaveBeenCalledTimes(0);
  });

  test("stop() marks adapter as disconnected", async () => {
    const adapter = new SlackAdapter();
    await adapter.start(() => {});
    expect(adapter.getStatus().status).toBe("connected");

    await adapter.stop();
    expect(adapter.getStatus().status).toBe("disconnected");
    expect(mockStop).toHaveBeenCalledTimes(1);
  });
});
