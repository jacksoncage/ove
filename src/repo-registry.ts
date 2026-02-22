import { Database } from "bun:sqlite";

export interface RepoRecord {
  name: string;
  url: string;
  owner: string | null;
  defaultBranch: string;
  source: string;
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
