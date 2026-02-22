import type { AgentRunner, RunOptions, RunResult, StatusCallback } from "../runner";
import { logger } from "../logger";
import { which } from "bun";
import { realpathSync } from "node:fs";

export function summarizeToolInput(name: string, input: any): string {
  if (!input) return "";
  switch (name) {
    case "Read":
      return input.file_path || "";
    case "Bash":
      return input.command || "";
    case "Edit":
    case "Write":
      return input.file_path || "";
    case "Grep":
      return input.pattern || "";
    case "Glob":
      return input.pattern || "";
    default: {
      const s = typeof input === "string" ? input : JSON.stringify(input);
      return s.slice(0, 80);
    }
  }
}

export class ClaudeRunner implements AgentRunner {
  name = "claude-code";
  private claudePath: string;

  constructor() {
    const found = which("claude");
    // Resolve symlinks so Bun.spawn can find the actual binary
    this.claudePath = found ? realpathSync(found) : "claude";
  }

  buildArgs(prompt: string, opts: RunOptions): string[] {
    // stream-json requires --verbose in claude CLI
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--max-turns", String(opts.maxTurns), "--dangerously-skip-permissions"];
    if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
    return args;
  }

  async run(prompt: string, workDir: string, opts: RunOptions, onStatus?: StatusCallback): Promise<RunResult> {
    const args = this.buildArgs(prompt, opts);
    const startTime = Date.now();
    logger.info("starting claude task", { workDir, maxTurns: opts.maxTurns, claudePath: this.claudePath });

    const proc = Bun.spawn([this.claudePath, ...args], {
      cwd: workDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CI: "1" },
    });

    if (opts.signal) {
      opts.signal.addEventListener("abort", () => proc.kill(), { once: true });
    }

    let resultText: string | null = null;
    let lastTextBlock: string | null = null;
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.type === "result" && msg.result) {
              resultText = msg.result;
            }
            if (msg.type === "assistant" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "text") {
                  lastTextBlock = block.text;
                  if (onStatus) onStatus({ kind: "text", text: block.text });
                }
                if (block.type === "tool_use" && onStatus) {
                  onStatus({
                    kind: "tool",
                    tool: block.name,
                    input: summarizeToolInput(block.name, block.input),
                  });
                }
              }
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
      logger.error("claude task failed", { exitCode, stderr, durationMs });
      return { success: false, output: stderr || "Claude task failed", durationMs };
    }

    const finalOutput = resultText || lastTextBlock || "Task completed (no output)";
    logger.info("claude task completed", { durationMs });
    return { success: true, output: finalOutput, durationMs };
  }
}
