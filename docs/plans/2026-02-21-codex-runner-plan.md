# Codex Runner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add OpenAI Codex CLI as a second agent runner, selectable per-repo or globally.

**Architecture:** New `CodexRunner` class implements the existing `AgentRunner` interface. Config gains a `runner` field (global + per-repo). A factory function in `index.ts` resolves which runner to use per task.

**Tech Stack:** Bun + TypeScript, `codex` CLI (npm: `@openai/codex`), JSONL stream parsing.

---

### Task 1: Add `RunnerConfig` type and `model` to `RunOptions`

**Files:**
- Modify: `src/runner.ts:1-4` (add model to RunOptions)
- Modify: `src/config.ts:1-36` (add RunnerConfig, add to Config and RepoConfig)

**Step 1: Add `model` to `RunOptions` in `src/runner.ts`**

```typescript
export interface RunOptions {
  maxTurns: number;
  mcpConfigPath?: string;
  model?: string;
}
```

**Step 2: Add `RunnerConfig` and wire it into config types in `src/config.ts`**

Add the type:

```typescript
export interface RunnerConfig {
  name: string;
  model?: string;
}
```

Add `runner?: RunnerConfig` to `RepoConfig`:

```typescript
export interface RepoConfig {
  url: string;
  defaultBranch: string;
  runner?: RunnerConfig;
}
```

Add `runner?: RunnerConfig` to `Config`:

```typescript
export interface Config {
  repos: Record<string, RepoConfig>;
  users: Record<string, UserConfig>;
  claude: {
    maxTurns: number;
  };
  reposDir: string;
  mcpServers?: Record<string, McpServerConfig>;
  cron?: CronTaskConfig[];
  runner?: RunnerConfig;
}
```

**Step 3: Parse `runner` in `loadConfig`**

In the `loadConfig` function, add to the return object:

```typescript
runner: raw.runner,
```

**Step 4: Preserve `runner` in `saveConfig`**

In `saveConfig`, add to the merged object:

```typescript
if (config.runner) merged.runner = config.runner;
```

**Step 5: Run tests**

Run: `cd /home/love/code/seenthis/dev-agent && bun test`
Expected: All existing tests pass (no tests break from adding optional fields).

**Step 6: Commit**

```bash
git add src/runner.ts src/config.ts
git commit -m "feat: add RunnerConfig type and model to RunOptions"
```

---

### Task 2: Create `CodexRunner`

**Files:**
- Create: `src/runners/codex.ts`
- Create: `src/runners/codex.test.ts`

**Step 1: Write the failing test in `src/runners/codex.test.ts`**

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/love/code/seenthis/dev-agent && bun test src/runners/codex.test.ts`
Expected: FAIL — module not found.

**Step 3: Write `src/runners/codex.ts`**

```typescript
import type {
  AgentRunner,
  RunOptions,
  RunResult,
  StatusCallback,
} from "../runner";
import { logger } from "../logger";
import { which } from "bun";
import { realpathSync } from "node:fs";

export function summarizeCodexItem(
  item: any
): { tool: string; input: string } | null {
  if (!item) return null;
  switch (item.type) {
    case "command_execution":
      return { tool: "shell", input: item.command || "" };
    case "file_change": {
      const paths = (item.changes || [])
        .map((c: any) => c.path)
        .filter(Boolean)
        .join(", ");
      return { tool: "file_change", input: paths };
    }
    case "mcp_tool_call":
      return {
        tool: item.tool || "mcp",
        input:
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments || "").slice(0, 80),
      };
    default:
      return null;
  }
}

export class CodexRunner implements AgentRunner {
  name = "codex";
  private codexPath: string;

  constructor() {
    const found = which("codex");
    this.codexPath = found ? realpathSync(found) : "codex";
  }

  buildArgs(prompt: string, workDir: string, opts: RunOptions): string[] {
    const args = [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--ephemeral",
      "-C",
      workDir,
    ];
    if (opts.model) args.push("-m", opts.model);
    args.push(prompt);
    return args;
  }

  async run(
    prompt: string,
    workDir: string,
    opts: RunOptions,
    onStatus?: StatusCallback
  ): Promise<RunResult> {
    const args = this.buildArgs(prompt, workDir, opts);
    const startTime = Date.now();
    logger.info("starting codex task", {
      workDir,
      model: opts.model,
      codexPath: this.codexPath,
    });

    const proc = Bun.spawn([this.codexPath, ...args], {
      cwd: workDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    let lastAgentMessage: string | null = null;
    let errorMessage: string | null = null;
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();

    try {
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (
              event.type === "item.completed" &&
              event.item?.type === "agent_message"
            ) {
              lastAgentMessage = event.item.text || "";
              if (onStatus) onStatus({ kind: "text", text: lastAgentMessage });
            }
            if (event.type === "item.started" && event.item) {
              const summary = summarizeCodexItem(event.item);
              if (summary && onStatus) {
                onStatus({ kind: "tool", ...summary });
              }
            }
            if (event.type === "turn.failed") {
              errorMessage = event.error?.message || "Turn failed";
            }
          } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }

    const exitCode = await proc.exited;
    const durationMs = Date.now() - startTime;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      const output = errorMessage || stderr || "Codex task failed";
      logger.error("codex task failed", { exitCode, output, durationMs });
      return { success: false, output, durationMs };
    }

    const finalOutput =
      lastAgentMessage || "Task completed (no output)";
    logger.info("codex task completed", { durationMs });
    return { success: true, output: finalOutput, durationMs };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /home/love/code/seenthis/dev-agent && bun test src/runners/codex.test.ts`
Expected: All tests PASS.

**Step 5: Run all tests**

Run: `cd /home/love/code/seenthis/dev-agent && bun test`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/runners/codex.ts src/runners/codex.test.ts
git commit -m "feat: add CodexRunner for OpenAI Codex CLI"
```

---

### Task 3: Add runner factory and per-task runner selection in `index.ts`

**Files:**
- Modify: `src/index.ts:5` (add CodexRunner import)
- Modify: `src/index.ts:45` (replace hardcoded runner with factory)
- Modify: `src/index.ts:262-278` (discuss mode — resolve runner)
- Modify: `src/index.ts:429-487` (processTask — resolve runner per repo)

**Step 1: Add import and runner factory**

Add import at top of `src/index.ts`:

```typescript
import { CodexRunner } from "./runners/codex";
```

Replace line 45 (`const runner: AgentRunner = new ClaudeRunner();`) with:

```typescript
const runners = new Map<string, AgentRunner>();

function getRunner(name: string = "claude"): AgentRunner {
  let r = runners.get(name);
  if (!r) {
    switch (name) {
      case "codex":
        r = new CodexRunner();
        break;
      case "claude":
      default:
        r = new ClaudeRunner();
        break;
    }
    runners.set(name, r);
  }
  return r;
}

function getRunnerForRepo(repo: string): AgentRunner {
  const repoRunner = config.repos[repo]?.runner;
  const globalRunner = config.runner;
  const name = repoRunner?.name || globalRunner?.name || "claude";
  return getRunner(name);
}

function getRunnerOptsForRepo(repo: string, baseOpts: RunOptions): RunOptions {
  const repoRunner = config.repos[repo]?.runner;
  const globalRunner = config.runner;
  const model = repoRunner?.model || globalRunner?.model;
  return model ? { ...baseOpts, model } : baseOpts;
}
```

**Step 2: Update discuss mode (around line 269)**

Change `runner.run(` to use the factory. The discuss mode doesn't have a specific repo, so use the global default:

```typescript
const discussRunner = getRunner(config.runner?.name);
const result = await discussRunner.run(
```

**Step 3: Update `processTask` (around line 472)**

Replace the `runner.run(` call with per-repo resolution:

```typescript
const taskRunner = getRunnerForRepo(task.repo);
const runOpts = getRunnerOptsForRepo(task.repo, {
  maxTurns: config.claude.maxTurns,
  mcpConfigPath,
});

const result = await taskRunner.run(
  task.prompt,
  workDir,
  runOpts,
  (event: StatusEvent) => {
```

**Step 4: Update the startup log (around line 559)**

Change `runner: runner.name` to show the default runner:

```typescript
logger.info("ove starting", { chatAdapters: adapters.length, eventAdapters: eventAdapters.length, runner: config.runner?.name || "claude" });
```

**Step 5: Run all tests**

Run: `cd /home/love/code/seenthis/dev-agent && bun test`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: add runner factory with per-repo runner selection"
```

---

### Task 4: Verify end-to-end

**Step 1: Check TypeScript compilation**

Run: `cd /home/love/code/seenthis/dev-agent && bun build src/index.ts --no-bundle --outdir /tmp/ove-check 2>&1 | head -20`
Expected: No type errors.

**Step 2: Run full test suite**

Run: `cd /home/love/code/seenthis/dev-agent && bun test`
Expected: All tests pass.

**Step 3: Verify codex binary is available (optional)**

Run: `which codex`
Expected: Path to codex binary, or empty if not installed. (Runner gracefully falls back to `"codex"` string — will fail at runtime with a clear error if not installed.)
