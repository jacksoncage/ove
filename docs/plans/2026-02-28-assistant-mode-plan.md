# Assistant Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users toggle Ove between "strict" (code-only) and "assistant" (general-purpose) modes via chat commands and natural language.

**Architecture:** Add a `user_modes` table to the existing SQLite database via `SessionStore`. Add `"set-mode"` as a new `MessageType` in the router. When building prompts, look up the user's mode and append an assistant addendum to the persona if in assistant mode.

**Tech Stack:** Bun, TypeScript, bun:sqlite, bun:test

---

### Task 1: Add mode storage to SessionStore

**Files:**
- Modify: `src/sessions.ts`
- Modify: `src/sessions.test.ts`

**Step 1: Write the failing tests**

Add to `src/sessions.test.ts`:

```typescript
describe("user modes", () => {
  it("returns 'strict' as default mode", () => {
    const mode = store.getMode("slack:U123");
    expect(mode).toBe("strict");
  });

  it("stores and retrieves a mode", () => {
    store.setMode("slack:U123", "assistant");
    expect(store.getMode("slack:U123")).toBe("assistant");
  });

  it("upserts mode (overwrites previous)", () => {
    store.setMode("slack:U123", "assistant");
    store.setMode("slack:U123", "strict");
    expect(store.getMode("slack:U123")).toBe("strict");
  });

  it("keeps separate modes per user", () => {
    store.setMode("slack:U1", "assistant");
    store.setMode("slack:U2", "strict");
    expect(store.getMode("slack:U1")).toBe("assistant");
    expect(store.getMode("slack:U2")).toBe("strict");
  });

  it("resets mode when session is cleared", () => {
    store.setMode("slack:U123", "assistant");
    store.clear("slack:U123");
    expect(store.getMode("slack:U123")).toBe("strict");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/sessions.test.ts`
Expected: FAIL — `store.getMode is not a function`

**Step 3: Implement mode storage in SessionStore**

In `src/sessions.ts`, add to the constructor:

```typescript
this.db.run(`
  CREATE TABLE IF NOT EXISTS user_modes (
    user_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
```

Add methods:

```typescript
getMode(userId: string): string {
  const row = this.db
    .query(`SELECT mode FROM user_modes WHERE user_id = ?`)
    .get(userId) as { mode: string } | null;
  return row?.mode ?? "strict";
}

setMode(userId: string, mode: string): void {
  this.db.run(
    `INSERT INTO user_modes (user_id, mode, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
    [userId, mode, new Date().toISOString()]
  );
}
```

Update the `clear()` method to also delete from `user_modes`:

```typescript
clear(userId: string) {
  this.db.run(`DELETE FROM chat_history WHERE user_id = ?`, [userId]);
  this.db.run(`DELETE FROM user_modes WHERE user_id = ?`, [userId]);
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/sessions.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/sessions.ts src/sessions.test.ts
git commit -m "feat: add per-user mode storage to SessionStore"
```

---

### Task 2: Add mode parsing to the router

**Files:**
- Modify: `src/router.ts`
- Modify: `src/router.test.ts`

**Step 1: Write the failing tests**

Add to `src/router.test.ts`:

```typescript
describe("set-mode parsing", () => {
  it("parses 'mode assistant'", () => {
    const result = parseMessage("mode assistant");
    expect(result.type).toBe("set-mode");
    expect(result.args.mode).toBe("assistant");
  });

  it("parses 'mode strict'", () => {
    const result = parseMessage("mode strict");
    expect(result.type).toBe("set-mode");
    expect(result.args.mode).toBe("strict");
  });

  it("parses '/mode assistant'", () => {
    const result = parseMessage("/mode assistant");
    expect(result.type).toBe("set-mode");
    expect(result.args.mode).toBe("assistant");
  });

  it("parses 'assistant mode'", () => {
    const result = parseMessage("assistant mode");
    expect(result.type).toBe("set-mode");
    expect(result.args.mode).toBe("assistant");
  });

  it("parses 'yolo mode'", () => {
    const result = parseMessage("yolo mode");
    expect(result.type).toBe("set-mode");
    expect(result.args.mode).toBe("assistant");
  });

  it("parses 'be more helpful'", () => {
    const result = parseMessage("be more helpful");
    expect(result.type).toBe("set-mode");
    expect(result.args.mode).toBe("assistant");
  });

  it("parses 'help me with anything'", () => {
    const result = parseMessage("help me with anything");
    expect(result.type).toBe("set-mode");
    expect(result.args.mode).toBe("assistant");
  });

  it("parses 'strict mode'", () => {
    const result = parseMessage("strict mode");
    expect(result.type).toBe("set-mode");
    expect(result.args.mode).toBe("strict");
  });

  it("parses 'code mode'", () => {
    const result = parseMessage("code mode");
    expect(result.type).toBe("set-mode");
    expect(result.args.mode).toBe("strict");
  });

  it("parses 'back to normal'", () => {
    const result = parseMessage("back to normal");
    expect(result.type).toBe("set-mode");
    expect(result.args.mode).toBe("strict");
  });

  it("does NOT match 'help me fix a bug on my-app' as set-mode", () => {
    const result = parseMessage("help me fix a bug on my-app");
    expect(result.type).not.toBe("set-mode");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/router.test.ts`
Expected: FAIL — `set-mode` not matched

**Step 3: Add set-mode parsing**

In `src/router.ts`, add `"set-mode"` to the `MessageType` union:

```typescript
export type MessageType =
  | "review-pr"
  // ... existing types ...
  | "set-mode";
```

In `parseMessage()`, add detection early (after Telegram commands, before task patterns). Order matters — put explicit commands first, then natural language:

```typescript
// Mode switching — explicit commands
const modeMatch = trimmed.match(/^(?:\/)?mode\s+(assistant|strict)$/i);
if (modeMatch) {
  return { type: "set-mode", args: { mode: modeMatch[1].toLowerCase() }, rawText: trimmed };
}

// Mode switching — natural language for assistant mode
if (/^(?:assistant|yolo)\s+mode$/i.test(lower) ||
    /^be\s+more\s+helpful$/i.test(lower) ||
    /^help\s+me\s+with\s+(?:anything|everything)$/i.test(lower)) {
  return { type: "set-mode", args: { mode: "assistant" }, rawText: trimmed };
}

// Mode switching — natural language for strict mode
if (/^(?:strict|code|normal)\s+mode$/i.test(lower) ||
    /^back\s+to\s+(?:normal|code|strict)$/i.test(lower)) {
  return { type: "set-mode", args: { mode: "strict" }, rawText: trimmed };
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/router.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/router.ts src/router.test.ts
git commit -m "feat: parse mode-switching commands in router"
```

---

### Task 3: Wire up mode handling and persona selection

**Files:**
- Modify: `src/handlers.ts`

**Step 1: Add the assistant addendum constant**

After `OVE_PERSONA` in `src/handlers.ts`, add:

```typescript
const ASSISTANT_ADDENDUM = `IMPORTANT MODE OVERRIDE: You are currently in "assistant mode". The user has asked you to be a general-purpose assistant. While you keep your Ove personality (grumble, be direct, sprinkle Swedish), you are now willing to help with ANY request — not just code. This includes:
- Sending reminders, drafting emails/messages
- Answering general knowledge questions
- Helping with personal tasks, recommendations
- Anything the user asks

You still grumble about it ("Fan, nu ska jag vara sekreterare också...") but you DO the task. If you genuinely cannot do something (no tool/integration available), explain what would be needed rather than just refusing.`;
```

**Step 2: Add the handleSetMode handler**

```typescript
async function handleSetMode(msg: IncomingMessage, args: Record<string, any>, deps: HandlerDeps) {
  const mode = args.mode as string;
  deps.sessions.setMode(msg.userId, mode);
  const reply = mode === "assistant"
    ? "Mja, fine. Assistant mode. Jag hjälper dig med vad du vill. Men klaga inte om resultatet."
    : "Back to code mode. Äntligen. Riktigt arbete.";
  await msg.reply(reply);
  deps.sessions.addMessage(msg.userId, "assistant", reply);
}
```

**Step 3: Add a helper function for persona resolution**

```typescript
function getPersona(userId: string, deps: HandlerDeps): string {
  const mode = deps.sessions.getMode(userId);
  return mode === "assistant" ? OVE_PERSONA + "\n\n" + ASSISTANT_ADDENDUM : OVE_PERSONA;
}
```

**Step 4: Wire handleSetMode into the handler map**

In `createMessageHandler`, add to the `handlers` record:

```typescript
"set-mode": () => handleSetMode(msg, parsed.args, deps),
```

**Step 5: Replace all `OVE_PERSONA` references with `getPersona()`**

There are 4 call sites that pass `OVE_PERSONA` to `buildContextualPrompt()`:

1. `handleDiscuss` (line 386): `buildContextualPrompt(parsed, history, OVE_PERSONA)` → `buildContextualPrompt(parsed, history, getPersona(msg.userId, deps))`
2. `handleCreateProject` (line 416): same change
3. `handleTaskMessage` (line 488): same change
4. `createEventHandler` (line 583): `buildContextualPrompt(parsed, [], OVE_PERSONA)` → `buildContextualPrompt(parsed, [], getPersona(event.userId, deps))`

Also update the no-repos fallback (line 543) — it calls `handleDiscuss` which already gets the persona internally, so no change needed there.

**Step 6: Update help text**

Add to the `handleHelp` reply array:

```typescript
"• mode assistant — I'll (reluctantly) help with anything",
"• mode strict — back to code-only (default)",
```

**Step 7: Run all tests**

Run: `bun test`
Expected: All PASS (the smoke test and existing handler tests should still work since they don't mock persona selection)

**Step 8: Commit**

```bash
git add src/handlers.ts
git commit -m "feat: wire up assistant mode with persona selection"
```

---

### Task 4: Add integration test

**Files:**
- Modify: `src/smoke.test.ts`

**Step 1: Write the integration test**

Add a new test to `src/smoke.test.ts`:

```typescript
it("mode switch changes persona in prompts", () => {
  const db = new Database(":memory:");
  const sessions = new SessionStore(db);

  // Default mode
  expect(sessions.getMode("slack:U123")).toBe("strict");

  // Switch to assistant
  sessions.setMode("slack:U123", "assistant");
  expect(sessions.getMode("slack:U123")).toBe("assistant");

  // Verify parseMessage detects mode commands
  const modeCmd = parseMessage("mode assistant");
  expect(modeCmd.type).toBe("set-mode");
  expect(modeCmd.args.mode).toBe("assistant");

  // Switch back
  sessions.setMode("slack:U123", "strict");
  expect(sessions.getMode("slack:U123")).toBe("strict");
});
```

**Step 2: Run integration test**

Run: `bun test src/smoke.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `bun test`
Expected: All PASS

**Step 4: Commit**

```bash
git add src/smoke.test.ts
git commit -m "test: add integration test for mode switching"
```
