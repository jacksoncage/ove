import { existsSync, readFileSync, writeFileSync, accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import type { Config } from "./config";

interface ValidationResult {
  valid: boolean;
  issues: string[];
}

export interface DiagnosticResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
}

export interface DiagnosticDeps {
  which: (cmd: string) => string | null;
  fetch: typeof globalThis.fetch;
  spawn: typeof Bun.spawn;
  accessSync: typeof accessSync;
  existsSync: typeof existsSync;
}

const defaultDeps: DiagnosticDeps = {
  which: (cmd: string) => Bun.which(cmd),
  fetch: globalThis.fetch,
  spawn: Bun.spawn,
  accessSync,
  existsSync,
};

export async function runDiagnostics(config: Config, deps: DiagnosticDeps = defaultDeps): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  // Check git installed
  const gitPath = deps.which("git");
  if (gitPath) {
    let version = "";
    try {
      const proc = deps.spawn(["git", "--version"], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      version = await new Response(proc.stdout).text();
      const match = version.match(/(\d+\.\d+[\.\d]*)/);
      results.push({ name: "git", status: "pass", message: `git installed (${match ? match[1] : "unknown version"})` });
    } catch {
      results.push({ name: "git", status: "pass", message: "git installed" });
    }
  } else {
    results.push({ name: "git", status: "fail", message: "git not found" });
  }

  // Check runner CLI installed (claude or codex)
  const runnerName = config.runner?.name || "claude";
  const runnerCmd = runnerName === "codex" ? "codex" : "claude";
  const runnerPath = deps.which(runnerCmd);
  if (runnerPath) {
    results.push({ name: runnerCmd, status: "pass", message: `${runnerCmd} CLI installed` });
  } else {
    results.push({ name: runnerCmd, status: "fail", message: `${runnerCmd} CLI not found` });
  }

  // Check gh CLI installed (if GitHub sync configured)
  const hasGitHubSync = !!(config.github?.orgs && config.github.orgs.length > 0);
  const hasGitHubPoll = !!process.env.GITHUB_POLL_REPOS;
  if (hasGitHubSync || hasGitHubPoll) {
    const ghPath = deps.which("gh");
    if (ghPath) {
      results.push({ name: "gh", status: "pass", message: "gh CLI installed" });
    } else {
      results.push({ name: "gh", status: "warn", message: "gh CLI not found (GitHub sync will not work)" });
    }
  }

  // Check SSH access to GitHub
  try {
    const proc = deps.spawn(
      ["ssh", "-T", "git@github.com", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    // GitHub SSH returns exit code 1 with "successfully authenticated" on success
    const stderr = await new Response(proc.stderr).text();
    if (exitCode === 0 || exitCode === 1 && stderr.includes("successfully authenticated")) {
      results.push({ name: "ssh", status: "pass", message: "SSH access to github.com" });
    } else {
      results.push({ name: "ssh", status: "warn", message: "SSH access to github.com failed (HTTPS clones still work)" });
    }
  } catch {
    results.push({ name: "ssh", status: "warn", message: "SSH access to github.com failed (HTTPS clones still work)" });
  }

  // Check REPOS_DIR exists and is writable
  const reposDir = config.reposDir;
  if (deps.existsSync(reposDir)) {
    try {
      deps.accessSync(reposDir, constants.W_OK);
      results.push({ name: "repos_dir", status: "pass", message: `REPOS_DIR ${reposDir} exists and is writable` });
    } catch {
      results.push({ name: "repos_dir", status: "fail", message: `REPOS_DIR ${reposDir} exists but is not writable` });
    }
  } else {
    results.push({ name: "repos_dir", status: "fail", message: `REPOS_DIR ${reposDir} does not exist` });
  }

  // Check bot token validity via API calls
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (slackToken && slackToken !== "xoxb-...") {
    try {
      const res = await deps.fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${slackToken}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json() as { ok: boolean };
      if (data.ok) {
        results.push({ name: "slack", status: "pass", message: "Slack bot token is valid" });
      } else {
        results.push({ name: "slack", status: "fail", message: "Slack bot token is invalid" });
      }
    } catch {
      results.push({ name: "slack", status: "warn", message: "Could not verify Slack bot token (network error)" });
    }
  }

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (telegramToken) {
    try {
      const res = await deps.fetch(`https://api.telegram.org/bot${telegramToken}/getMe`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json() as { ok: boolean };
      if (data.ok) {
        results.push({ name: "telegram", status: "pass", message: "Telegram bot token is valid" });
      } else {
        results.push({ name: "telegram", status: "fail", message: "Telegram bot token is invalid" });
      }
    } catch {
      results.push({ name: "telegram", status: "warn", message: "Could not verify Telegram bot token (network error)" });
    }
  }

  const discordToken = process.env.DISCORD_BOT_TOKEN;
  if (discordToken) {
    try {
      const res = await deps.fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${discordToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        results.push({ name: "discord", status: "pass", message: "Discord bot token is valid" });
      } else {
        results.push({ name: "discord", status: "fail", message: "Discord bot token is invalid" });
      }
    } catch {
      results.push({ name: "discord", status: "warn", message: "Could not verify Discord bot token (network error)" });
    }
  }

  return results;
}

export function printDiagnostics(results: DiagnosticResult[]): void {
  const icons = { pass: "\u2713", fail: "\u2717", warn: "\u26A0" };
  for (const r of results) {
    process.stdout.write(`  ${icons[r.status]} ${r.message}\n`);
  }
}

export function validateConfig(opts?: { configPath?: string; envPath?: string }): ValidationResult {
  const configPath = opts?.configPath || process.env.CONFIG_PATH || "./config.json";
  const envPath = opts?.envPath || "./.env";
  const issues: string[] = [];

  if (!existsSync(configPath)) {
    issues.push("config.json not found");
  }

  // Load env values from file if it exists
  const env = loadEnvFile(envPath);
  const get = (key: string) => process.env[key] || env[key] || "";
  const cliMode = get("CLI_MODE") === "true";

  // Detect which transports are configured
  const hasSlack = !!(get("SLACK_BOT_TOKEN") && get("SLACK_BOT_TOKEN") !== "xoxb-...");
  const hasTelegram = !!get("TELEGRAM_BOT_TOKEN");
  const hasDiscord = !!get("DISCORD_BOT_TOKEN");
  const hasWhatsApp = get("WHATSAPP_ENABLED") === "true";
  const hasHttp = !!get("HTTP_API_PORT") || !!get("HTTP_API_KEY");
  const hasGitHub = !!get("GITHUB_POLL_REPOS");
  const hasAnyTransport = cliMode || hasSlack || hasTelegram || hasDiscord || hasWhatsApp || hasHttp || hasGitHub;

  // Only warn about missing .env if env vars aren't already set
  if (!existsSync(envPath) && !hasAnyTransport) {
    issues.push(".env not found");
  }

  // Validate Slack tokens if Slack is partially configured
  const slackBot = get("SLACK_BOT_TOKEN");
  const slackApp = get("SLACK_APP_TOKEN");
  if (slackBot || slackApp) {
    if (!slackBot || slackBot === "xoxb-...") {
      issues.push("SLACK_BOT_TOKEN is a placeholder");
    }
    if (!slackApp || slackApp === "xapp-...") {
      issues.push("SLACK_APP_TOKEN is a placeholder");
    }
  }

  // Require at least one transport
  if (!hasAnyTransport) {
    issues.push("No transport configured");
  }

  // Check config.json content if it exists
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<Config>;
      const hasGithubSync = config.github?.orgs && config.github.orgs.length > 0;
      const hasWildcardUser = Object.values(config.users || {}).some(u => u.repos?.includes("*"));
      if (!hasGithubSync && !hasWildcardUser && (!config.repos || Object.keys(config.repos).length === 0)) {
        issues.push("No repos configured");
      }
      if (!config.users || Object.keys(config.users).length === 0) {
        issues.push("No users configured");
      }
    } catch {
      issues.push("config.json is invalid JSON");
    }
  }

  return { valid: issues.length === 0, issues };
}

function loadEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  try {
    const content = readFileSync(envPath, "utf-8");
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

export async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  const answer = await rl.question(`  ${question}: `);
  return answer.trim();
}

export async function choose(rl: ReturnType<typeof createInterface>, question: string, options: string[]): Promise<number> {
  process.stdout.write(`\n  ${question}\n`);
  for (let i = 0; i < options.length; i++) {
    process.stdout.write(`    ${i + 1}. ${options[i]}\n`);
  }
  const answer = await rl.question("  > ");
  const choice = parseInt(answer.trim(), 10);
  if (isNaN(choice) || choice < 1 || choice > options.length) {
    return 0; // default to first option
  }
  return choice - 1;
}

export async function chooseMulti(rl: ReturnType<typeof createInterface>, question: string, options: string[]): Promise<number[]> {
  process.stdout.write(`\n  ${question} (comma-separated, e.g. 1,3,5)\n`);
  for (let i = 0; i < options.length; i++) {
    process.stdout.write(`    ${i + 1}. ${options[i]}\n`);
  }
  const answer = await rl.question("  > ");
  const indices: number[] = [];
  for (const part of answer.split(",")) {
    const n = parseInt(part.trim(), 10);
    if (!isNaN(n) && n >= 1 && n <= options.length) {
      indices.push(n - 1);
    }
  }
  return indices.length > 0 ? indices : [0];
}

const TRANSPORTS = ["Slack", "Telegram", "Discord", "WhatsApp", "HTTP API", "GitHub", "CLI"] as const;
type Transport = (typeof TRANSPORTS)[number];

export async function runSetup(opts?: { fixOnly?: string[] }): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const configPath = process.env.CONFIG_PATH || "./config.json";
    const envPath = "./.env";
    const fixing = opts?.fixOnly;

    // Load existing data when fixing
    let existingEnv: Record<string, string> = {};
    let existingConfig: Partial<Config> = {};
    if (fixing) {
      existingEnv = loadEnvFile(envPath);
      if (existsSync(configPath)) {
        try {
          existingConfig = JSON.parse(readFileSync(configPath, "utf-8"));
        } catch { /* will be overwritten */ }
      }
    }

    if (!fixing) {
      process.stdout.write("\n  Nåväl. Let's get this sorted.\n");
    }

    const needsTokens = !fixing || fixing.some(i =>
      i.includes("SLACK_BOT_TOKEN") || i.includes("SLACK_APP_TOKEN") || i.includes("No transport")
    );
    const needsRepos = !fixing || fixing.some(i => i.includes("No repos"));
    const needsUsers = !fixing || fixing.some(i => i.includes("No users"));
    const needsConfigFile = !fixing || fixing.some(i => i.includes("config.json not found"));
    const needsEnvFile = !fixing || fixing.some(i => i.includes(".env not found"));

    // Select transports
    let selected: Transport[] = [];

    if (!fixing) {
      const indices = await chooseMulti(rl, "Which transports?", [...TRANSPORTS]);
      selected = indices.map(i => TRANSPORTS[i]);
    } else {
      // When fixing, infer from what's needed
      if (needsTokens && fixing.some(i => i.includes("SLACK"))) {
        selected.push("Slack");
      }
      if (selected.length === 0) selected.push("CLI");
    }

    const has = (t: Transport) => selected.includes(t);

    // Collect env values
    const envValues: Record<string, string> = { ...existingEnv };

    if (has("Slack") && needsTokens) {
      process.stdout.write("\n");
      const botToken = await ask(rl, "Slack Bot Token (xoxb-...)");
      if (botToken) envValues.SLACK_BOT_TOKEN = botToken;
      const appToken = await ask(rl, "Slack App Token (xapp-...)");
      if (appToken) envValues.SLACK_APP_TOKEN = appToken;
    }

    if (has("Telegram") && needsTokens) {
      process.stdout.write("\n");
      const token = await ask(rl, "Telegram Bot Token (from BotFather)");
      if (token) envValues.TELEGRAM_BOT_TOKEN = token;
    }

    if (has("Discord") && needsTokens) {
      process.stdout.write("\n");
      const token = await ask(rl, "Discord Bot Token");
      if (token) envValues.DISCORD_BOT_TOKEN = token;
    }

    if (has("WhatsApp")) {
      envValues.WHATSAPP_ENABLED = "true";
    }

    if (has("HTTP API") && needsTokens) {
      process.stdout.write("\n");
      const port = (await ask(rl, "HTTP API port [3000]")) || "3000";
      envValues.HTTP_API_PORT = port;
      const host = await ask(rl, "Bind address [127.0.0.1] (0.0.0.0 for all interfaces)");
      envValues.HTTP_API_HOST = host || "127.0.0.1";
      const key = await ask(rl, "API key (leave empty to generate)");
      envValues.HTTP_API_KEY = key || crypto.randomUUID();
    }

    if (has("GitHub") && needsTokens) {
      process.stdout.write("\n");
      const repos = await ask(rl, "GitHub repos to poll (comma-separated owner/repo)");
      if (repos) envValues.GITHUB_POLL_REPOS = repos;
      const botName = (await ask(rl, "GitHub bot name [ove]")) || "ove";
      envValues.GITHUB_BOT_NAME = botName;
    }

    if (has("CLI")) {
      envValues.CLI_MODE = "true";
    }

    // Tracing
    if (!fixing) {
      process.stdout.write("\n");
      const enableTrace = await ask(rl, "Enable task tracing? (y/n)");
      if (enableTrace.toLowerCase() === "y") {
        envValues.OVE_TRACE = "true";
      }
    }

    // Collect repos — GitHub sync or manual
    const repos: Record<string, { url: string; defaultBranch: string }> = existingConfig.repos
      ? { ...existingConfig.repos }
      : {};
    let githubOrgs: string[] = existingConfig.github?.orgs || [];
    let useWildcard = false;

    if (needsRepos || needsConfigFile) {
      const repoMode = await choose(rl, "How do you want to manage repos?", [
        "Auto-discover from GitHub (uses gh CLI)",
        "Add repos manually",
        "Skip — add repos later via chat",
      ]);

      if (repoMode === 0) {
        // GitHub auto-discovery
        const orgs = await ask(rl, "GitHub orgs/users to sync (comma-separated, or empty for your repos)");
        githubOrgs = orgs ? orgs.split(",").map(s => s.trim()).filter(Boolean) : [];
        useWildcard = true;
        process.stdout.write("  Repos will sync from GitHub on startup.\n");
      } else if (repoMode === 1) {
        let addMore = true;
        while (addMore) {
          process.stdout.write("\n  Add a repo:\n");
          const name = await ask(rl, "Name");
          if (!name) break;
          const url = await ask(rl, "Git URL");
          const branch = (await ask(rl, "Default branch [main]")) || "main";
          repos[name] = { url, defaultBranch: branch };

          const again = await ask(rl, "Add another repo? (y/n)");
          addMore = again.toLowerCase() === "y";
        }
      } else {
        useWildcard = true;
        process.stdout.write("  You can add repos later: 'clone org/repo' in chat.\n");
      }
    }

    // Collect users
    const users: Record<string, { name: string; repos: string[] }> = existingConfig.users
      ? { ...existingConfig.users }
      : {};
    const repoNames = useWildcard ? ["*"] : Object.keys(repos);

    if (needsUsers || needsConfigFile) {
      // Ask for user name once
      let userName = "";
      const chatTransports = selected.filter(t => t !== "HTTP API" && t !== "GitHub" && t !== "CLI");
      if (chatTransports.length > 0 || has("GitHub")) {
        process.stdout.write("\n");
        userName = await ask(rl, "Your name");
      }

      if (has("Slack")) {
        const userId = await ask(rl, "Your Slack user ID (U...)");
        if (userId) users[`slack:${userId}`] = { name: userName || "user", repos: repoNames };
      }
      if (has("Telegram")) {
        const userId = await ask(rl, "Your Telegram user ID (send /start to @userinfobot to find it)");
        if (userId) users[`telegram:${userId}`] = { name: userName || "user", repos: repoNames };
      }
      if (has("Discord")) {
        const userId = await ask(rl, "Your Discord user ID");
        if (userId) users[`discord:${userId}`] = { name: userName || "user", repos: repoNames };
      }
      if (has("WhatsApp")) {
        const phone = await ask(rl, "Your phone number (with country code)");
        if (phone) users[`whatsapp:${phone}`] = { name: userName || "user", repos: repoNames };
      }
      if (has("HTTP API")) {
        users["http:anon"] = { name: "http", repos: repoNames };
      }
      if (has("GitHub")) {
        const ghUser = await ask(rl, "Your GitHub username");
        if (ghUser) users[`github:${ghUser}`] = { name: userName || ghUser, repos: repoNames };
      }
      if (has("CLI")) {
        users["cli:local"] = { name: userName || "local", repos: repoNames };
      }
    }

    // Write .env
    if (needsEnvFile || needsTokens || !fixing) {
      const envLines: string[] = [];

      // Slack
      if (has("Slack")) {
        envLines.push("# Slack (Socket Mode)");
        envLines.push(`SLACK_BOT_TOKEN=${envValues.SLACK_BOT_TOKEN || "xoxb-..."}`);
        envLines.push(`SLACK_APP_TOKEN=${envValues.SLACK_APP_TOKEN || "xapp-..."}`);
        envLines.push("");
      }

      // Telegram
      if (has("Telegram")) {
        envLines.push("# Telegram");
        envLines.push(`TELEGRAM_BOT_TOKEN=${envValues.TELEGRAM_BOT_TOKEN || ""}`);
        envLines.push("");
      }

      // Discord
      if (has("Discord")) {
        envLines.push("# Discord");
        envLines.push(`DISCORD_BOT_TOKEN=${envValues.DISCORD_BOT_TOKEN || ""}`);
        envLines.push("");
      }

      // WhatsApp
      if (has("WhatsApp")) {
        envLines.push("# WhatsApp");
        envLines.push(`WHATSAPP_ENABLED=true`);
        envLines.push("");
      }

      // HTTP API
      if (has("HTTP API")) {
        envLines.push("# HTTP API + Web UI");
        envLines.push(`HTTP_API_PORT=${envValues.HTTP_API_PORT || "3000"}`);
        envLines.push(`HTTP_API_HOST=${envValues.HTTP_API_HOST || "127.0.0.1"}`);
        envLines.push(`HTTP_API_KEY=${envValues.HTTP_API_KEY || ""}`);
        envLines.push("");
      }

      // GitHub
      if (has("GitHub")) {
        envLines.push("# GitHub");
        envLines.push(`GITHUB_POLL_REPOS=${envValues.GITHUB_POLL_REPOS || ""}`);
        envLines.push(`GITHUB_BOT_NAME=${envValues.GITHUB_BOT_NAME || "ove"}`);
        envLines.push("");
      }

      // CLI
      if (has("CLI")) {
        envLines.push("# CLI mode");
        envLines.push("CLI_MODE=true");
        envLines.push("");
      }

      // Tracing
      if (envValues.OVE_TRACE) {
        envLines.push("# Tracing");
        envLines.push(`OVE_TRACE=${envValues.OVE_TRACE}`);
        envLines.push("");
      }

      // Always include repos dir
      envLines.push("# Repos directory");
      envLines.push(`REPOS_DIR=${envValues.REPOS_DIR || "./repos"}`);
      envLines.push("");

      writeFileSync(envPath, envLines.join("\n") + "\n");
      process.stdout.write("\n  Wrote .env\n");
    }

    // Write config.json
    if (needsConfigFile || needsRepos || needsUsers || !fixing) {
      const config = {
        repos,
        users,
        claude: existingConfig.claude || { maxTurns: 25 },
        ...(githubOrgs.length > 0 ? { github: { orgs: githubOrgs } } : existingConfig.github ? { github: existingConfig.github } : {}),
        ...(existingConfig.mcpServers ? { mcpServers: existingConfig.mcpServers } : {}),
        ...(existingConfig.cron ? { cron: existingConfig.cron } : {}),
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      process.stdout.write("  Wrote config.json\n");
    }

    // Systemd service setup
    let installedSystemd = false;
    if (!fixing) {
      const installService = await ask(rl, "Install as systemd service? (y/n)");
      if (installService.toLowerCase() === "y") {
        installedSystemd = await installSystemdService(rl);
      }
    }

    if (!fixing) {
      process.stdout.write("\n  Nåväl.\n");
      if (installedSystemd) {
        process.stdout.write("\n  Useful commands:\n");
        process.stdout.write("    sudo systemctl status ove     # check status\n");
        process.stdout.write("    sudo journalctl -u ove -f     # follow logs\n");
        process.stdout.write("    sudo systemctl restart ove    # restart\n");
        process.stdout.write("    sudo systemctl stop ove       # stop\n");
        if (has("HTTP API")) {
          const port = envValues.HTTP_API_PORT || "3000";
          const host = envValues.HTTP_API_HOST || "127.0.0.1";
          const displayHost = host === "0.0.0.0" ? "<your-ip>" : host;
          process.stdout.write(`\n  Web UI: http://${displayHost}:${port}\n`);
          if (envValues.OVE_TRACE === "true") {
            process.stdout.write(`  Traces: http://${displayHost}:${port}/trace\n`);
          }
          if (host === "0.0.0.0") {
            process.stdout.write("  (bound to all interfaces)\n");
          }
        }
        process.stdout.write("\n");
      } else {
        process.stdout.write("  Run 'ove start' when you're ready.\n\n");
      }
    } else {
      process.stdout.write("\n");
    }
  } finally {
    rl.close();
  }
}

async function installSystemdService(rl: ReturnType<typeof createInterface>): Promise<boolean> {
  const detectedUser = userInfo().username;
  const detectedDir = resolve(".");
  let detectedBun = "";
  try {
    detectedBun = execFileSync("which", ["bun"]).toString().trim();
  } catch {
    // bun not in PATH
  }

  const user = (await ask(rl, `User [${detectedUser}]`)) || detectedUser;
  const workDir = (await ask(rl, `Working directory [${detectedDir}]`)) || detectedDir;
  const bunPath = (await ask(rl, `Bun path [${detectedBun}]`)) || detectedBun;

  if (!bunPath) {
    process.stdout.write("  Could not find bun. Skipping service install.\n");
    return false;
  }

  const envPath = resolve(workDir, ".env");

  // Build PATH that includes dirs for bun, claude, and gh
  const pathDirs = new Set<string>();
  for (const bin of [bunPath, "claude", "gh"]) {
    let resolved = "";
    try { resolved = execFileSync("which", [bin]).toString().trim(); } catch {}
    if (resolved) pathDirs.add(dirname(resolved));
  }
  // Always include standard dirs
  for (const d of ["/usr/local/bin", "/usr/bin", "/bin"]) pathDirs.add(d);
  const pathLine = Array.from(pathDirs).join(":");

  const service = `[Unit]
Description=Ove - Personal AI coding assistant
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${workDir}
ExecStart=${bunPath} run src/index.ts
Restart=always
RestartSec=5
EnvironmentFile=${envPath}
Environment=PATH=${pathLine}

[Install]
WantedBy=multi-user.target
`;

  const servicePath = resolve(workDir, "ove.service");
  writeFileSync(servicePath, service);
  process.stdout.write(`  Wrote ${servicePath}\n`);

  const install = await ask(rl, "Install and enable now? Requires sudo (y/n)");
  if (install.toLowerCase() === "y") {
    try {
      execFileSync("sudo", ["cp", servicePath, "/etc/systemd/system/ove.service"]);
      execFileSync("sudo", ["systemctl", "daemon-reload"]);
      execFileSync("sudo", ["systemctl", "enable", "ove"]);
      process.stdout.write("  Service installed and enabled.\n");

      const startNow = await ask(rl, "Start service now? (y/n)");
      if (startNow.toLowerCase() === "y") {
        execFileSync("sudo", ["systemctl", "start", "ove"]);
        process.stdout.write("  Service started.\n");
      }
      return true;
    } catch (err) {
      process.stdout.write(`  Failed to install service: ${err}\n`);
    }
  }
  return false;
}
