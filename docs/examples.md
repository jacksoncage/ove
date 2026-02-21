# Example Interactions

Examples showing Ove across different transports. You can use shorthand commands or just chat naturally — Ove understands both.

## Natural Conversation

You don't need commands. Just describe what you need, like you'd tell a colleague.

**Slack DM:**
```
alice: the login page is broken, users get a 500 after submitting the form
ove:   Task queued (aaa11111). Working on it...
       > Grep: "login" in src/
       > Read: src/routes/auth.ts
       > Read: src/middleware/session.ts
ove:   Found the issue — the session middleware wasn't awaiting the
       database call on line 34 of src/middleware/session.ts. Created
       PR #47 with the fix and added a test:
       https://github.com/org/my-app/pull/47
```

**Telegram:**
```
alice: can you add input validation to the user registration endpoint in my-app?
ove:   Task queued (bbb22222). Working on it...
       > Read: src/routes/users.ts
       > Edit: src/routes/users.ts
       > Write: src/routes/users.test.ts
       > Bash: bun test
ove:   Done. Added zod validation for email, password length, and
       username format. All 48 tests pass. PR #48:
       https://github.com/org/my-app/pull/48
```

**Discord:**
```
alice: how does the caching layer work in my-app? I need to understand
       it before I make changes
ove:   Looking into it...
       > Glob: **/*cache*
       > Read: src/cache/redis.ts
       > Read: src/cache/keys.ts
       > Read: src/middleware/cache.ts
ove:   The caching layer has 3 parts:
       1. src/cache/redis.ts — Redis client wrapper with connection pooling
       2. src/cache/keys.ts — key generation with TTL per resource type
       3. src/middleware/cache.ts — Express middleware that caches GET
          responses by URL + user role
       Cache invalidation happens on POST/PUT/DELETE via the afterWrite
       hook in the base repository class.
```

## PR Review (shorthand)

**Slack DM:**
```
alice: review PR #42 on my-app
ove:   Task queued (abc12345). Working on it...
       > Bash: gh pr diff 42
       > Read: src/auth.ts
       > Read: src/middleware.ts
ove:   PR #42 review done. Left 3 inline comments:
       - src/auth.ts:15 — potential SQL injection in query param
       - src/middleware.ts:42 — missing error handler for async route
       - src/utils.ts:8 — unused import
```

**GitHub issue comment:**
```
@ove review PR #42
```
Ove replies with a comment containing the review summary.

## Fix Issue

**Telegram:**
```
alice: fix issue #15 on my-app
ove:   Task queued (bbb22222). Working on it...
       > Bash: gh issue view 15
       > Grep: "handleAuth"
       > Read: src/auth.ts
       > Edit: src/auth.ts
       > Bash: bun test
       > Bash: git add -A && git commit -m "Fix auth token expiry check"
       > Bash: gh pr create --title "Fix #15: auth token expiry"
ove:   Fixed! Created PR #43:
       https://github.com/org/my-app/pull/43
       Changed src/auth.ts to properly check token expiry timestamps.
```

## Validate

**Discord:**
```
alice: validate my-app
ove:   Task queued (ccc33333). Working on it...
       > Bash: bun test
       > Read: package.json
       > Bash: bunx eslint src/
ove:   All 42 tests pass. ESLint found 3 warnings:
       • src/utils.ts:12 — unused variable 'tmp'
       • src/api.ts:45 — prefer const
       • src/api.ts:88 — prefer const
```

## Simplify

```
alice: simplify src/router.ts in my-app
ove:   Task queued (ddd44444). Working on it...
       > Read: src/router.ts
       > Edit: src/router.ts
       > Bash: bun test
       > Bash: gh pr create --title "Simplify src/router.ts"
ove:   Created PR #44. Reduced cyclomatic complexity from 18 to 9.
       Extracted 3 helper functions, removed duplicated regex logic.
```

## Brainstorm / Discuss

```
alice: I have a new idea
ove:   What's the idea? Tell me more about what you're thinking.
alice: a notification service for our platform
ove:   Interesting! A few questions to shape this:
       1. What types of notifications? (email, push, in-app, SMS?)
       2. Real-time or batched?
       3. Do users need preferences/opt-out?
       Let's think through the architecture...
```

```
alice: discuss auth flow for the new API
ove:   Let's think about this. Key questions:
       - Who are the consumers? (internal services, external apps, users?)
       - Do you need OAuth2/OIDC or is API key auth sufficient?
       - What about rate limiting per client?
```

## Create Project

```
alice: create project my-api with template express
ove:   Task queued (eee55555). Working on it...
       > Bash: mkdir -p my-api && cd my-api && npm init -y
       > Write: src/index.ts
       > Bash: npm install express
       > Bash: git init && git add -A && git commit -m "Initial commit"
       > Bash: gh repo create my-api --public --push
ove:   Project "my-api" created and pushed to GitHub:
       https://github.com/org/my-api
       Structure: Express + TypeScript, src/index.ts entry point
```

## Scheduling

**Create a recurring task:**
```
alice: validate my-app every weekday at 9:00
ove:   Scheduled! Will run "validate my-app" Mon–Fri at 09:00.
       Schedule #1 created.
```

**List schedules:**
```
alice: list schedules
ove:   Your scheduled tasks:
       #1  validate my-app — Mon–Fri at 09:00
       #2  review PR activity on my-app — every Monday at 08:00
```

**Remove a schedule:**
```
alice: remove schedule #1
ove:   Schedule #1 removed.
```

## More Free-form Examples

Anything you type works. Ove parses intent from natural language.

```
alice: what does the auth middleware do in my-app
ove:   Task queued (fff66666). Working on it...
       > Glob: **/*middleware*
       > Read: src/middleware/auth.ts
ove:   The auth middleware in my-app:
       1. Extracts JWT from Authorization header
       2. Verifies signature against JWKS endpoint
       3. Attaches decoded user to req.user
       4. Returns 401 for invalid/missing tokens
       Located in src/middleware/auth.ts (42 lines).
```

```
alice: the CI is red on main, can you check what's going on?
ove:   Task queued (ggg77777). Working on it...
       > Bash: gh run list --limit 5
       > Bash: gh run view 12345 --log-failed
       > Read: src/api.test.ts
ove:   The test "should return 404 for unknown routes" is failing
       because the new /health endpoint was added without updating
       the route count assertion. Line 89 in src/api.test.ts expects
       12 routes but there are now 13. Want me to fix it?
```

## HTTP API

**Send a task via curl:**
```bash
curl -X POST http://localhost:3000/api/message \
  -H "X-API-Key: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"text": "validate my-app"}'
```

**Stream results via SSE:**
```bash
curl -N http://localhost:3000/api/tasks/abc12345/stream \
  -H "X-API-Key: your-secret"

data: {"type":"status","message":"Running tests..."}
data: {"type":"status","message":"All 42 tests pass."}
data: {"type":"done","result":"Validation complete. No issues."}
```

**Web UI:** Open `http://localhost:3000` in a browser for a chat-style interface.

## Meta Commands

```
alice: status
ove:   Agent status: 2 pending, 1 running, 15 completed, 0 failed

alice: history
ove:   Recent tasks:
       • [completed] Review PR #42 (my-app)
       • [completed] Fix issue #15 (my-app)
       • [running] Validate my-app

alice: help
ove:   Commands:
       • review PR #N on <repo>
       • fix issue #N on <repo>
       • simplify <path> in <repo>
       • validate <repo>
       • discuss <topic> — brainstorm ideas (no code changes)
       • create project <name> [with template <type>]
       • <task> every day at <time> — schedule a recurring task
       • list schedules — see your scheduled tasks
       • remove schedule #N — remove a scheduled task
       • status — show queue stats
       • history — show recent tasks
       • clear — reset conversation
       • Or just type anything for free-form coding help

alice: clear
ove:   Conversation cleared.
```
