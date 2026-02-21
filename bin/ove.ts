#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { validateConfig, runSetup } from "../src/setup";

const args = process.argv.slice(2);
const command = args[0];

if (command === "init") {
  if (existsSync("config.json")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("  Config already exists. Overwrite? (y/n): ");
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("  Aborted.");
      process.exit(0);
    }
  }
  await runSetup();
  process.exit(0);
}

if (command === "start" || !command) {
  process.stdout.write("\n  Checking config...\n");
  const { valid, issues } = validateConfig();

  if (!valid) {
    for (const issue of issues) {
      process.stdout.write(`  ⚠ ${issue}\n`);
    }
    process.stdout.write("\n");

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("  Want to fix these now? (y/n): ");
    rl.close();

    if (answer.trim().toLowerCase() === "y") {
      await runSetup({ fixOnly: issues });
    }
  }

  process.stdout.write("  Starting Ove...\n\n");
  const entry = join(import.meta.dir, "..", "src", "index.ts");
  await import(entry);
} else if (command === "test") {
  console.log("Run: bun test");
  process.exit(0);
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(`
ove - Your grumpy but meticulous dev companion

Usage:
  ove              Start Ove (auto-detects Slack/CLI from env)
  ove start        Same as above
  ove init         Interactive setup — creates config.json and .env
  ove help         Show this message

Environment:
  SLACK_BOT_TOKEN  Slack bot token (xoxb-...)
  SLACK_APP_TOKEN  Slack app token (xapp-...)
  CLI_MODE=true    Force CLI mode
  REPOS_DIR        Directory for git repos (default: ./repos)

More info: https://jacksoncage.github.io/ove
`);
  process.exit(0);
} else {
  console.log(`Unknown command: ${command}. Run 'ove help' for usage.`);
  process.exit(1);
}
