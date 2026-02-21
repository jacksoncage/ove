import { describe, it, expect } from "bun:test";
import { CodexRunner, summarizeCodexItem } from "./codex";

describe("CodexRunner", () => {
  const runner = new CodexRunner();

  it("has correct name", () => {
    expect(runner.name).toBe("codex");
  });

  it("builds correct args for a prompt", () => {
    const args = runner.buildArgs("fix the bug", "/tmp/work", {
      maxTurns: 25,
    });
    expect(args).toContain("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("-C");
    expect(args).toContain("/tmp/work");
    expect(args).toContain("fix the bug");
  });

  it("includes model flag when provided", () => {
    const args = runner.buildArgs("test", "/tmp/work", {
      maxTurns: 25,
      model: "o3",
    });
    expect(args).toContain("-m");
    expect(args).toContain("o3");
  });

  it("omits model flag when not provided", () => {
    const args = runner.buildArgs("test", "/tmp/work", { maxTurns: 25 });
    expect(args).not.toContain("-m");
  });

  it("ignores mcpConfigPath (not supported by codex CLI)", () => {
    const args = runner.buildArgs("test", "/tmp/work", {
      maxTurns: 25,
      mcpConfigPath: "/tmp/mcp.json",
    });
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("/tmp/mcp.json");
  });
});

describe("summarizeCodexItem", () => {
  it("summarizes command_execution", () => {
    expect(
      summarizeCodexItem({ type: "command_execution", command: "bun test" })
    ).toEqual({ tool: "shell", input: "bun test" });
  });

  it("summarizes file_change with paths", () => {
    const result = summarizeCodexItem({
      type: "file_change",
      changes: [
        { path: "src/a.ts", kind: "update" },
        { path: "src/b.ts", kind: "add" },
      ],
    });
    expect(result).toEqual({ tool: "file_change", input: "src/a.ts, src/b.ts" });
  });

  it("summarizes mcp_tool_call", () => {
    const result = summarizeCodexItem({
      type: "mcp_tool_call",
      tool: "search",
      arguments: '{"q":"hello"}',
    });
    expect(result).toEqual({ tool: "search", input: '{"q":"hello"}' });
  });

  it("returns null for agent_message", () => {
    expect(
      summarizeCodexItem({ type: "agent_message", text: "done" })
    ).toBeNull();
  });

  it("returns null for unknown types", () => {
    expect(summarizeCodexItem({ type: "reasoning", text: "thinking" })).toBeNull();
  });
});
