import { Database } from "bun:sqlite";
import { logger } from "./logger";

export interface RepoRecord {
  name: string;
  url: string;
  owner: string | null;
  defaultBranch: string;
  source: string;
  excluded: boolean;
  lastSyncedAt: string | null;
}

interface RepoRow {
  name: string;
  url: string;
  owner: string | null;
  default_branch: string;
  source: string;
  excluded: number;
  last_synced_at: string | null;
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
    const row = this.db.query(`SELECT * FROM repos WHERE name = ?`).get(name) as RepoRow;
    return row ? this.rowToRecord(row) : null;
  }

  getAll(): RepoRecord[] {
    const rows = this.db.query(`SELECT * FROM repos WHERE excluded = 0 ORDER BY name`).all() as RepoRow[];
    return rows.map(r => this.rowToRecord(r));
  }

  getAllNames(): string[] {
    const rows = this.db.query(`SELECT name FROM repos WHERE excluded = 0 ORDER BY name`).all() as { name: string }[];
    return rows.map(r => r.name);
  }

  setExcluded(name: string, excluded: boolean): void {
    this.db.run(`UPDATE repos SET excluded = ? WHERE name = ?`, [excluded ? 1 : 0, name]);
  }

  migrateFromConfig(configRepos: Record<string, { url: string; defaultBranch?: string }>): void {
    for (const [name, repo] of Object.entries(configRepos)) {
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

  private rowToRecord(row: RepoRow): RepoRecord {
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

export interface GhRepoParsed {
  name: string;
  owner: string;
  fullName: string;
}

export function parseGhRepoLine(line: string): GhRepoParsed | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const fullName = trimmed.split("\t")[0];
  if (!fullName || !fullName.includes("/")) return null;
  const [owner, ...rest] = fullName.split("/");
  const name = rest.join("/");
  return { name, owner, fullName };
}

interface GhRepoResponse {
  name: string;
  owner?: { login: string };
  defaultBranchRef?: { name: string };
  isArchived: boolean;
}

export async function syncGitHub(
  registry: RepoRegistry,
  orgs?: string[]
): Promise<number> {
  let count = 0;
  const targets = orgs && orgs.length > 0 ? orgs : [undefined];

  for (const org of targets) {
    try {
      const args = ["repo", "list", "--json", "name,owner,defaultBranchRef,isArchived", "--limit", "500"];
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

      let repos: GhRepoResponse[];
      try {
        repos = JSON.parse(output);
      } catch {
        logger.warn("gh repo list returned invalid JSON", { org });
        continue;
      }

      for (const repo of repos) {
        if (repo.isArchived) continue;
        const owner = repo.owner?.login || org || "";
        const name = repo.name;
        const defaultBranch = repo.defaultBranchRef?.name || "main";

        registry.upsert({
          name,
          url: `git@github.com:${owner}/${name}.git`,
          owner,
          defaultBranch,
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
