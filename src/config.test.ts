import { describe, it, expect } from "bun:test";
import { loadConfig, isAuthorized, getUserRepos } from "./config";

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
});
