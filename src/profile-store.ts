import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { Config } from "./config";
import { logger } from "./logger";

const MAX_CONTEXT_BYTES = 32_000;
const MAX_FILE_BYTES = 8_000;
const MAX_MEMORY_FACT_LENGTH = 1_000;
const MEMORY_DIRECTIVE = /<!--\s*OVE_MEMORY\s+({[\s\S]*?})\s*-->/g;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SAFE_MARKDOWN = /^[A-Z0-9][A-Z0-9_-]*\.md$/i;

export interface ProfileSummary {
  profile: string;
  files: string[];
  skills: string[];
  autoLearn: boolean;
}

interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

export class ProfileStore {
  readonly rootDir: string | null;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.rootDir = config.profilesDir ? resolve(config.profilesDir) : null;
    if (this.rootDir) {
      mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
      chmodSync(this.rootDir, 0o700);
    }
  }

  getProfileId(userId: string): string | null {
    const profile = this.config.users[userId]?.profile;
    return profile && SAFE_ID.test(profile) ? profile : null;
  }

  ensureProfile(userId: string): string | null {
    const profile = this.getProfileId(userId);
    if (!profile || !this.rootDir) return null;
    const dir = this.profileDir(profile);
    mkdirSync(join(dir, "skills"), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);

    const ownerFile = join(dir, "OWNER.md");
    if (!existsSync(ownerFile)) {
      writeFileSync(ownerFile, "# Owner\n\nPrivate facts the owner explicitly wants Ove to remember.\n", { mode: 0o600 });
    }
    const memoryFile = join(dir, "MEMORY.md");
    if (!existsSync(memoryFile)) {
      writeFileSync(memoryFile, "# Memory\n\nDurable facts learned during conversations.\n", { mode: 0o600 });
    }
    return dir;
  }

  buildPromptContext(userId: string): string {
    const dir = this.ensureProfile(userId);
    const profile = this.getProfileId(userId);
    if (!dir || !profile) return "";

    const sections: string[] = [];
    let total = 0;
    for (const file of this.contextFiles(profile, dir)) {
      if (total >= MAX_CONTEXT_BYTES) break;
      const path = join(dir, file);
      const content = readFileSync(path, "utf8").slice(0, Math.min(MAX_FILE_BYTES, MAX_CONTEXT_BYTES - total));
      total += content.length;
      sections.push(`## ${file}\n${content}`);
    }

    const skills = this.listSkillsForDir(dir);
    const skillCatalog = skills.length
      ? skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`).join("\n")
      : "- No private skills configured.";
    const autoLearn = this.config.profiles?.[profile]?.autoLearn !== false;
    const memoryInstruction = autoLearn
      ? `When you learn a new, durable fact about the owner or their environment that will improve future help, append one HTML comment per fact at the very end of your response using exactly:\n<!-- OVE_MEMORY {"file":"MEMORY.md","fact":"concise durable fact"} -->\nDo not store secrets, credentials, temporary states, guesses, sensitive third-party data, or facts already present.`
      : "Do not emit OVE_MEMORY directives; automatic learning is disabled for this profile.";

    return `<ove_private_profile profile="${profile}">
This is trusted, private owner context. Use it only for this authorized user. Never quote or expose it unnecessarily, never place it in logs, commits, issues, or messages to other people.

${sections.join("\n\n")}

## Available private skills
Skills are progressively disclosed. If a skill clearly applies, read its SKILL.md from the exact path shown before acting. You may create or update a private skill only when the owner explicitly requests it.
${skillCatalog}

## Durable memory updates
${memoryInstruction}
</ove_private_profile>`;
  }

  remember(userId: string, fact: string, file = "MEMORY.md"): { saved: boolean; reason?: string } {
    const dir = this.ensureProfile(userId);
    if (!dir) return { saved: false, reason: "No private profile is configured for this user." };
    const cleanFact = fact.replace(/\s+/g, " ").trim();
    if (!cleanFact) return { saved: false, reason: "The memory is empty." };
    if (cleanFact.length > MAX_MEMORY_FACT_LENGTH) return { saved: false, reason: "The memory is too long." };
    if (!SAFE_MARKDOWN.test(file)) return { saved: false, reason: "Invalid memory filename." };

    const path = this.safeChild(dir, file);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : `# ${basename(file, ".md")}\n`;
    const line = `- ${cleanFact}`;
    if (existing.split("\n").some((candidate) => candidate.trim().toLowerCase() === line.toLowerCase())) {
      return { saved: false, reason: "That fact is already remembered." };
    }
    if (!existsSync(path)) writeFileSync(path, existing + "\n", { mode: 0o600 });
    appendFileSync(path, `${existing.endsWith("\n") ? "" : "\n"}${line}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    logger.info("private profile memory saved", { userId, file, factLength: cleanFact.length });
    return { saved: true };
  }

  forget(userId: string, query: string): number {
    const dir = this.ensureProfile(userId);
    if (!dir || !query.trim()) return 0;
    const needle = query.trim().toLowerCase();
    let removed = 0;
    for (const file of this.contextFiles(this.getProfileId(userId)!, dir)) {
      const path = join(dir, file);
      const original = readFileSync(path, "utf8");
      const lines = original.split("\n");
      const kept = lines.filter((line) => {
        if (line.trim().startsWith("-") && line.toLowerCase().includes(needle)) {
          removed++;
          return false;
        }
        return true;
      });
      if (kept.length !== lines.length) this.atomicWrite(path, kept.join("\n"));
    }
    if (removed) logger.info("private profile memory forgotten", { userId, removed });
    return removed;
  }

  processMemoryDirectives(userId: string, output: string): { output: string; saved: number } {
    let saved = 0;
    const cleaned = output.replace(MEMORY_DIRECTIVE, (_match, json) => {
      try {
        const directive = JSON.parse(json) as { file?: string; fact?: string };
        if (directive.fact && this.remember(userId, directive.fact, directive.file || "MEMORY.md").saved) saved++;
      } catch (error) {
        logger.warn("invalid private memory directive", { userId, error: String(error) });
      }
      return "";
    });
    return { output: cleaned.trim(), saved };
  }

  summary(userId: string): ProfileSummary | null {
    const dir = this.ensureProfile(userId);
    const profile = this.getProfileId(userId);
    if (!dir || !profile) return null;
    return {
      profile,
      files: this.contextFiles(profile, dir),
      skills: this.listSkillsForDir(dir).map((skill) => skill.name),
      autoLearn: this.config.profiles?.[profile]?.autoLearn !== false,
    };
  }

  private contextFiles(profile: string, dir: string): string[] {
    const configured = this.config.profiles?.[profile]?.contextFiles;
    const files = configured?.length
      ? configured
      : readdirSync(dir).filter((name) => SAFE_MARKDOWN.test(name));
    return files
      .filter((name) => SAFE_MARKDOWN.test(name))
      .filter((name) => {
        const path = this.safeChild(dir, name);
        return existsSync(path) && statSync(path).isFile();
      })
      .sort();
  }

  private listSkillsForDir(dir: string): SkillSummary[] {
    const skillsDir = join(dir, "skills");
    if (!existsSync(skillsDir)) return [];
    const skills: SkillSummary[] = [];
    for (const name of readdirSync(skillsDir).sort()) {
      if (!SAFE_ID.test(name)) continue;
      const path = join(skillsDir, name, "SKILL.md");
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8").slice(0, 4_000);
      const description = text.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] || "Private owner skill";
      skills.push({ name, description, path });
    }
    return skills;
  }

  private profileDir(profile: string): string {
    if (!this.rootDir) throw new Error("Profiles directory is disabled");
    return this.safeChild(this.rootDir, profile);
  }

  private safeChild(parent: string, child: string): string {
    const path = resolve(parent, child);
    if (path !== parent && !path.startsWith(parent + sep)) throw new Error("Profile path escapes its root");
    return path;
  }

  private atomicWrite(path: string, content: string): void {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  }
}
