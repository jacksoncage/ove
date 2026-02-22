import { describe, it, expect } from "bun:test";
import { parseMessage, buildPrompt } from "./router";

describe("parseMessage", () => {
  it("parses PR review command", () => {
    const result = parseMessage("review PR #42 on my-app");
    expect(result.type).toBe("review-pr");
    expect(result.repo).toBe("my-app");
    expect(result.args.prNumber).toBe(42);
  });

  it("parses fix issue command", () => {
    const result = parseMessage("fix issue #15 on infra");
    expect(result.type).toBe("fix-issue");
    expect(result.repo).toBe("infra");
    expect(result.args.issueNumber).toBe(15);
  });

  it("parses simplify command", () => {
    const result = parseMessage("simplify src/auth.ts in my-app");
    expect(result.type).toBe("simplify");
    expect(result.repo).toBe("my-app");
    expect(result.args.filePath).toBe("src/auth.ts");
  });

  it("parses validate command", () => {
    const result = parseMessage("validate my-app");
    expect(result.type).toBe("validate");
    expect(result.repo).toBe("my-app");
  });

  it("parses status command", () => {
    const result = parseMessage("status");
    expect(result.type).toBe("status");
  });

  it("parses history command", () => {
    const result = parseMessage("history");
    expect(result.type).toBe("history");
  });

  it("parses create project command", () => {
    const result = parseMessage("create project my-api");
    expect(result.type).toBe("create-project");
    expect(result.args.name).toBe("my-api");
  });

  it("parses create project with template", () => {
    const result = parseMessage("create project my-api with template express");
    expect(result.type).toBe("create-project");
    expect(result.args.name).toBe("my-api");
    expect(result.args.template).toBe("express");
  });

  it("parses new project command", () => {
    const result = parseMessage("new project my-service");
    expect(result.type).toBe("create-project");
    expect(result.args.name).toBe("my-service");
  });

  it("parses discuss command", () => {
    const result = parseMessage("discuss notification service");
    expect(result.type).toBe("discuss");
    expect(result.args.topic).toBe("notification service");
  });

  it("parses brainstorm command", () => {
    const result = parseMessage("brainstorm auth flow");
    expect(result.type).toBe("discuss");
    expect(result.args.topic).toBe("auth flow");
  });

  it("parses 'I have an idea' as discuss", () => {
    const result = parseMessage("I have an idea about notifications");
    expect(result.type).toBe("discuss");
  });

  it("parses 'I have a new idea' as discuss", () => {
    const result = parseMessage("I have a new idea");
    expect(result.type).toBe("discuss");
  });

  it("parses 'every day at 9' as schedule", () => {
    const result = parseMessage("lint and check every day at 9 on my-app");
    expect(result.type).toBe("schedule");
    expect(result.repo).toBe("my-app");
  });

  it("parses 'each weekday at 17:00' as schedule", () => {
    const result = parseMessage("run tests each weekday at 17:00");
    expect(result.type).toBe("schedule");
  });

  it("parses 'daily at 8' as schedule", () => {
    const result = parseMessage("daily at 8 summarize open PRs on infra");
    expect(result.type).toBe("schedule");
  });

  it("parses 'list schedules' as list-schedules", () => {
    const result = parseMessage("list schedules");
    expect(result.type).toBe("list-schedules");
  });

  it("parses 'show my schedules' as list-schedules", () => {
    const result = parseMessage("show my schedules");
    expect(result.type).toBe("list-schedules");
  });

  it("parses 'remove schedule #3' as remove-schedule", () => {
    const result = parseMessage("remove schedule #3");
    expect(result.type).toBe("remove-schedule");
    expect(result.args.scheduleId).toBe(3);
  });

  it("parses 'delete schedule 5' as remove-schedule", () => {
    const result = parseMessage("delete schedule 5");
    expect(result.type).toBe("remove-schedule");
    expect(result.args.scheduleId).toBe(5);
  });

  it("parses 'cancel schedule #1' as remove-schedule", () => {
    const result = parseMessage("cancel schedule #1");
    expect(result.type).toBe("remove-schedule");
    expect(result.args.scheduleId).toBe(1);
  });

  it("parses 'every 30 min' as schedule", () => {
    const result = parseMessage("simplify code and create a PR every 30 min on infra-salming-ai");
    expect(result.type).toBe("schedule");
    expect(result.repo).toBe("infra-salming-ai");
  });

  it("parses 'every 2 hours' as schedule", () => {
    const result = parseMessage("run tests every 2 hours on my-app");
    expect(result.type).toBe("schedule");
    expect(result.repo).toBe("my-app");
  });

  it("parses 'every hour' as schedule", () => {
    const result = parseMessage("check for updates every hour");
    expect(result.type).toBe("schedule");
  });

  it("parses 'every 15 minutes' as schedule", () => {
    const result = parseMessage("deploy every 15 minutes on staging");
    expect(result.type).toBe("schedule");
    expect(result.repo).toBe("staging");
  });

  it("parses init repo with SSH URL", () => {
    const result = parseMessage("init repo my-app git@github.com:user/my-app.git");
    expect(result.type).toBe("init-repo");
    expect(result.args.name).toBe("my-app");
    expect(result.args.url).toBe("git@github.com:user/my-app.git");
    expect(result.args.branch).toBe("main");
  });

  it("parses setup repo with HTTPS URL", () => {
    const result = parseMessage("setup repo my-app https://github.com/user/my-app.git");
    expect(result.type).toBe("init-repo");
    expect(result.args.url).toBe("https://github.com/user/my-app.git");
  });

  it("parses add repo with custom branch", () => {
    const result = parseMessage("add repo my-app git@github.com:org/my-app.git develop");
    expect(result.type).toBe("init-repo");
    expect(result.args.branch).toBe("develop");
  });

  it("does not match init repo without URL", () => {
    const result = parseMessage("init repo my-app");
    expect(result.type).not.toBe("init-repo");
  });

  it("parses Telegram /start as help", () => {
    const result = parseMessage("/start");
    expect(result.type).toBe("help");
  });

  it("parses Telegram /help as help", () => {
    const result = parseMessage("/help");
    expect(result.type).toBe("help");
  });

  it("parses Telegram /status as status", () => {
    const result = parseMessage("/status");
    expect(result.type).toBe("status");
  });

  it("parses Telegram /history as history", () => {
    const result = parseMessage("/history");
    expect(result.type).toBe("history");
  });

  it("parses Telegram /clear as clear", () => {
    const result = parseMessage("/clear");
    expect(result.type).toBe("clear");
  });

  // Natural language status inquiries
  it("parses 'how's it going?' as status", () => {
    const result = parseMessage("how's it going?");
    expect(result.type).toBe("status");
  });

  it("parses 'any updates?' as status", () => {
    const result = parseMessage("any updates?");
    expect(result.type).toBe("status");
  });

  it("parses 'are you done?' as status", () => {
    const result = parseMessage("are you done?");
    expect(result.type).toBe("status");
  });

  it("parses 'how dose it the work go?' as status", () => {
    const result = parseMessage("how dose it the work go?");
    expect(result.type).toBe("status");
  });

  it("parses 'how is the work going' as status", () => {
    const result = parseMessage("how is the work going");
    expect(result.type).toBe("status");
  });

  it("parses 'what's the progress' as status", () => {
    const result = parseMessage("what's the progress");
    expect(result.type).toBe("status");
  });

  it("parses 'done yet?' as status", () => {
    const result = parseMessage("done yet?");
    expect(result.type).toBe("status");
  });

  it("parses 'how far along are you' as status", () => {
    const result = parseMessage("how far along are you");
    expect(result.type).toBe("status");
  });

  it("parses 'is it done' as status", () => {
    const result = parseMessage("is it done");
    expect(result.type).toBe("status");
  });

  it("parses 'progress?' as status", () => {
    const result = parseMessage("progress?");
    expect(result.type).toBe("status");
  });

  it("does NOT parse work requests as status", () => {
    expect(parseMessage("update the progress bar on my-app").type).toBe("free-form");
    expect(parseMessage("fix the status page in my-app").type).toBe("free-form");
    expect(parseMessage("add a progress indicator on my-app").type).toBe("free-form");
  });

  it("falls back to free-form for unrecognized input", () => {
    const result = parseMessage("what does the auth middleware do in my-app");
    expect(result.type).toBe("free-form");
  });
});

describe("buildPrompt", () => {
  it("builds review-pr prompt", () => {
    const prompt = buildPrompt({ type: "review-pr", repo: "my-app", args: { prNumber: 42 }, rawText: "" });
    expect(prompt).toContain("Review PR #42");
    expect(prompt).toContain("gh pr review");
  });

  it("builds fix-issue prompt", () => {
    const prompt = buildPrompt({ type: "fix-issue", repo: "infra", args: { issueNumber: 15 }, rawText: "" });
    expect(prompt).toContain("Fix GitHub issue #15");
  });

  it("builds create-project prompt", () => {
    const prompt = buildPrompt({ type: "create-project", args: { name: "my-api" }, rawText: "" });
    expect(prompt).toContain('Create a new project called "my-api"');
    expect(prompt).toContain("gh repo create");
  });

  it("builds create-project prompt with template", () => {
    const prompt = buildPrompt({ type: "create-project", args: { name: "my-api", template: "express" }, rawText: "" });
    expect(prompt).toContain("express template");
  });

  it("builds discuss prompt", () => {
    const prompt = buildPrompt({ type: "discuss", args: { topic: "notification service" }, rawText: "" });
    expect(prompt).toContain("brainstorming partner");
    expect(prompt).toContain("notification service");
    expect(prompt).toContain("Do not make any code changes");
  });

  it("builds free-form prompt as raw text", () => {
    const prompt = buildPrompt({ type: "free-form", args: {}, rawText: "explain the auth flow" });
    expect(prompt).toBe("explain the auth flow");
  });
});
