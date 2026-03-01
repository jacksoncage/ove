import { Database } from "bun:sqlite";
import { loadConfig } from "./config";
import { TaskQueue, type Task } from "./queue";
import { RepoManager } from "./repos";
import { ClaudeRunner } from "./runners/claude";
import { CodexRunner } from "./runners/codex";
import { buildCronPrompt } from "./router";
import { SlackAdapter } from "./adapters/slack";
import { WhatsAppAdapter } from "./adapters/whatsapp";
import { CliAdapter } from "./adapters/cli";
import { TelegramAdapter } from "./adapters/telegram";
import { DiscordAdapter } from "./adapters/discord";
import { HttpApiAdapter } from "./adapters/http";
import { GitHubAdapter } from "./adapters/github";
import type { ChatAdapter, IncomingMessage, EventAdapter, IncomingEvent } from "./adapters/types";
import type { AgentRunner, RunOptions } from "./runner";
import { logger } from "./logger";
import { RepoRegistry, syncGitHub } from "./repo-registry";
import { SessionStore } from "./sessions";
import { TraceStore } from "./trace";
import { startCronLoop } from "./cron";
import { ScheduleStore } from "./schedules";
import { createMessageHandler, createEventHandler } from "./handlers";
import { createWorker } from "./worker";

const config = loadConfig();
const db = new Database(process.env.DB_PATH || "./ove.db");
db.run("PRAGMA journal_mode = WAL");
const queue = new TaskQueue(db);
const repos = new RepoManager(config.reposDir);
const sessions = new SessionStore(db);
const trace = new TraceStore(db);
const schedules = new ScheduleStore(db);
const repoRegistry = new RepoRegistry(db);

repoRegistry.migrateFromConfig(
  Object.fromEntries(
    Object.entries(config.repos)
      .filter(([_, r]) => r.url)
      .map(([name, r]) => [name, { url: r.url!, defaultBranch: r.defaultBranch }])
  )
);

const runners = new Map<string, AgentRunner>();

function getRunner(name: string = "claude"): AgentRunner {
  let r = runners.get(name);
  if (!r) {
    r = name === "codex" ? new CodexRunner() : new ClaudeRunner();
    runners.set(name, r);
  }
  return r;
}

function getRunnerForRepo(repo: string): AgentRunner {
  const name = config.repos[repo]?.runner?.name || config.runner?.name || "claude";
  return getRunner(name);
}

function getRunnerOptsForRepo(repo: string, baseOpts: RunOptions): RunOptions {
  const model = config.repos[repo]?.runner?.model || config.runner?.model;
  return model ? { ...baseOpts, model } : baseOpts;
}

function getRepoInfo(repoName: string): { url: string; defaultBranch: string } | null {
  const configRepo = config.repos[repoName];
  const registryRepo = repoRegistry.getByName(repoName);

  if (!configRepo?.url && !registryRepo) return null;

  return {
    url: configRepo?.url || registryRepo?.url || "",
    defaultBranch: configRepo?.defaultBranch || registryRepo?.defaultBranch || "main",
  };
}

async function startGitHubSync() {
  if (!config.github) return;
  const interval = config.github.syncInterval || 1_800_000;

  await syncGitHub(repoRegistry, config.github.orgs);

  setInterval(() => {
    syncGitHub(repoRegistry, config.github!.orgs).catch((err) =>
      logger.warn("github sync failed", { error: String(err) })
    );
  }, interval);
}

const pendingReplies = new Map<string, IncomingMessage>();
const pendingEventReplies = new Map<string, { adapter: EventAdapter; event: IncomingEvent }>();
const runningProcesses = new Map<string, { abort: AbortController; task: Task }>();

const adapters: ChatAdapter[] = [];

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  adapters.push(new SlackAdapter());
}

if (process.env.WHATSAPP_ENABLED === "true") {
  const allowedChats = process.env.WHATSAPP_ALLOWED_CHATS
    ?.split(",").map((s) => s.trim()).filter(Boolean);
  adapters.push(new WhatsAppAdapter({
    phoneNumber: process.env.WHATSAPP_PHONE,
    allowedChats,
  }));
}

if (process.env.TELEGRAM_BOT_TOKEN) {
  adapters.push(new TelegramAdapter(process.env.TELEGRAM_BOT_TOKEN));
}

if (process.env.DISCORD_BOT_TOKEN) {
  adapters.push(new DiscordAdapter(process.env.DISCORD_BOT_TOKEN));
}

const eventAdapters: EventAdapter[] = [];

if (process.env.HTTP_API_PORT) {
  const httpAdapter = new HttpApiAdapter(
    parseInt(process.env.HTTP_API_PORT),
    process.env.HTTP_API_KEY || crypto.randomUUID(),
    trace,
    queue,
    sessions,
    process.env.HTTP_API_HOST
  );
  eventAdapters.push(httpAdapter);
}

if (process.env.GITHUB_POLL_REPOS) {
  const ghRepos = process.env.GITHUB_POLL_REPOS.split(",").map((r) => r.trim());
  const botName = process.env.GITHUB_BOT_NAME || "ove";
  const pollMs = parseInt(process.env.GITHUB_POLL_INTERVAL || "30000");
  eventAdapters.push(new GitHubAdapter(ghRepos, botName, pollMs));
}

if (process.env.CLI_MODE === "true" || (adapters.length === 0 && eventAdapters.length === 0)) {
  const cliUserId = Object.keys(config.users)[0] || "cli:local";
  adapters.push(new CliAdapter(cliUserId));
}

async function main() {
  const staleTasks = queue.listActive().filter((t) => t.status === "running");
  const staleCount = queue.resetStale();
  if (staleCount > 0) {
    logger.info("reset stale tasks", { count: staleCount });
  }

  logger.info("ove starting", { chatAdapters: adapters.length, eventAdapters: eventAdapters.length, runner: config.runner?.name || "claude", tracing: trace.isEnabled() });

  startGitHubSync().catch((err) =>
    logger.warn("initial github sync failed", { error: String(err) })
  );

  const handlerDeps = {
    config,
    queue,
    sessions,
    schedules,
    repoRegistry,
    trace,
    pendingReplies,
    pendingEventReplies,
    runningProcesses,
    getRunner,
    getRunnerForRepo,
    getRepoInfo,
  };

  const handleMessage = createMessageHandler(handlerDeps);
  const handleEvent = createEventHandler(handlerDeps);

  for (const adapter of adapters) {
    await adapter.start(handleMessage);
  }

  for (const ea of eventAdapters) {
    if (ea instanceof HttpApiAdapter) {
      ea.setMessageHandler(handleMessage);
      ea.setAdapters(adapters, eventAdapters);
      ea.setRunningProcesses(runningProcesses);
    }
    await ea.start((event) => handleEvent(event, ea));
  }

  const configCron = config.cron || [];
  startCronLoop(
    () => [
      ...configCron,
      ...schedules.getAll().map((s) => ({
        schedule: s.schedule,
        repo: s.repo,
        prompt: s.prompt,
        userId: s.userId,
      })),
    ],
    (cronTask) => {
      queue.enqueue({
        userId: cronTask.userId,
        repo: cronTask.repo,
        prompt: buildCronPrompt(cronTask.prompt),
        taskType: "cron",
      });
    }
  );
  logger.info("cron started", { configTasks: configCron.length });

  const worker = createWorker({
    config,
    queue,
    repos,
    sessions,
    adapters,
    pendingReplies,
    pendingEventReplies,
    runningProcesses,
    getRunnerForRepo,
    getRunnerOptsForRepo,
    getRepoInfo,
    trace,
  });
  worker.start();

  if (staleTasks.length > 0) {
    for (const task of staleTasks) {
      const platform = task.userId.split(":")[0];
      const adapter = adapters.find((a) => a.constructor.name.toLowerCase().includes(platform));
      if (adapter?.sendToUser) {
        adapter.sendToUser(task.userId, `Your task was interrupted by a restart: "${task.prompt.slice(0, 100)}". Please re-submit if needed.`).catch((err) =>
          logger.warn("failed to notify user of interrupted task", { userId: task.userId, error: String(err) })
        );
      }
    }
  }

  logger.info("ove ready");

  async function shutdown() {
    logger.info("shutting down...");
    for (const adapter of adapters) {
      await adapter.stop();
    }
    for (const ea of eventAdapters) {
      await ea.stop();
    }
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("fatal error", { error: String(err) });
  process.exit(1);
});
