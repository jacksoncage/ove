export interface RunOptions {
  maxTurns: number;
  mcpConfigPath?: string;
}

export interface RunResult {
  success: boolean;
  output: string;
  durationMs: number;
}

export type StatusEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; input: string };

export type StatusCallback = (event: StatusEvent) => void;

export interface AgentRunner {
  name: string;
  run(prompt: string, workDir: string, opts: RunOptions, onStatus?: StatusCallback): Promise<RunResult>;
}
