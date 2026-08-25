/**
 * worktree-name.sh is what keys every piece of per-worktree state (justfile
 * homes, Electron userData, screenshot dirs), so its two contracts are worth
 * pinning: silence in a main checkout, and a filesystem-safe branch name in a
 * linked worktree.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { git, hermeticEnv } from "./gitFixture.js";

const script = fileURLToPath(new URL("../scripts/worktree-name.sh", import.meta.url));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "domo-wt-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function nameIn(cwd: string, ...args: string[]): string {
  // The script asks git where it is, so it needs the same neutralised
  // environment the fixtures are built under — GIT_DIR and friends would
  // otherwise answer for the outer repository, and the cases that expect no
  // repository at all would find one above the temp directory.
  return execFileSync("sh", [script, ...args], {
    cwd,
    encoding: "utf8",
    env: hermeticEnv(fs.realpathSync(tmp)),
  }).trim();
}

function makeRepo(dir: string): string {
  const repo = path.join(tmp, dir);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

describe("hermeticEnv", () => {
  it("keeps a repository ABOVE the fixture root out of reach", () => {
    // The ceiling has to be the root's PARENT. GIT_CEILING_DIRECTORIES stops
    // git chdir-ing UP INTO a listed directory, so listing the root itself
    // leaves a lookup that starts AT the root free to check there and then
    // ascend past a ceiling it never enters. Both spellings behave identically
    // unless a repository actually sits above the root, which no ordinary
    // machine provides and which is why the correction had only a comment
    // holding it — so the outer repository is built here rather than waited for.
    const outer = path.join(tmp, "outer");
    const root = path.join(outer, "root");
    fs.mkdirSync(root, { recursive: true });
    git(outer, "init", "-q", "-b", "main");

    const said = execFileSync("sh", [script, "--branch"], {
      cwd: root,
      encoding: "utf8",
      env: hermeticEnv(root),
    }).trim();

    expect(said).toBe("");
  });
});

describe("worktree-name.sh", () => {
  it("prints nothing in a main checkout and outside a repo", () => {
    const repo = makeRepo("plain");
    expect(nameIn(repo)).toBe("");
    expect(nameIn(tmp)).toBe("");
  });

  it("prints the branch name in a linked worktree, normalized for paths", () => {
    const repo = makeRepo("normalize");
    const wt = path.join(tmp, "wt-branch");
    git(repo, "worktree", "add", "-q", "-b", "feature/foo@bar", wt);
    expect(nameIn(wt)).toBe("feature-foo-bar");
    // The main checkout still reads as main even while worktrees exist.
    expect(nameIn(repo)).toBe("");
  });

  it("falls back to the worktree directory name on a detached HEAD", () => {
    const repo = makeRepo("detached");
    const wt = path.join(tmp, "wt-detached");
    git(repo, "worktree", "add", "-q", "--detach", wt);
    expect(nameIn(wt)).toBe("wt-detached");
  });

  // --branch keys the per-branch app homes ("Domo-<branch>"), so unlike the
  // bare mode it must name EVERY checkout — the main one included — and still
  // print nothing outside a repository.
  it("--branch prints the normalized branch name in any checkout", () => {
    const repo = makeRepo("branch-mode");
    expect(nameIn(repo, "--branch")).toBe("main");
    const wt = path.join(tmp, "wt-branch-mode");
    git(repo, "worktree", "add", "-q", "-b", "feature/foo@bar", wt);
    expect(nameIn(wt, "--branch")).toBe("feature-foo-bar");
    expect(nameIn(tmp, "--branch")).toBe("");
  });
});
