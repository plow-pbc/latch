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
    expect((reg.manifest() as JSONValue[]).length).toBe(1);
  });

  it("manifest is sorted and carries bodies", () => {
    const reg = new SkillRegistry();
    reg.register({ name: "zeta", description: "z", body: "zz" });
    reg.register(BROWSING_SKILL);
    const manifest = reg.manifest() as JSONValue[];
    expect(jv(manifest[0]).get("name").str).toBe("camoufox-browsing");
    expect(jv(manifest[0]).get("body").str).toContain("browser_open");
    expect(jv(manifest[1]).get("name").str).toBe("zeta");
  });

  it("the built-in browsing skill documents the critical gotchas", () => {
    expect(BROWSING_SKILL.body).toContain("back");
    expect(BROWSING_SKILL.body).toContain("use_page");
    expect(BROWSING_SKILL.body).toContain("fill_secret");
    expect(BROWSING_SKILL.body).toContain("browser_request");
  });
});
