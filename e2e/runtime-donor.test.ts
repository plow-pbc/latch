/**
 * runtime-donor.sh decides which checkout a new one copies its ~500 MB browser
 * runtime from, and the vault ships inside that runtime — so getting it wrong
 * is either a checkout with no vault at all (no donor found, or a donor missing
 * the payload the vault lives in) or a checkout running versions its lock file
 * never pinned (wrong donor found). All of them are quiet, so all of them are
 * pinned here.
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

/** What `just fetch-browser-runtime --browser` leaves behind, all told. */
const FULL = ["python-runtime", "camoufox-browser", "vault-server", "vault-cli"];
/** What plain `just fetch-browser-runtime` leaves behind — the browser and the
 * vault come from the `--browser` pass, so this alone is a useless donor. */
const PYTHON_ONLY = ["python-runtime"];

const OURS = '{"python":"3.12"}';
const THEIRS = '{"python":"3.11"}';

/**
 * A checkout, as this script sees one: the two pin files it compares, plus
 * whichever runtime payloads have been built. `pins` is what makes two
 * checkouts agree or disagree.
 */
function checkout(
  parent: string,
  name: string,
  opts: { pins: string; payloads: string[]; git?: boolean },
): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, "vendor", "browser-server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "vendor/browser-server/runtime.lock.json"), opts.pins);
  fs.writeFileSync(path.join(dir, "vendor/browser-server/requirements.txt"), "camoufox==1\n");
  for (const payload of opts.payloads) fs.mkdirSync(path.join(dir, "vendor", payload));
  if (opts.git !== false) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  }
  return dir;
}

describe("runtime-donor.sh", () => {
  it("picks a sibling that already built this checkout's runtime", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "picks-"));
    const self = checkout(parent, "slot0", { pins: OURS, payloads: [] });
    const donor = checkout(parent, "slot1", { pins: OURS, payloads: FULL });
    expect(donorFor(self)).toBe(fs.realpathSync(donor));
  });

  it("refuses a sibling whose pins are not ours, however complete its runtime", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "pins-"));
    const self = checkout(parent, "slot0", { pins: OURS, payloads: [] });
    checkout(parent, "slot1", { pins: THEIRS, payloads: FULL });
    // Better no runtime than one built from a lock file this checkout never
    // pinned: everything would still resolve, and the wrong versions would run.
    expect(donorFor(self)).toBe("");
  });

  it("holds out for a donor with the browser and the vault, not just Python", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "partial-"));
    const self = checkout(parent, "slot0", { pins: OURS, payloads: [] });
    // Alphabetically first, so it is reached first and would win on a bare
    // "has a runtime" test — and would leave slot0 in exactly the no-browser,
    // no-vault state this script exists to prevent.
    checkout(parent, "slot1", { pins: OURS, payloads: PYTHON_ONLY });
    const full = checkout(parent, "slot2", { pins: OURS, payloads: FULL });
    expect(donorFor(self)).toBe(fs.realpathSync(full));
  });

  it("passes over a sibling with no runtime, and never answers with itself", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "empty-"));
    // The checkout asking has a full runtime of its own, which is what it would
    // match on if it did not exclude itself.
    const self = checkout(parent, "slot0", { pins: OURS, payloads: FULL });
    checkout(parent, "slot1", { pins: OURS, payloads: [] });
    expect(donorFor(self)).toBe("");
  });

  it("says nothing outside a git repository, rather than failing", () => {
    // worktree-setup.sh reads this under `set -e`, so the answer for a
    // directory git knows nothing about has to be an empty success — a
    // non-zero status here would abort a setup before it installed anything.
    const parent = fs.mkdtempSync(path.join(tmp, "nogit-"));
    const self = checkout(parent, "loose", { pins: OURS, payloads: [], git: false });
    expect(donorFor(self)).toBe("");
  });

  it("still finds the checkout a linked worktree came from, wherever it sits", () => {
    // The original case, and the one sibling-scanning cannot cover: a worktree
    // is placed wherever `git worktree add` was pointed, which is routinely not
    // beside its main checkout.
    const main = checkout(fs.mkdtempSync(path.join(tmp, "main-")), "repo", {
      pins: OURS,
      payloads: FULL,
    });
    const elsewhere = path.join(fs.mkdtempSync(path.join(tmp, "far-")), "wt");
    git(main, "worktree", "add", "-q", "-b", "feature", elsewhere);
    fs.mkdirSync(path.join(elsewhere, "vendor", "browser-server"), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "vendor/browser-server/runtime.lock.json"), OURS);
    fs.writeFileSync(path.join(elsewhere, "vendor/browser-server/requirements.txt"), "camoufox==1\n");
    expect(donorFor(elsewhere)).toBe(fs.realpathSync(main));
  });
});
