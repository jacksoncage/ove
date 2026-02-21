import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "./setup";

const TRANSPORT_ENV_KEYS = [
  "CLI_MODE", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN",
  "TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "WHATSAPP_ENABLED",
  "HTTP_API_PORT", "HTTP_API_KEY", "GITHUB_POLL_REPOS",
] as const;

describe("validateConfig", () => {
  let dir: string;
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ove-setup-test-"));
    for (const key of TRANSPORT_ENV_KEYS) {
      origEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of TRANSPORT_ENV_KEYS) {
      if (origEnv[key] !== undefined) process.env[key] = origEnv[key];
      else delete process.env[key];
    }
  });

  it("reports missing config.json", () => {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "CLI_MODE=true\n");

    const result = validateConfig({
      configPath: join(dir, "config.json"),
      envPath,
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("config.json not found");
  });

  it("reports missing .env when no env vars set", () => {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: { "slack:U123": { name: "test", repos: ["app"] } },
    }));

    const result = validateConfig({
      configPath,
      envPath: join(dir, ".env"),
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain(".env not found");
  });

  it("skips .env check when env vars already set", () => {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: { "slack:U123": { name: "test", repos: ["app"] } },
    }));

    process.env.SLACK_BOT_TOKEN = "xoxb-real-token";
    process.env.SLACK_APP_TOKEN = "xapp-real-token";
    const result = validateConfig({
      configPath,
      envPath: join(dir, ".env"),
    });

    expect(result.issues).not.toContain(".env not found");
  });

  it("reports placeholder SLACK_BOT_TOKEN", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: { "slack:U123": { name: "test", repos: ["app"] } },
    }));
    writeFileSync(envPath, "SLACK_BOT_TOKEN=xoxb-...\nSLACK_APP_TOKEN=xapp-real-token\n");

    const result = validateConfig({ configPath, envPath });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("SLACK_BOT_TOKEN is a placeholder");
  });

  it("reports placeholder SLACK_APP_TOKEN", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: { "slack:U123": { name: "test", repos: ["app"] } },
    }));
    writeFileSync(envPath, "SLACK_BOT_TOKEN=xoxb-real-token\nSLACK_APP_TOKEN=xapp-...\n");

    const result = validateConfig({ configPath, envPath });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("SLACK_APP_TOKEN is a placeholder");
  });

  it("skips Slack validation when no Slack tokens present", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: { "cli:local": { name: "test", repos: ["app"] } },
    }));
    writeFileSync(envPath, "CLI_MODE=true\n");

    const result = validateConfig({ configPath, envPath });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("still validates Slack placeholders even in CLI_MODE", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: { "cli:local": { name: "test", repos: ["app"] } },
    }));
    writeFileSync(envPath, "CLI_MODE=true\nSLACK_BOT_TOKEN=xoxb-...\n");

    const result = validateConfig({ configPath, envPath });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("SLACK_BOT_TOKEN is a placeholder");
  });

  it("reports no transport configured", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: { "cli:local": { name: "test", repos: ["app"] } },
    }));
    writeFileSync(envPath, "REPOS_DIR=./repos\n");

    const result = validateConfig({ configPath, envPath });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("No transport configured");
  });

  it("valid with Telegram-only config", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: { "telegram:123456": { name: "test", repos: ["app"] } },
    }));
    writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=123456:ABC-DEF\n");

    const result = validateConfig({ configPath, envPath });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("valid with Discord-only config", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: { "discord:987654": { name: "test", repos: ["app"] } },
    }));
    writeFileSync(envPath, "DISCORD_BOT_TOKEN=MTIz-abc\n");

    const result = validateConfig({ configPath, envPath });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("valid with multiple transports", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: {
        "slack:U123": { name: "test", repos: ["app"] },
        "telegram:456": { name: "test", repos: ["app"] },
      },
    }));
    writeFileSync(envPath, [
      "SLACK_BOT_TOKEN=xoxb-real-token",
      "SLACK_APP_TOKEN=xapp-real-token",
      "TELEGRAM_BOT_TOKEN=123:ABC",
    ].join("\n") + "\n");

    const result = validateConfig({ configPath, envPath });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("reports empty repos", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({
      repos: {},
      users: { "cli:local": { name: "test", repos: [] } },
    }));
    writeFileSync(envPath, "CLI_MODE=true\n");

    const result = validateConfig({ configPath, envPath });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("No repos configured");
  });

  it("reports empty users", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: {},
    }));
    writeFileSync(envPath, "CLI_MODE=true\n");

    const result = validateConfig({ configPath, envPath });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("No users configured");
  });

  it("reports invalid JSON in config.json", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, "not json{");
    writeFileSync(envPath, "CLI_MODE=true\n");

    const result = validateConfig({ configPath, envPath });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("config.json is invalid JSON");
  });

  it("returns valid for complete Slack config", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: { "slack:U123": { name: "test", repos: ["app"] } },
    }));
    writeFileSync(envPath, "SLACK_BOT_TOKEN=xoxb-real-token-123\nSLACK_APP_TOKEN=xapp-real-token-456\n");

    const result = validateConfig({ configPath, envPath });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });
});
