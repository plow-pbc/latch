/**
 * Every bundled plugin's `skill.md` documents `plow_run_command` invocations
 * for an agent to copy literally. This asserts each one against the real
 * vendored manifest's `classifyArgv` allowlist — not a copy pasted into this
 * test — so a doc/manifest drift (an example the allowlist actually refuses)
 * fails here instead of only being discovered by an agent following the
 * skill and getting refused. Plugins are discovered from disk
 * (apps/desktop/plugins/*), read the same way the installer does, so a new
 * plugin with a skill is covered here without a matching edit to this file.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyArgv } from "../src/plugins/argvRules.js";
import { parseManifest, type PluginManifest } from "../src/plugins/manifest.js";

const PLUGINS_DIR = fileURLToPath(new URL("../../../apps/desktop/plugins", import.meta.url));

/** Every bundled plugin whose manifest publishes a skill doc. */
const PLUGINS: { name: string; manifest: PluginManifest; skill: string }[] = fs
  .readdirSync(PLUGINS_DIR)
  .flatMap((name) => {
    const dir = path.join(PLUGINS_DIR, name);
    const manifestPath = path.join(dir, "latch-plugin.json");
    if (!fs.existsSync(manifestPath)) return [];
    const manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.skill === null) return [];
    return [{ name, manifest, skill: fs.readFileSync(path.join(dir, manifest.skill), "utf8") }];
  });

/** Every `argv=[...]` an agent following the skill literally would call. */
function documentedArgvCalls(doc: string): string[][] {
  const calls: string[][] = [];
  for (const m of doc.matchAll(/argv=(\[[^\]]*\])/g)) calls.push(JSON.parse(m[1]));
  return calls;
}

for (const { name, manifest, skill } of PLUGINS) {
  describe(`${name} skill.md documented invocations`, () => {
    const calls = documentedArgvCalls(skill);

    it("has at least one documented plow_run_command example to check", () => {
      expect(calls.length).toBeGreaterThan(0);
    });

    it.each(calls.map((argv) => [argv] as const))("%j is accepted by the real manifest's allowlist", (argv) => {
      expect(classifyArgv(manifest, argv).kind).not.toBe("refused");
    });
  });
}

describe("messages plugin", () => {
  it("carries the owner-authority rule itself — its page is loadable without the imessage skill", () => {
    expect(PLUGINS.find((p) => p.name === "messages")?.skill).toMatch(/carries the owner's authority in this\s+conversation/);
  });

  it("refuses --store and --app except as a pinned prefix ahead of the verb", () => {
    const messages = PLUGINS.find((p) => p.name === "messages");
    expect(messages).toBeDefined();
    const manifest = messages!.manifest;
    expect(classifyArgv(manifest, ["plow-messages", "--store", "/x", "chats"]).kind).toBe("refused");
    expect(classifyArgv(manifest, ["plow-messages", "chats", "--store", "/x"]).kind).toBe("refused");
    expect(classifyArgv(manifest, ["plow-messages", "chats", "--app", "whatsapp"]).kind).toBe("refused");
    expect(classifyArgv(manifest, ["plow-messages", "--app", "whatsapp", "chats"]).kind).toBe("read");
    expect(classifyArgv(manifest, ["plow-messages", "--app", "/tmp/ChatStorage.sqlite", "chats"]).kind).toBe("refused");
  });
});
