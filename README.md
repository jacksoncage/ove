<p align="center">
  <img src="logo.png" width="180" alt="Ove" />
</p>

<h1 align="center">Ove</h1>

<p align="center">
  Your grumpy but meticulous dev companion.<br>
  <a href="https://jacksoncage.github.io/ove">Docs</a> · <a href="https://github.com/jacksoncage/ove">GitHub</a> · <a href="https://www.npmjs.com/package/@lovenyberg/ove">Package</a>
</p>

---

Talk to Ove from Slack, WhatsApp, Telegram, Discord, GitHub issues, a Web UI, or the terminal — he'll grumble about it, but he'll review your PRs, fix your issues, run your tests, brainstorm ideas, and scaffold new projects. Properly.

**Just chat.** You don't need to memorize commands. Talk to Ove like you'd talk to a colleague — ask questions, describe what you need, paste error messages, think out loud. He understands natural language. The commands below are shortcuts, not requirements.

## Quick Start

```bash
npm install -g @lovenyberg/ove
ove init    # interactive setup — creates config.json and .env
ove start
```

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated
- SSH access to your git repos

## Usage

Talk to Ove the way you'd talk to a teammate. These all work:

```
"can you check what's failing in the auth tests on my-app?"
"the login page is broken, users get a 500 after submitting"
"how does the payment webhook work in my-app?"
"refactor the user service, it's getting messy"
```

Ove figures out the intent, picks the right repo, and gets to work. For common tasks, there are also shorthand commands:

```
review PR #N on <repo>      Code review with inline comments
fix issue #N on <repo>      Read issue, implement fix, create PR
simplify <path> in <repo>   Reduce complexity, create PR
validate <repo>             Run tests and linter
discuss <topic>             Brainstorm ideas (no code changes)
create project <name>       Scaffold a new project

Scheduling:
<task> every day at <time>   Schedule a recurring task
list schedules              See your scheduled tasks
remove schedule #N          Remove a scheduled task

Meta:
status                      Queue stats
history                     Recent tasks
clear                       Reset conversation
```

## Deployment

Three ways to run Ove. Pick what fits. See the [full guide](https://jacksoncage.github.io/ove#getting-started) for details.

### Local

```bash
npm install -g @lovenyberg/ove
ove init
ove start
```

Requires [Bun](https://bun.sh), Claude Code CLI, and GitHub CLI on your machine.

### Docker

```bash
ove init                    # generate config locally
docker compose up -d        # start container
docker compose logs -f      # watch logs
```

The image includes Bun, git, and Claude CLI. Mounts `config.json`, `.env`, `repos/`, and SSH keys from the host.

### VM

Ove runs well on a small VM (2 CPU, 4 GB RAM). Install Bun, Claude Code, and GitHub CLI, then run as a systemd service:

```bash
git clone git@github.com:jacksoncage/ove.git && cd ove
bun install
ove init
sudo cp deploy/ove.service /etc/systemd/system/ove.service
sudo systemctl enable --now ove
```

## Transport Setup

### Slack

1. Create app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** → generate App-Level Token (`xapp-...`)
3. Bot scopes: `chat:write`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `app_mentions:read`
4. Event subscriptions: `message.im`, `app_mention`
5. **App Home** → Messages Tab → "Allow users to send messages"
6. Install to workspace → copy Bot Token (`xoxb-...`)

### Telegram

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the bot token
3. Set `TELEGRAM_BOT_TOKEN=<token>` in `.env`

### Discord

1. Create app at [discord.com/developers](https://discord.com/developers/applications)
2. Bot → enable **Message Content Intent**
3. Copy bot token
4. Invite bot to server with `bot` scope + `Send Messages`, `Read Message History`
5. Set `DISCORD_BOT_TOKEN=<token>` in `.env`

### HTTP API + Web UI

1. Set `HTTP_API_PORT=3000` and `HTTP_API_KEY=<your-secret>` in `.env`
2. Open `http://localhost:3000` for the Web UI
3. Or call the API directly: `curl -X POST http://localhost:3000/api/message -H "X-API-Key: <key>" -H "Content-Type: application/json" -d '{"text": "validate my-app"}'`

### GitHub (issue/PR comments)

1. Set `GITHUB_POLL_REPOS=owner/repo1,owner/repo2` in `.env`
2. Optionally set `GITHUB_BOT_NAME=ove` (default) and `GITHUB_POLL_INTERVAL=30000`
3. Mention `@ove` in an issue or PR comment to trigger a task
4. Ove replies with a comment when the task completes

### WhatsApp

1. Set `WHATSAPP_ENABLED=true` in `.env`
2. Scan the QR code printed in the terminal on first start

## Config

```json
{
  "repos": {
    "my-app": {
      "url": "git@github.com:org/my-app.git",
      "defaultBranch": "main"
    }
  },
  "users": {
    "slack:U0ABC1234": { "name": "alice", "repos": ["my-app"] },
    "telegram:123456789": { "name": "alice", "repos": ["my-app"] },
    "discord:987654321": { "name": "alice", "repos": ["my-app"] },
    "github:alice": { "name": "alice", "repos": ["my-app"] },
    "http:anon": { "name": "alice", "repos": ["my-app"] },
    "cli:local": { "name": "alice", "repos": ["my-app"] }
  },
  "claude": { "maxTurns": 10 },
  "cron": [
    {
      "schedule": "0 9 * * 1-5",
      "repo": "my-app",
      "prompt": "Run lint and tests.",
      "userId": "slack:U0ABC1234"
    }
  ]
}
```

Static cron jobs go in `config.json`. Users can also create schedules via chat — these are stored in SQLite and managed with `list schedules` / `remove schedule #N`.

## Testing

```bash
bun test    # 150 tests
```

## How It Works

1. Message arrives via any transport (Slack, WhatsApp, Telegram, Discord, CLI, HTTP API, or GitHub comment)
2. Chat adapters use `handleMessage`, event adapters use `handleEvent`
3. Router parses intent and extracts repo/args
4. Task gets queued in SQLite (one per repo at a time)
5. Worker creates an isolated git worktree
6. Runs `claude -p` with streaming NDJSON output
7. Status updates stream back (chat: edits a message, HTTP: SSE, GitHub: single comment)
8. Result sent back, worktree cleaned up

See [example conversations](docs/examples.md) for all flows.

## License

MIT
