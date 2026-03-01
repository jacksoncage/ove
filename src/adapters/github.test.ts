import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { IncomingEvent } from "./types";

describe("GitHubAdapter", () => {
  test("module exports GitHubAdapter class", async () => {
    const mod = await import("./github");
    expect(mod.GitHubAdapter).toBeDefined();
  });

  test("constructor requires repos list", () => {
    const { GitHubAdapter } = require("./github");
    expect(() => new GitHubAdapter([], "ove-bot")).toThrow();
  });

  test("parseMention extracts text after @mention", async () => {
    const { parseMention } = await import("./github");
    expect(parseMention("@ove-bot fix this bug", "ove-bot")).toBe("fix this bug");
    expect(parseMention("hey @ove-bot review PR #5", "ove-bot")).toBe("hey  review PR #5");
    expect(parseMention("no mention here", "ove-bot")).toBeNull();
  });

  test("parseMention handles botName with regex metacharacters", async () => {
    const { parseMention } = await import("./github");
    // botName like "bot[1]" would break if used in a regex without escaping
    expect(parseMention("@bot[1] fix this", "bot[1]")).toBe("fix this");
    expect(parseMention("@bot.star do it", "bot.star")).toBe("do it");
    expect(parseMention("@bot(x) hello", "bot(x)")).toBe("hello");
  });
});
