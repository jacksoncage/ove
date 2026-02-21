import { which } from "bun";
import { realpathSync } from "node:fs";
import { logger } from "./logger";

export interface ParsedSchedule {
  schedule: string;
  prompt: string;
  repo: string | null;
  description: string;
}

export function buildSchedulePrompt(message: string, availableRepos: string[]): string {
  return `Extract a cron schedule from this user message. Return ONLY valid JSON, no explanation.

Required JSON format:
{"schedule": "<5-field cron expression>", "prompt": "<what task to run>", "repo": "<repo name from the list or null>", "description": "<human-readable schedule>"}

Cron format: minute hour day-of-month month day-of-week
Examples: "0 9 * * *" = daily at 09:00, "0 9 * * 1-5" = weekdays at 09:00, "30 16 * * *" = daily at 16:30

Available repos: ${JSON.stringify(availableRepos)}

User message: "${message}"`;
}

export function parseScheduleResponse(response: string): ParsedSchedule | null {
  try {
    // Strip markdown code fences if present
    let cleaned = response.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();

    const parsed = JSON.parse(cleaned);
    if (!parsed.schedule || !parsed.prompt) return null;
    return {
      schedule: parsed.schedule,
      prompt: parsed.prompt,
      repo: parsed.repo || null,
      description: parsed.description || parsed.schedule,
    };
  } catch {
    return null;
  }
}

export async function parseSchedule(message: string, availableRepos: string[]): Promise<ParsedSchedule | null> {
  const prompt = buildSchedulePrompt(message, availableRepos);

  const found = which("claude");
  const claudePath = found ? realpathSync(found) : "claude";

  logger.info("parsing schedule with claude", { message });

  const proc = Bun.spawn([claudePath, "-p", prompt, "--output-format", "text", "--max-turns", "1", "--dangerously-skip-permissions"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "1" },
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    logger.error("schedule parse failed", { exitCode, stderr });
    return null;
  }

  return parseScheduleResponse(output);
}
