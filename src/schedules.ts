import { Database } from "bun:sqlite";

interface ScheduleRow {
  id: number;
  user_id: string;
  repo: string;
  prompt: string;
  schedule: string;
  description: string | null;
  created_at: string;
}

export interface Schedule {
  id: number;
  userId: string;
  repo: string;
  prompt: string;
  schedule: string;
  description: string | null;
  createdAt: string;
}

export interface ScheduleInput {
  userId: string;
  repo: string;
  prompt: string;
  schedule: string;
  description: string;
}

export class ScheduleStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  create(input: ScheduleInput): number {
    const result = this.db.run(
      `INSERT INTO schedules (user_id, repo, prompt, schedule, description) VALUES (?, ?, ?, ?, ?)`,
      [input.userId, input.repo, input.prompt, input.schedule, input.description]
    );
    return Number(result.lastInsertRowid);
  }

  listByUser(userId: string): Schedule[] {
    return (this.db.query(`SELECT * FROM schedules WHERE user_id = ? ORDER BY id`).all(userId) as ScheduleRow[])
      .map(this.rowToSchedule);
  }

  remove(userId: string, id: number): boolean {
    const result = this.db.run(`DELETE FROM schedules WHERE id = ? AND user_id = ?`, [id, userId]);
    return result.changes > 0;
  }

  getAll(): Schedule[] {
    return (this.db.query(`SELECT * FROM schedules ORDER BY id`).all() as ScheduleRow[])
      .map(this.rowToSchedule);
  }

  private rowToSchedule(row: ScheduleRow): Schedule {
    return {
      id: row.id,
      userId: row.user_id,
      repo: row.repo,
      prompt: row.prompt,
      schedule: row.schedule,
      description: row.description,
      createdAt: row.created_at,
    };
  }
}
