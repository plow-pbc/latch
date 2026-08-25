/**
 * runtime-donor.sh decides which checkout a new one copies its ~500 MB browser
 * runtime from, and the vault ships inside that runtime — so getting it wrong
 * is either a checkout with no vault at all (no donor found) or a checkout
 * running versions its lock file never pinned (wrong donor found). Both are
 * quiet, so both are pinned here.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/runtime-donor.sh", import.meta.url));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "domo-donor-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
}

function donorFor(cwd: string): string {
  return execFileSync("sh", [script], { cwd, encoding: "utf8" }).trim();
}

/**
 * A checkout, as this script sees one: the two pin files it compares, plus a
 * built runtime when `runtime` says so. `pins` is what makes two checkouts
 * agree or disagree.
 */
function checkout(
  parent: string,
  name: string,
  opts: { pins: string; runtime: boolean; git?: boolean },
): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, "vendor", "browser-server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "vendor/browser-server/runtime.lock.json"), opts.pins);
  fs.writeFileSync(path.join(dir, "vendor/browser-server/requirements.txt"), "camoufox==1\n");
  if (opts.runtime) fs.mkdirSync(path.join(dir, "vendor", "python-runtime"));
  if (opts.git !== false) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  }
  return dir;
}

const OURS = '{"python":"3.12"}';
const THEIRS = '{"python":"3.11"}';

describe("runtime-donor.sh", () => {
  it("picks a sibling that already built this checkout's runtime", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "picks-"));
    const self = checkout(parent, "slot0", { pins: OURS, runtime: false });
    const donor = checkout(parent, "slot1", { pins: OURS, runtime: true });
    expect(donorFor(self)).toBe(fs.realpathSync(donor));
  });

  it("refuses a sibling whose pins are not ours, however complete its runtime", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "pins-"));
    const self = checkout(parent, "slot0", { pins: OURS, runtime: false });
    checkout(parent, "slot1", { pins: THEIRS, runtime: true });
    // Better no runtime than one built from a lock file this checkout never
    // pinned: everything would still resolve, and the wrong versions would run.
    expect(donorFor(self)).toBe("");
  });

  it("passes over a sibling with no runtime, and never answers with itself", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "empty-"));
    // The checkout asking has vendor/browser-server of its own, which is what
    // it would match on if it did not exclude itself.
    const self = checkout(parent, "slot0", { pins: OURS, runtime: true });
    checkout(parent, "slot1", { pins: OURS, runtime: false });
    expect(donorFor(self)).toBe("");
  });

  it("still finds the checkout a linked worktree came from, wherever it sits", () => {
    // The original case, and the one sibling-scanning cannot cover: a worktree
    // is placed wherever `git worktree add` was pointed, which is routinely not
    // beside its main checkout.
    const main = checkout(fs.mkdtempSync(path.join(tmp, "main-")), "repo", {
      pins: OURS,
      runtime: true,
    });
    const elsewhere = path.join(fs.mkdtempSync(path.join(tmp, "far-")), "wt");
    git(main, "worktree", "add", "-q", "-b", "feature", elsewhere);
    fs.mkdirSync(path.join(elsewhere, "vendor", "browser-server"), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "vendor/browser-server/runtime.lock.json"), OURS);
    fs.writeFileSync(path.join(elsewhere, "vendor/browser-server/requirements.txt"), "camoufox==1\n");
    expect(donorFor(elsewhere)).toBe(fs.realpathSync(main));
  });
});
