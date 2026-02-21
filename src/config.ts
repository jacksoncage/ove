import { readFileSync } from "node:fs";

export interface RepoConfig {
  url: string;
  defaultBranch: string;
}

export interface UserConfig {
  name: string;
  repos: string[];
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export interface CronTaskConfig {
  schedule: string;
  repo: string;
  prompt: string;
  userId: string;
}

export interface Config {
  repos: Record<string, RepoConfig>;
  users: Record<string, UserConfig>;
  claude: {
    maxTurns: number;
  };
  reposDir: string;
  mcpServers?: Record<string, McpServerConfig>;
  cron?: CronTaskConfig[];
}

export function loadConfig(): Config {
  const configPath = process.env.CONFIG_PATH || "./config.json";
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<Config>;
    return {
      repos: raw.repos || {},
      users: raw.users || {},
      claude: { maxTurns: raw.claude?.maxTurns || 25 },
      reposDir: process.env.REPOS_DIR || raw.reposDir || "./repos",
      mcpServers: raw.mcpServers,
      cron: raw.cron,
    };
  } catch {
    return {
      repos: {},
      users: {},
      claude: {
        maxTurns: 25,
      },
      reposDir: process.env.REPOS_DIR || "./repos",
    };
  }
}

export function getUserRepos(config: Config, platformUserId: string): string[] {
  const user = config.users[platformUserId];
  if (!user) return [];
  return user.repos;
}

export function isAuthorized(config: Config, platformUserId: string, repo?: string): boolean {
  const user = config.users[platformUserId];
  if (!user) return false;
  if (!repo) return true;
  return user.repos.includes(repo);
}
