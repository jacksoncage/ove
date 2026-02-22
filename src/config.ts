import { readFileSync, writeFileSync } from "node:fs";

export interface RunnerConfig {
  name: string;
  model?: string;
}

export interface RepoConfig {
  url?: string;
  defaultBranch?: string;
  runner?: RunnerConfig;
  excluded?: boolean;
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

export interface GitHubConfig {
  syncInterval?: number;
  orgs?: string[];
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
  runner?: RunnerConfig;
  github?: GitHubConfig;
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
      runner: raw.runner,
      github: raw.github,
    };
  } catch {
    // Config file doesn't exist yet or is invalid — use defaults
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
  return user.repos.includes("*") || user.repos.includes(repo);
}

export function saveConfig(config: Config): void {
  const configPath = process.env.CONFIG_PATH || "./config.json";
  // Read existing file to preserve extra fields (e.g. "runner")
  let existing: Record<string, any> = {};
  try {
    existing = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // File doesn't exist yet or is invalid — start with empty object
  }
  const merged = { ...existing, repos: config.repos, users: config.users, claude: config.claude, reposDir: config.reposDir };
  if (config.mcpServers) merged.mcpServers = config.mcpServers;
  if (config.cron) merged.cron = config.cron;
  if (config.runner) merged.runner = config.runner;
  if (config.github) merged.github = config.github;
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
}

export function addRepo(config: Config, name: string, url: string, branch: string = "main"): void {
  config.repos[name] = { url, defaultBranch: branch };
  saveConfig(config);
}

export function addUser(config: Config, userId: string, name: string, repos: string[]): void {
  const existing = config.users[userId];
  if (existing) {
    const merged = new Set([...existing.repos, ...repos]);
    existing.repos = [...merged];
  } else {
    config.users[userId] = { name, repos: [...repos] };
  }
  saveConfig(config);
}
