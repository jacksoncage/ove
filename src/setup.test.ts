import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "./setup";

describe("validateConfig", () => {
  let dir: string;
  const origCliMode = process.env.CLI_MODE;
  const origSlackBot = process.env.SLACK_BOT_TOKEN;
  const origSlackApp = process.env.SLACK_APP_TOKEN;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ove-setup-test-"));
    // Clear env to avoid interference
    delete process.env.CLI_MODE;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    // Restore env
    if (origCliMode !== undefined) process.env.CLI_MODE = origCliMode;
    else delete process.env.CLI_MODE;
    if (origSlackBot !== undefined) process.env.SLACK_BOT_TOKEN = origSlackBot;
    else delete process.env.SLACK_BOT_TOKEN;
    if (origSlackApp !== undefined) process.env.SLACK_APP_TOKEN = origSlackApp;
    else delete process.env.SLACK_APP_TOKEN;
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

  it("skips Slack token checks when CLI_MODE=true in env file", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: { "cli:local": { name: "test", repos: ["app"] } },
    }));
    writeFileSync(envPath, "CLI_MODE=true\nSLACK_BOT_TOKEN=xoxb-...\n");

    const result = validateConfig({ configPath, envPath });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("skips Slack token checks when CLI_MODE=true in process.env", () => {
    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({
      repos: { app: { url: "git@github.com:o/a.git", defaultBranch: "main" } },
      users: { "cli:local": { name: "test", repos: ["app"] } },
    }));
    writeFileSync(envPath, "SLACK_BOT_TOKEN=xoxb-...\n");

    process.env.CLI_MODE = "true";
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

  it("returns valid for complete config", () => {
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
