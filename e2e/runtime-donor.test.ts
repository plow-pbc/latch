/**
 * runtime-donor.sh decides which checkout a new one copies its ~500 MB browser
 * runtime from, and the vault ships inside that runtime — so getting it wrong
 * is either a checkout with no vault at all (no donor, or one missing the
 * payload the vault lives in) or a checkout running versions its lock file
 * never pinned. All of them are quiet, so all of them are pinned here.
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

function donorFor(cwd: string): string {
  return execFileSync("sh", [script], { cwd, encoding: "utf8" }).trim();
}

/**
 * What a complete donor carries, asked of the script rather than restated: it
 * owns the list, and a payload added to the build should extend what "complete"
 * means here without a second edit.
 *
 * Read, not asserted — so the two members this file exists to protect are named
 * once below. Everything else here compares the list against itself, which a
 * list that lost an entry would survive.
 */
const FULL = execFileSync("sh", [script, "--payloads"], { encoding: "utf8" }).trim().split("\n");
/** What plain `just fetch-browser-runtime` leaves behind. The browser and the
 * vault come from the separate `just fetch-browser` pass, so this alone cannot
 * give a checkout either one. */
const PYTHON_ONLY = ["python-runtime"];

const OURS = '{"python":"3.12"}';
const THEIRS = '{"python":"3.11"}';
const OUR_REQS = "camoufox==1\n";

interface Spec {
  /** Directory name, and how rows name their expected winner. */
  name: string;
  payloads: string[];
  lock?: string;
  reqs?: string;
  stamped?: boolean;
  git?: boolean;
}

/**
 * A checkout, as this script sees one: the two pin files it compares, plus
 * whichever runtime payloads have been built.
 */
function checkout(parent: string, spec: Spec): string {
  const dir = path.join(parent, spec.name);
  fs.mkdirSync(path.join(dir, "vendor", "browser-server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "vendor/browser-server/runtime.lock.json"), spec.lock ?? OURS);
  fs.writeFileSync(path.join(dir, "vendor/browser-server/requirements.txt"), spec.reqs ?? OUR_REQS);
  for (const payload of spec.payloads) fs.mkdirSync(path.join(dir, "vendor", payload));
  // Written last by build-browser-runtime.mjs, so its presence is what says the
  // build finished; `stamped: false` is a checkout caught mid-fetch.
  if (spec.payloads.includes("python-runtime") && spec.stamped !== false) {
    fs.writeFileSync(path.join(dir, "vendor/python-runtime/.stamp"), "stamped\n");
  }
  if (spec.git !== false) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  }
  return dir;
}

it("gates on the payloads the browser and the vault actually live in", () => {
  // The rest of the file derives from `payloads()`, so it would follow that
  // list anywhere — including off a cliff. Dropping vault-server from it would
  // stop the donor gate requiring it and stop setup copying it, and every case
  // below would still pass. These two are the point of the script; naming them
  // once is what makes the derivation safe. A fifth payload needs no edit here.
  expect(FULL).toContain("vault-server");
  expect(FULL).toContain("camoufox-browser");
});

describe("runtime-donor.sh, among siblings", () => {
  // One arrange/act shape — lay out a row of checkouts, ask the first one who
  // its donor is — so the differences between cases stay visible as data.
  const cases: { why: string; self?: string[]; siblings: Spec[]; winner: string }[] = [
    {
      why: "takes a sibling that already built this checkout's runtime",
      siblings: [{ name: "slot1", payloads: FULL }],
      winner: "slot1",
    },
    {
      why: "prefers a complete sibling over one carrying only Python",
      // slot1 sorts first, so it is reached first and would win on a bare
      // "has a runtime" test — leaving slot0 with no browser and no vault.
      siblings: [
        { name: "slot1", payloads: PYTHON_ONLY },
        { name: "slot2", payloads: FULL },
      ],
      winner: "slot2",
    },
    {
      why: "settles for a Python-only sibling when nothing nearby is complete",
      // Worth taking: it is the slow half of the fetch, it arrives with its
      // stamp, and the copy loop says per dir what did not come across.
      siblings: [{ name: "slot1", payloads: PYTHON_ONLY }],
      winner: "slot1",
    },
    {
      why: "settles for a browser without a vault, deliberately",
      // The fallback accepts any pin-matching Python runtime, so this donor is
      // taken and the checkout gets a working browser and a Vault tab that
      // says missing. That is the better trade — and it is the state the
      // startup line's "no vault payload" wording exists for — but it is a
      // choice, so it is pinned rather than left to fall out of the tiers.
      siblings: [{ name: "slot1", payloads: FULL.filter((p) => !p.startsWith("vault")) }],
      winner: "slot1",
    },
    {
      why: "refuses a sibling whose lock file is not ours, however complete",
      siblings: [{ name: "slot1", payloads: FULL, lock: THEIRS }],
      winner: "",
    },
    {
      why: "refuses a sibling whose requirements are not ours, however complete",
      // The pins move two ways, and a Python dependency bump with an unchanged
      // lock file is the one a single-file comparison would wave through.
      siblings: [{ name: "slot1", payloads: FULL, reqs: "camoufox==2\n" }],
      winner: "",
    },
    {
      why: "passes over a sibling rebuilding Python under an older browser set",
      // buildRuntime() runs on both passes and deletes vendor/python-runtime
      // outright when the stamp no longer matches, so a re-fetch after a pin
      // bump leaves all four dirs with the Python one mid-rebuild. This is the
      // dangerous one: every dir is present, so the complete tier would take it.
      siblings: [{ name: "slot1", payloads: FULL, stamped: false }],
      winner: "",
    },
    {
      why: "passes over a sibling still in the middle of its first fetch",
      // The Python build runs first and stamps itself when it finishes, so an
      // unstamped python-runtime with nothing else beside it is what a fetch
      // caught in its first pass actually looks like — and the tier that would
      // otherwise take a Python-only donor has to refuse this one.
      siblings: [{ name: "slot1", payloads: PYTHON_ONLY, stamped: false }],
      winner: "",
    },
    {
      why: "passes over a sibling that has built nothing",
      siblings: [{ name: "slot1", payloads: [] }],
      winner: "",
    },
    {
      why: "never answers with itself, complete though it is",
      self: FULL,
      siblings: [{ name: "slot1", payloads: [] }],
      winner: "",
    },
  ];

  it.each(cases)("$why", ({ self, siblings, winner }) => {
    const parent = fs.mkdtempSync(path.join(tmp, "row-"));
    const asking = checkout(parent, { name: "slot0", payloads: self ?? [] });
    const built = siblings.map((s) => checkout(parent, s));
    const expected = winner ? fs.realpathSync(built[siblings.findIndex((s) => s.name === winner)]) : "";
    expect(donorFor(asking)).toBe(expected);
  });
});

describe("runtime-donor.sh, from a linked worktree", () => {
  /** A worktree of `main`, placed where `git worktree add` was pointed — which
   * is routinely not beside its own checkout, so sibling-scanning cannot find
   * it and the git-common-dir is the only way back. */
  function worktreeOf(main: string): string {
    const dir = path.join(fs.mkdtempSync(path.join(tmp, "far-")), "wt");
    git(main, "worktree", "add", "-q", "-b", `f${path.basename(main)}`, dir);
    fs.mkdirSync(path.join(dir, "vendor", "browser-server"), { recursive: true });
    fs.writeFileSync(path.join(dir, "vendor/browser-server/runtime.lock.json"), OURS);
    fs.writeFileSync(path.join(dir, "vendor/browser-server/requirements.txt"), OUR_REQS);
    return dir;
  }

  it("finds the checkout it came from, wherever that sits", () => {
    const main = checkout(fs.mkdtempSync(path.join(tmp, "main-")), {
      name: "repo",
      payloads: FULL,
    });
    expect(donorFor(worktreeOf(main))).toBe(fs.realpathSync(main));
  });

  it("keeps looking past it when it has only Python, and takes a complete sibling", () => {
    // The common-dir candidate is tried first, so a search that stopped at the
    // first match would take the partial one and never see the complete one.
    const parent = fs.mkdtempSync(path.join(tmp, "wtpartial-"));
    const main = checkout(parent, { name: "repo", payloads: PYTHON_ONLY });
    const wt = worktreeOf(main);
    const full = checkout(path.dirname(wt), { name: "slotfull", payloads: FULL });
    expect(donorFor(wt)).toBe(fs.realpathSync(full));
  });
});

describe("runtime-donor.sh, outside a repository", () => {
  it("says nothing, rather than failing", () => {
    // worktree-setup.sh reads this under `set -e`, so the answer for a
    // directory git knows nothing about has to be an empty success — a
    // non-zero status would abort a setup before it installed anything.
    const parent = fs.mkdtempSync(path.join(tmp, "nogit-"));
    const loose = checkout(parent, { name: "loose", payloads: [], git: false });
    // Assert the premise, or this passes for the wrong reason: a tmpdir that
    // happens to sit inside a repository would send the script down the
    // ordinary "in a repo, nothing qualifies" path, which also answers "" with
    // status 0.
    expect(() => git(loose, "rev-parse", "--show-toplevel")).toThrow();
    expect(donorFor(loose)).toBe("");
  });
});
