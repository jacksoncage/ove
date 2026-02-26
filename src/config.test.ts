import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, isAuthorized, getUserRepos, saveConfig, addRepo, addUser } from "./config";
import type { Config } from "./config";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repos: {},
    users: {},
    claude: { maxTurns: 25 },
    reposDir: "./repos",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("returns config with repos and users", () => {
    const config = loadConfig();
    expect(config.repos).toBeDefined();
    expect(config.users).toBeDefined();
    expect(config.claude).toBeDefined();
    expect(config.claude.maxTurns).toBeGreaterThan(0);
  });

});

describe("isAuthorized", () => {
  it("returns false for unknown users", () => {
    const config = loadConfig();
    expect(isAuthorized(config, "unknown:user")).toBe(false);
  });

  it("returns true for known user without repo check", () => {
    const config = loadConfig();
    config.users["slack:U123"] = { name: "test", repos: ["my-app"] };
    expect(isAuthorized(config, "slack:U123")).toBe(true);
  });

  it("returns true for user with access to repo", () => {
    const config = loadConfig();
    config.users["slack:U123"] = { name: "test", repos: ["my-app"] };
    expect(isAuthorized(config, "slack:U123", "my-app")).toBe(true);
  });

  it("returns false for user without access to repo", () => {
    const config = loadConfig();
    config.users["slack:U123"] = { name: "test", repos: ["my-app"] };
    expect(isAuthorized(config, "slack:U123", "other-repo")).toBe(false);
  });
});

describe("getUserRepos", () => {
  it("returns empty for unknown user", () => {
    const config = loadConfig();
    expect(getUserRepos(config, "unknown:user")).toEqual([]);
  });

  it("returns repos for known user", () => {
    const config = loadConfig();
    config.users["slack:U123"] = { name: "test", repos: ["a", "b"] };
    expect(getUserRepos(config, "slack:U123")).toEqual(["a", "b"]);
  });

  it("returns wildcard for known user with empty repos", () => {
    const config = loadConfig();
    config.users["slack:U123"] = { name: "test", repos: [] };
    expect(getUserRepos(config, "slack:U123")).toEqual(["*"]);
  });
});

describe("saveConfig / addRepo / addUser", () => {
  const testPath = "./test-config-tmp.json";
  const origEnv = process.env.CONFIG_PATH;

  beforeEach(() => {
    process.env.CONFIG_PATH = testPath;
    writeFileSync(testPath, JSON.stringify({ runner: "claude", repos: {}, users: {} }));
  });

  afterEach(() => {
    process.env.CONFIG_PATH = origEnv;
    try { unlinkSync(testPath); } catch {}
  });

  it("saveConfig preserves extra fields from existing file", () => {
    const config = loadConfig();
    saveConfig(config);
    const written = JSON.parse(readFileSync(testPath, "utf-8"));
    expect(written.runner).toBe("claude");
  });

  it("addRepo adds a repo and persists to disk", () => {
    const config = loadConfig();
    addRepo(config, "my-app", "git@github.com:user/my-app.git", "develop");
    expect(config.repos["my-app"]).toEqual({ url: "git@github.com:user/my-app.git", defaultBranch: "develop" });
    const written = JSON.parse(readFileSync(testPath, "utf-8"));
    expect(written.repos["my-app"].url).toBe("git@github.com:user/my-app.git");
  });

  it("addRepo defaults branch to main", () => {
    const config = loadConfig();
    addRepo(config, "test", "https://github.com/u/test.git");
    expect(config.repos["test"].defaultBranch).toBe("main");
  });

  it("addUser creates a new user", () => {
    const config = loadConfig();
    addUser(config, "slack:U1", "Alice", ["my-app"]);
    expect(config.users["slack:U1"]).toEqual({ name: "Alice", repos: ["my-app"] });
  });

  it("addUser merges repos for existing user without dupes", () => {
    const config = loadConfig();
    addUser(config, "slack:U1", "Alice", ["a", "b"]);
    addUser(config, "slack:U1", "Alice", ["b", "c"]);
    expect(config.users["slack:U1"].repos).toEqual(["a", "b", "c"]);
  });
});

describe("wildcard auth", () => {
  it("grants access to any repo with wildcard", () => {
    const config = makeConfig({
      users: { "tg:123": { name: "love", repos: ["*"] } },
    });
    expect(isAuthorized(config, "tg:123", "any-repo")).toBe(true);
    expect(isAuthorized(config, "tg:123", "another-repo")).toBe(true);
  });

  it("still works with explicit repo list", () => {
    const config = makeConfig({
      users: { "tg:123": { name: "love", repos: ["my-app"] } },
    });
    expect(isAuthorized(config, "tg:123", "my-app")).toBe(true);
    expect(isAuthorized(config, "tg:123", "other")).toBe(false);
  });

  it("denies unknown user", () => {
    const config = makeConfig();
    expect(isAuthorized(config, "unknown", "repo")).toBe(false);
  });

  it("allows user without repo check", () => {
    const config = makeConfig({
      users: { "tg:123": { name: "love", repos: [] } },
    });
    expect(isAuthorized(config, "tg:123")).toBe(true);
  });
});

describe("getUserRepos with wildcard", () => {
  it("returns ['*'] when user has wildcard", () => {
    const config = makeConfig({
      users: { "tg:123": { name: "love", repos: ["*"] } },
    });
    expect(getUserRepos(config, "tg:123")).toEqual(["*"]);
  });

  it("returns empty for unknown user", () => {
    const config = makeConfig();
    expect(getUserRepos(config, "unknown")).toEqual([]);
  });
});

describe("github config type", () => {
  it("accepts github config on Config", () => {
    const config = makeConfig({
      github: { syncInterval: 60000, orgs: ["my-org"] },
    });
    expect(config.github!.syncInterval).toBe(60000);
    expect(config.github!.orgs).toEqual(["my-org"]);
  });

  it("github config is optional", () => {
    const config = makeConfig();
    expect(config.github).toBeUndefined();
  });
});
