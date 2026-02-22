# Repo Auto-Discovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scale Ove from manually configured repos to auto-discovering 50-100+ repos via GitHub, with on-demand cloning and Claude-powered repo resolution.

**Architecture:** New `RepoRegistry` class backed by SQLite `repos` table. GitHub sync via `gh repo list` runs on startup + interval. Config.json repos become overrides only. User wildcard `["*"]` grants access to all discovered repos. When a user message doesn't name a repo, the full repo list is injected into the prompt for Claude to resolve.

**Tech Stack:** Bun + TypeScript, bun:sqlite, `gh` CLI for GitHub API, existing ClaudeRunner for repo resolution.

---

### Task 1: Create RepoRegistry — SQLite table + CRUD

**Files:**
- Create: `src/repo-registry.ts`
- Test: `src/repo-registry.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/repo-registry.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { RepoRegistry } from "./repo-registry";

describe("RepoRegistry", () => {
  let db: Database;
  let registry: RepoRegistry;

  beforeEach(() => {
    db = new Database(":memory:");
    registry = new RepoRegistry(db);
  });

  it("creates repos table on construction", () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='repos'").all();
    expect(tables.length).toBe(1);
  });

  it("upserts and retrieves a repo", () => {
    registry.upsert({
      name: "my-app",
      url: "git@github.com:user/my-app.git",
      owner: "user",
      defaultBranch: "main",
      source: "github-sync",
    });
    const repo = registry.getByName("my-app");
    expect(repo).not.toBeNull();
    expect(repo!.url).toBe("git@github.com:user/my-app.git");
    expect(repo!.source).toBe("github-sync");
  });

  it("upsert updates existing repo", () => {
    registry.upsert({ name: "my-app", url: "old-url", source: "config" });
    registry.upsert({ name: "my-app", url: "new-url", source: "github-sync" });
    const repo = registry.getByName("my-app");
    expect(repo!.url).toBe("new-url");
  });

  it("returns null for unknown repo", () => {
    expect(registry.getByName("nope")).toBeNull();
  });

  it("lists all non-excluded repos", () => {
    registry.upsert({ name: "a", url: "u1", source: "github-sync" });
    registry.upsert({ name: "b", url: "u2", source: "github-sync" });
    registry.upsert({ name: "c", url: "u3", source: "github-sync", excluded: true });
    const all = registry.getAll();
    expect(all.length).toBe(2);
    expect(all.map(r => r.name).sort()).toEqual(["a", "b"]);
  });

  it("lists all repo names", () => {
    registry.upsert({ name: "x", url: "u1", source: "config" });
    registry.upsert({ name: "y", url: "u2", source: "github-sync" });
    const names = registry.getAllNames();
    expect(names.sort()).toEqual(["x", "y"]);
  });

  it("excludes a repo", () => {
    registry.upsert({ name: "old", url: "u", source: "github-sync" });
    registry.setExcluded("old", true);
    expect(registry.getAll().length).toBe(0);
    expect(registry.getByName("old")!.excluded).toBe(true);
  });

  it("migrates config repos", () => {
    const configRepos = {
      "my-app": { url: "git@github.com:user/my-app.git", defaultBranch: "main" },
      "infra": { url: "git@github.com:user/infra.git", defaultBranch: "develop" },
    };
    registry.migrateFromConfig(configRepos);
    expect(registry.getAll().length).toBe(2);
    const infra = registry.getByName("infra");
    expect(infra!.defaultBranch).toBe("develop");
    expect(infra!.source).toBe("config");
  });

  it("migration does not overwrite github-sync repos", () => {
    registry.upsert({ name: "my-app", url: "gh-url", source: "github-sync", defaultBranch: "main" });
    registry.migrateFromConfig({
      "my-app": { url: "config-url", defaultBranch: "main" },
    });
    expect(registry.getByName("my-app")!.url).toBe("gh-url");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/repo-registry.test.ts`
Expected: FAIL — `repo-registry` module not found

**Step 3: Write the implementation**

```typescript
// src/repo-registry.ts
import { Database } from "bun:sqlite";

export interface RepoRecord {
  name: string;
  url: string;
  owner?: string;
  defaultBranch: string;
  source: string; // "github-sync" | "manual" | "config"
  excluded: boolean;
  lastSyncedAt: string | null;
}

export interface RepoUpsertInput {
  name: string;
  url: string;
  owner?: string;
  defaultBranch?: string;
  source: string;
  excluded?: boolean;
}

export class RepoRegistry {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS repos (
        name TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        owner TEXT,
        default_branch TEXT DEFAULT 'main',
        source TEXT NOT NULL,
        excluded INTEGER DEFAULT 0,
        last_synced_at TEXT
      )
    `);
  }

  upsert(input: RepoUpsertInput): void {
    this.db.run(
      `INSERT INTO repos (name, url, owner, default_branch, source, excluded, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         url = excluded.url,
         owner = excluded.owner,
         default_branch = excluded.default_branch,
         source = excluded.source,
         excluded = excluded.excluded,
         last_synced_at = excluded.last_synced_at`,
      [
        input.name,
        input.url,
        input.owner || null,
        input.defaultBranch || "main",
        input.source,
        input.excluded ? 1 : 0,
        new Date().toISOString(),
      ]
    );
  }

  getByName(name: string): RepoRecord | null {
    const row = this.db.query(`SELECT * FROM repos WHERE name = ?`).get(name) as any;
    return row ? this.rowToRecord(row) : null;
  }

  getAll(): RepoRecord[] {
    const rows = this.db.query(`SELECT * FROM repos WHERE excluded = 0 ORDER BY name`).all() as any[];
    return rows.map(r => this.rowToRecord(r));
  }

  getAllNames(): string[] {
    const rows = this.db.query(`SELECT name FROM repos WHERE excluded = 0 ORDER BY name`).all() as any[];
    return rows.map(r => r.name);
  }

  setExcluded(name: string, excluded: boolean): void {
    this.db.run(`UPDATE repos SET excluded = ? WHERE name = ?`, [excluded ? 1 : 0, name]);
  }

  migrateFromConfig(configRepos: Record<string, { url: string; defaultBranch?: string }>): void {
    for (const [name, repo] of Object.entries(configRepos)) {
      // Don't overwrite repos already synced from GitHub
      const existing = this.getByName(name);
      if (existing && existing.source === "github-sync") continue;

      this.upsert({
        name,
        url: repo.url,
        defaultBranch: repo.defaultBranch || "main",
        source: "config",
      });
    }
  }

  private rowToRecord(row: any): RepoRecord {
    return {
      name: row.name,
      url: row.url,
      owner: row.owner,
      defaultBranch: row.default_branch,
      source: row.source,
      excluded: row.excluded === 1,
      lastSyncedAt: row.last_synced_at,
    };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/repo-registry.test.ts`
Expected: All 9 tests PASS

**Step 5: Commit**

```bash
git add src/repo-registry.ts src/repo-registry.test.ts
git commit -m "feat: add RepoRegistry with SQLite-backed repo store"
```

---

### Task 2: Add GitHub sync to RepoRegistry

**Files:**
- Modify: `src/repo-registry.ts`
- Test: `src/repo-registry.test.ts` (add sync tests)

**Step 1: Write the failing tests**

Add to `src/repo-registry.test.ts`:

```typescript
describe("parseGhRepoLine", () => {
  it("parses standard gh repo list output", () => {
    const result = parseGhRepoLine("jacksoncage/ove\tMy app\tpublic\t2026-02-20T10:00:00Z");
    expect(result).toEqual({ name: "ove", owner: "jacksoncage", fullName: "jacksoncage/ove" });
  });

  it("returns null for empty line", () => {
    expect(parseGhRepoLine("")).toBeNull();
  });
});
```

`parseGhRepoLine` is exported from `repo-registry.ts`.

**Step 2: Run tests to verify they fail**

Run: `bun test src/repo-registry.test.ts`
Expected: FAIL — `parseGhRepoLine` not exported

**Step 3: Write the implementation**

Add to `src/repo-registry.ts`:

```typescript
import { logger } from "./logger";

export interface GhRepoParsed {
  name: string;
  owner: string;
  fullName: string;
}

export function parseGhRepoLine(line: string): GhRepoParsed | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // gh repo list output: owner/name\tdescription\tvisibility\tupdated_at
  const fullName = trimmed.split("\t")[0];
  if (!fullName || !fullName.includes("/")) return null;
  const [owner, name] = fullName.split("/");
  return { name, owner, fullName };
}

export async function syncGitHub(
  registry: RepoRegistry,
  orgs?: string[]
): Promise<number> {
  let count = 0;
  const targets = orgs && orgs.length > 0 ? orgs : [undefined];

  for (const org of targets) {
    try {
      const args = ["repo", "list", "--limit", "500", "--no-archived"];
      if (org) args.splice(2, 0, org);

      const proc = Bun.spawn(["gh", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        logger.warn("gh repo list failed", { org, error: stderr.slice(0, 200) });
        continue;
      }

      for (const line of output.split("\n")) {
        const parsed = parseGhRepoLine(line);
        if (!parsed) continue;

        registry.upsert({
          name: parsed.name,
          url: `git@github.com:${parsed.fullName}.git`,
          owner: parsed.owner,
          source: "github-sync",
        });
        count++;
      }
    } catch (err) {
      logger.warn("github sync error", { org, error: String(err) });
    }
  }

  logger.info("github sync complete", { repos: count });
  return count;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/repo-registry.test.ts`
Expected: All tests PASS (sync function tested end-to-end in Task 6)

**Step 5: Commit**

```bash
git add src/repo-registry.ts src/repo-registry.test.ts
git commit -m "feat: add GitHub sync via gh repo list"
```

---

### Task 3: Update config.ts — GitHub config, wildcard auth, optional url

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts` (create)

**Step 1: Write the failing tests**

```typescript
// src/config.test.ts
import { describe, it, expect } from "bun:test";
import { isAuthorized, getUserRepos } from "./config";
import type { Config } from "./config";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repos: {},
    users: {},
    claude: { maxTurns: 25 },
    reposDir: "./repos",
    ...overrides,
  };
}

describe("wildcard auth", () => {
  it("grants access to any repo with wildcard", () => {
    const config = makeConfig({
      users: { "tg:123": { name: "love", repos: ["*"] } },
    });
    expect(isAuthorized(config, "tg:123", "any-repo")).toBe(true);
    expect(isAuthorized(config, "tg:123", "another-repo")).toBe(true);
  });

  it("still works with explicit repo list", () => {
    const config = makeConfig({
      users: { "tg:123": { name: "love", repos: ["my-app"] } },
    });
    expect(isAuthorized(config, "tg:123", "my-app")).toBe(true);
    expect(isAuthorized(config, "tg:123", "other")).toBe(false);
  });

  it("denies unknown user", () => {
    const config = makeConfig();
    expect(isAuthorized(config, "unknown", "repo")).toBe(false);
  });
});

describe("getUserRepos with wildcard", () => {
  it("returns ['*'] when user has wildcard", () => {
    const config = makeConfig({
      users: { "tg:123": { name: "love", repos: ["*"] } },
    });
    expect(getUserRepos(config, "tg:123")).toEqual(["*"]);
  });
});

describe("github config", () => {
  it("loadConfig parses github section", async () => {
    // This is a structural test — just verify the type compiles
    const config = makeConfig({
      github: { syncInterval: 60000, orgs: ["my-org"] },
    });
    expect(config.github!.syncInterval).toBe(60000);
    expect(config.github!.orgs).toEqual(["my-org"]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/config.test.ts`
Expected: FAIL — `github` not a valid key on Config type

**Step 3: Write the implementation**

Modify `src/config.ts`:

1. Add `GitHubConfig` interface:
```typescript
export interface GitHubConfig {
  syncInterval?: number; // ms, default 1800000 (30 min)
  orgs?: string[];
}
```

2. Add `github` to `Config`:
```typescript
export interface Config {
  repos: Record<string, RepoConfig>;
  users: Record<string, UserConfig>;
  claude: { maxTurns: number };
  reposDir: string;
  mcpServers?: Record<string, McpServerConfig>;
  cron?: CronTaskConfig[];
  runner?: RunnerConfig;
  github?: GitHubConfig;
}
```

3. Make `url` optional on `RepoConfig` (overrides-only repos won't have a url):
```typescript
export interface RepoConfig {
  url?: string;
  defaultBranch?: string;
  runner?: RunnerConfig;
  excluded?: boolean;
}
```

4. Update `loadConfig` to parse `github`:
```typescript
// In loadConfig return:
github: raw.github,
```

5. Update `isAuthorized` to support wildcard:
```typescript
export function isAuthorized(config: Config, platformUserId: string, repo?: string): boolean {
  const user = config.users[platformUserId];
  if (!user) return false;
  if (!repo) return true;
  return user.repos.includes("*") || user.repos.includes(repo);
}
```

6. Update `saveConfig` to preserve `github`:
```typescript
if (config.github) merged.github = config.github;
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/config.test.ts`
Expected: All tests PASS

Also run existing tests: `bun test src/router.test.ts`
Expected: All PASS (no breaking changes)

**Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add GitHub config, wildcard auth, optional repo url"
```

---

### Task 4: Wire registry into index.ts — replace config.repos, background sync

**Files:**
- Modify: `src/index.ts`

This is the integration task. Changes:

**Step 1: Import and initialize RepoRegistry**

At the top of `src/index.ts`, add:
```typescript
import { RepoRegistry, syncGitHub } from "./repo-registry";
```

After `const schedules = new ScheduleStore(db);`, add:
```typescript
const repoRegistry = new RepoRegistry(db);

// Migrate existing config repos to SQLite
repoRegistry.migrateFromConfig(
  Object.fromEntries(
    Object.entries(config.repos)
      .filter(([_, r]) => r.url)
      .map(([name, r]) => [name, { url: r.url!, defaultBranch: r.defaultBranch }])
  )
);
```

**Step 2: Add background sync function**

```typescript
async function startGitHubSync() {
  if (!config.github) return;
  const interval = config.github.syncInterval || 1_800_000;

  // Initial sync
  await syncGitHub(repoRegistry, config.github.orgs);

  // Recurring sync
  setInterval(() => {
    syncGitHub(repoRegistry, config.github!.orgs).catch((err) =>
      logger.warn("github sync failed", { error: String(err) })
    );
  }, interval);
}
```

**Step 3: Update repo resolution in handleMessage**

Replace the current repo-fallback block (lines 387-401 in current `index.ts`) with registry-aware resolution:

```typescript
// Need a repo for task commands
if (!parsed.repo) {
  const userRepos = getUserRepos(config, msg.userId);
  const hasWildcard = userRepos.includes("*");

  if (!hasWildcard && userRepos.length === 1) {
    parsed.repo = userRepos[0];
  } else if (hasWildcard || userRepos.length > 1) {
    // Resolve via Claude — inject repo list into prompt
    const repoNames = hasWildcard
      ? repoRegistry.getAllNames()
      : userRepos;

    if (repoNames.length === 1) {
      parsed.repo = repoNames[0];
    } else if (repoNames.length === 0) {
      const reply = "No repos discovered yet. Set one up with `init repo <name> <git-url>` or configure GitHub sync.";
      await msg.reply(reply);
      return;
    } else {
      // Let Claude resolve — inject available repos into the prompt
      // The free-form prompt + repo list will let Claude pick or ask
      parsed.args._availableRepos = repoNames;
    }
  } else {
    const reply = "You don't have access to any repos yet. Set one up:\n`init repo <name> <git-url> [branch]`\nExample: `init repo my-app git@github.com:user/my-app.git`";
    await msg.reply(reply);
    return;
  }
}
```

**Step 4: Update repo config lookup in handleMessage**

Replace the hard check for `config.repos[parsed.repo]` (lines 410-414) to fall back to registry:

```typescript
// Check repo exists — config overrides or registry
if (parsed.repo) {
  const repoConfig = config.repos[parsed.repo];
  const registryRepo = repoRegistry.getByName(parsed.repo);

  if (!repoConfig && !registryRepo) {
    await msg.reply(`Never heard of ${parsed.repo}. Check the config or run GitHub sync.`);
    return;
  }
}
```

**Step 5: Update processTask to resolve repo URL from registry**

In `processTask`, replace the `config.repos[task.repo]` lookup with a function that merges config overrides + registry:

```typescript
function getRepoInfo(repoName: string): { url: string; defaultBranch: string } | null {
  const configRepo = config.repos[repoName];
  const registryRepo = repoRegistry.getByName(repoName);

  if (!configRepo && !registryRepo) return null;

  return {
    url: configRepo?.url || registryRepo?.url || "",
    defaultBranch: configRepo?.defaultBranch || registryRepo?.defaultBranch || "main",
  };
}
```

Use this in `processTask` instead of `config.repos[task.repo]`.

**Step 6: Inject repo list into prompt when Claude needs to resolve**

In `buildContextualPrompt` call (or just before it), when `parsed.args._availableRepos` is set and `parsed.repo` is still undefined, prepend the repo list:

```typescript
// Before building prompt, inject repo list for Claude resolution
if (parsed.args._availableRepos && !parsed.repo) {
  const repoList = parsed.args._availableRepos.join(", ");
  const resolvePrefix = `Available repos: ${repoList}\n\nThe user hasn't specified which repo. Based on their message, determine the correct repo. If unclear, ask them which repo they mean.\n\n`;
  parsed.rawText = resolvePrefix + parsed.rawText;
}
```

**Step 7: Start GitHub sync in main()**

In `main()`, after stale task reset, before adapter startup:

```typescript
// Start GitHub repo sync (non-blocking)
startGitHubSync().catch((err) =>
  logger.warn("initial github sync failed", { error: String(err) })
);
```

**Step 8: Update handleEvent similarly**

Apply the same registry-aware resolution to `handleEvent` (the event adapter code path).

**Step 9: Run all tests**

Run: `bun test`
Expected: All existing tests PASS

**Step 10: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire RepoRegistry into index.ts with GitHub sync and Claude resolution"
```

---

### Task 5: Update schedule handling for wildcard repos

**Files:**
- Modify: `src/index.ts` (schedule section in handleMessage)

**Step 1: Update schedule repo resolution**

The schedule handler at line 264 uses `getUserRepos(config, msg.userId)` to get the repo list. Update it to resolve wildcard:

```typescript
if (parsed.type === "schedule") {
  await msg.updateStatus("Parsing your schedule...");
  const rawRepos = getUserRepos(config, msg.userId);
  const userRepos = rawRepos.includes("*") ? repoRegistry.getAllNames() : rawRepos;
  // ... rest unchanged
}
```

**Step 2: Run tests**

Run: `bun test`
Expected: All PASS

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: support wildcard repos in schedule handling"
```

---

### Task 6: Integration tests + config.example.json update

**Files:**
- Modify: `config.example.json`
- Test: `src/repo-registry.test.ts` (add integration-style tests)

**Step 1: Add integration tests for sync + config migration flow**

Add to `src/repo-registry.test.ts`:

```typescript
describe("config + registry integration", () => {
  it("config repos + registry merge correctly", () => {
    const db = new Database(":memory:");
    const registry = new RepoRegistry(db);

    // Simulate GitHub sync adding repos
    registry.upsert({ name: "api", url: "git@github.com:org/api.git", owner: "org", source: "github-sync" });
    registry.upsert({ name: "web", url: "git@github.com:org/web.git", owner: "org", source: "github-sync" });

    // Simulate config migration (manual repo + override)
    registry.migrateFromConfig({
      "legacy": { url: "git@github.com:me/legacy.git", defaultBranch: "develop" },
    });

    // All three repos exist
    expect(registry.getAllNames().sort()).toEqual(["api", "legacy", "web"]);

    // Excluding a repo hides it from getAll but not getByName
    registry.setExcluded("legacy", true);
    expect(registry.getAllNames().sort()).toEqual(["api", "web"]);
    expect(registry.getByName("legacy")).not.toBeNull();
  });
});
```

**Step 2: Run tests**

Run: `bun test`
Expected: All PASS

**Step 3: Update config.example.json**

```json
{
  "repos": {
    "my-app": {
      "url": "git@github.com:user/my-app.git",
      "defaultBranch": "main"
    },
    "infra": {
      "runner": { "name": "codex" },
      "defaultBranch": "develop"
    },
    "old-legacy": {
      "excluded": true
    }
  },
  "users": {
    "slack:U12345678": {
      "name": "love",
      "repos": ["my-app"]
    },
    "telegram:123456789": {
      "name": "love",
      "repos": ["*"]
    }
  },
  "claude": {
    "maxTurns": 25
  },
  "runner": {
    "name": "claude"
  },
  "github": {
    "syncInterval": 1800000,
    "orgs": ["my-org"]
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/YOUR_USER"]
    }
  },
  "cron": [
    {
      "schedule": "0 9 * * 1-5",
      "repo": "my-app",
      "prompt": "Review all open PRs and post review comments.",
      "userId": "slack:U12345678"
    }
  ]
}
```

**Step 4: Commit**

```bash
git add src/repo-registry.test.ts config.example.json
git commit -m "feat: integration tests and updated config example for auto-discovery"
```

---

### Task 7: Final verification and docs

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 2: Manual smoke test**

Run: `bun run src/index.ts`
Expected:
- Ove starts without errors
- If `github` config is set, logs `github sync complete`
- Config repos appear in registry
- Wildcard user can target any discovered repo

**Step 3: Commit everything and push**

```bash
git add -A
git commit -m "feat: repo auto-discovery via GitHub sync with Claude resolution"
```
