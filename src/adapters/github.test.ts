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
});
