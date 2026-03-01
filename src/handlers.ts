import { mkdirSync } from "node:fs";
import { parseMessage, buildContextualPrompt } from "./router";
import type { ParsedMessage } from "./router";
import { isAuthorized, getUserRepos, addRepo, addUser } from "./config";
import { parseSchedule } from "./schedule-parser";
import { logger } from "./logger";
import type { Config } from "./config";
import type { TaskQueue, Task } from "./queue";
import type { SessionStore } from "./sessions";
import type { ScheduleStore } from "./schedules";
import type { RepoRegistry } from "./repo-registry";
import type { IncomingMessage, EventAdapter, IncomingEvent } from "./adapters/types";
import type { AgentRunner } from "./runner";
import type { TraceStore } from "./trace";

export interface HandlerDeps {
  config: Config;
  queue: TaskQueue;
  sessions: SessionStore;
  schedules: ScheduleStore;
  repoRegistry: RepoRegistry;
  trace: TraceStore;
  pendingReplies: Map<string, IncomingMessage>;
  pendingEventReplies: Map<string, { adapter: EventAdapter; event: IncomingEvent }>;
  runningProcesses: Map<string, { abort: AbortController; task: Task }>;
  getRunner: (name?: string) => AgentRunner;
  getRunnerForRepo: (repo: string) => AgentRunner;
  getRepoInfo: (repoName: string) => { url: string; defaultBranch: string } | null;
}

export const OVE_PERSONA = `You are Ove, a grumpy but deeply competent Swedish developer. You're modeled after the character from Fredrik Backman's "A Man Called Ove" — you complain about things, mutter about how people don't know what they're doing, but you always help and you always do excellent work. You have strong opinions about code quality.

Personality traits:
- Grumble before helping, but always help thoroughly
- Short, direct sentences. No fluff.
- Occasionally mutter about "nowadays people" or how things were better before
- Take pride in doing things properly — no shortcuts
- Reluctantly kind. You care more than you let on.
- Sprinkle in the occasional Swedish word (fan, för helvete, herregud, mja, nåväl, jo)

Keep the personality subtle in code output — don't let it interfere with code quality. The grumpiness goes in your commentary, not in the code itself. When doing code reviews or fixes, be thorough and meticulous like Ove would be.`;

const ASSISTANT_ADDENDUM = `IMPORTANT MODE OVERRIDE: You are currently in "assistant mode". The user has asked you to be a general-purpose assistant. While you keep your Ove personality (grumble, be direct, sprinkle Swedish), you are now willing to help with ANY request — not just code. This includes:
- Sending reminders, drafting emails/messages
- Answering general knowledge questions
- Helping with personal tasks, recommendations
- Anything the user asks

You still grumble about it ("Fan, nu ska jag vara sekreterare också...") but you DO the task. If you genuinely cannot do something (no tool/integration available), explain what would be needed rather than just refusing.`;

function getPersona(userId: string, deps: HandlerDeps): string {
  const mode = deps.sessions.getMode(userId);
  return mode === "assistant" ? OVE_PERSONA + "\n\n" + ASSISTANT_ADDENDUM : OVE_PERSONA;
}

function formatDuration(since: string): string {
  const elapsed = Math.round((Date.now() - new Date(since).getTime()) / 1000);
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

const MESSAGE_LIMITS: Record<string, number> = {
  slack: 3900,
  whatsapp: 60000,
  cli: Infinity,
  telegram: 4096,
  discord: 2000,
};

export function splitAndReply(text: string, platform: string): string[] {
  const limit = MESSAGE_LIMITS[platform] || 3900;
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      parts.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.5) splitAt = limit;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return parts;
}

function getUserRepoNames(userId: string, deps: HandlerDeps): string[] {
  const userRepos = getUserRepos(deps.config, userId);
  if (userRepos.includes("*")) return deps.repoRegistry.getAllNames();
  return userRepos;
}

async function replyAndLog(msg: IncomingMessage, deps: HandlerDeps, text: string): Promise<void> {
  await msg.reply(text);
  deps.sessions.addMessage(msg.userId, "assistant", text);
}

type RepoResolution =
  | { kind: "resolved"; repo: string }
  | { kind: "none" }
  | { kind: "unknown"; repoNames: string[] }
  | { kind: "error"; message: string };

async function resolveRepoWithLLM(
  userId: string,
  rawText: string,
  hint: string | undefined,
  deps: HandlerDeps,
  onStatus?: (text: string) => void,
): Promise<RepoResolution> {
  if (hint && deps.getRepoInfo(hint)) return { kind: "resolved", repo: hint };

  const repoNames = getUserRepoNames(userId, deps);
  if (repoNames.length === 0) return { kind: "error", message: "No repos discovered yet. Set one up with `init repo <name> <git-url>` or configure GitHub sync." };
  if (repoNames.length === 1) return { kind: "resolved", repo: repoNames[0] };

  const history = deps.sessions.getHistory(userId, 6);
  const recentTasks = deps.queue.listByUser(userId, 5);
  const lastRepo = recentTasks.find(t => t.status === "completed" || t.status === "failed")?.repo;
  const historyContext = history.length > 1
    ? "Recent conversation:\n" + history.slice(0, -1).map(m => `${m.role}: ${m.content}`).join("\n") + "\n\n"
    : "";
  const lastRepoHint = lastRepo && repoNames.includes(lastRepo)
    ? `The user's most recent task was on repo "${lastRepo}", but only use this if the conversation context supports it.\n\n`
    : "";
  const resolvePrompt = `You are a repo-name resolver. ${historyContext}${lastRepoHint}The user's latest message:\n"${rawText}"\n\nAvailable repos: ${repoNames.join(", ")}\n\nRespond with ONLY the repo name that best matches their request. Consider the conversation context if the current message doesn't mention a specific repo. Nothing else — just the exact repo name from the list. If the question doesn't need a specific repo (e.g. "list my open PRs", "what should I work on today", cross-repo queries, general questions about the user's GitHub activity), respond with "NONE". If you cannot determine which specific repo, respond with "UNKNOWN".`;

  onStatus?.("Figuring out which repo...");
  try {
    const runner = deps.getRunner(deps.config.runner?.name);
    const result = await runner.run(resolvePrompt, deps.config.reposDir, { maxTurns: 1 });
    const resolved = result.output.trim().replace(/[`"']/g, "");

    if (resolved === "NONE") {
      logger.info("repo resolver returned NONE — falling back to discuss", { userText: rawText.slice(0, 80) });
      return { kind: "none" };
    }
    if (resolved === "UNKNOWN" || !repoNames.includes(resolved)) {
      return { kind: "unknown", repoNames };
    }

    logger.info("repo resolved via LLM", { resolved, userText: rawText.slice(0, 80) });
    return { kind: "resolved", repo: resolved };
  } catch (err) {
    return { kind: "error", message: `Couldn't figure out the repo: ${String(err).slice(0, 300)}` };
  }
}

async function handleClear(msg: IncomingMessage, deps: HandlerDeps) {
  deps.sessions.clear(msg.userId);
  await msg.reply("Conversation cleared.");
}

async function handleSetMode(msg: IncomingMessage, args: Record<string, any>, deps: HandlerDeps) {
  const mode = args.mode;
  if (mode !== "assistant" && mode !== "strict") {
    await msg.reply(`Unknown mode "${String(mode)}". Use "mode assistant" or "mode strict".`);
    return;
  }
  try {
    deps.sessions.setMode(msg.userId, mode);
  } catch (err) {
    logger.error("failed to set user mode", { userId: msg.userId, mode, error: String(err) });
    await msg.reply("Failed to save mode. Try again.");
    return;
  }
  const reply = mode === "assistant"
    ? "Mja, fine. Assistant mode. Jag hjälper dig med vad du vill. Men klaga inte om resultatet."
    : "Back to code mode. Äntligen. Riktigt arbete.";
  await replyAndLog(msg, deps, reply);
}

async function handleStatus(msg: IncomingMessage, deps: HandlerDeps) {
  const userTasks = deps.queue.listByUser(msg.userId, 5);
  const running = userTasks.find((t) => t.status === "running");

  let reply: string;
  if (running) {
    reply = `Working on ${running.repo} (${formatDuration(running.createdAt)})...`;
  } else {
    const lastDone = userTasks.find((t) => t.status === "completed");
    if (lastDone) {
      reply = `Nothing running. Last task on ${lastDone.repo} completed.`;
    } else {
      const stats = deps.queue.stats();
      reply = `${stats.pending} pending, ${stats.running} running, ${stats.completed} done, ${stats.failed} failed.`;
    }
  }
  await replyAndLog(msg, deps, reply);
}

async function handleHistory(msg: IncomingMessage, deps: HandlerDeps) {
  const tasks = deps.queue.listByUser(msg.userId, 5);
  if (tasks.length === 0) {
    await replyAndLog(msg, deps, "No recent tasks.");
    return;
  }
  const lines = tasks.map(
    (t) => `• [${t.status}] ${t.prompt.slice(0, 80)} (${t.repo})`
  );
  await replyAndLog(msg, deps, `Recent tasks:\n${lines.join("\n")}`);
}

async function handleHelp(msg: IncomingMessage, deps: HandlerDeps) {
  const reply = [
    "Available commands:",
    "• review PR #N on <repo> — I'll find every problem",
    "• fix issue #N on <repo> — I'll fix it properly",
    "• simplify <path> in <repo> — clean up your mess",
    "• validate <repo> — run tests, unlike some people",
    "• discuss <topic> — I'll brainstorm, but no promises I'll be nice",
    "• create project <name> [with template <type>]",
    "• init repo <name> <git-url> [branch] — set up a repo from chat",
    "• tasks — see running and pending tasks",
    "• cancel <id> — kill a running or pending task",
    "• trace [task-id] — see what happened step by step",
    "• mode assistant — I'll (reluctantly) help with anything",
    "• mode strict — back to code-only (default)",
    "• status / history / clear",
    "• <task> every day/weekday at <time> [on <repo>] — schedule a recurring task",
    "• list schedules — see your scheduled tasks",
    "• remove schedule #N — remove a scheduled task",
    "• Or just ask me whatever. I'll figure it out.",
  ].join("\n");
  await replyAndLog(msg, deps, reply);
}

async function handleListTasks(msg: IncomingMessage, deps: HandlerDeps) {
  const tasks = deps.queue.listActive();
  if (tasks.length === 0) {
    const reply = "Nothing running, nothing pending. Quiet. I like it.";
    await msg.reply(reply);
    return;
  }
  const running = tasks.filter((t) => t.status === "running");
  const pending = tasks.filter((t) => t.status === "pending");
  const lines: string[] = [];
  if (running.length > 0) {
    lines.push("Running:");
    for (const t of running) {
      lines.push(`  ${t.id.slice(0, 7)} — "${t.prompt.slice(0, 60)}" on ${t.repo} (${formatDuration(t.createdAt)})`);
    }
  }
  if (pending.length > 0) {
    lines.push("Pending:");
    for (const t of pending) {
      const busyRepo = running.some((r) => r.repo === t.repo);
      const reason = busyRepo ? `waiting — ${t.repo} busy` : "waiting";
      lines.push(`  ${t.id.slice(0, 7)} — "${t.prompt.slice(0, 60)}" on ${t.repo} (${reason})`);
    }
  }
  const reply = lines.join("\n");
  await msg.reply(reply);
}

async function handleCancelTask(msg: IncomingMessage, args: Record<string, any>, deps: HandlerDeps) {
  const prefix = args.taskId.toLowerCase();
  const match = [...deps.runningProcesses.entries()]
    .find(([id]) => id.toLowerCase().startsWith(prefix))?.[1];
  if (!match) {
    const active = deps.queue.listActive();
    const pendingMatch = active.find((t) => t.id.toLowerCase().startsWith(prefix) && t.status === "pending");
    if (pendingMatch) {
      if (pendingMatch.userId !== msg.userId) {
        await msg.reply("That's not your task.");
        return;
      }
      deps.queue.cancel(pendingMatch.id);
      await msg.reply(`Cancelled pending task ${pendingMatch.id.slice(0, 7)} on ${pendingMatch.repo}.`);
      return;
    }
    await msg.reply(`No task found matching "${prefix}". Use /tasks to see what's running.`);
    return;
  }
  if (match.task.userId !== msg.userId) {
    await msg.reply("That's not your task.");
    return;
  }
  match.abort.abort();
  deps.queue.cancel(match.task.id);
  await msg.reply(`Killed task ${match.task.id.slice(0, 7)} on ${match.task.repo}. Gone.`);
}

async function handleListSchedules(msg: IncomingMessage, deps: HandlerDeps) {
  const userSchedules = deps.schedules.listByUser(msg.userId);
  if (userSchedules.length === 0) {
    await replyAndLog(msg, deps, "No schedules. You haven't asked me to do anything on a timer yet.");
    return;
  }
  const lines = userSchedules.map(
    (s) => `#${s.id} — ${s.prompt} on ${s.repo} — ${s.description || s.schedule}`
  );
  await replyAndLog(msg, deps, `Your schedules:\n${lines.join("\n")}`);
}

async function handleRemoveSchedule(msg: IncomingMessage, args: Record<string, any>, deps: HandlerDeps) {
  const id = args.scheduleId;
  const removed = deps.schedules.remove(msg.userId, id);
  await replyAndLog(msg, deps, removed
    ? `Schedule #${id} removed. One less thing for me to do.`
    : `Schedule #${id} not found or not yours. I don't delete other people's things.`);
}

async function handleTrace(msg: IncomingMessage, args: Record<string, any>, deps: HandlerDeps) {
  let taskId = args.taskId as string | undefined;

  if (!taskId) {
    const recent = deps.queue.listByUser(msg.userId, 1);
    if (recent.length === 0) {
      await msg.reply("No tasks found. Nothing to trace.");
      return;
    }
    taskId = recent[0].id;
  }

  const task = deps.queue.get(taskId);
  if (!task) {
    await msg.reply(`No task found matching "${taskId}".`);
    return;
  }

  const events = deps.trace.getByTask(task.id);
  if (events.length === 0) {
    const reason = deps.trace.isEnabled()
      ? "No trace events recorded for this task."
      : "Tracing is disabled. Set OVE_TRACE=true to enable.";
    await msg.reply(reason);
    return;
  }

  const lines = events.map((e) => {
    const time = e.ts.slice(11, 19); // HH:MM:SS
    const detail = e.detail ? ` — ${e.detail.slice(0, 120)}` : "";
    return `${time} [${e.kind}] ${e.summary}${detail}`;
  });

  const reply = `Trace for ${task.id.slice(0, 7)} (${task.repo}):\n${lines.join("\n")}`;
  await msg.reply(reply);
}

async function handleSchedule(msg: IncomingMessage, parsedRepo: string | undefined, deps: HandlerDeps) {
  await msg.updateStatus("Parsing your schedule...");
  const userRepos = getUserRepoNames(msg.userId, deps);

  if (userRepos.length === 0) {
    await msg.reply("You don't have access to any repos. Set one up first with `init repo <name> <git-url>`.");
    return;
  }

  const result = await parseSchedule(msg.text, userRepos);

  if (!result) {
    await replyAndLog(msg, deps, "Couldn't figure out that schedule. Try something like: 'lint and check every day at 9 on my-app'");
    return;
  }

  let repo = result.repo;
  if (!repo || !userRepos.includes(repo)) {
    if (parsedRepo && userRepos.includes(parsedRepo)) {
      repo = parsedRepo;
    } else if (userRepos.length === 1) {
      repo = userRepos[0];
    } else {
      await replyAndLog(msg, deps, `Which repo? You have: ${userRepos.join(", ")}. Say it again with 'on <repo>'.`);
      return;
    }
  }

  const id = deps.schedules.create({
    userId: msg.userId,
    repo,
    prompt: result.prompt,
    schedule: result.schedule,
    description: result.description,
  });

  await replyAndLog(msg, deps, `Schedule #${id} created: "${result.prompt}" on ${repo} ${result.description}.`);
}

async function handleDiscuss(msg: IncomingMessage, parsed: ParsedMessage, history: { role: string; content: string }[], deps: HandlerDeps) {
  const prompt = buildContextualPrompt(parsed, history, getPersona(msg.userId, deps));

  await msg.updateStatus("Thinking...");

  try {
    mkdirSync(deps.config.reposDir, { recursive: true });
    const discussRunner = deps.getRunner(deps.config.runner?.name);
    const result = await discussRunner.run(
      prompt,
      deps.config.reposDir,
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
    deps.sessions.addMessage(msg.userId, "assistant", result.output.slice(0, 500));
  } catch (err) {
    await msg.reply(`Discussion error: ${String(err).slice(0, 500)}`);
  }
}

async function handleCreateProject(msg: IncomingMessage, parsed: ParsedMessage, history: { role: string; content: string }[], deps: HandlerDeps) {
  const projectName = parsed.args.name;
  const prompt = buildContextualPrompt(parsed, history, getPersona(msg.userId, deps));

  const taskId = deps.queue.enqueue({
    userId: msg.userId,
    repo: projectName,
    prompt,
    taskType: "create-project",
    priority: parsed.priority,
  });

  deps.pendingReplies.set(taskId, msg);
  await msg.reply(`Creating "${projectName}"...`);
  logger.info("task enqueued", { taskId, type: "create-project", name: projectName });
}

async function handleInitRepo(msg: IncomingMessage, args: Record<string, any>, deps: HandlerDeps) {
  const { name, url, branch } = args;

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    await msg.reply("Repo name must be alphanumeric, dashes, or underscores. Try again.");
    return;
  }

  if (deps.config.repos[name]) {
    addUser(deps.config, msg.userId, msg.userId, [name]);
    await replyAndLog(msg, deps, `Repo "${name}" already exists. I've added you to it. Go ahead.`);
    return;
  }

  addRepo(deps.config, name, url, branch);
  addUser(deps.config, msg.userId, msg.userId, [name]);
  await replyAndLog(msg, deps, `Added repo "${name}" (${url}, branch: ${branch}).`);
}

async function handleTaskMessage(msg: IncomingMessage, parsed: ParsedMessage, deps: HandlerDeps) {
  const hint = parsed.repo && deps.getRepoInfo(parsed.repo) ? parsed.repo : undefined;
  const resolution = await resolveRepoWithLLM(msg.userId, parsed.rawText, hint, deps, (text) => msg.updateStatus(text));

  switch (resolution.kind) {
    case "none": {
      const history = deps.sessions.getHistory(msg.userId, 6);
      return handleDiscuss(msg, { ...parsed, type: "free-form" }, history, deps);
    }
    case "unknown": {
      const { repoNames } = resolution;
      await replyAndLog(msg, deps, `Which repo? I see ${repoNames.length} repos. Some matches: ${repoNames.slice(0, 10).join(", ")}${repoNames.length > 10 ? "..." : ""}.\nSay it again with 'on <repo>'.`);
      return;
    }
    case "error": {
      await msg.reply(resolution.message);
      return;
    }
  }

  parsed.repo = resolution.repo;

  if (!isAuthorized(deps.config, msg.userId, parsed.repo)) {
    await msg.reply(`Not authorized for ${parsed.repo}.`);
    return;
  }

  if (!deps.getRepoInfo(parsed.repo)) {
    await msg.reply(`Unknown repo: ${parsed.repo}`);
    return;
  }

  const history = deps.sessions.getHistory(msg.userId, 6);
  const prompt = buildContextualPrompt(parsed, history, getPersona(msg.userId, deps));

  const taskId = deps.queue.enqueue({
    userId: msg.userId,
    repo: parsed.repo,
    prompt,
    priority: parsed.priority,
  });

  deps.pendingReplies.set(taskId, msg);

  const stats = deps.queue.stats();
  if (stats.running > 0 || stats.pending > 1) {
    await msg.reply(`Queued — ${stats.pending} task${stats.pending > 1 ? "s" : ""} ahead.`);
  }
  logger.info("task enqueued", { taskId, repo: parsed.repo, type: parsed.type, priority: parsed.priority });
}

export function createMessageHandler(deps: HandlerDeps): (msg: IncomingMessage) => Promise<void> {
  return async (msg: IncomingMessage) => {
    deps.sessions.addMessage(msg.userId, "user", msg.text);

    const parsed = parseMessage(msg.text);

    const handlers: Record<string, () => Promise<void>> = {
      "clear": () => handleClear(msg, deps),
      "status": () => handleStatus(msg, deps),
      "history": () => handleHistory(msg, deps),
      "help": () => handleHelp(msg, deps),
      "list-tasks": () => handleListTasks(msg, deps),
      "cancel-task": () => handleCancelTask(msg, parsed.args, deps),
      "set-mode": () => handleSetMode(msg, parsed.args, deps),
      "trace": () => handleTrace(msg, parsed.args, deps),
      "list-schedules": () => handleListSchedules(msg, deps),
      "remove-schedule": () => handleRemoveSchedule(msg, parsed.args, deps),
      "schedule": () => handleSchedule(msg, parsed.repo, deps),
      "discuss": () => {
        const history = deps.sessions.getHistory(msg.userId, 6);
        return handleDiscuss(msg, parsed, history, deps);
      },
      "create-project": () => {
        const history = deps.sessions.getHistory(msg.userId, 6);
        return handleCreateProject(msg, parsed, history, deps);
      },
      "init-repo": () => handleInitRepo(msg, parsed.args, deps),
    };

    const handler = handlers[parsed.type];
    if (handler) {
      await handler();
      return;
    }

    const userRepos = getUserRepos(deps.config, msg.userId);
    if (userRepos.length === 0) {
      const history = deps.sessions.getHistory(msg.userId, 6);
      return handleDiscuss(msg, { ...parsed, type: "discuss", args: { topic: parsed.rawText } }, history, deps);
    }

    await handleTaskMessage(msg, parsed, deps);
  };
}

export function createEventHandler(deps: HandlerDeps): (event: IncomingEvent, adapter: EventAdapter) => Promise<void> {
  return async (event: IncomingEvent, adapter: EventAdapter) => {
    const parsed = parseMessage(event.text);

    if (!parsed.repo) {
      const userRepoNames = getUserRepoNames(event.userId, deps);
      if (userRepoNames.length === 1) {
        parsed.repo = userRepoNames[0];
      } else if ("repo" in event.source && event.source.repo) {
        const shortName = event.source.repo.split("/").pop() || event.source.repo;
        if (isAuthorized(deps.config, event.userId, shortName)) {
          parsed.repo = shortName;
        }
      }
    }

    if (!parsed.repo) {
      await adapter.respondToEvent(event.eventId, "Couldn't determine which repo. Configure your user in config.json.");
      return;
    }

    if (!isAuthorized(deps.config, event.userId, parsed.repo)) {
      await adapter.respondToEvent(event.eventId, `Not authorized for ${parsed.repo}.`);
      return;
    }

    if (!deps.getRepoInfo(parsed.repo)) {
      await adapter.respondToEvent(event.eventId, `Unknown repo: ${parsed.repo}.`);
      return;
    }

    const prompt = buildContextualPrompt(parsed, [], getPersona(event.userId, deps));
    const taskId = deps.queue.enqueue({
      userId: event.userId,
      repo: parsed.repo,
      prompt,
      priority: parsed.priority,
    });

    deps.pendingEventReplies.set(taskId, { adapter, event });
    logger.info("event task enqueued", { taskId, eventId: event.eventId, repo: parsed.repo, priority: parsed.priority });
  };
}
