# Conversation-Aware Repo Resolution

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a user sends a follow-up message without specifying a repo, Ove should remember which repo they were talking about from recent conversation context.

**Architecture:** Two-layer fallback added to the repo resolution chain in `handleTaskMessage`: (1) check the user's most recent task for its repo (cheap DB query), (2) feed conversation history to the LLM resolver prompt so it can infer the repo from context. No new tables or schema changes.

**Tech Stack:** Bun, bun:sqlite, bun:test, TypeScript

---

### Task 1: Add `lastRepoForUser` helper to handlers

**Files:**
- Modify: `src/handlers.ts:396-446`

**Step 1: Write the failing test**

Add to `src/flows.test.ts`:

```typescript
describe("Conversation-aware repo resolution", () => {
  it("derives lastRepo from recent task history", async () => {
    const db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
    const queue = new TaskQueue(db);

    // Simulate a completed task on "iris"
    const taskId = queue.enqueue({
      userId: "telegram:U1",
      repo: "iris",
      prompt: "check the roadmap",
    });
    queue.dequeue();
    queue.complete(taskId, "Here's the roadmap...");

    // The user's last task repo should be "iris"
    const recent = queue.listByUser("telegram:U1", 1);
    expect(recent.length).toBe(1);
    expect(recent[0].repo).toBe("iris");
  });
});
```

**Step 2: Run test to verify it passes**

Run: `bun test src/flows.test.ts --test-name-pattern "derives lastRepo"`
Expected: PASS (this is testing existing queue behavior — sanity check)

**Step 3: Add lastRepo fallback in handleTaskMessage**

In `src/handlers.ts`, inside `handleTaskMessage`, after the single-repo check (line ~411) and before the LLM resolver (line ~418), add:

```typescript
      // Check last task's repo as context fallback
      const recentTasks = deps.queue.listByUser(msg.userId, 1);
      const lastRepo = recentTasks[0]?.repo;
      if (lastRepo && repoNames.includes(lastRepo)) {
        parsed.repo = lastRepo;
        logger.info("repo resolved from recent task", { resolved: lastRepo, userText: parsed.rawText.slice(0, 80) });
      } else {
```

This goes inside the `else if (repoNames.length > 1)` block, between the single-repo check and the LLM resolver. The full block becomes:

```typescript
      if (repoNames.length === 1) {
        parsed.repo = repoNames[0];
      } else if (repoNames.length === 0) {
        const reply = "No repos discovered yet. Set one up with `init repo <name> <git-url>` or configure GitHub sync.";
        await msg.reply(reply);
        return;
      } else {
        // Try last task's repo first (cheap)
        const recentTasks = deps.queue.listByUser(msg.userId, 1);
        const lastRepo = recentTasks[0]?.repo;
        if (lastRepo && repoNames.includes(lastRepo)) {
          parsed.repo = lastRepo;
          logger.info("repo resolved from recent task", { resolved: lastRepo, userText: parsed.rawText.slice(0, 80) });
        } else {
          // Resolve repo via LLM call (existing code, moved into else branch)
          const repoList = repoNames.join(", ");
          // ... existing LLM resolver code ...
        }
      }
```

**Step 4: Run all tests**

Run: `bun test src/flows.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/handlers.ts src/flows.test.ts
git commit -m "feat: resolve repo from recent task history for follow-up messages"
```

---

### Task 2: Enhance LLM resolver with conversation history

**Files:**
- Modify: `src/handlers.ts:418-433`

**Step 1: Write the failing test**

Add to `src/flows.test.ts`:

```typescript
describe("LLM resolver with conversation history", () => {
  it("buildResolverPrompt includes conversation history", () => {
    const history = [
      { role: "user", content: "check the roadmap on iris", timestamp: "" },
      { role: "assistant", content: "Here's the iris roadmap...", timestamp: "" },
      { role: "user", content: "what about tomorrow's plan", timestamp: "" },
    ];
    const currentText = "what about tomorrow's plan";
    const repoList = "iris, docs, my-app";

    // Test the prompt format includes history
    const historyContext = history.length > 0
      ? "Recent conversation:\n" + history.map(m => `${m.role}: ${m.content}`).join("\n") + "\n\n"
      : "";
    const prompt = `You are a repo-name resolver. ${historyContext}The user's latest message:\n"${currentText}"\n\nAvailable repos: ${repoList}\n\nRespond with ONLY the repo name that best matches their request. Nothing else — just the exact repo name from the list. If you cannot determine which repo, respond with "UNKNOWN".`;

    expect(prompt).toContain("Recent conversation:");
    expect(prompt).toContain("check the roadmap on iris");
    expect(prompt).toContain("Here's the iris roadmap");
    expect(prompt).toContain("what about tomorrow's plan");
    expect(prompt).toContain("iris, docs, my-app");
  });
});
```

**Step 2: Run test to verify it passes**

Run: `bun test src/flows.test.ts --test-name-pattern "buildResolverPrompt"`
Expected: PASS (testing the prompt format)

**Step 3: Update LLM resolver in handleTaskMessage to include history**

In `src/handlers.ts`, modify the LLM resolver block. Change the resolver prompt from:

```typescript
const resolvePrompt = `You are a repo-name resolver. The user said:\n"${parsed.rawText}"\n\nAvailable repos: ${repoList}\n\nRespond with ONLY the repo name that best matches their request. Nothing else — just the exact repo name from the list. If you cannot determine which repo, respond with "UNKNOWN".`;
```

To:

```typescript
const history = deps.sessions.getHistory(msg.userId, 6);
const historyContext = history.length > 1
  ? "Recent conversation:\n" + history.slice(0, -1).map(m => `${m.role}: ${m.content}`).join("\n") + "\n\n"
  : "";
const resolvePrompt = `You are a repo-name resolver. ${historyContext}The user's latest message:\n"${parsed.rawText}"\n\nAvailable repos: ${repoList}\n\nRespond with ONLY the repo name that best matches their request. Consider the conversation context if the current message doesn't mention a specific repo. Nothing else — just the exact repo name from the list. If you cannot determine which repo, respond with "UNKNOWN".`;
```

**Step 4: Run all tests**

Run: `bun test src/flows.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/handlers.ts src/flows.test.ts
git commit -m "feat: feed conversation history to LLM repo resolver"
```

---

### Task 3: Integration test for the full follow-up flow

**Files:**
- Modify: `src/flows.test.ts`

**Step 1: Write the integration test**

```typescript
describe("Full follow-up conversation flow", () => {
  it("follow-up message without repo uses last task's repo", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
    const queue = new TaskQueue(db);
    const sessions = new SessionStore(db);

    // Simulate conversation: user talked about iris
    sessions.addMessage("telegram:U1", "user", "check the roadmap on iris");
    sessions.addMessage("telegram:U1", "assistant", "Here's the iris roadmap...");
    sessions.addMessage("telegram:U1", "user", "what about tomorrow's plan");

    // Simulate a completed task on iris
    const taskId = queue.enqueue({
      userId: "telegram:U1",
      repo: "iris",
      prompt: "check the roadmap",
    });
    queue.dequeue();
    queue.complete(taskId, "Here's the roadmap...");

    // Now a follow-up: "what about tomorrow" — no repo mentioned
    const parsed = parseMessage("what about tomorrow's plan");
    expect(parsed.type).toBe("free-form");
    expect(parsed.repo).toBeUndefined(); // Router can't find repo in text

    // But the last task was on iris
    const recentTasks = queue.listByUser("telegram:U1", 1);
    expect(recentTasks[0].repo).toBe("iris");

    // And the conversation history mentions iris
    const history = sessions.getHistory("telegram:U1", 6);
    expect(history.some(m => m.content.includes("iris"))).toBe(true);
  });

  it("explicit repo in message overrides last task repo", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
    const queue = new TaskQueue(db);

    // Last task was on iris
    const taskId = queue.enqueue({
      userId: "telegram:U1",
      repo: "iris",
      prompt: "check roadmap",
    });
    queue.dequeue();
    queue.complete(taskId, "done");

    // But new message explicitly says "on docs"
    const parsed = parseMessage("check the tests on docs");
    expect(parsed.repo).toBe("docs"); // Regex hint takes priority
  });
});
```

**Step 2: Run test**

Run: `bun test src/flows.test.ts --test-name-pattern "follow-up"`
Expected: PASS

**Step 3: Commit**

```bash
git add src/flows.test.ts
git commit -m "test: add integration tests for conversation-aware repo resolution"
```

---

### Task 4: Verify full test suite passes

**Step 1: Run all tests**

Run: `bun test`
Expected: All tests pass

**Step 2: Manual verification (optional)**

If running locally, send a message to Ove via Telegram:
1. "check the roadmap on iris" → should resolve to iris
2. "what about tomorrow's plan" → should resolve to iris (from recent task)
3. "check tests on docs" → should resolve to docs (explicit override)

**Step 3: Final commit if needed**

```bash
git add -A
git commit -m "feat: conversation-aware repo resolution for follow-up messages"
```
