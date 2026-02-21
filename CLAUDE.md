# Ove

Your grumpy but meticulous dev companion — routes chat messages to Claude Code CLI in isolated worktrees.

## Stack
- Bun + TypeScript
- @slack/bolt (Socket Mode) for Slack
- baileys for WhatsApp
- grammy for Telegram
- discord.js for Discord
- Bun.serve for HTTP API + Web UI
- gh CLI for GitHub polling
- bun:sqlite for task queue
- claude -p CLI for code tasks

## Structure
- src/adapters/ — chat platform adapters (Slack, WhatsApp, Telegram, Discord, CLI) and event adapters (GitHub, HTTP API)
- src/queue.ts — SQLite task queue
- src/runners/ — agent runner implementations (Claude, future Codex)
- src/repos.ts — git clone/pull/worktree management
- src/router.ts — message → task mapping
- src/config.ts — repo/user configuration

## Conventions
- No classes unless necessary, prefer functions and plain objects
- Use bun:sqlite directly, no ORMs
- Use bun:test for testing
- Structured JSON logging via src/logger.ts
