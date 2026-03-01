import { Database } from "bun:sqlite";

export interface TaskInput {
  userId: string;
  repo: string;
  prompt: string;
  taskType?: string;
  priority?: number;
}

export interface Task {
  id: string;
  userId: string;
  repo: string;
  prompt: string;
  status: "pending" | "running" | "completed" | "failed";
  result: string | null;
  taskType: string | null;
  priority: number;
  createdAt: string;
  completedAt: string | null;
}

interface TaskRow {
  id: string;
  user_id: string;
  repo: string;
  prompt: string;
  status: string;
  result: string | null;
  task_type: string | null;
  priority: number;
  created_at: string;
  completed_at: string | null;
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
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);
    // Migration: add task_type column if missing (backward compat)
    const columns = this.db.query("PRAGMA table_info(tasks)").all() as { name: string }[];
    if (!columns.some(c => c.name === "task_type")) {
      this.db.run("ALTER TABLE tasks ADD COLUMN task_type TEXT");
    }
    // Migration: add priority column if missing (backward compat)
    if (!columns.some(c => c.name === "priority")) {
      this.db.run("ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
    }
  }

  enqueue(input: TaskInput): string {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO tasks (id, user_id, repo, prompt, status, task_type, priority, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [id, input.userId, input.repo, input.prompt, input.taskType || null, input.priority ?? 0, new Date().toISOString()]
    );
    return id;
  }

  dequeue(): Task | null {
    const row = this.db
      .query(
        `SELECT * FROM tasks
         WHERE status = 'pending'
         AND repo NOT IN (SELECT repo FROM tasks WHERE status = 'running')
         ORDER BY priority DESC, created_at ASC
         LIMIT 1`
      )
      .get() as TaskRow;

    if (!row) return null;

    this.db.run(`UPDATE tasks SET status = 'running' WHERE id = ?`, [row.id]);

    return this.rowToTask({ ...row, status: "running" });
  }

  complete(id: string, result: string) {
    this.finish(id, "completed", result);
  }

  fail(id: string, error: string) {
    this.finish(id, "failed", error);
  }

  private finish(id: string, status: "completed" | "failed", result: string) {
    this.db.run(
      `UPDATE tasks SET status = ?, result = ?, completed_at = ? WHERE id = ?`,
      [status, result, new Date().toISOString(), id]
    );
  }

  get(id: string): Task | null {
    const row = this.db.query(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow;
    return row ? this.rowToTask(row) : null;
  }

  listByUser(userId: string, limit: number = 10): Task[] {
    const rows = this.db
      .query(
        `SELECT * FROM tasks WHERE user_id = ? ORDER BY priority DESC, created_at DESC LIMIT ?`
      )
      .all(userId, limit) as TaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  stats(): { pending: number; running: number; completed: number; failed: number } {
    return this.db
      .query(
        `SELECT
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'running') as running,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'failed') as failed
        FROM tasks`
      )
      .get() as { pending: number; running: number; completed: number; failed: number };
  }

  metrics(): {
    counts: { pending: number; running: number; completed: number; failed: number };
    avgDurationByRepo: { repo: string; avgMs: number; count: number }[];
    throughput: { lastHour: number; last24h: number };
    errorRate: number;
    repoBreakdown: { repo: string; pending: number; running: number; completed: number; failed: number }[];
  } {
    const counts = this.stats();

    // Average task duration by repo (only completed/failed tasks with both timestamps)
    const avgDurationByRepo = this.db
      .query(
        `SELECT repo,
          AVG((julianday(completed_at) - julianday(created_at)) * 86400000) as avg_ms,
          COUNT(*) as count
        FROM tasks
        WHERE completed_at IS NOT NULL AND created_at IS NOT NULL
          AND status IN ('completed', 'failed')
        GROUP BY repo
        ORDER BY count DESC`
      )
      .all() as { repo: string; avg_ms: number; count: number }[];

    // Task throughput — completed in last hour and last 24h
    const now = new Date().toISOString();
    const throughputRow = this.db
      .query(
        `SELECT
          COUNT(*) FILTER (WHERE completed_at >= datetime(?, '-1 hour')) as last_hour,
          COUNT(*) FILTER (WHERE completed_at >= datetime(?, '-24 hours')) as last_24h
        FROM tasks
        WHERE status IN ('completed', 'failed') AND completed_at IS NOT NULL`
      )
      .get(now, now) as { last_hour: number; last_24h: number };

    // Error rate: failed / total finished
    const total = counts.completed + counts.failed;
    const errorRate = total > 0 ? counts.failed / total : 0;

    // Per-repo breakdown
    const repoBreakdown = this.db
      .query(
        `SELECT repo,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE status = 'running') as running,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'failed') as failed
        FROM tasks
        GROUP BY repo
        ORDER BY (COUNT(*) FILTER (WHERE status = 'running') + COUNT(*) FILTER (WHERE status = 'pending')) DESC, repo ASC`
      )
      .all() as { repo: string; pending: number; running: number; completed: number; failed: number }[];

    return {
      counts,
      avgDurationByRepo: avgDurationByRepo.map((r) => ({
        repo: r.repo,
        avgMs: Math.round(r.avg_ms),
        count: r.count,
      })),
      throughput: {
        lastHour: throughputRow.last_hour,
        last24h: throughputRow.last_24h,
      },
      errorRate: Math.round(errorRate * 10000) / 10000, // 4 decimal places
      repoBreakdown,
    };
  }

  listActive(limit: number = 20): Task[] {
    const rows = this.db
      .query(
        `SELECT * FROM tasks WHERE status IN ('running', 'pending') ORDER BY priority DESC, created_at ASC LIMIT ?`
      )
      .all(limit) as TaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  cancel(id: string): boolean {
    return this.db.run(
      `UPDATE tasks SET status = 'failed', result = 'Cancelled', completed_at = ? WHERE id = ? AND status IN ('running', 'pending')`,
      [new Date().toISOString(), id]
    ).changes > 0;
  }

  listRecent(limit: number = 20, status?: string): Task[] {
    let sql = `SELECT * FROM tasks`;
    const params: (string | number)[] = [];
    if (status) {
      sql += ` WHERE status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY priority DESC, created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = this.db.query(sql).all(...params) as TaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  resetStale(): number {
    return this.db.run(
      `UPDATE tasks SET status = 'failed', result = 'Interrupted — process restarted', completed_at = ? WHERE status = 'running'`,
      [new Date().toISOString()]
    ).changes;
  }

  private rowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      userId: row.user_id,
      repo: row.repo,
      prompt: row.prompt,
      status: row.status as "pending" | "running" | "completed" | "failed",
      result: row.result,
      taskType: row.task_type || null,
      priority: row.priority ?? 0,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}
