/**
 * The wiki plugin's `skill.md` documents `plow_run_command` invocations for
 * an agent to copy literally. This asserts each one against the real
 * vendored manifest's `classifyArgv` allowlist — not a copy pasted into this
 * test — so a doc/manifest drift (an example the allowlist actually refuses)
 * fails here instead of only being discovered by an agent following the
 * skill and getting refused.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyArgv } from "../src/plugins/argvRules.js";
import { parseManifest } from "../src/plugins/manifest.js";

const PLUGIN_DIR = fileURLToPath(new URL("../../../apps/desktop/plugins/wiki", import.meta.url));
const manifest = parseManifest(fs.readFileSync(`${PLUGIN_DIR}/latch-plugin.json`, "utf8"));
const skill = fs.readFileSync(`${PLUGIN_DIR}/skill.md`, "utf8");

/** Every `argv=[...]` an agent following the skill literally would call. */
function documentedArgvCalls(doc: string): string[][] {
  const calls: string[][] = [];
  for (const m of doc.matchAll(/argv=(\[[^\]]*\])/g)) calls.push(JSON.parse(m[1]));
  return calls;
}

describe("wiki skill.md documented invocations", () => {
  const calls = documentedArgvCalls(skill);

  it("has at least one documented plow_run_command example to check", () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it.each(calls.map((argv) => [argv] as const))("%j is accepted by the real manifest's allowlist", (argv) => {
    expect(classifyArgv(manifest, argv).kind).not.toBe("refused");
  });
});
