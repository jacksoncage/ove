import { describe, it, expect } from "bun:test";
import { SessionManager } from "./session-manager";
import type { StreamingSession, RunResult } from "./runner";

function mockSession(
  overrides?: Partial<StreamingSession>,
): StreamingSession & { _messages: string[] } {
  const messages: string[] = [];
  return {
    sendMessage: (text: string) => {
      messages.push(text);
    },
    kill: () => {},
    sessionId: "ses-test-123",
    done: Promise.resolve({ success: true, output: "done", durationMs: 100 }),
    _messages: messages,
    ...overrides,
  };
}

describe("SessionManager", () => {
  it("registers and retrieves a session by taskId", () => {
    const mgr = new SessionManager();
    const session = mockSession();
    mgr.register("task-1", "user-1", session);
    expect(mgr.getByTask("task-1")).toBe(session);
  });

  it("retrieves waiting session by userId", () => {
    const mgr = new SessionManager();
    const session = mockSession();
    mgr.register("task-1", "user-1", session);
    mgr.setWaiting("task-1");
    const waiting = mgr.getWaitingForUser("user-1");
    expect(waiting?.taskId).toBe("task-1");
    expect(waiting?.session).toBe(session);
  });

  it("returns null when no waiting session for user", () => {
    const mgr = new SessionManager();
    expect(mgr.getWaitingForUser("user-1")).toBeNull();
  });

  it("returns null for registered but non-waiting session", () => {
    const mgr = new SessionManager();
    mgr.register("task-1", "user-1", mockSession());
    expect(mgr.getWaitingForUser("user-1")).toBeNull();
  });

  it("sendToTask sends message to the session", () => {
    const mgr = new SessionManager();
    const session = mockSession();
    mgr.register("task-1", "user-1", session);
    mgr.sendToTask("task-1", "hello");
    expect(session._messages).toEqual(["hello"]);
  });

  it("sendToTask returns false for unknown task", () => {
    const mgr = new SessionManager();
    expect(mgr.sendToTask("nope", "hello")).toBe(false);
  });

  it("unregister removes the session", () => {
    const mgr = new SessionManager();
    mgr.register("task-1", "user-1", mockSession());
    mgr.unregister("task-1");
    expect(mgr.getByTask("task-1")).toBeNull();
  });

  it("clearWaiting removes waiting state but keeps session", () => {
    const mgr = new SessionManager();
    const session = mockSession();
    mgr.register("task-1", "user-1", session);
    mgr.setWaiting("task-1");
    mgr.clearWaiting("task-1");
    expect(mgr.getWaitingForUser("user-1")).toBeNull();
    expect(mgr.getByTask("task-1")).toBe(session);
  });

  it("killAll kills all sessions and clears map", () => {
    const mgr = new SessionManager();
    let killed = false;
    const session = mockSession({
      kill: () => {
        killed = true;
      },
    });
    mgr.register("task-1", "user-1", session);
    mgr.killAll();
    expect(killed).toBe(true);
    expect(mgr.getByTask("task-1")).toBeNull();
  });
});
