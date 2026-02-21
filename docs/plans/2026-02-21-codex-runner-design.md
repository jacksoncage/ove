# Codex Runner Design

Add OpenAI Codex CLI as a second agent runner alongside Claude Code CLI.

## Config

Global default runner + per-repo override:

```json
{
  "runner": { "name": "claude" },
  "repos": {
    "my-app": {
      "url": "git@github.com:user/my-app.git",
      "defaultBranch": "main",
      "runner": { "name": "codex", "model": "o3" }
    }
  }
}
```

`RunnerConfig`: `{ name: "claude" | "codex"; model?: string }`. Defaults to `"claude"` if omitted.

## New Types

`RunnerConfig` added to `config.ts` on both `Config` (global) and `RepoConfig` (per-repo). `RunOptions` gets optional `model` field.

## CodexRunner (`src/runners/codex.ts`)

Implements `AgentRunner`. Spawns `codex exec --json --yolo --skip-git-repo-check --ephemeral -C <workDir> "prompt"`.

Key differences from ClaudeRunner:
- No `--max-turns` (exec mode runs one turn, unlimited tool calls)
- No `--mcp-config` flag (Codex reads MCP from `~/.codex/config.toml`)
- JSONL output format (one JSON object per line) instead of Claude's stream-json
- Uses `CODEX_API_KEY` / `OPENAI_API_KEY` env vars

JSONL event mapping to `StatusEvent`:
- `item.completed` + `agent_message` -> `{ kind: "text" }` + final output
- `item.started` + `command_execution` -> `{ kind: "tool", tool: "shell" }`
- `item.started` + `file_change` -> `{ kind: "tool", tool: "file_change" }`
- `item.started` + `mcp_tool_call` -> `{ kind: "tool", tool: <name> }`
- `turn.failed` -> error output

## Runner Selection (`index.ts`)

Factory function creates runners by name. Per-task resolution: repo config -> global default -> "claude". Runners cached by name.

## Unchanged

`AgentRunner` interface, `RunResult`, `StatusEvent`, queue, router, adapters — all untouched.
