/** SkillRegistry: frontmatter parsing, dir loading, manifest shape. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSING_SKILL, SkillRegistry } from "@domo/device-core";
import { jv, JSONValue } from "@domo/protocol";

describe("SkillRegistry", () => {
  it("loads *.md with frontmatter and skips malformed files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-sk-"));
    fs.writeFileSync(
      path.join(dir, "good.md"),
      "---\nname: my-skill\ndescription: does things\n---\n# Body\ncontent here\n",
    );
    fs.writeFileSync(path.join(dir, "bad.md"), "no frontmatter at all");
    fs.writeFileSync(path.join(dir, "ignored.txt"), "---\nname: nope\n---\nx");
    const reg = new SkillRegistry();
    reg.loadDir(dir);
    expect(reg.skill("my-skill")?.description).toBe("does things");
    expect(reg.skill("my-skill")?.body).toContain("content here");
    expect(reg.manifest().length).toBe(1);
  });

  // Sorted, and names/descriptions ONLY. A body is fetched one at a time by
  // plow_read_skill; putting them all in the manifest would put a whole
  // operator manual on every listing.
  it("manifest is sorted and carries no bodies", () => {
    const reg = new SkillRegistry();
    reg.register({ name: "zeta", description: "z", body: "zz" });
    reg.register(BROWSING_SKILL);
    const manifest = reg.manifest();
    expect(manifest.map((s) => s.name)).toEqual(["camoufox-browsing", "zeta"]);
    expect(Object.keys(manifest[0])).toEqual(["name", "description"]);
    expect(reg.skill("camoufox-browsing")?.body).toContain("plow_browser_open");
  });

  it("the built-in browsing skill documents the critical gotchas", () => {
    expect(BROWSING_SKILL.body).toContain("back");
    expect(BROWSING_SKILL.body).toContain("use_page");
    expect(BROWSING_SKILL.body).toContain("fill_secret");
    expect(BROWSING_SKILL.body).toContain("plow_browser_request");
  });
});
