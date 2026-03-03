import { describe, it, expect } from "bun:test";
import { ClaudeRunner, summarizeToolInput } from "./claude";

describe("ClaudeRunner", () => {
  const runner = new ClaudeRunner();

  it("has correct name", () => {
    expect(runner.name).toBe("claude-code");
  });

  it("builds correct args for a prompt", () => {
    const args = runner.buildArgs("fix the bug", { maxTurns: 25 });
    expect(args).toContain("-p");
    expect(args).toContain("fix the bug");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--max-turns");
    expect(args).toContain("25");
  });

  it("always includes verbose flag (required for stream-json)", () => {
    const args = runner.buildArgs("test", { maxTurns: 10 });
    expect(args).toContain("--verbose");
  });

  it("includes MCP config path when provided", () => {
    const args = runner.buildArgs("test", { maxTurns: 25, mcpConfigPath: "/tmp/mcp.json" });
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/tmp/mcp.json");
  });

  it("omits MCP config when not provided", () => {
    const args = runner.buildArgs("test", { maxTurns: 25 });
    expect(args).not.toContain("--mcp-config");
  });
});

describe("summarizeToolInput", () => {
  it("extracts file_path for Read", () => {
    expect(summarizeToolInput("Read", { file_path: "src/index.ts" })).toBe("src/index.ts");
  });

  it("extracts command for Bash", () => {
    expect(summarizeToolInput("Bash", { command: "bun test" })).toBe("bun test");
  });

  it("extracts file_path for Edit", () => {
    expect(summarizeToolInput("Edit", { file_path: "src/app.ts", old_string: "foo", new_string: "bar" }))
      .toBe("src/app.ts");
  });

  it("extracts file_path for Write", () => {
    expect(summarizeToolInput("Write", { file_path: "new-file.ts", content: "hello" }))
      .toBe("new-file.ts");
  });

  it("extracts pattern for Grep", () => {
    expect(summarizeToolInput("Grep", { pattern: "TODO" })).toBe("TODO");
  });

  it("extracts pattern for Glob", () => {
    expect(summarizeToolInput("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  it("truncates unknown tools to 80 chars", () => {
    const longInput = "a".repeat(200);
    expect(summarizeToolInput("CustomTool", longInput).length).toBe(80);
  });

  it("handles null input", () => {
    expect(summarizeToolInput("Read", null)).toBe("");
  });

  it("handles object input for unknown tools", () => {
    expect(summarizeToolInput("Unknown", { foo: "bar" })).toBe('{"foo":"bar"}');
  });
});

describe("streaming args", () => {
  const runner = new ClaudeRunner();

  it("builds streaming args with input-format and without disallowed AskUserQuestion", () => {
    const args = runner.buildStreamingArgs("fix the bug", { maxTurns: 25 });
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).not.toContain("AskUserQuestion");
    expect(args).not.toContain("--disallowed-tools");
  });

  it("streaming args still include output-format stream-json", () => {
    const args = runner.buildStreamingArgs("test", { maxTurns: 10 });
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
  });

  it("includes resume flag when sessionId provided", () => {
    const args = runner.buildStreamingArgs("test", { maxTurns: 10, resumeSessionId: "ses-123" });
    expect(args).toContain("--resume");
    expect(args).toContain("ses-123");
  });

  it("omits resume when no sessionId", () => {
    const args = runner.buildStreamingArgs("test", { maxTurns: 10 });
    expect(args).not.toContain("--resume");
  });
});

describe("buildArgs resume support", () => {
  const runner = new ClaudeRunner();

  it("includes resume in regular buildArgs when provided", () => {
    const args = runner.buildArgs("test", { maxTurns: 10, resumeSessionId: "ses-456" });
    expect(args).toContain("--resume");
    expect(args).toContain("ses-456");
  });
});

describe("runStreaming", () => {
  const runner = new ClaudeRunner();

  it("method exists and is a function", () => {
    expect(typeof runner.runStreaming).toBe("function");
  });
});

describe("buildStreamingArgs details", () => {
  const runner = new ClaudeRunner();

  it("does not include --disallowed-tools at all", () => {
    const args = runner.buildStreamingArgs("test", { maxTurns: 10 });
    expect(args).not.toContain("--disallowed-tools");
  });

  it("includes --input-format stream-json", () => {
    const args = runner.buildStreamingArgs("test", { maxTurns: 10 });
    const idx = args.indexOf("--input-format");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("stream-json");
  });

  it("includes --dangerously-skip-permissions", () => {
    const args = runner.buildStreamingArgs("test", { maxTurns: 10 });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("includes MCP config when provided", () => {
    const args = runner.buildStreamingArgs("test", { maxTurns: 10, mcpConfigPath: "/tmp/mcp.json" });
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/tmp/mcp.json");
  });
});

describe("buildArgs with resume", () => {
  const runner = new ClaudeRunner();

  it("regular buildArgs still disallows AskUserQuestion", () => {
    const args = runner.buildArgs("test", { maxTurns: 10 });
    expect(args).toContain("--disallowed-tools");
    expect(args).toContain("AskUserQuestion");
  });

  it("regular buildArgs does NOT include --input-format", () => {
    const args = runner.buildArgs("test", { maxTurns: 10 });
    expect(args).not.toContain("--input-format");
  });
});

