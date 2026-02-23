# Ove

Your grumpy but meticulous dev companion — routes chat messages to AI coding agents (Claude Code CLI or OpenAI Codex CLI) in isolated worktrees.

## Stack
- Bun + TypeScript
- @slack/bolt (Socket Mode) for Slack
- baileys for WhatsApp
- grammy for Telegram
- discord.js for Discord
- Bun.serve for HTTP API + Web UI
- gh CLI for GitHub polling
- bun:sqlite for task queue
- claude -p CLI for code tasks (default runner)
- codex exec CLI for code tasks (alternative runner)

## Structure
- src/adapters/ — chat platform adapters (Slack, WhatsApp, Telegram, Discord, CLI) and event adapters (GitHub, HTTP API)
- src/queue.ts — SQLite task queue
- src/runners/ — agent runner implementations (Claude, Codex)
- src/repos.ts — git clone/pull/worktree management
- src/router.ts — message → task mapping
- src/config.ts — repo/user configuration

## Conventions
- No classes unless necessary, prefer functions and plain objects
- Use bun:sqlite directly, no ORMs
- Use bun:test for testing
- Structured JSON logging via src/logger.ts

## Skills

Ove spawns Claude Code CLI (`claude -p`) in isolated worktrees. The spawned instances automatically pick up:

- **Project skills** from `.claude/skills/` in the target repo's worktree
- **Personal skills** from `~/.claude/skills/` on the host machine
- **Plugin skills** from installed plugins (configured via `~/.claude/settings.json` `enabledPlugins`)

Skills follow the [Agent Skills](https://agentskills.io) open standard. See [Claude Code skills docs](https://code.claude.com/docs/en/skills) for full reference.

### Setting up skills for Ove

Skills are configured **manually** in the Claude Code installation that Ove runs on:

1. **Personal skills** — place in `~/.claude/skills/<name>/SKILL.md` on the host running Ove
2. **Per-repo skills** — commit `.claude/skills/<name>/SKILL.md` to each repo Ove manages
3. **Plugins** — install via `claude plugins add` and enable in `~/.claude/settings.json`

The Ove project itself ships skills in `.claude/skills/` (review-pr, create-issue, ship) that are available when working on the Ove codebase.
