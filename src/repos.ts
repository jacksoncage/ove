import { join, resolve } from "node:path";
import { logger } from "./logger";

export class RepoManager {
  constructor(private reposDir: string) {}

  repoPath(repoName: string): string {
    return resolve(this.reposDir, repoName);
  }

  worktreePath(repoName: string, taskId: string): string {
    return resolve(this.reposDir, ".worktrees", `${repoName}-${taskId}`);
  }

  async cloneIfNeeded(repoName: string, url: string): Promise<void> {
    const path = this.repoPath(repoName);
    const exists = await Bun.file(join(path, ".git/HEAD")).exists();
    if (exists) {
      logger.debug("repo already cloned", { repo: repoName });
      return;
    }
    logger.info("cloning repo", { repo: repoName, url });
    const proc = Bun.spawn(["git", "clone", url, path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git clone failed: ${stderr}`);
    }
  }

  async pull(repoName: string, branch: string = "main"): Promise<void> {
    const path = this.repoPath(repoName);
    logger.info("pulling latest", { repo: repoName, branch });
    const proc = Bun.spawn(["git", "pull", "origin", branch], {
      cwd: path,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      logger.warn("git pull failed", { repo: repoName, error: stderr });
    }
  }

  async createWorktree(repoName: string, taskId: string, baseBranch: string = "main"): Promise<string> {
    const repoDir = this.repoPath(repoName);
    const wtPath = this.worktreePath(repoName, taskId);
    const branchName = `agent/${taskId}`;

    logger.info("creating worktree", { repo: repoName, taskId, path: wtPath });

    const proc = Bun.spawn(
      ["git", "worktree", "add", "-b", branchName, wtPath, baseBranch],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git worktree add failed: ${stderr}`);
    }

    return wtPath;
  }

  async removeWorktree(repoName: string, taskId: string): Promise<void> {
    const repoDir = this.repoPath(repoName);
    const wtPath = this.worktreePath(repoName, taskId);

    logger.info("removing worktree", { repo: repoName, taskId });

    const proc = Bun.spawn(
      ["git", "worktree", "remove", wtPath, "--force"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    await proc.exited;
  }
}
