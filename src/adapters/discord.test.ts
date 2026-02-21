import { describe, test, expect } from "bun:test";

describe("DiscordAdapter", () => {
  test("module exports DiscordAdapter class", async () => {
    const mod = await import("./discord");
    expect(mod.DiscordAdapter).toBeDefined();
  });

  test("constructor requires bot token", () => {
    const { DiscordAdapter } = require("./discord");
    expect(() => new DiscordAdapter("")).toThrow();
  });
});
