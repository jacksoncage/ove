---
name: review-pr
description: Review a pull request with critical analysis and refactoring suggestions
disable-model-invocation: true
argument-hint: "[PR number or URL]"
allowed-tools: Bash(gh *), Read, Grep, Glob
---

Review the pull request specified by $ARGUMENTS.

## Steps

1. Fetch PR details: `gh pr view $ARGUMENTS --json title,body,additions,deletions,changedFiles,baseRefName,headRefName`
2. Fetch the diff: `gh pr diff $ARGUMENTS`
3. Read changed files in full for context
4. Analyze the changes for:
   - Correctness: bugs, edge cases, off-by-one errors
   - Security: injection, auth issues, secrets in code
   - Performance: N+1 queries, unnecessary allocations, missing indexes
   - Style: matches project conventions (see CLAUDE.md)
   - Tests: adequate coverage for new/changed behavior

## Output format

Provide a structured review:

### Summary
One paragraph on what the PR does.

### Issues
List any problems found, with file:line references.

### Suggestions
Optional improvements that aren't blocking.

### Verdict
APPROVE, REQUEST_CHANGES, or COMMENT with reasoning.
