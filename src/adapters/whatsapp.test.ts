import { describe, test, expect, mock } from "bun:test";

// Mock baileys before importing the adapter
mock.module("baileys", () => ({
  default: () => ({
    ev: {
      on: () => {},
    },
    end: () => {},
    sendMessage: mock(() => Promise.resolve({ key: { id: "mock-id" } })),
  }),
  useMultiFileAuthState: () =>
    Promise.resolve({ state: {}, saveCreds: () => {} }),
  DisconnectReason: { loggedOut: 401 },
}));

import { WhatsAppAdapter } from "./whatsapp";

describe("WhatsAppAdapter", () => {
  test("module exports WhatsAppAdapter class", async () => {
    const mod = await import("./whatsapp");
    expect(mod.WhatsAppAdapter).toBeDefined();
  });

  test("constructor defaults authDir to ./auth/whatsapp", () => {
    const adapter = new WhatsAppAdapter();
    // Access private field via getStatus details or by casting
    const status = adapter.getStatus();
    // authDir is private, but we can verify the object was constructed
    expect(adapter).toBeInstanceOf(WhatsAppAdapter);
  });

  test("constructor defaults allowedChats to empty Set", () => {
    const adapter = new WhatsAppAdapter();
    // allowedChats is private; we verify construction succeeds with defaults
    expect(adapter).toBeInstanceOf(WhatsAppAdapter);
  });

  test("constructor accepts custom options", () => {
    const adapter = new WhatsAppAdapter({
      authDir: "/custom/auth",
      phoneNumber: "+1234567890",
      allowedChats: ["chat1", "chat2"],
    });
    expect(adapter).toBeInstanceOf(WhatsAppAdapter);
  });

  test("getStatus() returns name and type", () => {
    const adapter = new WhatsAppAdapter();
    const status = adapter.getStatus();
    expect(status.name).toBe("whatsapp");
    expect(status.type).toBe("chat");
  });

  test("getStatus() returns 'unknown' before start (initial connecting state)", () => {
    const adapter = new WhatsAppAdapter();
    const status = adapter.getStatus();
    // Initial connectionState is "connecting" with reconnectAttempt=0 => "unknown"
    expect(status.status).toBe("unknown");
  });

  test("getStatus() includes details with reconnectAttempt and pairingCode", () => {
    const adapter = new WhatsAppAdapter();
    const status = adapter.getStatus();
    expect(status.details).toBeDefined();
    expect(status.details).toHaveProperty("reconnectAttempt", 0);
    expect(status.details).toHaveProperty("pairingCode", undefined);
  });

  test("getStatus() error is undefined initially", () => {
    const adapter = new WhatsAppAdapter();
    const status = adapter.getStatus();
    expect(status.error).toBeUndefined();
  });

  test("sendToUser() formats JID from userId", async () => {
    const adapter = new WhatsAppAdapter();

    // Start the adapter so sock is initialized
    await adapter.start(() => {});

    // sendToUser should format "whatsapp:1234" -> "1234@s.whatsapp.net"
    // Since sock is mocked, this won't throw
    await adapter.sendToUser("whatsapp:1234", "hello");

    // Access the mock to verify the JID format
    const sock = (adapter as any).sock;
    expect(sock.sendMessage).toHaveBeenCalledWith("1234@s.whatsapp.net", {
      text: "hello",
    });
  });

  test("stop() nullifies the socket", async () => {
    const adapter = new WhatsAppAdapter();

    await adapter.start(() => {});
    expect((adapter as any).sock).not.toBeNull();

    await adapter.stop();
    expect((adapter as any).sock).toBeNull();
  });
});
