---
name: ship
description: Create branch, commit changes, push, and open a PR
disable-model-invocation: true
argument-hint: "[description of changes]"
allowed-tools: Bash(git *), Bash(gh *)
---

Ship the current changes as a pull request.

## Steps

1. Run `git status` and `git diff --stat` to understand what changed
2. Create a descriptive branch name from the changes (e.g. `fix/sse-timeout`, `feat/sidebar-history`)
3. Stage relevant files (avoid secrets, lock files, local config)
4. Commit with a conventional commit message (feat/fix/refactor/docs/chore)
5. Push the branch with `git push -u origin <branch>`
6. Create a PR with `gh pr create` including:
   - Short title (under 70 chars)
   - Summary section with bullet points
   - Test plan section
7. Return the PR URL
