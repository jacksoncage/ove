import { logger } from "./logger";

const IDLE_TIMEOUT = 3 * 60 * 60_000; // 3 hours idle → kill session
const STALL_TIMEOUT = 180_000; // 3 min no pane changes → assume stuck
const ACTIVE_TIMEOUT = 30 * 60_000; // 30 min max while Claude is still working
const POLL_INTERVAL = 500; // poll every 500ms
const MIN_RESPONSE_WAIT = 5_000; // don't check for completion in the first 5s
const STABLE_THRESHOLD = 10; // 10 consecutive stable polls (5s) before declaring done
const POST_PROMPT_DELAY = 2000; // wait after prompt detected before sending keys

interface TmuxSession {
  sessionName: string;
  userId: string;
  workDir: string;
  createdAt: number;
  ready: boolean;
}

/**
 * Manages persistent Claude CLI sessions via tmux for fast follow-up messages.
 * Each user gets a tmux session running `claude` interactively.
 * Messages are sent via `tmux send-keys`, responses read via `tmux capture-pane`.
 */
export class DiscussPool {
  private sessions = new Map<string, TmuxSession>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async send(
    userId: string,
    prompt: string,
    workDir: string,
    model?: string,
  ): Promise<{ output: string; durationMs: number }> {
    const start = Date.now();

    let session = this.sessions.get(userId);

    // Check if tmux session is still alive
    if (session && !(await this.isAlive(session.sessionName))) {
      logger.warn("discuss tmux session died", { userId, sessionName: session.sessionName });
      this.cleanup(userId);
      session = undefined;
    }

    if (!session) {
      session = await this.spawn(userId, workDir, model);
    }

    this.resetIdleTimer(userId);

    const output = await this.sendAndWait(session, prompt);
    return { output, durationMs: Date.now() - start };
  }

  private async spawn(userId: string, workDir: string, model?: string): Promise<TmuxSession> {
    const sessionName = `ove-discuss-${userId.replace(/[^a-zA-Z0-9]/g, "-")}`;

    // Kill any existing tmux session with this name
    await this.tmux(["kill-session", "-t", sessionName]).catch(() => {});

    const modelFlag = model ? `--model ${model}` : "";
    const cmd = `cd ${this.shellEscape(workDir)} && unset CLAUDECODE ANTHROPIC_API_KEY && claude --dangerously-skip-permissions ${modelFlag}`.trim();

    logger.info("spawning discuss tmux session", { userId, sessionName, workDir, model });

    const result = await this.tmux([
      "new-session", "-d",
      "-s", sessionName,
      "-x", "200", "-y", "50",
      cmd,
    ], { TERM: "xterm" });

    if (!result.success) {
      throw new Error(`Failed to create tmux session: ${result.stderr}`);
    }

    const session: TmuxSession = {
      sessionName,
      userId,
      workDir,
      createdAt: Date.now(),
      ready: false,
    };

    // Wait for the REPL prompt to appear, then extra delay for TUI to be fully ready
    await this.waitForPrompt(session, 30_000);
    await Bun.sleep(POST_PROMPT_DELAY);
    session.ready = true;

    this.sessions.set(userId, session);
    this.resetIdleTimer(userId);

    logger.info("discuss tmux session ready", { userId, sessionName, startupMs: Date.now() - session.createdAt });
    return session;
  }

  private async sendAndWait(session: TmuxSession, prompt: string): Promise<string> {
    // Capture pane before sending to know what's already there
    const beforePane = await this.capturePane(session.sessionName);

    // Send text literally (-l avoids bracket paste), then Enter to submit
    const singleLine = prompt.replace(/\n/g, " ").trim();
    await this.tmux(["send-keys", "-l", "-t", session.sessionName, singleLine]);

    // Brief pause to let TUI render the typed text before submitting
    await Bun.sleep(200);
    await this.tmux(["send-keys", "-t", session.sessionName, "Enter"]);

    // Verify the text was actually typed by checking the pane changed
    await Bun.sleep(500);
    const afterSend = await this.capturePane(session.sessionName);
    if (afterSend === beforePane) {
      logger.warn("discuss send-keys may have been lost, retrying", { userId: session.userId });
      // Retry: the TUI might not have been ready
      await Bun.sleep(1000);
      await this.tmux(["send-keys", "-l", "-t", session.sessionName, singleLine]);
      await Bun.sleep(200);
      await this.tmux(["send-keys", "-t", session.sessionName, "Enter"]);
    }

    // Poll for response — two timeout modes:
    // 1. STALL_TIMEOUT: no pane changes for 3 min → assume stuck
    // 2. ACTIVE_TIMEOUT: 30 min total even if Claude is still working
    const startWait = Date.now();
    let lastPane = "";
    let lastChangeAt = Date.now();
    let stableCount = 0;

    while (true) {
      const elapsed = Date.now() - startWait;
      const stalledFor = Date.now() - lastChangeAt;

      if (elapsed >= ACTIVE_TIMEOUT) {
        logger.warn("discuss active timeout", { userId: session.userId, elapsedMs: elapsed });
        break;
      }
      if (stalledFor >= STALL_TIMEOUT) {
        logger.warn("discuss stall timeout", { userId: session.userId, stalledMs: stalledFor, elapsedMs: elapsed });
        break;
      }

      await Bun.sleep(POLL_INTERVAL);

      const pane = await this.capturePane(session.sessionName);
      if (pane === lastPane && pane !== beforePane) {
        stableCount++;
        // Require STABLE_THRESHOLD consecutive stable polls (5s) and MIN_RESPONSE_WAIT elapsed
        if (stableCount >= STABLE_THRESHOLD && elapsed >= MIN_RESPONSE_WAIT && this.hasPromptReady(pane)) {
          const response = this.extractResponse(pane, prompt);
          if (response) {
            logger.info("discuss response received", {
              userId: session.userId,
              responseLen: response.length,
              waitMs: elapsed,
            });
            return response;
          }
        }
      } else {
        stableCount = 0;
        if (pane !== lastPane) lastChangeAt = Date.now();
      }
      lastPane = pane;
    }

    // Log the final pane state for debugging
    const finalPane = await this.capturePane(session.sessionName);
    const nonEmptyLines = finalPane.split("\n").filter(l => l.trim()).slice(-10);
    logger.warn("discuss response timed out", {
      userId: session.userId,
      lastLines: nonEmptyLines.join(" | "),
    });
    return "Response timed out";
  }

  /**
   * Extract the assistant's response from the pane output.
   * Claude Code format: user prompt, then ● response text, then ❯ prompt
   */
  private extractResponse(pane: string, prompt: string): string | null {
    const lines = pane.split("\n");

    // Find the last ● marker (assistant response)
    let responseStart = -1;
    let promptLineAfter = -1;

    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("❯") && trimmed.length <= 2 && promptLineAfter === -1) {
        promptLineAfter = i;
      }
      if (trimmed.startsWith("●") && responseStart === -1) {
        responseStart = i;
        break;
      }
    }

    if (responseStart === -1) return null;

    // Collect response lines from ● to the next ❯ prompt
    const end = promptLineAfter > responseStart ? promptLineAfter : lines.length;
    const responseLines: string[] = [];

    for (let i = responseStart; i < end; i++) {
      let line = lines[i].trim();
      // Strip the ● prefix from first line
      if (i === responseStart && line.startsWith("●")) {
        line = line.slice(1).trim();
      }
      // Skip separator lines (may contain ▪▪▪ or spaces)
      if (line.match(/^[─━▪ ]+$/)) continue;
      // Skip empty lines at end
      if (i === end - 1 && !line) continue;
      responseLines.push(line);
    }

    const response = responseLines.join("\n").trim();
    return response || null;
  }

  private hasPromptReady(pane: string): boolean {
    const lines = pane.split("\n").filter(l => l.trim());
    // Check last few non-empty lines for the ❯ prompt
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      const trimmed = lines[i].trim();
      if (trimmed === "❯") return true;
    }
    return false;
  }

  private async waitForPrompt(session: TmuxSession, timeout: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const pane = await this.capturePane(session.sessionName);
      if (this.hasPromptReady(pane)) return;
      await Bun.sleep(POLL_INTERVAL);
    }
    throw new Error(`Tmux session ${session.sessionName} did not reach prompt within ${timeout}ms`);
  }

  private async capturePane(sessionName: string): Promise<string> {
    const result = await this.tmux(["capture-pane", "-t", sessionName, "-p", "-S", "-100"]);
    return result.stdout;
  }

  private async isAlive(sessionName: string): Promise<boolean> {
    const result = await this.tmux(["has-session", "-t", sessionName]);
    return result.success;
  }

  private async tmux(
    args: string[],
    extraEnv?: Record<string, string>,
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["tmux", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...extraEnv },
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    return { success: exitCode === 0, stdout, stderr };
  }

  private shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }

  private resetIdleTimer(userId: string) {
    const existing = this.idleTimers.get(userId);
    if (existing) clearTimeout(existing);
    this.idleTimers.set(userId, setTimeout(() => {
      logger.info("discuss session idle timeout", { userId });
      this.cleanup(userId);
    }, IDLE_TIMEOUT));
  }

  private cleanup(userId: string) {
    const session = this.sessions.get(userId);
    if (session) {
      this.tmux(["kill-session", "-t", session.sessionName]).catch(() => {});
    }
    this.sessions.delete(userId);
    const timer = this.idleTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(userId);
  }

  hasSession(userId: string): boolean {
    return this.sessions.has(userId);
  }

  killAll() {
    for (const [userId] of this.sessions) {
      this.cleanup(userId);
    }
  }
}
