import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { RepoManager } from "./repos";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("RepoManager", () => {
  let tmpDir: string;
  let manager: RepoManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ove-test-"));
    manager = new RepoManager(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a worktree path that includes task ID", () => {
    const path = manager.worktreePath("my-app", "abc-123");
    expect(path).toContain("my-app");
    expect(path).toContain("abc-123");
  });

  it("generates unique worktree paths", () => {
    const path1 = manager.worktreePath("my-app", "task-1");
    const path2 = manager.worktreePath("my-app", "task-2");
    expect(path1).not.toBe(path2);
  });
});
