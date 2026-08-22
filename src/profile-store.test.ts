import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "./config";
import { ProfileStore } from "./profile-store";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(autoLearn = true): { store: ProfileStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "ove-profiles-"));
  tempDirs.push(root);
  const config: Config = {
    repos: {},
    users: { "telegram:1": { name: "Owner", repos: ["*"], profile: "owner" } },
    claude: { maxTurns: 25 },
    reposDir: "/tmp/repos",
    profilesDir: root,
    profiles: { owner: { autoLearn } },
  };
  return { store: new ProfileStore(config), root };
}

describe("ProfileStore", () => {
  it("creates a private profile and remembers durable facts", () => {
    const { store, root } = makeStore();
    expect(store.remember("telegram:1", "The home server is named bot.").saved).toBe(true);
    expect(readFileSync(join(root, "owner", "MEMORY.md"), "utf8")).toContain("The home server is named bot.");
    expect(store.remember("telegram:1", "The home server is named bot.").saved).toBe(false);
  });

  it("keeps profiles isolated by configured user mapping", () => {
    const { store } = makeStore();
    expect(store.summary("telegram:unknown")).toBeNull();
    expect(store.buildPromptContext("telegram:unknown")).toBe("");
  });

  it("removes matching bullet memories", () => {
    const { store, root } = makeStore();
    store.remember("telegram:1", "UniFi controller lives on bot.");
    expect(store.forget("telegram:1", "UniFi")).toBe(1);
    expect(readFileSync(join(root, "owner", "MEMORY.md"), "utf8")).not.toContain("UniFi controller");
  });

  it("extracts automatic memory directives without exposing them in output", () => {
    const { store, root } = makeStore();
    const result = store.processMemoryDirectives(
      "telegram:1",
      'Done.\n<!-- OVE_MEMORY {"file":"HOME.md","fact":"The router is named gateway."} -->',
    );
    expect(result.output).toBe("Done.");
    expect(result.saved).toBe(1);
    expect(readFileSync(join(root, "owner", "HOME.md"), "utf8")).toContain("The router is named gateway.");
  });

  it("discovers valid private skills progressively", () => {
    const { store, root } = makeStore();
    store.ensureProfile("telegram:1");
    const skillDir = join(root, "owner", "skills", "unifi-home");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: unifi-home\ndescription: Inspect the owner's UniFi home network.\n---\n\nUse the local controller.\n");
    const context = store.buildPromptContext("telegram:1");
    expect(context).toContain("unifi-home: Inspect the owner's UniFi home network.");
    expect(store.summary("telegram:1")?.skills).toEqual(["unifi-home"]);
  });

  it("can disable automatic learning per profile", () => {
    const { store } = makeStore(false);
    expect(store.buildPromptContext("telegram:1")).toContain("automatic learning is disabled");
  });
});
