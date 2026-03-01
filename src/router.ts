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
  | "remove-schedule"
  | "list-tasks"
  | "cancel-task"
  | "trace"
  | "set-mode";

export interface ParsedMessage {
  type: MessageType;
  repo?: string;
  args: Record<string, any>;
  rawText: string;
  priority: number;
}

export function parsePriority(text: string): { priority: number; text: string } {
  const lower = text.toLowerCase();

  // --priority urgent / --priority high / --priority normal
  const flagMatch = text.match(/--priority\s+(urgent|high|normal|low)/i);
  if (flagMatch) {
    const level = flagMatch[1].toLowerCase();
    const cleaned = text.replace(/\s*--priority\s+(urgent|high|normal|low)/i, "").trim();
    const map: Record<string, number> = { urgent: 2, high: 1, normal: 0, low: 0 };
    return { priority: map[level] ?? 0, text: cleaned };
  }

  // urgent: prefix
  if (/^urgent:\s*/i.test(text)) {
    return { priority: 2, text: text.replace(/^urgent:\s*/i, "").trim() };
  }

  // !important marker (anywhere)
  if (/!important\b/i.test(lower)) {
    return { priority: 1, text: text.replace(/\s*!important/i, "").trim() };
  }

  // p1 / p2 / p3 markers
  const pMatch = text.match(/\bp([0-3])\b/i);
  if (pMatch) {
    const pNum = parseInt(pMatch[1]);
    // p0 = urgent (2), p1 = high (1), p2 = normal (0), p3 = normal (0)
    const map: Record<number, number> = { 0: 2, 1: 1, 2: 0, 3: 0 };
    const cleaned = text.replace(/\s*\bp[0-3]\b/i, "").trim();
    return { priority: map[pNum] ?? 0, text: cleaned };
  }

  return { priority: 0, text };
}

export function parseMessage(text: string): ParsedMessage {
  const { priority, text: priorityStripped } = parsePriority(text.trim());
  const trimmed = priorityStripped;
  const lower = trimmed.toLowerCase();

  function msg(partial: Omit<ParsedMessage, "priority">): ParsedMessage {
    return { ...partial, priority };
  }

  // Handle Telegram /commands — strip leading slash
  if (lower === "/start") return msg({ type: "help", args: {}, rawText: trimmed });
  if (lower === "/help") return msg({ type: "help", args: {}, rawText: trimmed });
  if (lower === "/status") return msg({ type: "status", args: {}, rawText: trimmed });
  if (lower === "/history") return msg({ type: "history", args: {}, rawText: trimmed });
  if (lower === "/clear") return msg({ type: "clear", args: {}, rawText: trimmed });

  if (lower === "status") return msg({ type: "status", args: {}, rawText: trimmed });
  if (lower === "history" || lower === "my tasks") return msg({ type: "history", args: {}, rawText: trimmed });
  if (lower === "help") return msg({ type: "help", args: {}, rawText: trimmed });
  if (lower === "clear" || lower === "reset") return msg({ type: "clear", args: {}, rawText: trimmed });

  // Task management
  if (lower === "tasks" || lower === "/tasks") return msg({ type: "list-tasks", args: {}, rawText: trimmed });
  const cancelMatch = trimmed.match(/^(?:\/)?cancel\s+(\S+)$/i);
  if (cancelMatch) return msg({ type: "cancel-task", args: { taskId: cancelMatch[1] }, rawText: trimmed });

  const traceMatch = trimmed.match(/^(?:\/)?trace(?:\s+(\S+))?$/i);
  if (traceMatch) return msg({ type: "trace", args: { taskId: traceMatch[1] }, rawText: trimmed });

  // Mode switching — explicit commands
  const modeMatch = trimmed.match(/^(?:\/)?mode\s+(assistant|strict)$/i);
  if (modeMatch) {
    return msg({ type: "set-mode", args: { mode: modeMatch[1].toLowerCase() }, rawText: trimmed });
  }

  // Mode switching — natural language for assistant mode
  if (/^(?:assistant|yolo)\s+mode$/i.test(lower) ||
      /^be\s+more\s+helpful$/i.test(lower) ||
      /^help\s+me\s+with\s+(?:anything|everything)$/i.test(lower)) {
    return msg({ type: "set-mode", args: { mode: "assistant" }, rawText: trimmed });
  }

  // Mode switching — natural language for strict mode
  if (/^(?:strict|code|normal)\s+mode$/i.test(lower) ||
      /^back\s+to\s+(?:normal|code|strict)$/i.test(lower)) {
    return msg({ type: "set-mode", args: { mode: "strict" }, rawText: trimmed });
  }

  // Natural language status inquiries — short messages asking about progress
  if (isStatusInquiry(lower)) return msg({ type: "status", args: {}, rawText: trimmed });

  const prMatch = trimmed.match(/review\s+pr\s+#?(\d+)\s+(?:on|in)\s+(\S+)/i);
  if (prMatch) {
    return msg({ type: "review-pr", repo: prMatch[2], args: { prNumber: parseInt(prMatch[1]) }, rawText: trimmed });
  }

  const issueMatch = trimmed.match(/fix\s+issue\s+#?(\d+)\s+(?:on|in)\s+(\S+)/i);
  if (issueMatch) {
    return msg({ type: "fix-issue", repo: issueMatch[2], args: { issueNumber: parseInt(issueMatch[1]) }, rawText: trimmed });
  }

  const simplifyMatch = trimmed.match(/simplify\s+(\S+)\s+(?:on|in)\s+(\S+)/i);
  if (simplifyMatch) {
    return msg({ type: "simplify", repo: simplifyMatch[2], args: { filePath: simplifyMatch[1] }, rawText: trimmed });
  }

  const validateMatch = trimmed.match(/validate\s+(\S+)/i);
  if (validateMatch) {
    return msg({ type: "validate", repo: validateMatch[1], args: {}, rawText: trimmed });
  }

  // create project <name> [with template <type>]
  const createMatch = trimmed.match(/(?:create|new)\s+project\s+(\S+)(?:\s+with\s+template\s+(\S+))?/i);
  if (createMatch) {
    const args: Record<string, any> = { name: createMatch[1] };
    if (createMatch[2]) args.template = createMatch[2];
    return msg({ type: "create-project", args, rawText: trimmed });
  }

  // Schedule management
  if (/list\s+schedules|show\s+(?:my\s+)?schedules|what.?s\s+scheduled/i.test(lower)) {
    return msg({ type: "list-schedules", args: {}, rawText: trimmed });
  }

  const removeScheduleMatch = trimmed.match(/(?:remove|delete|cancel)\s+schedule\s+#?(\d+)/i);
  if (removeScheduleMatch) {
    return msg({ type: "remove-schedule", args: { scheduleId: parseInt(removeScheduleMatch[1]) }, rawText: trimmed });
  }

  // Schedule creation — detect natural language scheduling intent
  if (/\b(?:every\s+(?:day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday|morning|evening|hour|(?:\d+\s+)?(?:min(?:ute)?s?|hours?))|each\s+(?:day|week|weekday)|daily|weekly|monthly)\b/i.test(lower) ||
      /\b(?:at\s+\d{1,2}(?::\d{2})?)\b.*\b(?:every|each|daily|weekly)\b/i.test(lower)) {
    const repoHint = trimmed.match(/(?:in|on)\s+(\S+)\s*$/i);
    return msg({ type: "schedule", repo: repoHint?.[1], args: {}, rawText: trimmed });
  }

  // discuss / brainstorm / "I have an idea"
  const discussMatch = trimmed.match(/^(?:discuss|brainstorm)\s+(.+)/i);
  if (discussMatch) {
    return msg({ type: "discuss", args: { topic: discussMatch[1] }, rawText: trimmed });
  }
  if (/^i\s+have\s+(?:a|an)\s+(?:idea|new\s+idea)/i.test(lower)) {
    return msg({ type: "discuss", args: { topic: trimmed }, rawText: trimmed });
  }

  // init repo <name> <url> [branch]
  const initRepoMatch = trimmed.match(/^(?:init|setup|add)\s+repo\s+(\S+)\s+((?:git@|https:\/\/)\S+)(?:\s+(\S+))?$/i);
  if (initRepoMatch) {
    return msg({
      type: "init-repo",
      args: { name: initRepoMatch[1], url: initRepoMatch[2], branch: initRepoMatch[3] || "main" },
      rawText: trimmed,
    });
  }

  // Natural language repo setup: "clone org/repo", "setup org/repo", "add org/repo"
  const naturalRepoMatch = trimmed.match(/^(?:clone|setup|add|init|use)\s+(?:(?:the|repo)\s+)?([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)(?:\s+(?:repo(?:sitory)?))?\s*$/i);
  if (naturalRepoMatch) {
    const slug = naturalRepoMatch[1];
    const name = slug.split("/").pop()!;
    const url = `git@github.com:${slug}.git`;
    return msg({
      type: "init-repo",
      args: { name, url, branch: "main" },
      rawText: trimmed,
    });
  }

  // Detect org/repo or GitHub URLs anywhere in a message that looks like a setup request
  const setupIntent = /(?:clone|setup|add|init|use|start\s+(?:with|on)|work\s+(?:on|with))/i.test(lower);
  if (setupIntent) {
    const ghUrl = trimmed.match(/((?:git@github\.com:|https:\/\/github\.com\/)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?)\b/);
    if (ghUrl) {
      const slug = ghUrl[2];
      const name = slug.split("/").pop()!;
      const url = ghUrl[1].endsWith(".git") ? ghUrl[1] : ghUrl[1] + ".git";
      return msg({
        type: "init-repo",
        args: { name, url: url.startsWith("git@") ? url : `git@github.com:${slug}.git`, branch: "main" },
        rawText: trimmed,
      });
    }
    const slugMatch = trimmed.match(/\b([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\b/);
    if (slugMatch && slugMatch[1].indexOf("/") > 0) {
      const slug = slugMatch[1];
      const name = slug.split("/").pop()!;
      const url = `git@github.com:${slug}.git`;
      return msg({
        type: "init-repo",
        args: { name, url, branch: "main" },
        rawText: trimmed,
      });
    }
  }

  const repoHint = trimmed.match(/(?:in|on)\s+(\S+?)[?.!,]*\s*$/i);
  return msg({ type: "free-form", repo: repoHint?.[1], args: {}, rawText: trimmed });
}

// Detect natural language status/progress inquiries.
// Only matches short, question-like messages — not work requests that happen
// to contain words like "progress" or "status" (e.g. "fix the status page").
const STATUS_PATTERNS = [
  /^(?:how.s it going|how.?s .* going)/,       // how's it going, how is the work going
  /^(?:any )?update[s]?\??$/,                   // updates?, any updates?
  /^(?:are you |you |is it )done/,              // are you done?, is it done
  /^done\s*(?:yet)?\??$/,                       // done?, done yet?
  /^(?:what.s the |what is the )?progress\??$/,  // progress?, what's the progress
  /^how (?:far|much)/,                          // how far along, how much left
  /^(?:how.s|what.s|how is) (?:the )?(?:progress|status|work)/,  // how's the progress/status/work
  /^(?:is it |are you )(?:still )?(?:working|running|busy)/,     // is it still running
  /^(?:how do(?:se|es)? (?:it )?(?:the )?work go|how (?:do(?:se|es)? )?(?:the )?work go)/, // how does the work go (typo-tolerant)
  /^(?:eta|when (?:will|are) (?:you|it) (?:be )?done)/,          // eta, when will you be done
];

function isStatusInquiry(lower: string): boolean {
  // Only consider short messages (< 60 chars) to avoid matching work requests
  if (lower.length > 60) return false;
  return STATUS_PATTERNS.some((p) => p.test(lower));
}

export function buildCronPrompt(prompt: string): string {
  return `This is an autonomous scheduled task. Do not ask questions — make your own decisions and proceed with the work. If there are multiple options, pick the best one and go.\n\n${prompt}`;
}

const CHAT_PIPELINE_HINT = "You are running in a chat pipeline — your text output is sent to the user via a messaging app. Do NOT use AskUserQuestion or other interactive CLI tools (they don't work here). If you need to ask the user something, include the question and numbered options directly in your text response — the user will reply in chat and you'll see their answer in the next message.";

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
  return persona + "\n\n" + CHAT_PIPELINE_HINT + "\n\n" + contextPrefix + buildPrompt(parsed);
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
