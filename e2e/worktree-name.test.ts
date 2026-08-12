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

const script = fileURLToPath(new URL("../scripts/worktree-name.sh", import.meta.url));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "domo-wt-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
}

function nameIn(cwd: string): string {
  return execFileSync("sh", [script], { cwd, encoding: "utf8" }).trim();
}

function makeRepo(dir: string): string {
  const repo = path.join(tmp, dir);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

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
});
