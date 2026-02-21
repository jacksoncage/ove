import type { EventAdapter, IncomingEvent, EventSource } from "./types";
import { logger } from "../logger";

export function parseMention(body: string, botName: string): string | null {
  if (!body.includes(`@${botName}`)) return null;
  return body.replace(new RegExp(`@${botName}`, "g"), "").trim();
}

interface GitHubComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  html_url: string;
}

export class GitHubAdapter implements EventAdapter {
  private repos: string[];
  private botName: string;
  private pollIntervalMs: number;
  private onEvent?: (event: IncomingEvent) => void;
  private seenCommentIds = new Set<number>();
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(repos: string[], botName: string, pollIntervalMs: number = 30_000) {
    if (!repos.length) throw new Error("GitHub adapter requires at least one repo");
    this.repos = repos;
    this.botName = botName;
    this.pollIntervalMs = pollIntervalMs;
  }

  async start(onEvent: (event: IncomingEvent) => void): Promise<void> {
    this.onEvent = onEvent;

    // Do an initial poll to seed seenCommentIds (don't process old mentions)
    for (const repo of this.repos) {
      await this.seedRepo(repo);
    }

    this.pollTimer = setInterval(() => this.pollAll(), this.pollIntervalMs);
    logger.info("github adapter started", { repos: this.repos, pollMs: this.pollIntervalMs });
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    logger.info("github adapter stopped");
  }

  async respondToEvent(eventId: string, text: string): Promise<void> {
    // eventId format: "github:<owner/repo>:<issue|pr>:<number>"
    const parts = eventId.split(":");
    if (parts.length < 4) return;
    const repo = parts[1];
    const number = parts[3];

    try {
      const proc = Bun.spawn(["gh", "api", `repos/${repo}/issues/${number}/comments`, "-f", `body=${text}`], {
        stdout: "ignore",
        stderr: "pipe",
      });
      await proc.exited;
    } catch (err) {
      logger.error("failed to post github comment", { eventId, error: String(err) });
    }
  }

  private async seedRepo(repo: string): Promise<void> {
    const comments = await this.fetchRecentComments(repo);
    for (const c of comments) {
      this.seenCommentIds.add(c.id);
    }
  }

  private async pollAll(): Promise<void> {
    for (const repo of this.repos) {
      try {
        await this.pollRepo(repo);
      } catch (err) {
        logger.error("github poll error", { repo, error: String(err) });
      }
    }
  }

  private async pollRepo(repo: string): Promise<void> {
    const comments = await this.fetchRecentComments(repo);

    for (const comment of comments) {
      if (this.seenCommentIds.has(comment.id)) continue;
      this.seenCommentIds.add(comment.id);

      // Skip own comments
      if (comment.user.login === this.botName) continue;

      const text = parseMention(comment.body, this.botName);
      if (!text) continue;

      // Parse issue/PR number from html_url
      const urlMatch = comment.html_url.match(/\/(issues|pull)\/(\d+)/);
      if (!urlMatch) continue;

      const sourceType = urlMatch[1] === "pull" ? "pr" : "issue";
      const number = parseInt(urlMatch[2]);

      const source: EventSource = { type: sourceType as "issue" | "pr", repo, number };
      const eventId = `github:${repo}:${sourceType}:${number}`;

      const event: IncomingEvent = {
        eventId,
        userId: `github:${comment.user.login}`,
        platform: "github",
        source,
        text,
      };

      logger.info("github mention detected", { repo, user: comment.user.login, number });
      this.onEvent?.(event);
    }
  }

  private async fetchRecentComments(repo: string): Promise<GitHubComment[]> {
    const since = new Date(Date.now() - this.pollIntervalMs * 2).toISOString();
    const proc = Bun.spawn(
      ["gh", "api", `repos/${repo}/issues/comments?since=${since}&sort=created&direction=desc&per_page=30`],
      { stdout: "pipe", stderr: "pipe" }
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    try {
      return JSON.parse(output);
    } catch {
      return [];
    }
  }
}
