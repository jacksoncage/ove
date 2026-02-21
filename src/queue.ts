import { Database } from "bun:sqlite";

export interface TaskInput {
  userId: string;
  repo: string;
  prompt: string;
  taskType?: string;
}

export interface Task {
  id: string;
  userId: string;
  repo: string;
  prompt: string;
  status: "pending" | "running" | "completed" | "failed";
  result: string | null;
  taskType: string | null;
  createdAt: string;
  completedAt: string | null;
}

export class TaskQueue {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        task_type TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);
    // Migration: add task_type column if missing (backward compat)
    try {
      this.db.run(`ALTER TABLE tasks ADD COLUMN task_type TEXT`);
    } catch {
      // Column already exists
    }
  }

  enqueue(input: TaskInput): string {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO tasks (id, user_id, repo, prompt, status, task_type, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [id, input.userId, input.repo, input.prompt, input.taskType || null, new Date().toISOString()]
    );
    return id;
  }

  dequeue(): Task | null {
    const row = this.db
      .query(
        `SELECT * FROM tasks
         WHERE status = 'pending'
         AND repo NOT IN (SELECT repo FROM tasks WHERE status = 'running')
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get() as any;

    if (!row) return null;

    this.db.run(`UPDATE tasks SET status = 'running' WHERE id = ?`, [row.id]);

    return this.rowToTask({ ...row, status: "running" });
  }

  complete(id: string, result: string) {
    this.db.run(
      `UPDATE tasks SET status = 'completed', result = ?, completed_at = ? WHERE id = ?`,
      [result, new Date().toISOString(), id]
    );
  }

  fail(id: string, error: string) {
    this.db.run(
      `UPDATE tasks SET status = 'failed', result = ?, completed_at = ? WHERE id = ?`,
      [error, new Date().toISOString(), id]
    );
  }

  get(id: string): Task | null {
    const row = this.db.query(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
    return row ? this.rowToTask(row) : null;
  }

  listByUser(userId: string, limit: number = 10): Task[] {
    const rows = this.db
      .query(
        `SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(userId, limit) as any[];
    return rows.map((r) => this.rowToTask(r));
  }

  stats(): { pending: number; running: number; completed: number; failed: number } {
    const row = this.db
      .query(
        `SELECT
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'running') as running,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'failed') as failed
        FROM tasks`
      )
      .get() as any;
    return row;
  }

  private rowToTask(row: any): Task {
    return {
      id: row.id,
      userId: row.user_id,
      repo: row.repo,
      prompt: row.prompt,
      status: row.status,
      result: row.result,
      taskType: row.task_type || null,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}
