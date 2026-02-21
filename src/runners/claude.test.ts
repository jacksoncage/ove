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
