# Auto-Discovery Repo Management Design

## Goal

Scale Ove from manually configured repos to auto-discovering 50-100+ repos via GitHub, with on-demand cloning and Claude-powered repo resolution.

## Repo Storage

Move repo registry from config.json to SQLite. New `repos` table:

```sql
CREATE TABLE repos (
  name TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  owner TEXT,
  default_branch TEXT DEFAULT 'main',
  source TEXT NOT NULL,  -- "github-sync" | "manual" | "config"
  excluded INTEGER DEFAULT 0,
  last_synced_at TEXT
);
```

## GitHub Sync

On startup and every 30 min (configurable), run `gh repo list` to discover repos. New repos inserted, existing ones updated. Non-blocking — Ove starts immediately, sync runs in background.

Config adds optional `github` section:

```json
{
  "github": {
    "syncInterval": 1800000,
    "orgs": ["seenthis-ab", "jacksoncage"]
  }
}
```

If `orgs` omitted, syncs all repos the `gh` user has access to.

## User Access

Wildcard support: `"repos": ["*"]` means access to all discovered repos. Existing per-repo lists still work.

## Repo Resolution

When user doesn't specify a repo explicitly:

1. Router regex — explicit `on <repo>` works as fast path
2. Claude resolves — inject user's repo list into the prompt, Claude picks the right repo or asks

Repo list injected as: `Available repos: repo-a, repo-b, ...`

## Config Changes

`config.json` repos become overrides only:

```json
{
  "repos": {
    "infra-salming-ai": {
      "runner": { "name": "codex" },
      "defaultBranch": "develop"
    },
    "old-legacy-thing": {
      "excluded": true
    }
  },
  "users": {
    "telegram:8518556027": { "name": "love", "repos": ["*"] }
  },
  "claude": { "maxTurns": 10 },
  "github": {
    "syncInterval": 1800000,
    "orgs": ["seenthis-ab", "jacksoncage"]
  }
}
```

Repos no longer need `url` — auto-discovered repos have it in SQLite. Only specify overrides (custom branch, runner, exclusion). `url` still works for non-GitHub repos.

## Clone Strategy

On-demand — clone only when a task first targets a repo. Existing `cloneIfNeeded` handles this. No change needed.

## Migration

On first run, existing config.json repos get inserted into SQLite with `source: "config"`. No breaking change.

## Components

- `src/repo-registry.ts` — new SQLite-backed repo store (sync, getAll, getByName, isExcluded)
- `src/config.ts` — add github config, update types, wildcard auth
- `src/router.ts` — remove single-repo fallback
- `src/index.ts` — wire up registry, inject repo list into prompts, start background sync

## Unchanged

Queue, runners, adapters, worktrees, task processing — all untouched.
