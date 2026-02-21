import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Config } from "./config";

interface ValidationResult {
  valid: boolean;
  issues: string[];
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
  const cliMode = process.env.CLI_MODE === "true" || env.CLI_MODE === "true";

  // Only warn about missing .env if env vars aren't already set
  // (in Docker, env_file loads vars into process.env without the file being at ./.env)
  const hasEnvVars = cliMode || (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
  if (!existsSync(envPath) && !hasEnvVars) {
    issues.push(".env not found");
  }

  if (!cliMode) {
    const botToken = process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN || "";
    if (!botToken || botToken === "xoxb-..." || botToken.startsWith("xoxb-...")) {
      issues.push("SLACK_BOT_TOKEN is a placeholder");
    }

    const appToken = process.env.SLACK_APP_TOKEN || env.SLACK_APP_TOKEN || "";
    if (!appToken || appToken === "xapp-..." || appToken.startsWith("xapp-...")) {
      issues.push("SLACK_APP_TOKEN is a placeholder");
    }
  }

  // Check config.json content if it exists
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<Config>;
      if (!config.repos || Object.keys(config.repos).length === 0) {
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

    // Determine adapter mode
    let useSlack = false;
    let useCli = false;

    const needsSlackTokens = !fixing || fixing.some(i =>
      i.includes("SLACK_BOT_TOKEN") || i.includes("SLACK_APP_TOKEN")
    );
    const needsRepos = !fixing || fixing.some(i => i.includes("No repos"));
    const needsUsers = !fixing || fixing.some(i => i.includes("No users"));
    const needsConfigFile = !fixing || fixing.some(i => i.includes("config.json not found"));
    const needsEnvFile = !fixing || fixing.some(i => i.includes(".env not found"));

    if (!fixing) {
      const mode = await choose(rl, "How will you talk to me?", ["Slack", "CLI only", "Both"]);
      useSlack = mode === 0 || mode === 2;
      useCli = mode === 1 || mode === 2;
    } else {
      // When fixing, infer mode from what's needed
      useSlack = needsSlackTokens;
      useCli = !useSlack;
    }

    // Collect env values
    const envValues: Record<string, string> = { ...existingEnv };

    if (useSlack && needsSlackTokens) {
      process.stdout.write("\n");
      const botToken = await ask(rl, "Slack Bot Token (xoxb-...)");
      if (botToken) envValues.SLACK_BOT_TOKEN = botToken;

      const appToken = await ask(rl, "Slack App Token (xapp-...)");
      if (appToken) envValues.SLACK_APP_TOKEN = appToken;
    }

    if (!fixing && useCli && !useSlack) {
      envValues.CLI_MODE = "true";
    }

    // Collect repos
    const repos: Record<string, { url: string; defaultBranch: string }> = existingConfig.repos
      ? { ...existingConfig.repos }
      : {};

    if (needsRepos || needsConfigFile) {
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
    }

    // Collect users
    const users: Record<string, { name: string; repos: string[] }> = existingConfig.users
      ? { ...existingConfig.users }
      : {};
    const repoNames = Object.keys(repos);

    if (needsUsers || needsConfigFile) {
      if (useSlack) {
        process.stdout.write("\n");
        const userId = await ask(rl, "Your Slack user ID (U...)");
        const name = await ask(rl, "Your name");
        if (userId && name) {
          users[`slack:${userId}`] = { name, repos: repoNames };
        }
      }

      if (useCli || !useSlack) {
        if (!fixing) {
          users["cli:local"] = { name: "local", repos: repoNames };
        } else {
          const name = await ask(rl, "Your name");
          users["cli:local"] = { name: name || "local", repos: repoNames };
        }
      }
    }

    // Write .env
    if (needsEnvFile || needsSlackTokens || !fixing) {
      const envLines: string[] = [
        "# Slack (Socket Mode)",
        `SLACK_BOT_TOKEN=${envValues.SLACK_BOT_TOKEN || "xoxb-..."}`,
        `SLACK_APP_TOKEN=${envValues.SLACK_APP_TOKEN || "xapp-..."}`,
        "",
        "# WhatsApp",
        `WHATSAPP_ENABLED=${envValues.WHATSAPP_ENABLED || "false"}`,
        "",
        "# CLI mode",
        ...(envValues.CLI_MODE ? [`CLI_MODE=${envValues.CLI_MODE}`] : ["# CLI_MODE=true"]),
        "",
        "# Repos directory",
        `REPOS_DIR=${envValues.REPOS_DIR || "./repos"}`,
        "",
      ];
      writeFileSync(envPath, envLines.join("\n") + "\n");
      process.stdout.write("\n  Wrote .env\n");
    }

    // Write config.json
    if (needsConfigFile || needsRepos || needsUsers || !fixing) {
      const config = {
        repos,
        users,
        claude: existingConfig.claude || { maxTurns: 25 },
        ...(existingConfig.mcpServers ? { mcpServers: existingConfig.mcpServers } : {}),
        ...(existingConfig.cron ? { cron: existingConfig.cron } : {}),
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      process.stdout.write("  Wrote config.json\n");
    }

    if (!fixing) {
      process.stdout.write("\n  Nåväl. Run 'ove start' when you're ready.\n\n");
    } else {
      process.stdout.write("\n");
    }
  } finally {
    rl.close();
  }
}
