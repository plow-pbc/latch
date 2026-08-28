/**
 * The ~/Plow playground primitives: the confinement predicate that gates the
 * auto-approval, the startup mkdir, and the skill that teaches the folder.
 *
 * The predicate is security-relevant — a false positive grants a file
 * operation nobody reviewed — so the cases here are the escapes: symlinks out
 * of the folder, prefix look-alikes, non-file capabilities riding along.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  confinedToPlowFolder,
  ensurePlowFolder,
  plowFolderPath,
  registerPlowFolderSkill,
} from "../src/plowFolder.js";
import { SkillRegistry } from "../src/skills.js";

let home: string;
let root: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "plow-home-"));
  root = ensurePlowFolder(home);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("ensurePlowFolder", () => {
  it("creates ~/Plow and is idempotent", () => {
    expect(root).toBe(plowFolderPath(home));
    expect(fs.statSync(root).isDirectory()).toBe(true);
    expect(ensurePlowFolder(home)).toBe(root);
  });
});

describe("confinedToPlowFolder", () => {
  it("accepts file reads and writes inside the folder", async () => {
    await expect(
      confinedToPlowFolder(
        [
          { kind: "fs.read", paths: [path.join(root, "a.txt")] },
          { kind: "fs.write", paths: [path.join(root, "sub/b.txt")] },
        ],
        root,
      ),
    ).resolves.toBe(true);
  });

  // The refusal matrix: same question (input set → false), one row each.
  // Capabilities are built lazily because `root`/`home` exist only per-test.
  it.each<[string, () => Parameters<typeof confinedToPlowFolder>[0]]>([
    ["an empty capability set — vacuous truth is not confinement", () => []],
    ["a file capability with an empty path list", () => [{ kind: "fs.read", paths: [] }]],
    ["a file capability with no paths at all", () => [{ kind: "fs.read" }]],
    ["a sibling prefix look-alike", () => [{ kind: "fs.write", paths: [path.join(home, "Plowman/x")] }]],
    [
      "a confined write riding with an outside read",
      () => [
        { kind: "fs.write", paths: [path.join(root, "in.txt")] },
        { kind: "fs.read", paths: [path.join(home, "out.txt")] },
      ],
    ],
    ["a lexical .. traversal", () => [{ kind: "fs.read", paths: [path.join(root, "../out.txt")] }]],
    ["exec, even run in the folder", () => [{ kind: "process.exec", argv: ["ls"], cwd: root }]],
    [
      "exec riding with a confined write",
      () => [
        { kind: "fs.write", paths: [path.join(root, "a.txt")] },
        { kind: "process.exec", argv: ["ls"], cwd: root },
      ],
    ],
    ["browser", () => [{ kind: "browser", origins: ["example.com"] }]],
  ])("refuses %s", async (_name, caps) => {
    await expect(confinedToPlowFolder(caps(), root)).resolves.toBe(false);
  });

  it("refuses a symlink inside the folder that points out of it", async () => {
    const secret = path.join(home, "secret");
    fs.mkdirSync(secret);
    fs.symlinkSync(secret, path.join(root, "escape"));
    await expect(
      confinedToPlowFolder([{ kind: "fs.read", paths: [path.join(root, "escape/key")] }], root),
    ).resolves.toBe(false);
  });

  it("refuses a symlinked ROOT — ~/Plow -> ~ must not confine the whole home", async () => {
    const link = path.join(home, "PlowLink");
    fs.symlinkSync(home, link);
    await expect(
      confinedToPlowFolder([{ kind: "fs.read", paths: [path.join(link, "a.txt")] }], link),
    ).resolves.toBe(false);
  });
});

describe("the plow-folder skill", () => {
  it("registers and names the real folder in its body", () => {
    const skills = new SkillRegistry();
    registerPlowFolderSkill(skills, home);
    const skill = skills.skill("plow-folder");
    expect(skill).not.toBeNull();
    expect(skill!.body).toContain(root);
    // The body teaches the boundary, not just the perk: outside paths are
    // reviewed, and non-file operations are always reviewed.
    expect(skill!.body).toMatch(/outside/);
    expect(skill!.body).toMatch(/[Rr]unning commands/);
    expect(skills.manifest().map((s) => s.name)).toContain("plow-folder");
  });
});
