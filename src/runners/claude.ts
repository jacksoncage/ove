import type { AgentRunner, RunOptions, RunResult, StatusCallback, StreamEvent, StreamingSession } from "../runner";
import { logger } from "../logger";
import { which } from "bun";
import { realpathSync } from "node:fs";
import { TIMEOUT_MS, withTimeout } from "./timeout";

export function summarizeToolInput(name: string, input: any): string {
  if (!input) return "";
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
      return input.file_path || "";
    case "Bash":
      return input.command || "";
    case "Grep":
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
    this.claudePath = found ? realpathSync(found) : "claude";
  }

  buildArgs(prompt: string, opts: RunOptions): string[] {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--max-turns", String(opts.maxTurns), "--dangerously-skip-permissions", "--disallowed-tools", "AskUserQuestion"];
    if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    return args;
  }

  buildStreamingArgs(prompt: string, opts: RunOptions): string[] {
    const args = [
      "-p", prompt,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--max-turns", String(opts.maxTurns),
      "--dangerously-skip-permissions",
    ];
    if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
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
    let resultSessionId: string | null = null;
    const textBlocks: string[] = [];
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
              if (msg.session_id) resultSessionId = msg.session_id;
            }
            if (msg.type === "assistant" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "text") {
                  textBlocks.push(block.text);
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

    const exitCode = await withTimeout(proc);
    const durationMs = Date.now() - startTime;

    if (exitCode === "timeout") {
      logger.error("claude task timed out", { durationMs });
      return { success: false, output: `Claude task timed out after ${TIMEOUT_MS / 60000} minutes`, durationMs };
    }

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      logger.error("claude task failed", { exitCode, stderr, durationMs });
      return { success: false, output: stderr || "Claude task failed", durationMs };
    }

    const finalOutput = resultText || textBlocks.join("\n\n") || "Task completed (no output)";
    logger.info("claude task completed", { durationMs });
    return { success: true, output: finalOutput, durationMs, sessionId: resultSessionId ?? undefined };
  }

  runStreaming(
    prompt: string,
    workDir: string,
    opts: RunOptions,
    onEvent?: (event: StreamEvent) => void,
  ): StreamingSession {
    const args = this.buildStreamingArgs(prompt, opts);
    const startTime = Date.now();
    logger.info("starting streaming claude task", { workDir, maxTurns: opts.maxTurns });

    const proc = Bun.spawn([this.claudePath, ...args], {
      cwd: workDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CI: "1" },
    });

    if (opts.signal) {
      opts.signal.addEventListener("abort", () => proc.kill(), { once: true });
    }

    let sessionId: string | null = null;
    let resultText: string | null = null;
    const textBlocks: string[] = [];

    const done = (async (): Promise<RunResult> => {
      const decoder = new TextDecoder();
      const reader = proc.stdout.getReader();
      try {
        while (true) {
          const { done: isDone, value } = await reader.read();
          if (isDone) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const msg = JSON.parse(line);

              if (msg.type === "system" && msg.session_id) {
                sessionId = msg.session_id;
              }

              if (msg.type === "result" && msg.result) {
                resultText = msg.result;
                if (msg.session_id) sessionId = msg.session_id;
                onEvent?.({ kind: "result", text: msg.result, sessionId: sessionId ?? undefined });
              }

              if (msg.type === "assistant" && msg.message?.content) {
                for (const block of msg.message.content) {
                  if (block.type === "text") {
                    textBlocks.push(block.text);
                    onEvent?.({ kind: "text", text: block.text });
                  }
                  if (block.type === "tool_use") {
                    if (block.name === "AskUserQuestion") {
                      const questions = block.input?.questions;
                      if (questions?.[0]) {
                        onEvent?.({
                          kind: "ask_user",
                          question: questions[0].question,
                          options: questions[0].options || [],
                        });
                      }
                    } else {
                      onEvent?.({
                        kind: "tool",
                        tool: block.name,
                        input: summarizeToolInput(block.name, block.input),
                      });
                    }
                  }
                }
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
        return { success: false, output: `Claude task timed out after ${TIMEOUT_MS / 60000} minutes`, durationMs };
      }
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return { success: false, output: stderr || "Claude task failed", durationMs };
      }

      return {
        success: true,
        output: resultText || textBlocks.join("\n\n") || "Task completed (no output)",
        durationMs,
        sessionId: sessionId ?? undefined,
      };
    })();

    const encoder = new TextEncoder();

    return {
      sendMessage(text: string) {
        try {
          const msg = JSON.stringify({ type: "user_message", content: text }) + "\n";
          proc.stdin.write(encoder.encode(msg));
        } catch (err) {
          logger.warn("failed to write to streaming session stdin", { error: String(err) });
        }
      },
      kill() {
        proc.kill();
      },
      get sessionId() {
        return sessionId;
      },
      done,
    };
  }
}
