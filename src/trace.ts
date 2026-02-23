import { Database } from "bun:sqlite";

export interface TraceEvent {
  id: number;
  taskId: string;
  ts: string;
  kind: "status" | "tool" | "lifecycle" | "output" | "error";
  summary: string;
  detail: string | null;
}

interface TraceRow {
  id: number;
  task_id: string;
  ts: string;
  kind: string;
  summary: string;
  detail: string | null;
}

export class TraceStore {
  private db: Database;
  private enabled: boolean;

  constructor(db: Database) {
    this.db = db;
    this.enabled = process.env.OVE_TRACE === "true";
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_trace_task_id ON task_traces(task_id)`);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  append(taskId: string, kind: TraceEvent["kind"], summary: string, detail?: string) {
    if (!this.enabled) return;
    this.db.run(
      `INSERT INTO task_traces (task_id, ts, kind, summary, detail) VALUES (?, ?, ?, ?, ?)`,
      [taskId, new Date().toISOString(), kind, summary, detail ?? null]
    );
  }

  getByTask(taskId: string, limit: number = 100): TraceEvent[] {
    const rows = this.db
      .query(`SELECT * FROM task_traces WHERE task_id = ? ORDER BY id ASC LIMIT ?`)
      .all(taskId, limit) as TraceRow[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      ts: r.ts,
      kind: r.kind as TraceEvent["kind"],
      summary: r.summary,
      detail: r.detail,
    }));
  }

  cleanup(olderThanDays: number = 7) {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    this.db.run(`DELETE FROM task_traces WHERE ts < ?`, [cutoff]);
  }
}
