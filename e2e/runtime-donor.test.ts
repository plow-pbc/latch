/**
 * runtime-donor.sh decides WHO may hand this checkout a ~500 MB browser runtime
 * — payloads that then get executed here, outside the seatbelt, with this
 * checkout's vault and relay credential in reach. So the load-bearing behaviour
 * is what it refuses: it never picks a neighbour, however good, because a
 * checkout is an ordinary thing to hand an agent. A worktree inherits from the
 * checkout it was made out of; anything else a human names.
 *
 * It decides nothing about whether the payloads are any good. That belongs to
 * build-browser-runtime.mjs, which worktree-setup.sh runs after the copy, so
 * there is no readiness contract here to pin.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { git } from "./gitFixture.js";

const script = fileURLToPath(new URL("../scripts/runtime-donor.sh", import.meta.url));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "domo-donor-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function donor(cwd: string, ...args: string[]): string {
  return execFileSync("sh", [script, ...args], { cwd, encoding: "utf8" }).trim();
}

/** `--check`'s answer, which is an exit status rather than output. */
function accepts(cwd: string, dir: string): boolean {
  try {
    execFileSync("sh", [script, "--check", dir], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const FULL = execFileSync("sh", [script, "--payloads"], { encoding: "utf8" }).trim().split("\n");

/** A checkout of this repo, carrying whichever payloads it has built. */
function checkout(parent: string, name: string, payloads: string[] = []): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, "vendor", "browser-server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "vendor/browser-server/runtime.lock.json"), "{}\n");
  for (const p of payloads) fs.mkdirSync(path.join(dir, "vendor", p), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

it("names the payloads the browser and the vault live in", () => {
  // worktree-setup.sh copies whatever this list says, so a payload dropped from
  // it silently stops being copied. Everything else derives from the list.
  expect(FULL).toContain("vault-server");
  expect(FULL).toContain("camoufox-browser");
});

describe("runtime-donor.sh picks nobody on its own", () => {
  it("leaves a plain clone with no donor, however good the neighbour", () => {
    // The whole security posture in one case: a neighbour is never promoted to
    // donor by proximity. A human names one, and the same directory is accepted
    // the moment they do.
    const parent = fs.mkdtempSync(path.join(tmp, "plain-"));
    const asking = checkout(parent, "slot0");
    const neighbour = checkout(parent, "slot1", FULL);

    expect(donor(asking)).toBe("");
    expect(accepts(asking, neighbour)).toBe(true);
  });

  it("inherits from the checkout a linked worktree was made out of", () => {
    // The one donor that needs no naming: a worktree already runs on that
    // checkout's git dir, so the trust is one it was created with.
    const main = checkout(fs.mkdtempSync(path.join(tmp, "main-")), "repo", FULL);
    const wt = path.join(fs.mkdtempSync(path.join(tmp, "far-")), "wt");
    git(main, "worktree", "add", "-q", "-b", "feature", wt);
    fs.mkdirSync(path.join(wt, "vendor", "browser-server"), { recursive: true });
    fs.writeFileSync(path.join(wt, "vendor/browser-server/runtime.lock.json"), "{}\n");

    expect(donor(wt)).toBe(fs.realpathSync(main));
  });

  it("says nothing outside a git repository, rather than failing", () => {
    // worktree-setup.sh reads this under `set -e`, so a directory git knows
    // nothing about has to be an empty success, not a non-zero abort.
    const parent = fs.mkdtempSync(path.join(tmp, "nogit-"));
    const loose = path.join(parent, "loose");
    fs.mkdirSync(loose, { recursive: true });
    expect(() => git(loose, "rev-parse", "--show-toplevel")).toThrow();
    expect(donor(loose)).toBe("");
  });
});

describe("runtime-donor.sh --check vets the one it is handed", () => {
  it("takes a checkout of this repo", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "check-"));
    expect(accepts(checkout(parent, "asking"), checkout(parent, "d", FULL))).toBe(true);
  });

  it("takes one whose payloads are absent, or half-built, or stale", () => {
    // Deliberately not this script's business. Whatever came across is checked
    // by the build worktree-setup.sh runs afterwards, whose stamps compare
    // content — so an incomplete donor costs a rebuild rather than a refusal,
    // and there is no second notion of "ready" here to drift from the first.
    const parent = fs.mkdtempSync(path.join(tmp, "partial-"));
    expect(accepts(checkout(parent, "asking"), checkout(parent, "d"))).toBe(true);
  });

  it("refuses a directory that is not a checkout of this repo", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "stranger-"));
    const stranger = path.join(parent, "elsewhere");
    fs.mkdirSync(stranger, { recursive: true });
    expect(accepts(checkout(parent, "asking"), stranger)).toBe(false);
  });

  it("refuses this checkout itself", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "self-"));
    const asking = checkout(parent, "slot0", FULL);
    expect(accepts(asking, asking)).toBe(false);
  });
});

describe("runtime-donor.sh --candidates advises without choosing", () => {
  it("names the neighbours worth naming, and nothing else", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "cand-"));
    const asking = checkout(parent, "slot0");
    const worth = checkout(parent, "slot1", FULL);
    // Nothing to copy: suggesting it would only send someone to a checkout that
    // saves them nothing.
    checkout(parent, "slot2");

    // Listing is not choosing: the same run still inherits no donor.
    expect(donor(asking, "--candidates").split("\n")).toEqual([fs.realpathSync(worth)]);
    expect(donor(asking)).toBe("");
  });
});
