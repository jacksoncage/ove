import { describe, test, expect, mock } from "bun:test";
import type { IncomingMessage } from "./types";

// We can't unit-test the Bot connection, but we can test the message building
describe("TelegramAdapter", () => {
  test("module exports TelegramAdapter class", async () => {
    const mod = await import("./telegram");
    expect(mod.TelegramAdapter).toBeDefined();
  });

  test("constructor requires bot token", () => {
    const { TelegramAdapter } = require("./telegram");
    expect(() => new TelegramAdapter("")).toThrow();
  });
});
