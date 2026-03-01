#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { validateConfig, runSetup, runDiagnostics, printDiagnostics } from "../src/setup";
import { loadConfig } from "../src/config";

async function checkForUpdate(): Promise<void> {
  try {
    const pkgPath = join(import.meta.dir, "..", "package.json");
    const { name, version: current } = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const res = await fetch(`https://registry.npmjs.org/${name}/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const { version: latest } = await res.json() as { version: string };
    if (latest && latest !== current) {
      process.stdout.write(`\n  Update available: ${current} → ${latest}\n`);
      process.stdout.write(`  Run: npm install -g ${name}\n\n`);
    }
  } catch {
    // Silent fail — don't block startup for update checks
  }
}

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

  // Run diagnostics after init
  process.stdout.write("\n  Checking environment...\n");
  const config = loadConfig();
  const results = await runDiagnostics(config);
  printDiagnostics(results);
  const failures = results.filter(r => r.status === "fail");
  if (failures.length > 0) {
    process.stdout.write(`\n  ${failures.length} issue(s) found. Run 'ove doctor' for details.\n`);
  }
  process.stdout.write("\n");
  process.exit(0);
}

if (command === "doctor") {
  process.stdout.write("\n  Checking environment...\n");
  const config = loadConfig();
  const results = await runDiagnostics(config);
  printDiagnostics(results);

  const failures = results.filter(r => r.status === "fail");
  const warnings = results.filter(r => r.status === "warn");
  process.stdout.write("\n");
  if (failures.length === 0 && warnings.length === 0) {
    process.stdout.write("  All checks passed.\n\n");
  } else {
    if (failures.length > 0) {
      process.stdout.write(`  ${failures.length} error(s)`);
    }
    if (warnings.length > 0) {
      process.stdout.write(`${failures.length > 0 ? ", " : "  "}${warnings.length} warning(s)`);
    }
    process.stdout.write("\n\n");
  }
  process.exit(failures.length > 0 ? 1 : 0);
}

if (command === "start" || !command) {
  await checkForUpdate();
  process.stdout.write("  Checking config...\n");
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
  ove doctor       Check environment, tools, and connections
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
