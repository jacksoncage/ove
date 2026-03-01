import { describe, test, expect } from "bun:test";

describe("adapter wiring", () => {
  test("all adapter modules can be imported", async () => {
    const types = await import("./types");
    const telegram = await import("./telegram");
    const discord = await import("./discord");
    const http = await import("./http");
    const github = await import("./github");
    const slack = await import("./slack");

    expect(telegram.TelegramAdapter).toBeDefined();
    expect(discord.DiscordAdapter).toBeDefined();
    expect(http.HttpApiAdapter).toBeDefined();
    expect(github.GitHubAdapter).toBeDefined();
    expect(slack.SlackAdapter).toBeDefined();
  });
});
