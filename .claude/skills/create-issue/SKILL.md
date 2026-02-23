---
name: create-issue
description: Create a well-structured GitHub issue with labels and acceptance criteria
disable-model-invocation: true
argument-hint: "[repo] [title]"
allowed-tools: Bash(gh *)
---

Create a GitHub issue on the specified repo.

Usage: `/create-issue owner/repo Title of the issue`

If only a title is given without a repo, use the current repository.

## Steps

1. Parse $ARGUMENTS into repo and title
2. Ask clarifying questions if the request is vague
3. Draft the issue body with:
   - **Description**: What and why
   - **Acceptance criteria**: Checkboxes for done conditions
   - **Technical notes**: Relevant files, patterns, constraints
4. Create with: `gh issue create --repo <repo> --title "<title>" --body "<body>"`
5. Return the issue URL
