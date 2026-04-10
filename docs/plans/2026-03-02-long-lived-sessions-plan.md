# Long-lived Streaming Sessions — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace fire-and-forget task execution with bidirectional streaming sessions so Ove can relay user questions, inject CI results, and iterate until goals are met.

**Architecture:** The ClaudeRunner gains a new `runStreaming()` method that keeps stdin open via `--input-format stream-json`. A new SessionManager tracks live sessions and routes follow-up messages. The worker uses streaming for interactive tasks and resume-based chaining for autonomous (cron) tasks. Queue gets new `waiting_user` status for tasks blocked on user input.

**Tech Stack:** Bun subprocess with stdin pipe, Claude CLI `--input-format stream-json` / `--resume`, bun:sqlite for state.

---

### Task 1: Add `waiting_user` task status to queue

**Files:**
- Modify: `src/queue.ts:16` (Task type)
- Modify: `src/queue.ts:82` (dequeue query)
- Modify: `src/queue.ts:103` (finish method)
- Modify: `src/queue.ts:209` (listActive query)
- Modify: `src/queue.ts:217` (cancel query)
- Modify: `src/queue.ts:237` (resetStale query)
- Test: `src/queue.test.ts`

**Step 1: Write the failing test**

Add to `src/queue.test.ts`:

```typescript
describe("waiting_user status", () => {
  it("setWaiting transitions running task to waiting_user", () => {
    const id = queue.enqueue({ userId: "u1", repo: "r1", prompt: "test" });
    queue.dequeue(); // running
    queue.setWaiting(id, "waiting_user");
    const task = queue.get(id);
    expect(task?.status).toBe("waiting_user");
  });

  it("resume transitions waiting_user back to running", () => {
    const id = queue.enqueue({ userId: "u1", repo: "r1", prompt: "test" });
    queue.dequeue();
    queue.setWaiting(id, "waiting_user");
    queue.resume(id);
    const task = queue.get(id);
    expect(task?.status).toBe("running");
  });

  it("dequeue skips waiting_user tasks", () => {
    const id = queue.enqueue({ userId: "u1", repo: "r1", prompt: "test" });
    queue.dequeue();
    queue.setWaiting(id, "waiting_user");
    // Enqueue another for same repo
    queue.enqueue({ userId: "u1", repo: "r1", prompt: "test2" });
    // Should NOT dequeue test2 because r1 has a waiting_user task (still "occupies" the repo)
    const next = queue.dequeue();
    expect(next).toBeNull();
  });

  it("resetStale also resets waiting_user tasks", () => {
    const id = queue.enqueue({ userId: "u1", repo: "r1", prompt: "test" });
    queue.dequeue();
    queue.setWaiting(id, "waiting_user");
    const count = queue.resetStale();
    expect(count).toBe(1);
    expect(queue.get(id)?.status).toBe("failed");
  });

  it("listActive includes waiting_user tasks", () => {
    const id = queue.enqueue({ userId: "u1", repo: "r1", prompt: "test" });
    queue.dequeue();
    queue.setWaiting(id, "waiting_user");
    const active = queue.listActive();
    expect(active.some(t => t.id === id)).toBe(true);
  });

  it("getWaitingForUser returns waiting_user task for a user", () => {
    const id = queue.enqueue({ userId: "u1", repo: "r1", prompt: "test" });
    queue.dequeue();
    queue.setWaiting(id, "waiting_user");
    const waiting = queue.getWaitingForUser("u1");
    expect(waiting?.id).toBe(id);
  });

  it("getWaitingForUser returns null when no waiting tasks", () => {
    const waiting = queue.getWaitingForUser("u1");
    expect(waiting).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/queue.test.ts`
Expected: FAIL — `setWaiting`, `resume`, `getWaitingForUser` don't exist.

**Step 3: Implement**

In `src/queue.ts`:

1. Update the `Task` status type (line 16):
```typescript
status: "pending" | "running" | "completed" | "failed" | "waiting_user";
```

2. Add `setWaiting` method:
```typescript
setWaiting(id: string, status: "waiting_user") {
  this.db.run(
    `UPDATE tasks SET status = ? WHERE id = ? AND status = 'running'`,
    [status, id]
  );
}
```

3. Add `resume` method:
```typescript
resume(id: string) {
  this.db.run(
    `UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'waiting_user'`,
    [id]
  );
}
```

4. Add `getWaitingForUser` method:
```typescript
getWaitingForUser(userId: string): Task | null {
  const row = this.db
    .query(`SELECT * FROM tasks WHERE user_id = ? AND status = 'waiting_user' ORDER BY created_at DESC LIMIT 1`)
    .get(userId) as TaskRow;
  return row ? this.rowToTask(row) : null;
}
```

5. Update `dequeue` query (line 82) — treat `waiting_user` like `running` for repo blocking:
```sql
AND repo NOT IN (SELECT repo FROM tasks WHERE status IN ('running', 'waiting_user'))
```

6. Update `listActive` query (line 209):
```sql
WHERE status IN ('running', 'pending', 'waiting_user')
```

7. Update `cancel` query (line 217):
```sql
WHERE id = ? AND status IN ('running', 'pending', 'waiting_user')
```

8. Update `resetStale` query (line 237):
```sql
WHERE status IN ('running', 'waiting_user')
```

9. Update `rowToTask` cast (line 248) to include `waiting_user` in the union type.

10. Update `stats()` to count `waiting_user` — add it to the return type and query.

**Step 4: Run test to verify it passes**

Run: `bun test src/queue.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/queue.ts src/queue.test.ts
git commit -m "feat: add waiting_user task status to queue"
```

---

### Task 2: Add `sessionId` column to tasks table

**Files:**
- Modify: `src/queue.ts` (schema + enqueue + rowToTask)
- Test: `src/queue.test.ts`

We need to store the Claude session ID so we can resume sessions later.

**Step 1: Write the failing test**

```typescript
describe("sessionId tracking", () => {
  it("stores sessionId via setSessionId", () => {
    const id = queue.enqueue({ userId: "u1", repo: "r1", prompt: "test" });
    queue.setSessionId(id, "ses-abc-123");
    const task = queue.get(id);
    expect(task?.sessionId).toBe("ses-abc-123");
  });

  it("sessionId is null by default", () => {
    const id = queue.enqueue({ userId: "u1", repo: "r1", prompt: "test" });
    const task = queue.get(id);
    expect(task?.sessionId).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/queue.test.ts`
Expected: FAIL — `sessionId` not on Task, `setSessionId` doesn't exist.

**Step 3: Implement**

1. Add `sessionId` to `Task` interface and `TaskRow`:
```typescript
// Task interface
sessionId: string | null;

// TaskRow interface
session_id: string | null;
```

2. Add migration in constructor:
```typescript
if (!columns.some(c => c.name === "session_id")) {
  this.db.run("ALTER TABLE tasks ADD COLUMN session_id TEXT");
}
```

3. Add `setSessionId` method:
```typescript
setSessionId(id: string, sessionId: string) {
  this.db.run(`UPDATE tasks SET session_id = ? WHERE id = ?`, [sessionId, id]);
}
```

4. Update `rowToTask` to include `sessionId: row.session_id || null`.

**Step 4: Run test to verify it passes**

Run: `bun test src/queue.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/queue.ts src/queue.test.ts
git commit -m "feat: add sessionId column to tasks for session resume"
```

---

### Task 3: Update `AgentRunner` interface and `RunOptions` for streaming

**Files:**
- Modify: `src/runner.ts`
- Test: `src/runners/claude.test.ts`

**Step 1: Write the failing test**

Add to `src/runners/claude.test.ts`:

```typescript
describe("streaming args", () => {
  it("builds streaming args with input-format and without disallowed AskUserQuestion", () => {
    const args = runner.buildStreamingArgs("fix the bug", { maxTurns: 25 });
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).not.toContain("AskUserQuestion");
  });

  it("streaming args still include output-format stream-json", () => {
    const args = runner.buildStreamingArgs("test", { maxTurns: 10 });
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
  });

  it("includes resume flag when sessionId provided", () => {
    const args = runner.buildStreamingArgs("test", { maxTurns: 10, resumeSessionId: "ses-123" });
    expect(args).toContain("--resume");
    expect(args).toContain("ses-123");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/runners/claude.test.ts`
Expected: FAIL — `buildStreamingArgs` doesn't exist.

**Step 3: Implement**

1. Update `RunOptions` in `src/runner.ts`:
```typescript
export interface RunOptions {
  maxTurns: number;
  mcpConfigPath?: string;
  model?: string;
  signal?: AbortSignal;
  resumeSessionId?: string;
}
```

2. Add `StreamEvent` type and `StreamingSession` interface to `src/runner.ts`:
```typescript
export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; input: string }
  | { kind: "ask_user"; question: string; options: { label: string; description?: string }[] }
  | { kind: "result"; text: string; sessionId?: string }
  | { kind: "error"; text: string };

export interface StreamingSession {
  sendMessage(text: string): void;
  kill(): void;
  readonly sessionId: string | null;
  readonly done: Promise<RunResult>;
}
```

3. Add `buildStreamingArgs` to `ClaudeRunner` in `src/runners/claude.ts`:
```typescript
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
```

Note: No `--disallowed-tools AskUserQuestion` — that's the key difference from `buildArgs`.

**Step 4: Run test to verify it passes**

Run: `bun test src/runners/claude.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runner.ts src/runners/claude.ts src/runners/claude.test.ts
git commit -m "feat: add streaming args builder and StreamingSession interface"
```

---

### Task 4: Implement `runStreaming()` on ClaudeRunner

**Files:**
- Modify: `src/runners/claude.ts`
- Test: `src/runners/claude.test.ts`

This is the core new method. It spawns Claude with stdin pipe open and returns a `StreamingSession` handle.

**Step 1: Write the failing test**

```typescript
describe("runStreaming", () => {
  it("method exists and returns a StreamingSession-like object", () => {
    expect(typeof runner.runStreaming).toBe("function");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/runners/claude.test.ts`
Expected: FAIL — `runStreaming` doesn't exist.

**Step 3: Implement**

Add `runStreaming` method to `ClaudeRunner`:

```typescript
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

  // Read stdout in background
  const done = (async (): Promise<RunResult> => {
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

            // Capture session ID from init message
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

    return { success: true, output: resultText || textBlocks.join("\n\n") || "Task completed (no output)", durationMs };
  })();

  const encoder = new TextEncoder();

  return {
    sendMessage(text: string) {
      const msg = JSON.stringify({ type: "user_message", content: text }) + "\n";
      proc.stdin.write(encoder.encode(msg));
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
```

**Step 4: Run test to verify it passes**

Run: `bun test src/runners/claude.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runners/claude.ts src/runners/claude.test.ts
git commit -m "feat: implement runStreaming with bidirectional stdin/stdout"
```

---

### Task 5: Create SessionManager

**Files:**
- Create: `src/session-manager.ts`
- Test: `src/session-manager.test.ts`

The SessionManager tracks live streaming sessions and provides methods to send messages to them.

**Step 1: Write the failing test**

Create `src/session-manager.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { SessionManager } from "./session-manager";
import type { StreamingSession } from "./runner";
import type { RunResult } from "./runner";

function mockSession(overrides?: Partial<StreamingSession>): StreamingSession {
  const messages: string[] = [];
  return {
    sendMessage: (text: string) => messages.push(text),
    kill: () => {},
    sessionId: "ses-test-123",
    done: Promise.resolve({ success: true, output: "done", durationMs: 100 }),
    _messages: messages, // for test inspection
    ...overrides,
  } as StreamingSession & { _messages: string[] };
}

describe("SessionManager", () => {
  it("registers and retrieves a session by taskId", () => {
    const mgr = new SessionManager();
    const session = mockSession();
    mgr.register("task-1", "user-1", session);
    expect(mgr.getByTask("task-1")).toBe(session);
  });

  it("retrieves waiting session by userId", () => {
    const mgr = new SessionManager();
    const session = mockSession();
    mgr.register("task-1", "user-1", session);
    mgr.setWaiting("task-1");
    expect(mgr.getWaitingForUser("user-1")).toEqual({ taskId: "task-1", session });
  });

  it("returns null when no waiting session for user", () => {
    const mgr = new SessionManager();
    expect(mgr.getWaitingForUser("user-1")).toBeNull();
  });

  it("sendToTask sends message to the session", () => {
    const mgr = new SessionManager();
    const session = mockSession();
    mgr.register("task-1", "user-1", session);
    mgr.sendToTask("task-1", "hello");
    expect((session as any)._messages).toEqual(["hello"]);
  });

  it("unregister removes the session", () => {
    const mgr = new SessionManager();
    const session = mockSession();
    mgr.register("task-1", "user-1", session);
    mgr.unregister("task-1");
    expect(mgr.getByTask("task-1")).toBeNull();
  });

  it("clearWaiting removes waiting state but keeps session", () => {
    const mgr = new SessionManager();
    const session = mockSession();
    mgr.register("task-1", "user-1", session);
    mgr.setWaiting("task-1");
    mgr.clearWaiting("task-1");
    expect(mgr.getWaitingForUser("user-1")).toBeNull();
    expect(mgr.getByTask("task-1")).toBe(session);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/session-manager.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Implement**

Create `src/session-manager.ts`:

```typescript
import type { StreamingSession } from "./runner";

interface SessionEntry {
  taskId: string;
  userId: string;
  session: StreamingSession;
  waiting: boolean;
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();

  register(taskId: string, userId: string, session: StreamingSession) {
    this.sessions.set(taskId, { taskId, userId, session, waiting: false });
  }

  unregister(taskId: string) {
    this.sessions.delete(taskId);
  }

  getByTask(taskId: string): StreamingSession | null {
    return this.sessions.get(taskId)?.session ?? null;
  }

  setWaiting(taskId: string) {
    const entry = this.sessions.get(taskId);
    if (entry) entry.waiting = true;
  }

  clearWaiting(taskId: string) {
    const entry = this.sessions.get(taskId);
    if (entry) entry.waiting = false;
  }

  getWaitingForUser(userId: string): { taskId: string; session: StreamingSession } | null {
    for (const entry of this.sessions.values()) {
      if (entry.userId === userId && entry.waiting) {
        return { taskId: entry.taskId, session: entry.session };
      }
    }
    return null;
  }

  sendToTask(taskId: string, text: string): boolean {
    const entry = this.sessions.get(taskId);
    if (!entry) return false;
    entry.session.sendMessage(text);
    return true;
  }

  killAll() {
    for (const entry of this.sessions.values()) {
      entry.session.kill();
    }
    this.sessions.clear();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/session-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/session-manager.ts src/session-manager.test.ts
git commit -m "feat: add SessionManager for tracking live streaming sessions"
```

---

### Task 6: Wire streaming sessions into worker

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/worker.ts` (WorkerDeps)
- Test: (integration — tested via existing worker tests + manual)

This is the main integration task. The worker uses `runStreaming()` for interactive tasks and feeds `ask_user` events to the session manager.

**Step 1: Update WorkerDeps**

Add to `WorkerDeps` in `src/worker.ts`:

```typescript
import { SessionManager } from "./session-manager";
// Add to interface:
sessionManager: SessionManager;
```

**Step 2: Update processTask to use streaming for non-cron, non-discuss tasks**

Replace the `taskRunner.run(...)` call in `processTask` with logic that:

1. For **discuss tasks** and **cron tasks**: keep using `taskRunner.run()` (fire-and-forget). Discuss tasks are lightweight (5 turns). Cron tasks are autonomous.
2. For **repo-bound interactive tasks**: use `taskRunner.runStreaming()` if the runner has that method.

The key change in `processTask` (around lines 124-140):

```typescript
const isStreaming = !isDiscuss && task.taskType !== "cron" && typeof taskRunner.runStreaming === "function";

if (isStreaming) {
  const session = (taskRunner as any).runStreaming(
    task.prompt, workDir, runOpts,
    (event: StreamEvent) => {
      if (event.kind === "tool") {
        const summary = `Using ${event.tool}...`;
        if (statusLog.at(-1) !== summary) statusLog.push(summary);
        deps.trace.append(task.id, "tool", summary, event.input.slice(0, 2000));
      } else if (event.kind === "text") {
        statusLog.push(event.text.slice(0, 200));
        deps.trace.append(task.id, "status", event.text.slice(0, 200));
      } else if (event.kind === "ask_user") {
        deps.queue.setWaiting(task.id, "waiting_user");
        deps.sessionManager.setWaiting(task.id);
        deps.trace.append(task.id, "lifecycle", "Waiting for user input", event.question);

        const questionText = event.options.length > 0
          ? `${event.question}\n${event.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")}`
          : event.question;
        replyWithFallback(questionText, originalMsg, task.userId, deps.adapters);
      } else if (event.kind === "result") {
        if (event.sessionId) deps.queue.setSessionId(task.id, event.sessionId);
      }
      originalMsg?.updateStatus(statusLog.slice(-5).join("\n"));
    }
  );

  deps.sessionManager.register(task.id, task.userId, session);
  const result = await session.done;
  deps.sessionManager.unregister(task.id);

  // ... handle result (same success/fail logic as current code)
} else {
  // Current fire-and-forget path
  const result = await taskRunner.run(...);
  // ... existing handling
}
```

**Step 3: Commit**

```bash
git add src/worker.ts
git commit -m "feat: wire streaming sessions into worker for interactive tasks"
```

---

### Task 7: Route user replies to waiting sessions in handlers

**Files:**
- Modify: `src/handlers.ts`
- Modify: `src/handlers.ts` (HandlerDeps)
- Test: `src/handlers.test.ts`

When a user sends a message and they have a `waiting_user` task, route the reply to the session instead of creating a new task.

**Step 1: Write the failing test**

Add to `src/handlers.test.ts`:

```typescript
describe("reply routing to waiting sessions", () => {
  it("routes reply to waiting session instead of creating new task", async () => {
    const sentMessages: string[] = [];
    const mockSessionManager = {
      getWaitingForUser: (userId: string) => userId === "slack:U123"
        ? { taskId: "task-waiting", session: { sendMessage: (t: string) => sentMessages.push(t) } }
        : null,
      clearWaiting: () => {},
    };

    const deps = makeDeps({
      sessionManager: mockSessionManager as any,
    });

    // Simulate a waiting_user task
    const id = deps.queue.enqueue({ userId: "slack:U123", repo: "my-app", prompt: "original" });
    deps.queue.dequeue(); // running
    deps.queue.setWaiting(id, "waiting_user");

    const handler = createMessageHandler(deps);
    const msg = makeMessage("yes, fix them all");
    await handler(msg);

    // Should have sent to session, not created a new task
    expect(sentMessages).toContain("yes, fix them all");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/handlers.test.ts`
Expected: FAIL — `sessionManager` not in HandlerDeps.

**Step 3: Implement**

1. Add `sessionManager` to `HandlerDeps`:
```typescript
import type { SessionManager } from "./session-manager";
// In HandlerDeps interface:
sessionManager?: SessionManager;
```

2. At the top of the message handler (in `createMessageHandler`, before parsing), add:

```typescript
// Check if user has a waiting session — route reply there instead of new task
if (deps.sessionManager) {
  const waiting = deps.sessionManager.getWaitingForUser(msg.userId);
  if (waiting) {
    waiting.session.sendMessage(msg.text);
    deps.sessionManager.clearWaiting(waiting.taskId);
    deps.queue.resume(waiting.taskId);
    deps.sessions.addMessage(msg.userId, "user", msg.text);
    deps.trace.append(waiting.taskId, "lifecycle", "User reply received", msg.text.slice(0, 200));
    return;
  }
}
```

This goes right after `deps.sessions.addMessage(msg.userId, "user", msg.text)` (line 485) and before `const parsed = parseMessage(msg.text)` (line 487). Move the addMessage call after the check to avoid double-adding.

**Step 4: Run test to verify it passes**

Run: `bun test src/handlers.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/handlers.ts src/handlers.test.ts
git commit -m "feat: route user replies to waiting streaming sessions"
```

---

### Task 8: Wire SessionManager into index.ts

**Files:**
- Modify: `src/index.ts`

**Step 1: Implement**

1. Import SessionManager:
```typescript
import { SessionManager } from "./session-manager";
```

2. Create instance after other stores:
```typescript
const sessionManager = new SessionManager();
```

3. Add to `handlerDeps`:
```typescript
sessionManager,
```

4. Add to worker deps:
```typescript
sessionManager,
```

5. In `shutdown()`, add:
```typescript
sessionManager.killAll();
```

**Step 2: Run all tests**

Run: `bun test`
Expected: All tests PASS. The sessionManager is optional in HandlerDeps so existing tests work without it.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire SessionManager into main application"
```

---

### Task 9: Autonomous completion loop for cron tasks (resume-based)

**Files:**
- Modify: `src/worker.ts`
- Test: (integration)

For cron tasks, after Claude exits, check if a PR was created and if CI passed. If CI failed, resume the session with `--resume` and inject the failure context.

**Step 1: Add CI check helper**

Create a helper function in `src/worker.ts`:

```typescript
async function checkRecentPR(repo: string, workDir: string): Promise<{ prNumber: number; ciStatus: string; ciDetails: string } | null> {
  try {
    const proc = Bun.spawn(
      ["gh", "pr", "list", "--repo", repo, "--state", "open", "--author", "@me", "--limit", "1", "--json", "number,statusCheckRollup,headRefName"],
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

    let ciStatus: string;
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
```

**Step 2: Add retry loop for cron tasks**

After the main `result` handling in `processTask`, add a retry loop for cron tasks:

```typescript
// After initial result handling for cron tasks
if (task.taskType === "cron" && result.success) {
  const repoUrl = repoInfo ? `${repoInfo.url.replace("git@github.com:", "").replace(".git", "")}` : "";
  const maxRetries = 3;

  for (let retry = 0; retry < maxRetries; retry++) {
    // Wait for CI to start
    await Bun.sleep(30_000);

    const prStatus = await checkRecentPR(repoUrl, workDir);
    if (!prStatus || prStatus.ciStatus === "passed") break;
    if (prStatus.ciStatus === "pending") {
      // Wait longer for pending CI
      await Bun.sleep(60_000);
      const recheck = await checkRecentPR(repoUrl, workDir);
      if (!recheck || recheck.ciStatus !== "failed") break;
    }

    // CI failed — resume and fix
    logger.info("cron task CI failed, retrying", { taskId: task.id, retry: retry + 1, pr: prStatus.prNumber });
    deps.trace.append(task.id, "lifecycle", `CI retry ${retry + 1}/${maxRetries}`, prStatus.ciDetails);

    const retryPrompt = `CI failed on PR #${prStatus.prNumber}. Failures: ${prStatus.ciDetails}. Fix the issues and push again.`;
    const sessionId = deps.queue.get(task.id)?.sessionId;
    const retryOpts = { ...runOpts, resumeSessionId: sessionId ?? undefined };

    const retryResult = await taskRunner.run(retryPrompt, workDir, retryOpts);
    if (!retryResult.success) break;

    // Update stored result
    deps.queue.complete(task.id, retryResult.output);
    await replyWithFallback(
      `[Scheduled: ${task.repo}] CI retry ${retry + 1}: ${retryResult.output.slice(0, 500)}`,
      originalMsg, task.userId, deps.adapters
    );
  }
}
```

**Step 3: Update ClaudeRunner.buildArgs to support resumeSessionId**

In `src/runners/claude.ts`, update `buildArgs`:
```typescript
buildArgs(prompt: string, opts: RunOptions): string[] {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--max-turns", String(opts.maxTurns), "--dangerously-skip-permissions", "--disallowed-tools", "AskUserQuestion"];
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  return args;
}
```

**Step 4: Also capture sessionId from fire-and-forget runs**

In the existing `run()` method, extract session_id from result messages:
```typescript
// Inside the line parsing loop, add:
if (msg.type === "result" && msg.session_id) {
  // Store for potential resume
  resultSessionId = msg.session_id;
}
```

Return it as part of RunResult (add `sessionId?: string` to RunResult interface).

**Step 5: Run all tests**

Run: `bun test`
Expected: All PASS.

**Step 6: Commit**

```bash
git add src/worker.ts src/runners/claude.ts src/runner.ts
git commit -m "feat: add autonomous CI retry loop for cron tasks"
```

---

### Task 10: Final integration test and cleanup

**Files:**
- Test: run full suite
- Modify: any fixes needed

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass.

**Step 2: Run type check**

Run: `bunx tsc --noEmit`
Expected: No type errors.

**Step 3: Manual smoke test**

Start Ove locally and verify:
- Discuss tasks still work (fire-and-forget, 5 turns)
- Repo-bound tasks use streaming (check logs for "starting streaming claude task")
- The `--input-format stream-json` flag appears in process args

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: integration fixes for streaming sessions"
```

**Step 5: Create PR**

```bash
gh pr create --title "feat: long-lived streaming sessions (#21)" --body "..."
```
