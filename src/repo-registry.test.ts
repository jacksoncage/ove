import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { RepoRegistry, parseGhRepoLine } from "./repo-registry";

describe("RepoRegistry", () => {
  let db: Database;
  let registry: RepoRegistry;

  beforeEach(() => {
    db = new Database(":memory:");
    registry = new RepoRegistry(db);
  });

  it("creates repos table on construction", () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='repos'").all();
    expect(tables.length).toBe(1);
  });

  it("upserts and retrieves a repo", () => {
    registry.upsert({
      name: "my-app",
      url: "git@github.com:user/my-app.git",
      owner: "user",
      defaultBranch: "main",
      source: "github-sync",
    });
    const repo = registry.getByName("my-app");
    expect(repo).not.toBeNull();
    expect(repo!.url).toBe("git@github.com:user/my-app.git");
    expect(repo!.source).toBe("github-sync");
  });

  it("upsert updates existing repo", () => {
    registry.upsert({ name: "my-app", url: "old-url", source: "config" });
    registry.upsert({ name: "my-app", url: "new-url", source: "github-sync" });
    const repo = registry.getByName("my-app");
    expect(repo!.url).toBe("new-url");
  });

  it("returns null for unknown repo", () => {
    expect(registry.getByName("nope")).toBeNull();
  });

  it("lists all non-excluded repos", () => {
    registry.upsert({ name: "a", url: "u1", source: "github-sync" });
    registry.upsert({ name: "b", url: "u2", source: "github-sync" });
    registry.upsert({ name: "c", url: "u3", source: "github-sync", excluded: true });
    const all = registry.getAll();
    expect(all.length).toBe(2);
    expect(all.map(r => r.name).sort()).toEqual(["a", "b"]);
  });

  it("lists all repo names", () => {
    registry.upsert({ name: "x", url: "u1", source: "config" });
    registry.upsert({ name: "y", url: "u2", source: "github-sync" });
    const names = registry.getAllNames();
    expect(names.sort()).toEqual(["x", "y"]);
  });

  it("excludes a repo", () => {
    registry.upsert({ name: "old", url: "u", source: "github-sync" });
    registry.setExcluded("old", true);
    expect(registry.getAll().length).toBe(0);
    expect(registry.getByName("old")!.excluded).toBe(true);
  });

  it("migrates config repos", () => {
    const configRepos = {
      "my-app": { url: "git@github.com:user/my-app.git", defaultBranch: "main" },
      "infra": { url: "git@github.com:user/infra.git", defaultBranch: "develop" },
    };
    registry.migrateFromConfig(configRepos);
    expect(registry.getAll().length).toBe(2);
    const infra = registry.getByName("infra");
    expect(infra!.defaultBranch).toBe("develop");
    expect(infra!.source).toBe("config");
  });

  it("migration does not overwrite github-sync repos", () => {
    registry.upsert({ name: "my-app", url: "gh-url", source: "github-sync", defaultBranch: "main" });
    registry.migrateFromConfig({
      "my-app": { url: "config-url", defaultBranch: "main" },
    });
    expect(registry.getByName("my-app")!.url).toBe("gh-url");
  });
});

describe("parseGhRepoLine", () => {
  it("parses standard gh repo list output", () => {
    const result = parseGhRepoLine("jacksoncage/ove\tMy app\tpublic\t2026-02-20T10:00:00Z");
    expect(result).toEqual({ name: "ove", owner: "jacksoncage", fullName: "jacksoncage/ove" });
  });

  it("parses line with no description", () => {
    const result = parseGhRepoLine("org/repo-name\t\tprivate\t2026-01-01T00:00:00Z");
    expect(result).toEqual({ name: "repo-name", owner: "org", fullName: "org/repo-name" });
  });

  it("returns null for empty line", () => {
    expect(parseGhRepoLine("")).toBeNull();
  });

  it("returns null for line without slash", () => {
    expect(parseGhRepoLine("no-slash-here")).toBeNull();
  });
});

describe("config + registry integration", () => {
  it("config repos + registry merge correctly", () => {
    const db = new Database(":memory:");
    const registry = new RepoRegistry(db);

    // Simulate GitHub sync adding repos
    registry.upsert({ name: "api", url: "git@github.com:org/api.git", owner: "org", source: "github-sync" });
    registry.upsert({ name: "web", url: "git@github.com:org/web.git", owner: "org", source: "github-sync" });

    // Simulate config migration (manual repo)
    registry.migrateFromConfig({
      "legacy": { url: "git@github.com:me/legacy.git", defaultBranch: "develop" },
    });

    // All three repos exist
    expect(registry.getAllNames().sort()).toEqual(["api", "legacy", "web"]);

    // Excluding a repo hides it from getAll but not getByName
    registry.setExcluded("legacy", true);
    expect(registry.getAllNames().sort()).toEqual(["api", "web"]);
    expect(registry.getByName("legacy")).not.toBeNull();
  });
});
