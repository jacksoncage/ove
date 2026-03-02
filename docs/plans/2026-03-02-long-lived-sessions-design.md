# Long-lived Streaming Sessions

**Date:** 2026-03-02
**Status:** Proposed
**Issue:** TBD

## Problem

Ove's task execution is fire-and-forget. Each task spawns `claude -p <prompt>`, Claude runs, exits, and the task is marked done — regardless of whether the actual goal was achieved. This causes:

1. **Incomplete work**: Ove creates PRs with failing CI and stops. It reports the failures but doesn't fix them.
2. **No user interaction**: Claude can't ask clarifying questions during execution because `AskUserQuestion` is disabled.
3. **No follow-up**: When CI fails or the user wants to course-correct, there's no way to feed context back into the running session. A new task starts from scratch.
4. **Repeated context loss**: Each new task re-explores the codebase, losing all context from the previous run.

Real example: Ove was asked to implement 4 issues on the Virke project. It wrote code, opened 4 PRs — all with failing CI. Then it stopped and asked the user what to do. The user said "fix them." Ove started over, re-explored, and failed again. No progress toward the actual goal.

## Solution

Replace fire-and-forget with **long-lived bidirectional streaming sessions**.

### Core idea

Instead of:
```
claude -p <prompt> --output-format stream-json  →  exits  →  "done"
```

Spawn:
```
claude -p <prompt> --input-format stream-json --output-format stream-json
```

Keep stdin open. Ove can push follow-up messages (user replies, CI results, course corrections) into the running Claude session. Claude keeps full context. The session stays alive until Claude signals it's truly done.

## Architecture

### Current flow
```
User msg → enqueue → worker dequeues → claude -p → exits → completed/failed
```

### New flow
```
User msg → enqueue → worker dequeues → claude -p (streaming)
                                             ↕ bidirectional
                                        SessionManager
                                             ↕
                                   user replies / CI results / follow-ups
```

A new **SessionManager** component manages the lifecycle of running Claude sessions, handling the bidirectional stream between the worker and the Claude process.

## Task States

### Current
```
pending → running → completed | failed
```

### New
```
pending → running → completed | failed
                  → waiting_user   (Claude asked a question, relayed to user)
                  → waiting_ci     (Claude pushed code, awaiting CI)
```

`waiting_*` states mean the Claude process is alive but idle — waiting for Ove to inject the next message via stdin.

## Key Components

### 1. SessionManager

New module that wraps a running Claude process:

```typescript
interface Session {
  taskId: string;
  process: Subprocess;
  stdin: WritableStream;     // Send messages TO Claude
  state: "running" | "waiting_user" | "waiting_ci" | "done";
  sendMessage(text: string): void;   // Inject follow-up via stdin
  kill(): void;
}
```

### 2. AskUserQuestion relay

Currently disabled (`--disallowed-tools AskUserQuestion`). With streaming sessions, we **enable it**.

When Claude calls AskUserQuestion:
1. Ove intercepts the `tool_use` event from stdout stream
2. Relays question + options to the user via their chat platform
3. Sets task state to `waiting_user`
4. When user responds, Ove sends the answer back via stdin stream-json
5. Claude continues with the answer

### 3. Completion logic

Claude decides when it's done (emits `result` event). Ove adds guardrails:

| Guard | Default | Purpose |
|-------|---------|---------|
| Max duration | 30min repo, 5min discuss | Prevent runaway sessions |
| Max turns | 50 repo, 5 discuss | Same as today but higher |
| Idle timeout | 5min no events | Kill stuck sessions |
| Cost budget | Optional `--max-budget-usd` | Spending limit |

### 4. Reply routing

When a user sends a message and there's a `waiting_user` task for that user:
- Route the reply INTO the waiting session (via stdin) instead of creating a new task
- Set task state back to `running`

When there's no waiting task:
- Create a new task as today

## What Changes

| File | Change |
|------|--------|
| `src/runners/claude.ts` | Add `--input-format stream-json`, enable AskUserQuestion, return Session handle instead of awaiting result |
| `src/session-manager.ts` | **New** — manages running sessions, stdin/stdout routing, state transitions |
| `src/worker.ts` | Use SessionManager instead of fire-and-forget. Handle waiting states. |
| `src/queue.ts` | Add `waiting_user` and `waiting_ci` status values |
| `src/handlers.ts` | Route user replies to waiting sessions. Relay AskUserQuestion to chat. |
| `src/runner.ts` | Update AgentRunner interface for bidirectional streaming |

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `--input-format stream-json` stdin protocol undocumented | Test empirically before building. Fallback: use `--resume` for chaining. |
| Long-lived processes consume resources | Enforce max duration + idle timeout. Max 5 concurrent sessions (same as today). |
| Process crashes mid-session | Detect crash, mark task failed, notify user. Consider auto-resume with `--resume <session-id>`. |
| User never replies to question | Idle timeout kills session after configurable period. Notify user before killing. |
| Claude loops endlessly | Max turns limit. Cost budget limit. |

## Incremental Delivery

### Phase 1: Enable AskUserQuestion + relay
- Enable AskUserQuestion in Claude args
- Parse tool_use events for AskUserQuestion
- Relay to chat, accept reply, feed back to stdin
- This alone fixes the "can't ask questions" problem

### Phase 2: Long-lived session manager
- SessionManager with state tracking
- Reply routing to waiting sessions
- Proper cleanup and timeout handling

### Phase 3: CI-aware completion (optional)
- After Claude pushes, Ove polls CI status
- Injects CI results back into session
- Claude iterates until green

## Open Questions

1. Exact stdin JSON format for `--input-format stream-json` — needs empirical testing
2. Does AskUserQuestion emit a parseable event in stream-json mode, or does it use a different mechanism?
3. Should we support `--resume` as a fallback when streaming fails?
4. Per-repo session limits: should a repo allow multiple concurrent sessions if they're in different worktrees?
