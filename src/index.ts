import { Database } from "bun:sqlite";
import { loadConfig, isAuthorized, getUserRepos, addRepo, addUser } from "./config";
import { TaskQueue } from "./queue";
import { RepoManager } from "./repos";
import { ClaudeRunner } from "./runners/claude";
import { CodexRunner } from "./runners/codex";
import { parseMessage, buildContextualPrompt, buildCronPrompt } from "./router";
import { SlackAdapter } from "./adapters/slack";
import { WhatsAppAdapter } from "./adapters/whatsapp";
import { CliAdapter } from "./adapters/cli";
import { TelegramAdapter } from "./adapters/telegram";
import { DiscordAdapter } from "./adapters/discord";
import { HttpApiAdapter } from "./adapters/http";
import { GitHubAdapter } from "./adapters/github";
import type { ChatAdapter, IncomingMessage } from "./adapters/types";
import type { EventAdapter, IncomingEvent } from "./adapters/types";
import type { AgentRunner, RunOptions, StatusEvent } from "./runner";
import { logger } from "./logger";
import { RepoRegistry, syncGitHub } from "./repo-registry";
import { SessionStore } from "./sessions";
import { startCronLoop } from "./cron";
import { ScheduleStore } from "./schedules";
import { parseSchedule } from "./schedule-parser";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OVE_PERSONA = `You are Ove, a grumpy but deeply competent Swedish developer. You're modeled after the character from Fredrik Backman's "A Man Called Ove" — you complain about things, mutter about how people don't know what they're doing, but you always help and you always do excellent work. You have strong opinions about code quality.

Personality traits:
- Grumble before helping, but always help thoroughly
- Short, direct sentences. No fluff.
- Occasionally mutter about "nowadays people" or how things were better before
- Take pride in doing things properly — no shortcuts
- Reluctantly kind. You care more than you let on.
- Sprinkle in the occasional Swedish word (fan, för helvete, herregud, mja, nåväl, jo)

Keep the personality subtle in code output — don't let it interfere with code quality. The grumpiness goes in your commentary, not in the code itself. When doing code reviews or fixes, be thorough and meticulous like Ove would be.`;

const config = loadConfig();
const db = new Database(process.env.DB_PATH || "./ove.db");
db.run("PRAGMA journal_mode = WAL");
const queue = new TaskQueue(db);
const repos = new RepoManager(config.reposDir);
const sessions = new SessionStore(db);
const schedules = new ScheduleStore(db);
const repoRegistry = new RepoRegistry(db);

// Migrate existing config repos to SQLite
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

  // Initial sync
  await syncGitHub(repoRegistry, config.github.orgs);

  // Recurring sync
  setInterval(() => {
    syncGitHub(repoRegistry, config.github!.orgs).catch((err) =>
      logger.warn("github sync failed", { error: String(err) })
    );
  }, interval);
}

// Reply callback map — stores original message for replying after task completion
const pendingReplies = new Map<string, IncomingMessage>();

// Start adapters based on available env vars
const adapters: ChatAdapter[] = [];

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  adapters.push(new SlackAdapter());
}

if (process.env.WHATSAPP_ENABLED === "true") {
  adapters.push(new WhatsAppAdapter());
}

if (process.env.TELEGRAM_BOT_TOKEN) {
  adapters.push(new TelegramAdapter(process.env.TELEGRAM_BOT_TOKEN));
}

if (process.env.DISCORD_BOT_TOKEN) {
  adapters.push(new DiscordAdapter(process.env.DISCORD_BOT_TOKEN));
}

// Event adapters
const eventAdapters: EventAdapter[] = [];

if (process.env.HTTP_API_PORT) {
  const httpAdapter = new HttpApiAdapter(
    parseInt(process.env.HTTP_API_PORT),
    process.env.HTTP_API_KEY || crypto.randomUUID()
  );
  eventAdapters.push(httpAdapter);
}

if (process.env.GITHUB_POLL_REPOS) {
  const ghRepos = process.env.GITHUB_POLL_REPOS.split(",").map((r) => r.trim());
  const botName = process.env.GITHUB_BOT_NAME || "ove";
  const pollMs = parseInt(process.env.GITHUB_POLL_INTERVAL || "30000");
  eventAdapters.push(new GitHubAdapter(ghRepos, botName, pollMs));
}

// CLI mode — enabled by default when no other adapters are configured, or explicitly with CLI_MODE=true
if (process.env.CLI_MODE === "true" || (adapters.length === 0 && eventAdapters.length === 0)) {
  const cliUserId = Object.keys(config.users)[0] || "cli:local";
  adapters.push(new CliAdapter(cliUserId));
}

// Platform-specific formatting hints for Claude output
const PLATFORM_FORMAT_HINTS: Record<string, string> = {
  telegram: "Format output for Telegram: use plain text, bold with *text*, no markdown tables. Use simple bulleted lists with • instead. Keep it concise.",
  slack: "Format output for Slack: use *bold*, no markdown tables. Use simple bulleted lists with • instead. Keep it concise.",
  discord: "Format output for Discord: use **bold**, no wide tables. Use simple bulleted lists. Keep under 2000 chars.",
  whatsapp: "Format output for WhatsApp: use *bold*, no markdown tables or code blocks. Use simple bulleted lists with • instead.",
  cli: "Format output using markdown. Tables are fine.",
};

// Platform-specific message size limits
const MESSAGE_LIMITS: Record<string, number> = {
  slack: 3900,
  whatsapp: 60000,
  cli: Infinity,
  telegram: 4096,
  discord: 2000,
};

function splitAndReply(text: string, platform: string): string[] {
  const limit = MESSAGE_LIMITS[platform] || 3900;
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      parts.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.5) splitAt = limit;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return parts;
}

function formatStatusLog(log: string[]): string {
  return log.slice(-10).map((l) => `> ${l}`).join("\n");
}

async function handleMessage(msg: IncomingMessage) {
  // Store user message in session
  sessions.addMessage(msg.userId, "user", msg.text);

  const parsed = parseMessage(msg.text);

  // Handle clear/reset command
  if (parsed.type === "clear") {
    sessions.clear(msg.userId);
    await msg.reply("Nåväl. Slate wiped clean. Try not to make a mess of it again.");
    return;
  }

  // Handle non-task commands
  if (parsed.type === "status") {
    const userTasks = queue.listByUser(msg.userId, 5);
    const running = userTasks.find((t) => t.status === "running");

    let reply: string;
    if (running) {
      const elapsed = Math.round((Date.now() - new Date(running.createdAt).getTime()) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      const duration = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
      reply = `Still working on task ${running.id.slice(0, 8)} on ${running.repo} (${duration}). Hold your horses.`;
    } else {
      const lastDone = userTasks.find((t) => t.status === "completed");
      if (lastDone) {
        reply = `Nothing running right now. Last task (${lastDone.id.slice(0, 8)} on ${lastDone.repo}) completed. Ask me something if you want.`;
      } else {
        const stats = queue.stats();
        reply = `${stats.pending} pending, ${stats.running} running, ${stats.completed} done, ${stats.failed} failed. I'm keeping track so you don't have to.`;
      }
    }
    await msg.reply(reply);
    sessions.addMessage(msg.userId, "assistant", reply);
    return;
  }

  if (parsed.type === "history") {
    const tasks = queue.listByUser(msg.userId, 5);
    if (tasks.length === 0) {
      await msg.reply("Nothing. You haven't asked me to do anything yet. Typical.");
      sessions.addMessage(msg.userId, "assistant", "No recent tasks.");
      return;
    }
    const lines = tasks.map(
      (t) => `• [${t.status}] ${t.prompt.slice(0, 80)} (${t.repo})`
    );
    const reply = `Here. Your recent tasks:\n${lines.join("\n")}`;
    await msg.reply(reply);
    sessions.addMessage(msg.userId, "assistant", reply);
    return;
  }

  if (parsed.type === "help") {
    const reply = [
      "Fine. Here's what I can do, since apparently you need to be told:",
      "• review PR #N on <repo> — I'll find every problem",
      "• fix issue #N on <repo> — I'll fix it properly",
      "• simplify <path> in <repo> — clean up your mess",
      "• validate <repo> — run tests, unlike some people",
      "• discuss <topic> — I'll brainstorm, but no promises I'll be nice",
      "• create project <name> [with template <type>]",
      "• init repo <name> <git-url> [branch] — set up a repo from chat",
      "• status / history / clear",
      "• <task> every day/weekday at <time> [on <repo>] — schedule a recurring task",
      "• list schedules — see your scheduled tasks",
      "• remove schedule #N — remove a scheduled task",
      "• Or just ask me whatever. I'll figure it out.",
    ].join("\n");
    await msg.reply(reply);
    sessions.addMessage(msg.userId, "assistant", reply);
    return;
  }

  // List schedules
  if (parsed.type === "list-schedules") {
    const userSchedules = schedules.listByUser(msg.userId);
    if (userSchedules.length === 0) {
      const reply = "No schedules. You haven't asked me to do anything on a timer yet.";
      await msg.reply(reply);
      sessions.addMessage(msg.userId, "assistant", reply);
      return;
    }
    const lines = userSchedules.map(
      (s) => `#${s.id} — ${s.prompt} on ${s.repo} — ${s.description || s.schedule}`
    );
    const reply = `Your schedules:\n${lines.join("\n")}`;
    await msg.reply(reply);
    sessions.addMessage(msg.userId, "assistant", reply);
    return;
  }

  // Remove schedule
  if (parsed.type === "remove-schedule") {
    const id = parsed.args.scheduleId;
    const removed = schedules.remove(msg.userId, id);
    const reply = removed
      ? `Schedule #${id} removed. One less thing for me to do.`
      : `Schedule #${id} not found or not yours. I don't delete other people's things.`;
    await msg.reply(reply);
    sessions.addMessage(msg.userId, "assistant", reply);
    return;
  }

  // Create schedule
  if (parsed.type === "schedule") {
    await msg.updateStatus("Parsing your schedule...");
    const rawRepos = getUserRepos(config, msg.userId);
    const userRepos = rawRepos.includes("*") ? repoRegistry.getAllNames() : rawRepos;

    if (userRepos.length === 0) {
      await msg.reply("You don't have access to any repos. Set one up first with `init repo <name> <git-url>`.");
      return;
    }

    const result = await parseSchedule(msg.text, userRepos);

    if (!result) {
      await msg.reply("Couldn't figure out that schedule. Try something like: 'lint and check every day at 9 on my-app'");
      sessions.addMessage(msg.userId, "assistant", "Failed to parse schedule.");
      return;
    }

    // Resolve repo
    let repo = result.repo;
    if (!repo || !userRepos.includes(repo)) {
      if (parsed.repo && userRepos.includes(parsed.repo)) {
        repo = parsed.repo;
      } else if (userRepos.length === 1) {
        repo = userRepos[0];
      } else {
        const reply = `Which repo? You have: ${userRepos.join(", ")}. Say it again with 'on <repo>'.`;
        await msg.reply(reply);
        sessions.addMessage(msg.userId, "assistant", reply);
        return;
      }
    }

    const id = schedules.create({
      userId: msg.userId,
      repo,
      prompt: result.prompt,
      schedule: result.schedule,
      description: result.description,
    });

    const reply = `Fine. Schedule #${id} created. I'll "${result.prompt}" on ${repo} ${result.description}. You can see all schedules with "list schedules".`;
    await msg.reply(reply);
    sessions.addMessage(msg.userId, "assistant", reply);
    return;
  }

  // Discuss runs inline — no queue, no worktree
  if (parsed.type === "discuss") {
    const history = sessions.getHistory(msg.userId, 6);
    const prompt = buildContextualPrompt(parsed, history, OVE_PERSONA);

    await msg.updateStatus("Thinking...");

    try {
      const discussRunner = getRunner(config.runner?.name);
      const result = await discussRunner.run(
        prompt,
        config.reposDir,
        { maxTurns: 5 },
        (event) => {
          if (event.kind === "text") {
            msg.updateStatus(event.text.slice(0, 200));
          }
        }
      );

      const parts = splitAndReply(result.output, msg.platform);
      for (const part of parts) {
        await msg.reply(part);
      }
      sessions.addMessage(msg.userId, "assistant", result.output.slice(0, 500));
    } catch (err) {
      await msg.reply(`Discussion error: ${String(err).slice(0, 500)}`);
    }
    return;
  }

  // Create-project doesn't need an existing repo
  if (parsed.type === "create-project") {
    const projectName = parsed.args.name;
    const history = sessions.getHistory(msg.userId, 6);
    const prompt = buildContextualPrompt(parsed, history, OVE_PERSONA);

    const taskId = queue.enqueue({
      userId: msg.userId,
      repo: projectName,
      prompt,
      taskType: "create-project",
    });

    pendingReplies.set(taskId, msg);
    await msg.reply(`Nåväl. Creating "${projectName}" (${taskId.slice(0, 8)}). I'll set it up properly.`);
    logger.info("task enqueued", { taskId, type: "create-project", name: projectName });
    return;
  }

  // Init repo — onboarding a new repo from chat
  if (parsed.type === "init-repo") {
    const { name, url, branch } = parsed.args;

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      await msg.reply("Repo name must be alphanumeric, dashes, or underscores. Try again.");
      return;
    }

    if (config.repos[name]) {
      // Repo exists — just grant access
      addUser(config, msg.userId, msg.userId, [name]);
      const reply = `Repo "${name}" already exists. I've added you to it. Go ahead.`;
      await msg.reply(reply);
      sessions.addMessage(msg.userId, "assistant", reply);
      return;
    }

    addRepo(config, name, url, branch);
    addUser(config, msg.userId, msg.userId, [name]);
    const reply = `Fine. Added repo "${name}" (${url}, branch: ${branch}). You're good to go — ask me to do something on ${name}.`;
    await msg.reply(reply);
    sessions.addMessage(msg.userId, "assistant", reply);
    return;
  }

  // Need a repo for task commands
  if (!parsed.repo) {
    const userRepos = getUserRepos(config, msg.userId);
    const hasWildcard = userRepos.includes("*");

    if (!hasWildcard && userRepos.length === 1) {
      parsed.repo = userRepos[0];
    } else if (hasWildcard || userRepos.length > 1) {
      const repoNames = hasWildcard ? repoRegistry.getAllNames() : userRepos;

      if (repoNames.length === 1) {
        parsed.repo = repoNames[0];
      } else if (repoNames.length === 0) {
        const reply = "No repos discovered yet. Set one up with `init repo <name> <git-url>` or configure GitHub sync.";
        await msg.reply(reply);
        return;
      } else {
        // Multiple repos — run inline (like discuss) with repo list context
        // Claude answers from knowledge + gh CLI, no worktree needed
        const repoList = repoNames.join(", ");
        const history = sessions.getHistory(msg.userId, 6);
        const formatHint = PLATFORM_FORMAT_HINTS[msg.platform] || PLATFORM_FORMAT_HINTS.slack;
        const inlinePrompt = `${OVE_PERSONA}\n\nAvailable repos: ${repoList}\n\nThe user has access to ${repoNames.length} repos. Based on their message, determine which repo(s) they mean and answer their question fully. Use \`gh\` CLI to query GitHub (e.g. \`gh pr list --repo owner/repo\`, \`gh issue list --repo owner/repo\`). Do NOT stop after identifying the repo — complete the actual task.\n\n${formatHint}\n\n${parsed.rawText}`;

        await msg.reply("Mja. Let me look into that...");
        await msg.updateStatus("Working...");
        try {
          const runner = getRunner(config.runner?.name);
          const result = await runner.run(inlinePrompt, config.reposDir, { maxTurns: 10 }, (event) => {
            if (event.kind === "text") msg.updateStatus(event.text.slice(0, 200));
          });
          const parts = splitAndReply(result.output, msg.platform);
          for (const part of parts) await msg.reply(part);
          sessions.addMessage(msg.userId, "assistant", result.output.slice(0, 500));
        } catch (err) {
          await msg.reply(`Error: ${String(err).slice(0, 500)}`);
        }
        return;
      }
    } else {
      const reply = "You don't have access to any repos yet. Set one up:\n`init repo <name> <git-url> [branch]`\nExample: `init repo my-app git@github.com:user/my-app.git`";
      await msg.reply(reply);
      return;
    }
  }

  // Auth check
  if (!isAuthorized(config, msg.userId, parsed.repo)) {
    await msg.reply(`You're not authorized for ${parsed.repo}. I don't make the rules.`);
    return;
  }

  // Check repo exists — config overrides or registry
  const repoInfo = getRepoInfo(parsed.repo);
  if (!repoInfo) {
    await msg.reply(`Never heard of ${parsed.repo}. Check the config or run GitHub sync.`);
    return;
  }

  // Build prompt with conversation context
  const history = sessions.getHistory(msg.userId, 6);
  const prompt = buildContextualPrompt(parsed, history, OVE_PERSONA);

  // Enqueue the task
  const taskId = queue.enqueue({
    userId: msg.userId,
    repo: parsed.repo,
    prompt,
  });

  // Store reply callback for later
  pendingReplies.set(taskId, msg);

  await msg.reply(`Mja. Fine. Queued (${taskId.slice(0, 8)}). I'll get to it.`);
  logger.info("task enqueued", { taskId, repo: parsed.repo, type: parsed.type });
}

// Pending event responses — stores taskId → adapter for responding
const pendingEventReplies = new Map<string, { adapter: EventAdapter; event: IncomingEvent }>();

async function handleEvent(event: IncomingEvent, adapter: EventAdapter) {
  const parsed = parseMessage(event.text);

  if (!parsed.repo) {
    const userRepos = getUserRepos(config, event.userId);
    if (userRepos.length === 1) {
      parsed.repo = userRepos[0];
    } else if ("repo" in event.source && event.source.repo) {
      const shortName = event.source.repo.split("/").pop() || event.source.repo;
      if (isAuthorized(config, event.userId, shortName)) {
        parsed.repo = shortName;
      }
    }
  }

  if (!parsed.repo) {
    await adapter.respondToEvent(event.eventId, "Couldn't determine which repo. Configure your user in config.json.");
    return;
  }

  if (!isAuthorized(config, event.userId, parsed.repo)) {
    await adapter.respondToEvent(event.eventId, `Not authorized for ${parsed.repo}.`);
    return;
  }

  const repoInfo = getRepoInfo(parsed.repo);
  if (!repoInfo) {
    await adapter.respondToEvent(event.eventId, `Unknown repo: ${parsed.repo}.`);
    return;
  }

  const prompt = buildContextualPrompt(parsed, [], OVE_PERSONA);
  const taskId = queue.enqueue({
    userId: event.userId,
    repo: parsed.repo,
    prompt,
  });

  pendingEventReplies.set(taskId, { adapter, event });
  logger.info("event task enqueued", { taskId, eventId: event.eventId, repo: parsed.repo });
}

async function processTask(task: import("./queue").Task) {
  const isCreateProject = task.taskType === "create-project";
  const repoInfo = isCreateProject ? null : getRepoInfo(task.repo);

  if (!isCreateProject && !repoInfo) {
    queue.fail(task.id, `Unknown repo: ${task.repo}`);
    return;
  }

  const originalMsg = pendingReplies.get(task.id);
  const statusLog: string[] = [];

  try {
    // Status update
    await originalMsg?.updateStatus(`Working on task ${task.id.slice(0, 8)}...`);

    let workDir: string;

    if (isCreateProject) {
      // Create project directory under reposDir
      workDir = join(config.reposDir, task.repo);
      await Bun.write(join(workDir, ".gitkeep"), "");
    } else {
      // Ensure repo is cloned and up to date
      await repos.cloneIfNeeded(task.repo, repoInfo!.url);
      await repos.pull(task.repo, repoInfo!.defaultBranch);

      // Create worktree
      workDir = await repos.createWorktree(
        task.repo,
        task.id,
        repoInfo!.defaultBranch
      );
    }

    try {
      // Write MCP config to temp file if configured
      let mcpConfigPath: string | undefined;
      if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
        mcpConfigPath = join(tmpdir(), `mcp-${task.id}.json`);
        await Bun.write(mcpConfigPath, JSON.stringify({ mcpServers: config.mcpServers }));
      }

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
          if (event.kind === "tool") {
            statusLog.push(`${event.tool}: ${event.input}`);
          } else {
            statusLog.push(event.text.slice(0, 200));
          }
          originalMsg?.updateStatus(formatStatusLog(statusLog));
        }
      );

      // Clean up MCP temp file
      if (mcpConfigPath) {
        try {
          await unlink(mcpConfigPath);
        } catch {}
      }

      if (result.success) {
        queue.complete(task.id, result.output);
        logger.info("task completed", { taskId: task.id, durationMs: result.durationMs });

        // Reply to user — split long results across messages
        const platform = originalMsg?.platform || "slack";
        const parts = splitAndReply(result.output, platform);
        for (const part of parts) {
          await originalMsg?.reply(part);
        }
        sessions.addMessage(task.userId, "assistant", result.output.slice(0, 500));

        // Check if this was triggered by an event adapter
        const eventReply = pendingEventReplies.get(task.id);
        if (eventReply) {
          await eventReply.adapter.respondToEvent(eventReply.event.eventId, result.output);
          pendingEventReplies.delete(task.id);
        }
      } else {
        queue.fail(task.id, result.output);
        logger.error("task failed", { taskId: task.id });
        await originalMsg?.reply(`Task failed: ${result.output.slice(0, 500)}`);
        sessions.addMessage(task.userId, "assistant", `Task failed: ${result.output.slice(0, 200)}`);

        // Notify event adapter of failure too
        const eventReply = pendingEventReplies.get(task.id);
        if (eventReply) {
          await eventReply.adapter.respondToEvent(eventReply.event.eventId, `Task failed: ${result.output.slice(0, 500)}`);
          pendingEventReplies.delete(task.id);
        }
      }
    } finally {
      // Only clean up worktree for non-create-project tasks
      if (!isCreateProject) {
        await repos.removeWorktree(task.repo, task.id).catch(() => {});
      }
    }
  } catch (err) {
    queue.fail(task.id, String(err));
    logger.error("task processing error", { taskId: task.id, error: String(err) });
    await originalMsg?.reply(`Task error: ${String(err).slice(0, 500)}`);
  } finally {
    pendingReplies.delete(task.id);
  }
}

// Worker loop — polls queue every 2 seconds
async function workerLoop() {
  while (true) {
    try {
      const task = queue.dequeue();
      if (task) {
        await processTask(task);
      }
    } catch (err) {
      logger.error("worker loop error", { error: String(err) });
    }
    await Bun.sleep(2000);
  }
}

// Main
async function main() {
  // Reset tasks stuck as "running" from a previous interrupted session
  const staleCount = queue.resetStale();
  if (staleCount > 0) {
    logger.info("reset stale tasks", { count: staleCount });
  }

  logger.info("ove starting", { chatAdapters: adapters.length, eventAdapters: eventAdapters.length, runner: config.runner?.name || "claude" });

  // Start GitHub repo sync (non-blocking)
  startGitHubSync().catch((err) =>
    logger.warn("initial github sync failed", { error: String(err) })
  );

  for (const adapter of adapters) {
    await adapter.start(handleMessage);
  }

  // Start event adapters
  for (const ea of eventAdapters) {
    await ea.start((event) => handleEvent(event, ea));
  }

  // Start cron loop — checks both config-based and user-created schedules
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
      });
    }
  );
  logger.info("cron started", { configTasks: configCron.length });

  // Start worker loop
  workerLoop();

  logger.info("ove ready");

  // Graceful shutdown
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
