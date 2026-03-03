export interface RunOptions {
  maxTurns: number;
  mcpConfigPath?: string;
  model?: string;
  signal?: AbortSignal;
  resumeSessionId?: string;
}

export interface RunResult {
  success: boolean;
  output: string;
  durationMs: number;
  sessionId?: string;
}

export type StatusEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; input: string };

export type StatusCallback = (event: StatusEvent) => void;

export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; input: string }
  | { kind: "ask_user"; question: string; options: { label: string; description?: string }[] }
  | { kind: "result"; text: string; sessionId?: string }
  | { kind: "error"; text: string };

export interface StreamingSession {
  sendMessage(text: string): void;
  kill(): void;
  readonly sessionId: string | null;
  readonly done: Promise<RunResult>;
}

export interface AgentRunner {
  name: string;
  run(prompt: string, workDir: string, opts: RunOptions, onStatus?: StatusCallback): Promise<RunResult>;
}
