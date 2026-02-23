import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlink } from "node:fs/promises";
import { logger } from "./logger";
import { splitAndReply } from "./handlers";
import type { Config } from "./config";
import type { TaskQueue, Task } from "./queue";
import type { RepoManager } from "./repos";
import type { SessionStore } from "./sessions";
import type { IncomingMessage, ChatAdapter, EventAdapter, IncomingEvent } from "./adapters/types";
import type { AgentRunner, RunOptions, StatusEvent } from "./runner";
import type { TraceStore } from "./trace";
import type { DebouncedFunction } from "./adapters/debounce";

export interface WorkerDeps {
  config: Config;
  queue: TaskQueue;
  repos: RepoManager;
  sessions: SessionStore;
  adapters: ChatAdapter[];
  pendingReplies: Map<string, IncomingMessage>;
  pendingEventReplies: Map<string, { adapter: EventAdapter; event: IncomingEvent }>;
  runningProcesses: Map<string, { abort: AbortController; task: Task }>;
  getRunnerForRepo: (repo: string) => AgentRunner;
  getRunnerOptsForRepo: (repo: string, baseOpts: RunOptions) => RunOptions;
  getRepoInfo: (repoName: string) => { url: string; defaultBranch: string } | null;
  trace: TraceStore;
}

function findAdapterForUser(userId: string, adapters: ChatAdapter[]): ChatAdapter | undefined {
  const platform = userId.split(":")[0]; // e.g. "telegram", "slack", "discord"
  return adapters.find((a) => a.constructor.name.toLowerCase().includes(platform));
}

async function replyWithFallback(
  text: string,
  originalMsg: IncomingMessage | undefined,
  userId: string,
  adapters: ChatAdapter[],
) {
  if (originalMsg) {
    try {
      await originalMsg.reply(text);
      return;
    } catch (err) {
      logger.warn("original reply failed, trying fallback", { userId, error: String(err) });
    }
  }
  const adapter = findAdapterForUser(userId, adapters);
  if (adapter?.sendToUser) {
    try {
      await adapter.sendToUser(userId, text);
    } catch (err) {
      logger.warn("fallback sendToUser failed", { userId, error: String(err) });
    }
  }
}

async function processTask(task: Task, deps: WorkerDeps) {
  const isCreateProject = task.taskType === "create-project";
  const repoInfo = isCreateProject ? null : deps.getRepoInfo(task.repo);

  if (!isCreateProject && !repoInfo) {
    deps.queue.fail(task.id, `Unknown repo: ${task.repo}`);
    return;
  }

  const abortController = new AbortController();
  deps.runningProcesses.set(task.id, { abort: abortController, task });

  const originalMsg = deps.pendingReplies.get(task.id);
  const statusLog: string[] = [];
  const trace = deps.trace;
  const startTime = Date.now();

  trace.append(task.id, "lifecycle", "Task started", task.prompt);

  try {
    await originalMsg?.updateStatus(`Working on it...`);

    let workDir: string;

    if (isCreateProject) {
      workDir = join(deps.config.reposDir, task.repo);
      await Bun.write(join(workDir, ".gitkeep"), "");
    } else {
      await deps.repos.cloneIfNeeded(task.repo, repoInfo!.url);
      await deps.repos.pull(task.repo, repoInfo!.defaultBranch);

      workDir = await deps.repos.createWorktree(
        task.repo,
        task.id,
        repoInfo!.defaultBranch
      );
    }

    try {
      let mcpConfigPath: string | undefined;
      if (deps.config.mcpServers && Object.keys(deps.config.mcpServers).length > 0) {
        mcpConfigPath = join(tmpdir(), `mcp-${task.id}.json`);
        await Bun.write(mcpConfigPath, JSON.stringify({ mcpServers: deps.config.mcpServers }));
      }

      const taskRunner = deps.getRunnerForRepo(task.repo);
      // Cron tasks are autonomous — give them plenty of room to finish
      const baseTurns = deps.config.claude.maxTurns;
      const maxTurns = task.taskType === "cron" ? Math.max(baseTurns, 100) : baseTurns;
      const runOpts = deps.getRunnerOptsForRepo(task.repo, {
        maxTurns,
        mcpConfigPath,
        signal: abortController.signal,
      });

      const result = await taskRunner.run(
        task.prompt,
        workDir,
        runOpts,
        (event: StatusEvent) => {
          if (event.kind === "tool") {
            const last = statusLog[statusLog.length - 1];
            const summary = `Using ${event.tool}...`;
            if (last !== summary) statusLog.push(summary);
            trace.append(task.id, "tool", summary, event.input.slice(0, 2000));
          } else {
            statusLog.push(event.text.slice(0, 200));
            trace.append(task.id, "status", event.text.slice(0, 200));
          }
          originalMsg?.updateStatus(statusLog.slice(-5).join("\n"));
        }
      );

      if (mcpConfigPath) {
        try {
          await unlink(mcpConfigPath);
        } catch (err) {
          logger.debug("failed to clean up mcp config", { error: String(err) });
        }
      }

      // Cancel any pending debounced status update before sending final reply
      const updateFn = originalMsg?.updateStatus as DebouncedFunction<any> | undefined;
      if (updateFn?.cancel) updateFn.cancel();

      trace.append(task.id, "output", "Runner output", result.output.slice(0, 10_000));

      if (result.success) {
        deps.queue.complete(task.id, result.output);
        logger.info("task completed", { taskId: task.id, durationMs: result.durationMs });

        const platform = originalMsg?.platform || "slack";
        const isCron = task.taskType === "cron";
        const replyText = isCron
          ? `[Scheduled: ${task.repo}]\n${result.output}`
          : result.output;
        const parts = splitAndReply(replyText, platform);
        for (const part of parts) {
          await replyWithFallback(part, originalMsg, task.userId, deps.adapters);
        }
        trace.append(task.id, "lifecycle", "Reply sent");
        deps.sessions.addMessage(task.userId, "assistant", result.output.slice(0, 500));

        const eventReply = deps.pendingEventReplies.get(task.id);
        if (eventReply) {
          await eventReply.adapter.respondToEvent(eventReply.event.eventId, result.output);
          deps.pendingEventReplies.delete(task.id);
        }

        const elapsed = Date.now() - startTime;
        trace.append(task.id, "lifecycle", `Task completed in ${elapsed}ms`);
      } else {
        deps.queue.fail(task.id, result.output);
        logger.error("task failed", { taskId: task.id });
        await replyWithFallback(`Task failed: ${result.output.slice(0, 500)}`, originalMsg, task.userId, deps.adapters);
        deps.sessions.addMessage(task.userId, "assistant", `Task failed: ${result.output.slice(0, 200)}`);

        const eventReply = deps.pendingEventReplies.get(task.id);
        if (eventReply) {
          await eventReply.adapter.respondToEvent(eventReply.event.eventId, `Task failed: ${result.output.slice(0, 500)}`);
          deps.pendingEventReplies.delete(task.id);
        }

        const elapsed = Date.now() - startTime;
        trace.append(task.id, "lifecycle", `Task failed in ${elapsed}ms`, result.output.slice(0, 2000));
      }
    } finally {
      if (!isCreateProject) {
        await deps.repos.removeWorktree(task.repo, task.id).catch(() => {});
      }
    }
  } catch (err) {
    deps.queue.fail(task.id, String(err));
    logger.error("task processing error", { taskId: task.id, error: String(err) });
    trace.append(task.id, "error", "Task processing error", String(err).slice(0, 2000));
    const updateFn = originalMsg?.updateStatus as DebouncedFunction<any> | undefined;
    if (updateFn?.cancel) updateFn.cancel();
    await replyWithFallback(`Task error: ${String(err).slice(0, 500)}`, originalMsg, task.userId, deps.adapters);
  } finally {
    deps.runningProcesses.delete(task.id);
    deps.pendingReplies.delete(task.id);
  }
}

export function createWorker(deps: WorkerDeps): { start: () => void; cancel: (id: string) => boolean } {
  async function workerLoop() {
    const maxConcurrent = 5;

    while (true) {
      if (deps.runningProcesses.size < maxConcurrent) {
        try {
          const task = deps.queue.dequeue();
          if (task) {
            processTask(task, deps).catch((err) =>
              logger.error("worker task error", { taskId: task.id, error: String(err) })
            );
            continue;
          }
        } catch (err) {
          logger.error("worker loop error", { error: String(err) });
        }
      }
      await Bun.sleep(2000);
    }
  }

  return {
    start: () => { workerLoop(); },
    cancel: (id: string) => {
      const entry = deps.runningProcesses.get(id);
      if (!entry) return false;
      entry.abort.abort();
      deps.queue.cancel(entry.task.id);
      return true;
    },
  };
}
