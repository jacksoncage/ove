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
import type { AgentRunner, RunOptions, RunResult, StatusEvent, StreamEvent } from "./runner";
import type { TraceStore } from "./trace";
import type { SessionManager } from "./session-manager";
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
  sessionManager: SessionManager;
}

function findAdapterForUser(userId: string, adapters: ChatAdapter[]): ChatAdapter | undefined {
  const platform = userId.split(":")[0];
  return adapters.find((a) => a.constructor.name.toLowerCase().includes(platform));
}

function cancelDebouncedStatus(msg: IncomingMessage | undefined) {
  const fn = msg?.updateStatus as DebouncedFunction<any> | undefined;
  if (fn?.cancel) fn.cancel();
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

async function checkRecentPR(
  repoSlug: string,
  workDir: string
): Promise<{ prNumber: number; ciStatus: "passed" | "failed" | "pending"; ciDetails: string } | null> {
  try {
    const proc = Bun.spawn(
      ["gh", "pr", "list", "--state", "open", "--author", "@me", "--limit", "1", "--json", "number,statusCheckRollup,headRefName"],
      { cwd: workDir, stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;

    const prs = JSON.parse(text);
    if (prs.length === 0) return null;

    const pr = prs[0];
    const checks = pr.statusCheckRollup || [];
    const failed = checks.filter((c: any) => c.conclusion === "FAILURE" || c.conclusion === "ERROR");
    const pending = checks.filter((c: any) => !c.conclusion || c.conclusion === "PENDING");

    let ciStatus: "passed" | "failed" | "pending";
    let ciDetails = "";
    if (failed.length > 0) {
      ciStatus = "failed";
      ciDetails = failed.map((c: any) => `${c.name}: ${c.conclusion}`).join(", ");
    } else if (pending.length > 0) {
      ciStatus = "pending";
    } else {
      ciStatus = "passed";
    }

    return { prNumber: pr.number, ciStatus, ciDetails };
  } catch {
    return null;
  }
}

async function processTask(task: Task, deps: WorkerDeps) {
  const isCreateProject = task.taskType === "create-project";
  const isDiscuss = task.taskType === "discuss";
  const skipRepoSetup = isCreateProject || isDiscuss;
  const repoInfo = skipRepoSetup ? null : deps.getRepoInfo(task.repo);

  if (!skipRepoSetup && !repoInfo) {
    deps.queue.fail(task.id, `Unknown repo: ${task.repo}`);
    return;
  }

  const abortController = new AbortController();
  deps.runningProcesses.set(task.id, { abort: abortController, task });

  const originalMsg = deps.pendingReplies.get(task.id);
  const statusLog: string[] = [];
  const startTime = Date.now();

  deps.trace.append(task.id, "lifecycle", "Task started", task.prompt);

  try {
    await originalMsg?.updateStatus(`Working on it...`);

    let workDir: string;

    if (isDiscuss) {
      workDir = deps.config.reposDir;
    } else if (isCreateProject) {
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
      const maxTurns = task.taskType === "cron"
        ? Math.max(deps.config.claude.maxTurns, 100)
        : isDiscuss
        ? 5
        : deps.config.claude.maxTurns;
      const runOpts = deps.getRunnerOptsForRepo(task.repo, {
        maxTurns,
        mcpConfigPath,
        signal: abortController.signal,
      });

      const useStreaming = !isDiscuss && task.taskType !== "cron" && typeof (taskRunner as any).runStreaming === "function";

      let result: RunResult;

      if (useStreaming) {
        const session = (taskRunner as any).runStreaming(
          task.prompt,
          workDir,
          runOpts,
          (event: StreamEvent) => {
            if (event.kind === "tool") {
              const last = statusLog.at(-1);
              const summary = `Using ${event.tool}...`;
              if (last !== summary) statusLog.push(summary);
              deps.trace.append(task.id, "tool", summary, event.input.slice(0, 2000));
            } else if (event.kind === "text") {
              statusLog.push(event.text.slice(0, 200));
              deps.trace.append(task.id, "status", event.text.slice(0, 200));
            } else if (event.kind === "ask_user") {
              deps.queue.setWaiting(task.id);
              deps.sessionManager.setWaiting(task.id);
              deps.trace.append(task.id, "lifecycle", "Waiting for user input", event.question);
              const questionText = event.options.length > 0
                ? `${event.question}\n${event.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")}`
                : event.question;
              replyWithFallback(questionText, originalMsg, task.userId, deps.adapters);
            } else if (event.kind === "result" && event.sessionId) {
              deps.queue.setSessionId(task.id, event.sessionId);
            }
            originalMsg?.updateStatus(statusLog.slice(-5).join("\n"));
          }
        );

        deps.sessionManager.register(task.id, task.userId, session);
        result = await session.done;
        deps.sessionManager.unregister(task.id);
      } else {
        result = await taskRunner.run(
          task.prompt,
          workDir,
          runOpts,
          (event: StatusEvent) => {
            if (event.kind === "tool") {
              const last = statusLog.at(-1);
              const summary = `Using ${event.tool}...`;
              if (last !== summary) statusLog.push(summary);
              deps.trace.append(task.id, "tool", summary, event.input.slice(0, 2000));
            } else {
              statusLog.push(event.text.slice(0, 200));
              deps.trace.append(task.id, "status", event.text.slice(0, 200));
            }
            originalMsg?.updateStatus(statusLog.slice(-5).join("\n"));
          }
        );
      }

      if (mcpConfigPath) {
        try {
          await unlink(mcpConfigPath);
        } catch (err) {
          logger.debug("failed to clean up mcp config", { error: String(err) });
        }
      }

      cancelDebouncedStatus(originalMsg);
      deps.trace.append(task.id, "output", "Runner output", result.output.slice(0, 10_000));

      const elapsed = Date.now() - startTime;
      const outcome = result.success ? "completed" : "failed";

      if (result.success) {
        deps.queue.complete(task.id, result.output);
        logger.info("task completed", { taskId: task.id, durationMs: result.durationMs });

        const platform = originalMsg?.platform || "slack";
        const replyText = task.taskType === "cron"
          ? `[Scheduled: ${task.repo}]\n${result.output}`
          : result.output;
        for (const part of splitAndReply(replyText, platform)) {
          await replyWithFallback(part, originalMsg, task.userId, deps.adapters);
        }
        deps.trace.append(task.id, "lifecycle", "Reply sent");
        deps.sessions.addMessage(task.userId, "assistant", result.output.slice(0, 500));
      } else {
        deps.queue.fail(task.id, result.output);
        logger.error("task failed", { taskId: task.id });
        await replyWithFallback(`Task failed: ${result.output.slice(0, 500)}`, originalMsg, task.userId, deps.adapters);
        deps.sessions.addMessage(task.userId, "assistant", `Task failed: ${result.output.slice(0, 200)}`);
      }

      const eventReply = deps.pendingEventReplies.get(task.id);
      if (eventReply) {
        const eventOutput = result.success ? result.output : `Task failed: ${result.output.slice(0, 500)}`;
        await eventReply.adapter.respondToEvent(eventReply.event.eventId, eventOutput);
        deps.pendingEventReplies.delete(task.id);
      }

      deps.trace.append(
        task.id, "lifecycle", `Task ${outcome} in ${elapsed}ms`,
        result.success ? undefined : result.output.slice(0, 2000),
      );

      // Autonomous CI retry for cron tasks
      if (task.taskType === "cron" && result.success && !skipRepoSetup) {
        const MAX_CI_RETRIES = 3;

        for (let retry = 0; retry < MAX_CI_RETRIES; retry++) {
          // Wait for CI to start
          await Bun.sleep(30_000);

          const prStatus = await checkRecentPR(task.repo, workDir);
          if (!prStatus) break; // No PR found, nothing to check
          if (prStatus.ciStatus === "passed") break; // CI passed, done

          if (prStatus.ciStatus === "pending") {
            // Wait longer for pending CI
            await Bun.sleep(60_000);
            const recheck = await checkRecentPR(task.repo, workDir);
            if (!recheck || recheck.ciStatus !== "failed") break;
            // Update prStatus for the retry prompt
            Object.assign(prStatus, recheck);
          }

          // CI failed — retry with resume
          logger.info("cron task CI failed, retrying", {
            taskId: task.id,
            retry: retry + 1,
            pr: prStatus.prNumber,
            details: prStatus.ciDetails,
          });
          deps.trace.append(task.id, "lifecycle", `CI retry ${retry + 1}/${MAX_CI_RETRIES}`, prStatus.ciDetails);

          const retryPrompt = `CI failed on PR #${prStatus.prNumber}. Failures: ${prStatus.ciDetails}. Fix the issues and push again.`;
          const currentTask = deps.queue.get(task.id);
          const retryOpts: RunOptions = {
            ...runOpts,
            resumeSessionId: currentTask?.sessionId ?? undefined,
          };

          const retryResult = await taskRunner.run(retryPrompt, workDir, retryOpts);

          if (!retryResult.success) {
            logger.error("cron CI retry failed", { taskId: task.id, retry: retry + 1 });
            deps.trace.append(task.id, "lifecycle", `CI retry ${retry + 1} failed`, retryResult.output.slice(0, 500));
            break;
          }

          // Store session ID from retry if available
          if (retryResult.sessionId) {
            deps.queue.setSessionId(task.id, retryResult.sessionId);
          }

          deps.queue.updateResult(task.id, retryResult.output);
          await replyWithFallback(
            `[Scheduled: ${task.repo}] CI retry ${retry + 1}: ${retryResult.output.slice(0, 500)}`,
            originalMsg,
            task.userId,
            deps.adapters,
          );
          deps.trace.append(task.id, "lifecycle", `CI retry ${retry + 1} completed`);

          // Check if this retry fixed CI
          await Bun.sleep(30_000);
          const postRetry = await checkRecentPR(task.repo, workDir);
          if (!postRetry || postRetry.ciStatus !== "failed") break;
        }
      }
    } finally {
      if (!skipRepoSetup) {
        await deps.repos.removeWorktree(task.repo, task.id).catch((err) => {
          logger.warn("worktree cleanup failed", { repo: task.repo, taskId: task.id, error: String(err) });
        });
      }
    }
  } catch (err) {
    deps.queue.fail(task.id, String(err));
    logger.error("task processing error", { taskId: task.id, error: String(err) });
    deps.trace.append(task.id, "error", "Task processing error", String(err).slice(0, 2000));
    cancelDebouncedStatus(originalMsg);
    await replyWithFallback(`Task error: ${String(err).slice(0, 500)}`, originalMsg, task.userId, deps.adapters);
  } finally {
    deps.runningProcesses.delete(task.id);
    deps.pendingReplies.delete(task.id);
  }
}

export function createWorker(deps: WorkerDeps): { start: () => void; cancel: (id: string) => boolean } {
  async function workerLoop() {
    while (true) {
      try {
        const task = deps.queue.dequeue();
        if (task) {
          processTask(task, deps).catch((err) => {
            logger.error("worker task error", { taskId: task.id, error: String(err) });
            deps.queue.fail(task.id, String(err));
            deps.runningProcesses.delete(task.id);
            deps.pendingReplies.delete(task.id);
          });
          await Bun.sleep(100); // brief pause between spawns to prevent burst
          continue;
        }
      } catch (err) {
        logger.error("worker loop error", { error: String(err) });
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
