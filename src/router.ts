export type MessageType =
  | "review-pr"
  | "fix-issue"
  | "simplify"
  | "validate"
  | "discuss"
  | "create-project"
  | "init-repo"
  | "free-form"
  | "status"
  | "history"
  | "help"
  | "clear"
  | "schedule"
  | "list-schedules"
  | "remove-schedule";

export interface ParsedMessage {
  type: MessageType;
  repo?: string;
  args: Record<string, any>;
  rawText: string;
}

export function parseMessage(text: string): ParsedMessage {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "status") return { type: "status", args: {}, rawText: trimmed };
  if (lower === "history" || lower === "my tasks") return { type: "history", args: {}, rawText: trimmed };
  if (lower === "help") return { type: "help", args: {}, rawText: trimmed };
  if (lower === "clear" || lower === "reset") return { type: "clear", args: {}, rawText: trimmed };

  const prMatch = trimmed.match(/review\s+pr\s+#?(\d+)\s+(?:on|in)\s+(\S+)/i);
  if (prMatch) {
    return { type: "review-pr", repo: prMatch[2], args: { prNumber: parseInt(prMatch[1]) }, rawText: trimmed };
  }

  const issueMatch = trimmed.match(/fix\s+issue\s+#?(\d+)\s+(?:on|in)\s+(\S+)/i);
  if (issueMatch) {
    return { type: "fix-issue", repo: issueMatch[2], args: { issueNumber: parseInt(issueMatch[1]) }, rawText: trimmed };
  }

  const simplifyMatch = trimmed.match(/simplify\s+(\S+)\s+(?:on|in)\s+(\S+)/i);
  if (simplifyMatch) {
    return { type: "simplify", repo: simplifyMatch[2], args: { filePath: simplifyMatch[1] }, rawText: trimmed };
  }

  const validateMatch = trimmed.match(/validate\s+(\S+)/i);
  if (validateMatch) {
    return { type: "validate", repo: validateMatch[1], args: {}, rawText: trimmed };
  }

  // create project <name> [with template <type>]
  const createMatch = trimmed.match(/(?:create|new)\s+project\s+(\S+)(?:\s+with\s+template\s+(\S+))?/i);
  if (createMatch) {
    const args: Record<string, any> = { name: createMatch[1] };
    if (createMatch[2]) args.template = createMatch[2];
    return { type: "create-project", args, rawText: trimmed };
  }

  // Schedule management
  if (/list\s+schedules|show\s+(?:my\s+)?schedules|what.?s\s+scheduled/i.test(lower)) {
    return { type: "list-schedules", args: {}, rawText: trimmed };
  }

  const removeScheduleMatch = trimmed.match(/(?:remove|delete|cancel)\s+schedule\s+#?(\d+)/i);
  if (removeScheduleMatch) {
    return { type: "remove-schedule", args: { scheduleId: parseInt(removeScheduleMatch[1]) }, rawText: trimmed };
  }

  // Schedule creation — detect natural language scheduling intent
  if (/\b(?:every\s+(?:day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday|morning|evening)|each\s+(?:day|week|weekday)|daily|weekly|monthly)\b/i.test(lower) ||
      /\b(?:at\s+\d{1,2}(?::\d{2})?)\b.*\b(?:every|each|daily|weekly)\b/i.test(lower)) {
    const repoHint = trimmed.match(/(?:in|on)\s+(\S+)\s*$/i);
    return { type: "schedule", repo: repoHint?.[1], args: {}, rawText: trimmed };
  }

  // discuss / brainstorm / "I have an idea"
  const discussMatch = trimmed.match(/^(?:discuss|brainstorm)\s+(.+)/i);
  if (discussMatch) {
    return { type: "discuss", args: { topic: discussMatch[1] }, rawText: trimmed };
  }
  if (/^i\s+have\s+(?:a|an)\s+(?:idea|new\s+idea)/i.test(lower)) {
    return { type: "discuss", args: { topic: trimmed }, rawText: trimmed };
  }

  // init repo <name> <url> [branch]
  const initRepoMatch = trimmed.match(/^(?:init|setup|add)\s+repo\s+(\S+)\s+((?:git@|https:\/\/)\S+)(?:\s+(\S+))?$/i);
  if (initRepoMatch) {
    return {
      type: "init-repo",
      args: { name: initRepoMatch[1], url: initRepoMatch[2], branch: initRepoMatch[3] || "main" },
      rawText: trimmed,
    };
  }

  const repoHint = trimmed.match(/(?:in|on)\s+(\S+)\s*$/i);
  return { type: "free-form", repo: repoHint?.[1], args: {}, rawText: trimmed };
}

export function buildContextualPrompt(
  parsed: ParsedMessage,
  history: { role: string; content: string }[],
  persona: string
): string {
  const contextPrefix = history.length > 1
    ? "Previous conversation:\n" +
      history.slice(0, -1).map((m) => `${m.role}: ${m.content}`).join("\n") +
      "\n\nCurrent request:\n"
    : "";
  return persona + "\n\n" + contextPrefix + buildPrompt(parsed);
}

export function buildPrompt(parsed: ParsedMessage): string {
  switch (parsed.type) {
    case "review-pr":
      return `Review PR #${parsed.args.prNumber}. Analyze the diff for bugs, security issues, code quality, and style. Leave constructive inline comments using \`gh pr review\`. Be thorough but fair.`;
    case "fix-issue":
      return `Fix GitHub issue #${parsed.args.issueNumber}. Read the issue, understand the problem, explore the relevant code, implement a fix, write tests if appropriate, and create a PR with a clear description.`;
    case "simplify":
      return `Simplify the file ${parsed.args.filePath}. Reduce complexity, improve readability, remove duplication. Keep all existing behavior. Create a PR with the changes.`;
    case "validate":
      return `Run the test suite and linter for this project. Report any failures with suggested fixes. Do not modify any files.`;
    case "create-project": {
      const tmpl = parsed.args.template ? ` using the ${parsed.args.template} template` : "";
      return `Create a new project called "${parsed.args.name}"${tmpl}. Scaffold the project structure, initialize git, create a GitHub repo with \`gh repo create\`, and push the initial commit.`;
    }
    case "discuss":
      return `Act as a brainstorming partner. The topic is: ${parsed.args.topic}\n\nAsk clarifying questions, suggest approaches, discuss trade-offs. Do not make any code changes.`;
    case "free-form":
      return parsed.rawText;
    default:
      return parsed.rawText;
  }
}
