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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { git, hermeticEnv } from "./gitFixture.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS = ["worktree-setup.sh", "worktree-name.sh", "termic-setup.sh"];
/** The vendor dirs a runtime is made of, as the script under test names them. */
const PAYLOADS = (() => {
  const m = /^payloads="([^"]+)"$/m.exec(fs.readFileSync(path.join(repo, "scripts/worktree-setup.sh"), "utf8"));
  // Loudly, and naming the cause: a reformat of that assignment would otherwise
  // surface as an unreadable TypeError at module load.
  if (!m) throw new Error("could not find the payloads= assignment in worktree-setup.sh");
  return m[1].split(" ");
})();
/** The file worktree-setup.sh refuses a donor for lacking, and termic-setup.sh vouches on. */
const DONOR_MARKER = "vendor/browser-server/runtime.lock.json";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "domo-setup-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const stubBin = path.join(tmp, "bin");

/**
 * The working-tree contents a checkout of this repo needs for these scripts to
 * run in it. Separate from `checkout` because a linked worktree is made by git
 * and populated afterwards, not initialised.
 */
function populate(dir: string, payloads: string[]): string {
  // vendor/ itself, and not the marker's directory below — setup copies each
  // payload into vendor/, and a checkout carrying none of them would otherwise
  // have nowhere to put the first one.
  fs.mkdirSync(path.join(dir, "vendor"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  for (const s of SCRIPTS) fs.copyFileSync(path.join(repo, "scripts", s), path.join(dir, "scripts", s));
  // The refusal's own file, which is the only one a checkout needs here:
  // everything else under vendor/browser-server is read by the runtime build,
  // and that is behind the `just` these runs stub out. The path is stated once,
  // at the top — and every fixture is seeded with it, so re-pointing setup's
  // refusal makes it refuse every donor in the suite rather than slipping by.
  fs.mkdirSync(path.dirname(path.join(dir, DONOR_MARKER)), { recursive: true });
  fs.copyFileSync(path.join(repo, DONOR_MARKER), path.join(dir, DONOR_MARKER));
  for (const p of payloads) {
    fs.mkdirSync(path.join(dir, "vendor", p), { recursive: true });
    // Named so a copy that landed a directory deeper is distinguishable from
    // one that landed right — the dir itself exists either way.
    fs.writeFileSync(path.join(dir, "vendor", p, "payload-marker"), p);
  }
  return dir;
}

/** A checkout of this repo on its own branch, carrying whichever payloads it has. */
function checkout(parent: string, name: string, payloads: string[], branch?: string): string {
  const dir = populate(path.join(parent, name), payloads);
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

/** What a run throws when the script exits non-zero — its own streams. */
class SetupFailed extends Error implements Ran {
  constructor(
    script: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${script} exited non-zero.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  }
}

/**
 * Run one of the scripts under test and hand back both streams, separately.
 * They report on both — the per-payload notes on stdout, the argument errors
 * and the failed-check reason on stderr — so neither alone is the whole answer,
 * and merging them would order the two by stream rather than by when they were
 * written, and fuse the last line of one to the first of the other.
 */
function run(dir: string, script: string, args: string[] = [], failing?: string): Ran {
  const r = spawnSync("bash", [path.join(dir, "scripts", script), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      // Same neutralisation the fixtures are built under — these scripts run
      // git themselves, so it has to hold on this side too. The row that needs
      // no repository above it then fails as "the fixture is not what this
      // needs" rather than as a lookup regression.
      ...hermeticEnv(tmp),
      PATH: `${stubBin}:${process.env.PATH}`,
      JUST_FAIL: failing ?? "",
    },
  });
  // A spawn that never happened, or a child killed on maxBuffer: reported here
  // rather than through `status`, and both streams may be null. Raised as
  // itself, and NOT caught below — a broken environment is not a script exit.
  if (r.error) throw r.error;
  if (r.status !== 0) throw new SetupFailed(script, r.stdout, r.stderr);
  return { stdout: r.stdout, stderr: r.stderr };
}

function runSetup(dir: string, donor?: string, failing?: string): Ran {
  return run(dir, "worktree-setup.sh", donor ? [donor] : [], failing);
}

/** Run a script that must exit non-zero, and hand back what it said on the way. */
function runExpectingFailure(dir: string, script: string, args: string[] = [], failing?: string): Ran {
  try {
    run(dir, script, args, failing);
  } catch (e) {
    if (e instanceof SetupFailed) return e;
    throw e;
  }
  throw new Error(`${script} was expected to fail, and did not`);
}

function runSetupExpectingFailure(dir: string, donor?: string, failing?: string): Ran {
  return runExpectingFailure(dir, "worktree-setup.sh", donor ? [donor] : [], failing);
}

it("names the payloads the browser and the vault live in", () => {
  // PAYLOADS is read from the script, so everything derived from it agrees with
  // it by construction — including a list that lost an entry. These two are the
  // point of copying anything at all, so they are named once, here.
  expect(PAYLOADS).toContain("vault-server");
  expect(PAYLOADS).toContain("camoufox-browser");
});

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

  it("counts a payload that is present as anything, not only as a directory", () => {
    // The skip arm and the check gate both ask `-e`. When they disagreed, a
    // payload present as a regular file was left alone as "already present" and
    // then not counted as something to validate — present for one purpose and
    // absent for the other. No donor, so nothing can set it from the side.
    const parent = fs.mkdtempSync(path.join(tmp, "notadir-"));
    const asking = checkout(parent, "slot0", []);
    for (const p of PAYLOADS) fs.writeFileSync(path.join(asking, "vendor", p), "not a directory\n");

    const { stdout: out } = runSetup(asking);

    expect(out).toContain(`vendor/${PAYLOADS[0]} already present`);
    expect(out.split("\n")).toContain("stub just fetch-browser");
  });

  it("clones nothing from a payload the donor holds as a file", () => {
    // The copy arm's own `-d`, which the filter is aligned against. A donor with
    // a file where a payload goes has nothing to hand over, and copying it would
    // put a file where a directory has to be — so it reports and moves on.
    const parent = fs.mkdtempSync(path.join(tmp, "donorfile-"));
    const donor = checkout(parent, "slot1", PAYLOADS.slice(1));
    fs.writeFileSync(path.join(donor, "vendor", PAYLOADS[0]), "not a directory\n");
    const asking = checkout(parent, "slot0", []);

    const { stdout: out } = runSetup(asking, donor);

    expect(out).toContain(`no vendor/${PAYLOADS[0]} to clone`);
    expect(fs.existsSync(path.join(asking, "vendor", PAYLOADS[0]))).toBe(false);
    // The rest still came, so this is the one payload being declined.
    expect(fs.readFileSync(path.join(asking, "vendor", PAYLOADS[1], "payload-marker"), "utf8")).toBe(PAYLOADS[1]);
    // And a partial landing is still something to check: the gate asks whether
    // any payload is here, not whether the whole runtime is, so the build runs
    // and completes what is missing. Keyed on the first payload instead, this
    // checkout would finish "ready" holding half a runtime nothing had looked at.
    expect(out.split("\n")).toContain("stub just fetch-browser");
  });

  it("refuses to be its own donor", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "selfdonor-"));
    const asking = checkout(parent, "slot0", PAYLOADS);
    const { stderr } = runSetupExpectingFailure(asking, asking);
    expect(stderr).toMatch(/cannot be its own donor/);
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
    expect(stderr).toMatch(/the runtime in vendor\/ did not check out/);
    expect(stdout).not.toContain("is ready.");
  });

  it("checks again on a re-run, and blames no donor for what it did not copy", () => {
    // The gate keys on a runtime being present, not on having copied one. Keyed
    // on the copy, a second run would find every payload already there, skip the
    // only content-aware look at them, and sign the checkout off — which is the
    // way past the gate that the failure message would otherwise be handing out.
    const parent = fs.mkdtempSync(path.join(tmp, "rerun-"));
    const donor = checkout(parent, "slot1", [...PAYLOADS, "downloads"]);
    const asking = checkout(parent, "slot0", []);
    runSetup(asking, donor);

    const { stdout: out } = runSetup(asking, donor);

    expect(out).toContain(`vendor/${PAYLOADS[0]} already present`);
    expect(out.split("\n")).toContain("stub just fetch-browser");

    // The failure must not attribute the payloads to a source: the gate arms on
    // presence, so it is reached with nothing copied.
    //
    // Two halves, because neither covers the class alone. Sameness catches a
    // claim that NAMES the source — the name differs between a run that copied
    // and one that did not — and cannot catch one worded as a constant, since
    // "the copied payloads" reads identically either way. The word list catches
    // that second shape and only that; three earlier versions of this guard
    // were the list alone, and each let the next synonym through, so it matches
    // stems rather than the spellings that happened to be tried.
    //
    // Only the error block is compared: the copying run's `cp` can write to
    // stderr on a filesystem without clonefile, which is not the message.
    const fresh = checkout(parent, "slot9", []);
    const copied = runSetupExpectingFailure(fresh, donor, "fetch-browser");
    const notCopied = runSetupExpectingFailure(asking, undefined, "fetch-browser");
    const complaint = (r: Ran) => {
      const at = r.stderr.indexOf("error:");
      // slice(-1) is the last character, which would compare equal for two
      // runs that both failed some other way and say nothing at all.
      expect(at).toBeGreaterThanOrEqual(0);
      return r.stderr.slice(at);
    };

    // The premise: that run has to have copied, or the two sides are the same
    // shape and the comparison says nothing. This is the invariant that broke
    // silently once already.
    expect(copied.stdout).toMatch(/cloning vendor\//);
    expect(complaint(copied)).toMatch(/the runtime in vendor\/ did not check out/);
    expect(complaint(notCopied)).toBe(complaint(copied));
    expect(complaint(copied)).not.toMatch(/cop(y|ies|ied|ying)|clon(e|es|ed|ing)|donor|came from/i);
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
    /** Payload dirs that must NOT be here afterwards. */
    absent?: string[];
    /** A string the run must not print. */
    omits?: string;
  }[] = [
    {
      why: "given one that had nothing to give",
      // A donor may be named whether or not it ever built a runtime. Copying
      // nothing is not a reason to fetch ~500 MB and cargo-build vaultwarden
      // here.
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
      why: "not given one at all",
      // The ordinary first run: no donor named, so there is none, and setup
      // still has to finish — the browser stack is a later errand.
      donor: () => undefined,
      says: "name one to copy a runtime",
      // Said once. The per-payload notes are for a donor that could not give a
      // payload, not for a run that asked nobody — and keyed on the `note:`
      // prefix, which is what marks that class of line, rather than on the
      // wording, which a reword would slip straight past.
      omits: "note:",
    },
    {
      why: "not given one, beside a neighbour that has everything",
      // The security posture, and now the whole of it: there is no inference
      // left to go wrong, so this is the case that says so. A complete runtime
      // sits one directory away and setup does not look at it, because nothing
      // in this script looks anywhere.
      donor: (parent) => {
        checkout(parent, "slot1", [...PAYLOADS, "downloads"]);
        return undefined;
      },
      says: "name one to copy a runtime",
      absent: PAYLOADS,
      omits: "note:",
    },
  ];

  it.each(noSeed)("finishes without a fetch when $why", ({ donor, says, landed, absent, omits }) => {
    const parent = fs.mkdtempSync(path.join(tmp, "noseed-"));
    const named = donor(parent);
    const asking = checkout(parent, "slot0", []);

    const { stdout: out } = runSetup(asking, named);

    expect(out).toContain(says);
    // Said once, and nothing taken that was not offered.
    if (omits) expect(out).not.toContain(omits);
    for (const p of absent ?? []) {
      expect(fs.existsSync(path.join(asking, "vendor", p))).toBe(false);
    }
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

describe("termic-setup.sh", () => {
  /** A main checkout carrying `payloads`, and a linked worktree of it. */
  function worktreeOf(parent: string, payloads: string[]): { main: string; wt: string } {
    const main = checkout(parent, "main", payloads);
    const wt = path.join(parent, "wt");
    // Added before it is populated: git refuses a target that already has
    // anything in it.
    git(main, "worktree", "add", "-q", "-b", "feature/vault-fix", wt);
    return { main, wt: populate(wt, []) };
  }

  it("names the main checkout, so a worktree of it comes up with a runtime", () => {
    // The hook's whole reason for existing. Termic's setup takes no argument,
    // so without this the worktree it just made starts with no browser and no
    // vault — which is what 579d8ea was fixing.
    const parent = fs.mkdtempSync(path.join(tmp, "termic-wt-"));
    const { main, wt } = worktreeOf(parent, [...PAYLOADS, "downloads"]);

    const { stdout: out } = run(wt, "termic-setup.sh");

    expect(out).toContain(`donor:    ${fs.realpathSync(main)}`);
    // The donor's marker, not the directory — a copy nested inside its own
    // staging dir leaves the directory there either way.
    for (const p of [...PAYLOADS, "downloads"]) {
      expect(fs.readFileSync(path.join(wt, "vendor", p, "payload-marker"), "utf8")).toBe(p);
    }
    expect(out).toContain("Checkout 'feature-vault-fix' is ready.");
  });

  // Two ways the lookup comes back with no donor to name, one contract: setup
  // runs WITHOUT a donor rather than with one it would refuse. A refusal lands
  // before the install and the build, so the worktree would come out with no
  // dependencies and nothing compiled — worse off than the missing runtime this
  // hook exists to fix. What separates the rows is the fixture and what each
  // one is entitled to say.
  const noDonor: { why: string; make: (parent: string) => string; says: RegExp | "" }[] = [
    {
      // Reachable from any checkout that is its own main: git names this one's
      // own .git, the lockfile is tracked so the marker test would pass, and
      // setup would refuse it as its own donor before installing or building.
      // Whether Termic can produce this is not something this repo can check —
      // Termic is not here, and its worktree-only behaviour was inferred from
      // the archive hook, never verified. One condition beats being wrong.
      why: "what it resolves to is this checkout",
      make: (parent) => checkout(parent, "slot0", []),
      // Silent: no other checkout to name, and the note would be false here —
      // this one does hold the marker.
      says: "",
    },
    {
      // A main checkout parked on a commit from before the runtime.
      why: "the main checkout has no runtime to give",
      make: (parent) => {
        const { main, wt } = worktreeOf(parent, PAYLOADS);
        fs.rmSync(path.join(main, DONOR_MARKER));
        return wt;
      },
      // It names the checkout to go and fix, which setup's banner cannot: that
      // offers "name one", which this caller has no way to do. The whole
      // sentence, because half of it was once the claim that was wrong — this
      // donor IS a checkout of this repo, and the missing file is what is true.
      says: /^note: .+\/main holds no vendor\/browser-server\/runtime\.lock\.json, so there\n {2}is no runtime/m,
    },
  ];

  it.each(noDonor)("hands setup no donor when $why", ({ make, says }) => {
    const parent = fs.mkdtempSync(path.join(tmp, "termic-none-"));

    const { stdout: out, stderr } = run(make(parent), "termic-setup.sh");

    expect(out).toContain("donor:    none");
    if (says) expect(stderr).toMatch(says);
    else expect(stderr).toBe("");
    expect(stderr).not.toContain("fatal:");
    // The whole point of not passing a refused donor: these still happen.
    const lines = out.split("\n");
    expect(lines).toContain("stub just install");
    expect(lines).toContain("stub just build");
    expect(out).toContain("is ready.");
  });

  it("stops on git's own failure rather than carrying on with a degraded answer", () => {
    // Folded into one statement the assignment takes `dirname`'s status, git's
    // failure goes unseen by `set -e`, and `dirname ""` hands back "." — this
    // checkout under another name, handed to setup as its donor. Nothing else
    // here can see the split: every other row runs inside a real repository,
    // where the lookup succeeds. Reachable with no UI and no human, so it is
    // testable, so it is tested.
    const parent = fs.mkdtempSync(path.join(tmp, "termic-norepo-"));

    const { stdout, stderr } = runExpectingFailure(populate(path.join(parent, "loose"), []), "termic-setup.sh");

    expect(stderr).toContain("fatal:");
    // It stopped there: no install, no build, and not setup's own refusal of a
    // donor it should never have been handed.
    expect(stdout).not.toContain("stub just");
    expect(stderr).not.toContain("its own donor");
  });
});
