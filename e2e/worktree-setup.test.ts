/**
 * worktree-setup.sh end to end, with `just` stubbed out.
 *
 * Nothing ran this script before, and it cost: a loop variable renamed to
 * `name` silently took over the checkout's branch name, so the closing report
 * told every owner their state lived in a Plow-Latch-downloads that does not
 * exist. It survived two review rounds because the only thing that would have
 * noticed was a run. The install and build at the end are the reason there was
 * no test, so they are what a stubbed `just` replaces — everything above them
 * is the script's actual work, running for real against real donor checkouts.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { git } from "./gitFixture.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS = ["worktree-setup.sh", "runtime-donor.sh", "worktree-name.sh"];
const PAYLOADS = execFileSync("sh", [path.join(repo, "scripts/runtime-donor.sh"), "--payloads"], {
  encoding: "utf8",
})
  .trim()
  .split("\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "domo-setup-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const stubBin = path.join(tmp, "bin");

/** A checkout carrying this repo's real scripts and the two real pin files. */
function checkout(parent: string, name: string, payloads: string[], branch?: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, "vendor", "browser-server"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  for (const s of SCRIPTS) fs.copyFileSync(path.join(repo, "scripts", s), path.join(dir, "scripts", s));
  for (const f of ["runtime.lock.json", "requirements.txt"]) {
    fs.copyFileSync(path.join(repo, "vendor/browser-server", f), path.join(dir, "vendor/browser-server", f));
  }
  for (const p of payloads) {
    fs.mkdirSync(path.join(dir, "vendor", p), { recursive: true });
    // Named so a copy that landed a directory deeper is distinguishable from
    // one that landed right — the dir itself exists either way.
    fs.writeFileSync(path.join(dir, "vendor", p, "payload-marker"), p);
  }
  git(dir, "init", "-q", "-b", branch ?? "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

/**
 * A `just` that says what it was asked for, so the real recipes stay inert but
 * visible, and fails the one named in JUST_FAIL. The emptiness guard matters:
 * unset, JUST_FAIL is "" and a bare `just` would otherwise match it.
 */
fs.mkdirSync(stubBin);
fs.writeFileSync(
  path.join(stubBin, "just"),
  '#!/bin/sh\necho "stub just $*"\n' +
    '[ -n "$JUST_FAIL" ] && [ "$1" = "$JUST_FAIL" ] && exit 1\nexit 0\n',
);
fs.chmodSync(path.join(stubBin, "just"), 0o755);

interface Ran {
  stdout: string;
  stderr: string;
}

/** What runSetup throws when the script exits non-zero — its own streams. */
class SetupFailed extends Error implements Ran {
  constructor(
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`worktree-setup.sh exited non-zero.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  }
}

/**
 * Run setup and hand back both streams, separately. It reports on both — the
 * per-payload notes on stdout, the refusals and the failed-check reason on
 * stderr — so neither alone is the whole answer, and merging them would order
 * the two by stream rather than by when they were written, and fuse the last
 * line of one to the first of the other.
 */
function runSetup(dir: string, donor?: string, failing?: string): Ran {
  const r = spawnSync("bash", [path.join(dir, "scripts", "worktree-setup.sh"), ...(donor ? [donor] : [])], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}`, JUST_FAIL: failing ?? "" },
  });
  // A spawn that never happened, or a child killed on maxBuffer: reported here
  // rather than through `status`, and both streams may be null. Raised as
  // itself, and NOT caught below — a broken environment is not a refusal.
  if (r.error) throw r.error;
  if (r.status !== 0) throw new SetupFailed(r.stdout, r.stderr);
  return { stdout: r.stdout, stderr: r.stderr };
}

/** Run a setup that must exit non-zero, and hand back what it said on the way. */
function runSetupExpectingFailure(dir: string, donor?: string, failing?: string): Ran {
  try {
    runSetup(dir, donor, failing);
  } catch (e) {
    if (e instanceof SetupFailed) return e;
    throw e;
  }
  throw new Error("setup was expected to fail, and did not");
}

describe("worktree-setup.sh", () => {
  it("copies the named donor's payloads and signs off with this checkout's own name", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "run-"));
    const donor = checkout(parent, "slot1", [...PAYLOADS, "downloads"]);
    const asking = checkout(parent, "slot0", [], "feature/vault-fix");
    // One payload already built here. The branch that leaves it alone guards a
    // ~500 MB tree from being overwritten, so the proof is that this survives.
    fs.mkdirSync(path.join(asking, "vendor", PAYLOADS[0]), { recursive: true });
    fs.writeFileSync(path.join(asking, "vendor", PAYLOADS[0], "ours"), "keep me");
    // What a ^C'd run leaves behind. The copy clears its staging dir before
    // each attempt, so this must not end up inside the payload that lands.
    fs.mkdirSync(path.join(asking, "vendor", `${PAYLOADS[1]}.partial`), { recursive: true });
    fs.writeFileSync(path.join(asking, "vendor", `${PAYLOADS[1]}.partial`, "junk"), "from a killed run");

    const { stdout: out } = runSetup(asking, donor);

    // Everything the donor had, at the depth it had it — all but the payload
    // this checkout already carried. Asserting the donor's marker rather than
    // the directory is what separates a copy renamed into place from one
    // nested inside its own staging dir.
    for (const p of [...PAYLOADS.slice(1), "downloads"]) {
      expect(fs.readFileSync(path.join(asking, "vendor", p, "payload-marker"), "utf8")).toBe(p);
    }
    expect(fs.readFileSync(path.join(asking, "vendor", PAYLOADS[0], "ours"), "utf8")).toBe("keep me");
    // The already-present branch's contract is "nothing of the donor's landed
    // here", not merely "ours survived a merge into it".
    expect(fs.existsSync(path.join(asking, "vendor", PAYLOADS[0], "payload-marker"))).toBe(false);
    expect(fs.existsSync(path.join(asking, "vendor", PAYLOADS[1], "junk"))).toBe(false);
    // Whole lines throughout: a substring match on "stub just fetch-browser"
    // is also satisfied by "stub just fetch-browser-runtime", and on
    // "stub just build" by nothing here today but as easily tomorrow.
    const lines = out.split("\n");
    expect(lines).toContain("stub just install");
    expect(lines).toContain("stub just build");
    // Something was copied, so the build that owns readiness runs over it — a
    // good copy makes this a no-op, a stale one costs the rebuild it should.
    // After install and build, so a flake there cannot leave the checkout
    // without node_modules.
    expect(lines).toContain("stub just fetch-browser");
    expect(lines.indexOf("stub just fetch-browser")).toBeGreaterThan(lines.indexOf("stub just build"));
    // The closing hand-off names this checkout's branch and its real home. This
    // is the line the shadowing bug corrupted, and it is what the owner copies.
    expect(out).toContain("Checkout 'feature-vault-fix' is ready.");
    expect(out).toContain("Plow-Latch-feature-vault-fix");
    expect(out).not.toContain("Plow-Latch-downloads");
  });

  it("refuses to pick a neighbour, and names the ones it can see instead", () => {
    // The security posture, from the caller's side: a perfectly good neighbour
    // sits right there and setup still will not take it unasked. It says which
    // one it would have been, because listing is not choosing.
    const parent = fs.mkdtempSync(path.join(tmp, "unasked-"));
    const neighbour = checkout(parent, "slot1", PAYLOADS);
    const asking = checkout(parent, "slot0", []);

    const { stdout, stderr } = runSetupExpectingFailure(asking);

    expect(stderr).toMatch(/will not adopt a\s+neighbour on its own/);
    expect(stderr).toContain(fs.realpathSync(neighbour));
    // And it stopped before the work, rather than building over a copy it
    // never made.
    expect(stdout).not.toContain("stub just");
  });

  it("refuses a named donor that is not a checkout of this repo", () => {
    // The only thing left to refuse. Whether its payloads are complete is not
    // asked here — the build below settles that — so the one mistake worth
    // catching up front is being pointed at the wrong directory entirely.
    const parent = fs.mkdtempSync(path.join(tmp, "baddonor-"));
    const asking = checkout(parent, "slot0", []);
    const stranger = path.join(parent, "elsewhere");
    fs.mkdirSync(stranger, { recursive: true });

    const { stdout, stderr } = runSetupExpectingFailure(asking, stranger);

    expect(stderr).toMatch(/not a checkout of this repo/);
    expect(stdout).not.toContain("stub just");
  });

  it("fails after the build rather than before it, and does not sign off", () => {
    // The check is the only content-aware look at what was copied, and
    // browserRuntime.ts accepts payloads on path existence alone — so a
    // suppressed failure would leave the checkout declared ready over a runtime
    // nothing has looked at. It fails. What its position buys is that the
    // dependencies and the build survive, which is the whole reason it moved
    // below them.
    const parent = fs.mkdtempSync(path.join(tmp, "failcheck-"));
    const donor = checkout(parent, "slot1", [...PAYLOADS, "downloads"]);
    const asking = checkout(parent, "slot0", []);

    const { stdout, stderr } = runSetupExpectingFailure(asking, donor, "fetch-browser");
    const lines = stdout.split("\n");

    expect(lines).toContain("stub just fetch-browser");
    // The dependencies and the build survived, which is what its position buys.
    expect(lines).toContain("stub just install");
    expect(lines).toContain("stub just build");
    // And it says so, rather than stopping with only the recipe's own error.
    expect(stderr).toMatch(/did not check out, so this checkout is NOT/);
    expect(stdout).not.toContain("is ready.");
  });

  // Four ways to arrive with nothing worth checking, one contract: setup
  // finishes, and the build that validates a seed does not run because there is
  // no seed. Each row keeps only what distinguishes it.
  const noSeed: {
    why: string;
    donor: (parent: string) => string | undefined;
    says: string;
    /** A vendor dir that must still have been copied, where one is. */
    landed?: string;
  }[] = [
    {
      why: "told not to take one",
      donor: (parent) => {
        checkout(parent, "slot1", PAYLOADS);
        return "--no-donor";
      },
      says: "--no-donor was passed, so nothing is being copied",
    },
    {
      why: "given one that had nothing to give",
      // A worktree inherits its donor whether or not that checkout ever built a
      // runtime. Copying nothing is not a reason to fetch ~500 MB and
      // cargo-build vaultwarden here.
      donor: (parent) => checkout(parent, "slot1", []),
      says: "no vendor/python-runtime to clone",
    },
    {
      why: "given one carrying only the download cache",
      // Not a payload — it is what a fetch downloads FROM, so on its own it
      // leaves this checkout nothing to validate. It still gets copied, which
      // is what separates this row from the empty donor above.
      donor: (parent) => checkout(parent, "slot1", ["downloads"]),
      says: "no vendor/python-runtime to clone",
      landed: "downloads",
    },
    {
      why: "with nothing nearby to name at all",
      // A first checkout on a machine: nothing to inherit and nothing offered,
      // so no choice is being withheld and setup still has to finish.
      donor: () => undefined,
      says: "nothing nearby to copy from",
    },
  ];

  it.each(noSeed)("finishes without a fetch when $why", ({ donor, says, landed }) => {
    const parent = fs.mkdtempSync(path.join(tmp, "noseed-"));
    const named = donor(parent);
    const asking = checkout(parent, "slot0", []);

    const { stdout: out } = runSetup(asking, named);

    expect(out).toContain(says);
    // The donor's marker, not the directory — the same distinction the copy
    // case makes, since a nested copy leaves the directory there either way.
    if (landed) {
      expect(fs.readFileSync(path.join(asking, "vendor", landed, "payload-marker"), "utf8")).toBe(landed);
    }
    expect(out).not.toContain("stub just fetch-browser");
    expect(out.split("\n")).toContain("stub just build");
    expect(out).toContain("is ready.");
  });
});
