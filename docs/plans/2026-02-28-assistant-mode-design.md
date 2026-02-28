# Assistant Mode Design

## Problem

Ove is strictly a code assistant and refuses all non-code requests. Users want the option to use Ove as a general-purpose assistant while keeping his personality.

## Solution

A user-togglable "assistant mode" that relaxes Ove's restrictions. When enabled, Ove keeps his grumpy Swedish personality but is willing to help with anything — emails, reminders, general questions, personal tasks.

## Modes

| Mode | Default | Behavior |
|------|---------|----------|
| `strict` | Yes | Code-only. Refuses non-code tasks with Ove-style commentary. |
| `assistant` | No | General-purpose. Still grumpy, still Ove, but willing to try anything. |

## Toggle Mechanism

Users switch modes via chat:

**Explicit commands:**
- `mode assistant`, `/mode assistant`
- `mode strict`, `/mode strict`

**Natural language:**
- "be more helpful", "yolo mode", "assistant mode", "help me with anything"
- "strict mode", "code mode", "back to normal"

## Persona Design

In `assistant` mode, the existing `OVE_PERSONA` is extended with an addendum:

```
IMPORTANT MODE OVERRIDE: You are currently in "assistant mode". The user has asked
you to be a general-purpose assistant. While you keep your Ove personality (grumble,
be direct, sprinkle Swedish), you are now willing to help with ANY request — not just
code. This includes:
- Sending reminders, drafting emails/messages
- Answering general knowledge questions
- Helping with personal tasks, recommendations
- Anything the user asks

You still grumble about it ("Fan, nu ska jag vara sekreterare också...") but you DO
the task. If you genuinely cannot do something (no tool/integration available), explain
what would be needed rather than just refusing.
```

## Storage

Per-user mode stored in SQLite via `SessionStore`:

- New table: `user_modes (user_id TEXT PRIMARY KEY, mode TEXT, updated_at TEXT)`
- `getMode(userId)` — returns `"strict"` if not set
- `setMode(userId, mode)` — upserts

Mode persists until explicitly changed or session cleared.

## Files Changed

1. **`src/router.ts`** — Add `"set-mode"` to `MessageType`, add parsing patterns in `parseMessage()`
2. **`src/sessions.ts`** — Add `user_modes` table, `getMode()`, `setMode()` methods
3. **`src/handlers.ts`** — Add `ASSISTANT_ADDENDUM` constant, `handleSetMode()` handler, use mode-aware persona selection in all prompt-building call sites

## Prompt Flow

```
User message → parseMessage() → "set-mode" → handleSetMode() → store in SQLite

User message → parseMessage() → any other type →
  getMode(userId) →
    strict  → OVE_PERSONA
    assistant → OVE_PERSONA + ASSISTANT_ADDENDUM
  → buildContextualPrompt(parsed, history, persona)
```
