import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionStore } from "./sessions";

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    const db = new Database(":memory:");
    store = new SessionStore(db);
  });

  it("stores and retrieves messages", () => {
    store.addMessage("slack:U123", "user", "review PR #42 on my-app");
    store.addMessage("slack:U123", "assistant", "Task queued. Working on it...");

    const messages = store.getHistory("slack:U123");
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("limits history to last N messages", () => {
    for (let i = 0; i < 20; i++) {
      store.addMessage("slack:U123", "user", `message ${i}`);
    }
    const messages = store.getHistory("slack:U123", 5);
    expect(messages.length).toBe(5);
    expect(messages[0].content).toBe("message 15");
  });

  it("keeps separate history per user", () => {
    store.addMessage("slack:U1", "user", "hello");
    store.addMessage("slack:U2", "user", "world");

    expect(store.getHistory("slack:U1").length).toBe(1);
    expect(store.getHistory("slack:U2").length).toBe(1);
  });

  it("clears history for a user", () => {
    store.addMessage("slack:U123", "user", "test");
    store.clear("slack:U123");
    expect(store.getHistory("slack:U123").length).toBe(0);
  });

  describe("user modes", () => {
    it("returns 'strict' as default mode", () => {
      const mode = store.getMode("slack:U123");
      expect(mode).toBe("strict");
    });

    it("stores and retrieves a mode", () => {
      store.setMode("slack:U123", "assistant");
      expect(store.getMode("slack:U123")).toBe("assistant");
    });

    it("upserts mode (overwrites previous)", () => {
      store.setMode("slack:U123", "assistant");
      store.setMode("slack:U123", "strict");
      expect(store.getMode("slack:U123")).toBe("strict");
    });

    it("keeps separate modes per user", () => {
      store.setMode("slack:U1", "assistant");
      store.setMode("slack:U2", "strict");
      expect(store.getMode("slack:U1")).toBe("assistant");
      expect(store.getMode("slack:U2")).toBe("strict");
    });

    it("resets mode when session is cleared", () => {
      store.setMode("slack:U123", "assistant");
      store.clear("slack:U123");
      expect(store.getMode("slack:U123")).toBe("strict");
    });
  });
});
