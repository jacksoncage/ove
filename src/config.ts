import { readFileSync, writeFileSync } from "node:fs";
import { logger } from "./logger";

function getConfigPath(): string {
  return process.env.CONFIG_PATH || "./config.json";
}

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
  let raw: Partial<Config> = {};
  try {
    raw = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      logger.warn("failed to load config", { error: String(err) });
    }
  }

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
}

export function getUserRepos(config: Config, platformUserId: string): string[] {
  const user = config.users[platformUserId];
  if (!user) return [];
  // Known users with empty repos get wildcard access — avoids
  // silently falling back to discuss-only mode with no tracing.
  if (user.repos.length === 0) return ["*"];
  return user.repos;
}

export function isAuthorized(config: Config, platformUserId: string, repo?: string): boolean {
  const user = config.users[platformUserId];
  if (!user) return false;
  if (!repo) return true;
  // Empty repos = wildcard (same as getUserRepos)
  return user.repos.length === 0 || user.repos.includes("*") || user.repos.includes(repo);
}

export function saveConfig(config: Config): void {
  const configPath = getConfigPath();
  let existing: Record<string, any> = {};
  try {
    existing = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      logger.warn("failed to read existing config for merge", { error: String(err) });
    }
  }

  const merged = {
    ...existing,
    repos: config.repos,
    users: config.users,
    claude: config.claude,
    reposDir: config.reposDir,
    ...(config.mcpServers && { mcpServers: config.mcpServers }),
    ...(config.cron && { cron: config.cron }),
    ...(config.runner && { runner: config.runner }),
    ...(config.github && { github: config.github }),
  };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
}

export function addRepo(config: Config, name: string, url: string, branch: string = "main"): void {
  config.repos[name] = { url, defaultBranch: branch };
  saveConfig(config);
}

export function addUser(config: Config, userId: string, name: string, repos: string[]): void {
  const existing = config.users[userId];
  if (existing) {
    existing.repos = [...new Set([...existing.repos, ...repos])];
  } else {
    config.users[userId] = { name, repos: [...repos] };
  }
  saveConfig(config);
}
