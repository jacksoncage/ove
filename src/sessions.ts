import { Database } from "bun:sqlite";

export type UserMode = "strict" | "assistant";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface ChatMessageRow {
  role: string;
  content: string;
  created_at: string;
}

export class SessionStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_history(user_id)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_modes (
        user_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  addMessage(userId: string, role: "user" | "assistant", content: string) {
    this.db.run(
      `INSERT INTO chat_history (user_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
      [userId, role, content, new Date().toISOString()]
    );
  }

  getHistory(userId: string, limit: number = 10): ChatMessage[] {
    const rows = this.db
      .query(
        `SELECT role, content, created_at FROM chat_history
         WHERE user_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(userId, limit) as ChatMessageRow[];

    return rows
      .reverse()
      .map((r) => ({
        role: r.role as "user" | "assistant",
        content: r.content,
        timestamp: r.created_at,
      }));
  }

  getMode(userId: string): UserMode {
    const row = this.db
      .query(`SELECT mode FROM user_modes WHERE user_id = ?`)
      .get(userId) as { mode: string } | null;
    return row?.mode === "assistant" ? "assistant" : "strict";
  }

  setMode(userId: string, mode: UserMode): void {
    this.db.run(
      `INSERT INTO user_modes (user_id, mode, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
      [userId, mode, new Date().toISOString()]
    );
  }

  clear(userId: string) {
    this.db.run(`DELETE FROM chat_history WHERE user_id = ?`, [userId]);
    this.db.run(`DELETE FROM user_modes WHERE user_id = ?`, [userId]);
  }
}
