import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDiagnostics, type DiagnosticDeps } from "./setup";
import type { Config } from "./config";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repos: {},
    users: { "cli:local": { name: "local", repos: ["*"] } },
    claude: { maxTurns: 25 },
    reposDir: "./repos",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DiagnosticDeps> = {}): DiagnosticDeps {
  return {
    which: () => null,
    fetch: (() => Promise.reject(new Error("no network"))) as any,
    spawn: (() => ({
      exited: Promise.resolve(1),
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
    })) as any,
    accessSync: () => {},
    existsSync: () => false,
    ...overrides,
  };
}

const ENV_KEYS = [
  "SLACK_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN",
  "GITHUB_POLL_REPOS",
] as const;

describe("runDiagnostics", () => {
  let dir: string;
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ove-diag-test-"));
    for (const key of ENV_KEYS) {
      origEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (origEnv[key] !== undefined) process.env[key] = origEnv[key];
      else delete process.env[key];
    }
  });

  it("passes when git is found", async () => {
    const deps = makeDeps({
      which: (cmd: string) => cmd === "git" ? "/usr/bin/git" : null,
      spawn: ((args: string[]) => {
        if (args[0] === "git") {
          return {
            exited: Promise.resolve(0),
            stdout: new ReadableStream({
              start(c) { c.enqueue(new TextEncoder().encode("git version 2.43.0\n")); c.close(); },
            }),
            stderr: new ReadableStream({ start(c) { c.close(); } }),
          };
        }
        return {
          exited: Promise.resolve(1),
          stdout: new ReadableStream({ start(c) { c.close(); } }),
          stderr: new ReadableStream({ start(c) { c.close(); } }),
        };
      }) as any,
    });

    const results = await runDiagnostics(makeConfig(), deps);
    const git = results.find(r => r.name === "git");
    expect(git?.status).toBe("pass");
    expect(git?.message).toContain("2.43.0");
  });

  it("fails when git is not found", async () => {
    const deps = makeDeps({ which: () => null });
    const results = await runDiagnostics(makeConfig(), deps);
    const git = results.find(r => r.name === "git");
    expect(git?.status).toBe("fail");
    expect(git?.message).toContain("not found");
  });

  it("passes when claude CLI is found (default runner)", async () => {
    const deps = makeDeps({
      which: (cmd: string) => cmd === "claude" ? "/usr/local/bin/claude" : null,
    });
    const results = await runDiagnostics(makeConfig(), deps);
    const claude = results.find(r => r.name === "claude");
    expect(claude?.status).toBe("pass");
    expect(claude?.message).toContain("claude CLI installed");
  });

  it("fails when claude CLI is not found", async () => {
    const deps = makeDeps({ which: () => null });
    const results = await runDiagnostics(makeConfig(), deps);
    const claude = results.find(r => r.name === "claude");
    expect(claude?.status).toBe("fail");
    expect(claude?.message).toContain("claude CLI not found");
  });

  it("checks codex CLI when runner is codex", async () => {
    const deps = makeDeps({
      which: (cmd: string) => cmd === "codex" ? "/usr/local/bin/codex" : null,
    });
    const config = makeConfig({ runner: { name: "codex" } });
    const results = await runDiagnostics(config, deps);
    const codex = results.find(r => r.name === "codex");
    expect(codex?.status).toBe("pass");
    expect(codex?.message).toContain("codex CLI installed");
  });

  it("warns when gh CLI is missing but GitHub sync is configured", async () => {
    const deps = makeDeps({ which: () => null });
    const config = makeConfig({ github: { orgs: ["myorg"] } });
    const results = await runDiagnostics(config, deps);
    const gh = results.find(r => r.name === "gh");
    expect(gh?.status).toBe("warn");
    expect(gh?.message).toContain("gh CLI not found");
  });

  it("passes when gh CLI is found and GitHub sync is configured", async () => {
    const deps = makeDeps({
      which: (cmd: string) => cmd === "gh" ? "/usr/bin/gh" : null,
    });
    const config = makeConfig({ github: { orgs: ["myorg"] } });
    const results = await runDiagnostics(config, deps);
    const gh = results.find(r => r.name === "gh");
    expect(gh?.status).toBe("pass");
  });

  it("skips gh check when no GitHub sync configured", async () => {
    const deps = makeDeps({ which: () => null });
    const results = await runDiagnostics(makeConfig(), deps);
    const gh = results.find(r => r.name === "gh");
    expect(gh).toBeUndefined();
  });

  it("passes when REPOS_DIR exists and is writable", async () => {
    const reposDir = join(dir, "repos");
    mkdirSync(reposDir);
    const deps = makeDeps({
      existsSync: (p: string) => p === reposDir,
      accessSync: () => {},
    });
    const config = makeConfig({ reposDir });
    const results = await runDiagnostics(config, deps);
    const rd = results.find(r => r.name === "repos_dir");
    expect(rd?.status).toBe("pass");
    expect(rd?.message).toContain("writable");
  });

  it("fails when REPOS_DIR does not exist", async () => {
    const deps = makeDeps({ existsSync: () => false });
    const config = makeConfig({ reposDir: "./nonexistent" });
    const results = await runDiagnostics(config, deps);
    const rd = results.find(r => r.name === "repos_dir");
    expect(rd?.status).toBe("fail");
    expect(rd?.message).toContain("does not exist");
  });

  it("fails when REPOS_DIR exists but is not writable", async () => {
    const deps = makeDeps({
      existsSync: () => true,
      accessSync: () => { throw new Error("EACCES"); },
    });
    const config = makeConfig({ reposDir: "/read-only" });
    const results = await runDiagnostics(config, deps);
    const rd = results.find(r => r.name === "repos_dir");
    expect(rd?.status).toBe("fail");
    expect(rd?.message).toContain("not writable");
  });

  it("passes SSH check when github returns exit 1 with success message", async () => {
    const deps = makeDeps({
      spawn: ((args: string[]) => {
        if (args[0] === "ssh") {
          return {
            exited: Promise.resolve(1),
            stdout: new ReadableStream({ start(c) { c.close(); } }),
            stderr: new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("Hi user! You've successfully authenticated, but GitHub does not provide shell access.\n"));
                c.close();
              },
            }),
          };
        }
        return {
          exited: Promise.resolve(1),
          stdout: new ReadableStream({ start(c) { c.close(); } }),
          stderr: new ReadableStream({ start(c) { c.close(); } }),
        };
      }) as any,
    });
    const results = await runDiagnostics(makeConfig(), deps);
    const ssh = results.find(r => r.name === "ssh");
    expect(ssh?.status).toBe("pass");
    expect(ssh?.message).toContain("SSH access to github.com");
  });

  it("warns when SSH check fails", async () => {
    const deps = makeDeps({
      spawn: ((args: string[]) => ({
        exited: Promise.resolve(255),
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("Permission denied (publickey).\n"));
            c.close();
          },
        }),
      })) as any,
    });
    const results = await runDiagnostics(makeConfig(), deps);
    const ssh = results.find(r => r.name === "ssh");
    expect(ssh?.status).toBe("warn");
  });

  it("passes Slack token check when API returns ok", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-valid-token";
    const deps = makeDeps({
      fetch: (async (url: string) => {
        if (url === "https://slack.com/api/auth.test") {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error("unexpected fetch");
      }) as any,
    });
    const results = await runDiagnostics(makeConfig(), deps);
    const slack = results.find(r => r.name === "slack");
    expect(slack?.status).toBe("pass");
    expect(slack?.message).toContain("valid");
  });

  it("fails Slack token check when API returns not ok", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-invalid";
    const deps = makeDeps({
      fetch: (async (url: string) => {
        if (url === "https://slack.com/api/auth.test") {
          return new Response(JSON.stringify({ ok: false }), { status: 200 });
        }
        throw new Error("unexpected fetch");
      }) as any,
    });
    const results = await runDiagnostics(makeConfig(), deps);
    const slack = results.find(r => r.name === "slack");
    expect(slack?.status).toBe("fail");
    expect(slack?.message).toContain("invalid");
  });

  it("warns on Slack network error", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-valid-token";
    const deps = makeDeps({
      fetch: (() => Promise.reject(new Error("network error"))) as any,
    });
    const results = await runDiagnostics(makeConfig(), deps);
    const slack = results.find(r => r.name === "slack");
    expect(slack?.status).toBe("warn");
    expect(slack?.message).toContain("network error");
  });

  it("skips Slack check when no token set", async () => {
    const deps = makeDeps();
    const results = await runDiagnostics(makeConfig(), deps);
    const slack = results.find(r => r.name === "slack");
    expect(slack).toBeUndefined();
  });

  it("passes Telegram token check when API returns ok", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-DEF";
    const deps = makeDeps({
      fetch: (async (url: string) => {
        if (url.includes("api.telegram.org")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error("unexpected fetch");
      }) as any,
    });
    const results = await runDiagnostics(makeConfig(), deps);
    const tg = results.find(r => r.name === "telegram");
    expect(tg?.status).toBe("pass");
  });

  it("fails Telegram token check when API returns not ok", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bad-token";
    const deps = makeDeps({
      fetch: (async (url: string) => {
        if (url.includes("api.telegram.org")) {
          return new Response(JSON.stringify({ ok: false }), { status: 200 });
        }
        throw new Error("unexpected fetch");
      }) as any,
    });
    const results = await runDiagnostics(makeConfig(), deps);
    const tg = results.find(r => r.name === "telegram");
    expect(tg?.status).toBe("fail");
  });

  it("passes Discord token check when API returns 200", async () => {
    process.env.DISCORD_BOT_TOKEN = "valid-discord-token";
    const deps = makeDeps({
      fetch: (async (url: string) => {
        if (url.includes("discord.com")) {
          return new Response(JSON.stringify({ id: "123" }), { status: 200 });
        }
        throw new Error("unexpected fetch");
      }) as any,
    });
    const results = await runDiagnostics(makeConfig(), deps);
    const dc = results.find(r => r.name === "discord");
    expect(dc?.status).toBe("pass");
  });

  it("fails Discord token check when API returns 401", async () => {
    process.env.DISCORD_BOT_TOKEN = "invalid-discord-token";
    const deps = makeDeps({
      fetch: (async (url: string) => {
        if (url.includes("discord.com")) {
          return new Response(JSON.stringify({ message: "401: Unauthorized" }), { status: 401 });
        }
        throw new Error("unexpected fetch");
      }) as any,
    });
    const results = await runDiagnostics(makeConfig(), deps);
    const dc = results.find(r => r.name === "discord");
    expect(dc?.status).toBe("fail");
  });

  it("warns on Discord network error", async () => {
    process.env.DISCORD_BOT_TOKEN = "valid-discord-token";
    const deps = makeDeps({
      fetch: (() => Promise.reject(new Error("timeout"))) as any,
    });
    const results = await runDiagnostics(makeConfig(), deps);
    const dc = results.find(r => r.name === "discord");
    expect(dc?.status).toBe("warn");
    expect(dc?.message).toContain("network error");
  });

  it("warns when gh CLI missing with GITHUB_POLL_REPOS env var", async () => {
    process.env.GITHUB_POLL_REPOS = "owner/repo";
    const deps = makeDeps({ which: () => null });
    const results = await runDiagnostics(makeConfig(), deps);
    const gh = results.find(r => r.name === "gh");
    expect(gh?.status).toBe("warn");
  });

  it("always checks git, runner, ssh, and repos_dir", async () => {
    const deps = makeDeps();
    const results = await runDiagnostics(makeConfig(), deps);
    const names = results.map(r => r.name);
    expect(names).toContain("git");
    expect(names).toContain("claude");
    expect(names).toContain("ssh");
    expect(names).toContain("repos_dir");
  });

  it("skips placeholder Slack tokens", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-...";
    const deps = makeDeps();
    const results = await runDiagnostics(makeConfig(), deps);
    const slack = results.find(r => r.name === "slack");
    expect(slack).toBeUndefined();
  });
});
