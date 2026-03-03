import type { StreamingSession } from "./runner";

interface SessionEntry {
  taskId: string;
  userId: string;
  session: StreamingSession;
  waiting: boolean;
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();

  register(taskId: string, userId: string, session: StreamingSession) {
    this.sessions.set(taskId, { taskId, userId, session, waiting: false });
  }

  unregister(taskId: string) {
    this.sessions.delete(taskId);
  }

  getByTask(taskId: string): StreamingSession | null {
    return this.sessions.get(taskId)?.session ?? null;
  }

  setWaiting(taskId: string) {
    const entry = this.sessions.get(taskId);
    if (entry) entry.waiting = true;
  }

  clearWaiting(taskId: string) {
    const entry = this.sessions.get(taskId);
    if (entry) entry.waiting = false;
  }

  getWaitingForUser(
    userId: string,
  ): { taskId: string; session: StreamingSession } | null {
    for (const entry of this.sessions.values()) {
      if (entry.userId === userId && entry.waiting) {
        return { taskId: entry.taskId, session: entry.session };
      }
    }
    return null;
  }

  sendToTask(taskId: string, text: string): boolean {
    const entry = this.sessions.get(taskId);
    if (!entry) return false;
    entry.session.sendMessage(text);
    return true;
  }

  killAll() {
    for (const entry of this.sessions.values()) {
      entry.session.kill();
    }
    this.sessions.clear();
  }
}
