import type { ChatAdapter, IncomingMessage, AdapterStatus } from "./types";
import { createInterface } from "node:readline";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CLEAR_LINE = "\x1b[2K";
const MOVE_UP = "\x1b[1A";

export class CliAdapter implements ChatAdapter {
  private rl?: ReturnType<typeof createInterface>;
  private onMessage?: (msg: IncomingMessage) => void;
  private userId: string;
  private statusLines: string[] = [];
  private statusLinesShown = 0;
  private started = false;
  private startedAt?: string;

  constructor(userId: string = "cli:local") {
    this.userId = userId;
  }

  private clearStatusBlock() {
    for (let i = 0; i < this.statusLinesShown; i++) {
      process.stdout.write(`${MOVE_UP}${CLEAR_LINE}\r`);
    }
    this.statusLinesShown = 0;
  }

  private renderStatusBlock() {
    this.clearStatusBlock();
    const lines = this.statusLines.slice(-8);
    for (const line of lines) {
      process.stdout.write(`${DIM}  ${line}${RESET}\n`);
    }
    this.statusLinesShown = lines.length;
  }

  async start(onMessage: (msg: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "\nove> ",
    });

    this.started = true;
    this.startedAt = new Date().toISOString();

    console.log("\n--- Ove ---");
    console.log("Ja. What do you want? Type 'help' if you need it.\n");

    this.rl.prompt();

    this.rl.on("line", (line) => {
      const text = line.trim();
      if (!text) {
        this.rl?.prompt();
        return;
      }
      if (text === "quit" || text === "exit") {
        console.log("Bye!");
        process.exit(0);
      }

      // Reset status log for new message
      this.statusLines = [];
      this.statusLinesShown = 0;

      const msg: IncomingMessage = {
        userId: this.userId,
        platform: "cli",
        text,
        reply: async (replyText: string) => {
          this.clearStatusBlock();
          this.statusLines = [];
          console.log(`\n${replyText}`);
          this.rl?.prompt();
        },
        updateStatus: async (statusText: string) => {
          this.statusLines.push(statusText);
          this.renderStatusBlock();
        },
      };

      this.onMessage?.(msg);
    });

    this.rl.on("close", () => {
      // Don't exit immediately — let worker loop finish pending tasks
      console.log("\n(stdin closed, waiting for pending tasks to finish...)");
    });
  }

  getStatus(): AdapterStatus {
    return {
      name: "cli",
      type: "chat",
      status: this.started ? "connected" : "disconnected",
      startedAt: this.startedAt,
    };
  }

  async stop(): Promise<void> {
    this.started = false;
    this.rl?.close();
  }
}
