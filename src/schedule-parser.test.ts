import { describe, it, expect } from "bun:test";
import { buildSchedulePrompt, parseScheduleResponse } from "./schedule-parser";

describe("schedule-parser", () => {
  it("builds prompt with user repos", () => {
    const prompt = buildSchedulePrompt("lint and check every day at 9 on my-app", ["my-app", "infra"]);
    expect(prompt).toContain("my-app");
    expect(prompt).toContain("infra");
    expect(prompt).toContain("lint and check every day at 9 on my-app");
  });

  it("parses valid JSON response", () => {
    const json = '{"schedule": "0 9 * * *", "prompt": "run lint and check", "repo": "my-app", "description": "every day at 09:00"}';
    const result = parseScheduleResponse(json);
    expect(result).toEqual({
      schedule: "0 9 * * *",
      prompt: "run lint and check",
      repo: "my-app",
      description: "every day at 09:00",
    });
  });

  it("parses JSON wrapped in markdown code block", () => {
    const response = '```json\n{"schedule": "0 9 * * *", "prompt": "lint", "repo": "my-app", "description": "daily 9"}\n```';
    const result = parseScheduleResponse(response);
    expect(result!.schedule).toBe("0 9 * * *");
  });

  it("returns null for invalid response", () => {
    expect(parseScheduleResponse("I don't understand")).toBeNull();
  });

  it("returns null when schedule is missing", () => {
    const json = '{"prompt": "lint", "repo": "my-app"}';
    expect(parseScheduleResponse(json)).toBeNull();
  });
});
