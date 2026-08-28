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
  it("accepts file reads and writes inside the folder", () => {
    expect(
      confinedToPlowFolder(
        [
          { kind: "fs.read", paths: [path.join(root, "a.txt")] },
          { kind: "fs.write", paths: [path.join(root, "sub/b.txt")] },
        ],
        root,
      ),
    ).toBe(true);
  });

  it("refuses an empty capability set — vacuous truth is not confinement", () => {
    expect(confinedToPlowFolder([], root)).toBe(false);
  });

  it("refuses a file capability with no paths", () => {
    expect(confinedToPlowFolder([{ kind: "fs.read", paths: [] }], root)).toBe(false);
    expect(confinedToPlowFolder([{ kind: "fs.read" }], root)).toBe(false);
  });

  it("refuses any path outside, including a sibling prefix look-alike", () => {
    fs.mkdirSync(path.join(home, "Plowman"), { recursive: true });
    expect(
      confinedToPlowFolder([{ kind: "fs.write", paths: [path.join(home, "Plowman/x")] }], root),
    ).toBe(false);
    expect(
      confinedToPlowFolder(
        [
          { kind: "fs.write", paths: [path.join(root, "in.txt")] },
          { kind: "fs.read", paths: [path.join(home, "out.txt")] },
        ],
        root,
      ),
    ).toBe(false);
  });

  it("refuses a symlink inside the folder that points out of it", () => {
    const secret = path.join(home, "secret");
    fs.mkdirSync(secret);
    fs.symlinkSync(secret, path.join(root, "escape"));
    expect(
      confinedToPlowFolder([{ kind: "fs.read", paths: [path.join(root, "escape/key")] }], root),
    ).toBe(false);
  });

  it("refuses a lexical .. traversal", () => {
    expect(
      confinedToPlowFolder([{ kind: "fs.read", paths: [path.join(root, "../out.txt")] }], root),
    ).toBe(false);
  });

  it("refuses every non-file kind, even alongside confined file ops", () => {
    const inside = path.join(root, "a.txt");
    expect(
      confinedToPlowFolder([{ kind: "process.exec", argv: ["ls"], cwd: root }], root),
    ).toBe(false);
    expect(
      confinedToPlowFolder(
        [
          { kind: "fs.write", paths: [inside] },
          { kind: "process.exec", argv: ["ls"], cwd: root },
        ],
        root,
      ),
    ).toBe(false);
    expect(confinedToPlowFolder([{ kind: "browser", origins: ["example.com"] }], root)).toBe(false);
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
