import type { AgentRunner, RunOptions, RunResult, StatusCallback } from "../runner";
import { logger } from "../logger";
import { which } from "bun";
import { realpathSync } from "node:fs";
import { TIMEOUT_MS, withTimeout } from "./timeout";

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

    if (opts.signal) {
      opts.signal.addEventListener("abort", () => proc.kill(), { once: true });
    }

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

    const exitCode = await withTimeout(proc);
    const durationMs = Date.now() - startTime;

    if (exitCode === "timeout") {
      logger.error("codex task timed out", { durationMs });
      return { success: false, output: `Codex task timed out after ${TIMEOUT_MS / 60000} minutes`, durationMs };
    }

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
