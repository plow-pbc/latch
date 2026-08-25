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
import { execFileSync } from "node:child_process";
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

/** A `just` that succeeds and says so, so `install`/`build` are inert but visible. */
const stubBin = path.join(tmp, "bin");
fs.mkdirSync(stubBin);
fs.writeFileSync(path.join(stubBin, "just"), '#!/bin/sh\necho "stub just $*"\n');
fs.chmodSync(path.join(stubBin, "just"), 0o755);

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

function runSetup(dir: string, donor?: string): string {
  return execFileSync("bash", [path.join(dir, "scripts", "worktree-setup.sh"), ...(donor ? [donor] : [])], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
  });
}

/** Run a setup that must refuse, and hand back what it said on the way out. */
function runSetupExpectingRefusal(dir: string, donor?: string): { stdout: string; stderr: string } {
  try {
    runSetup(dir, donor);
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
    expect(err.stdout).toBeDefined();
    expect(err.stderr).toBeDefined();
    return { stdout: String(err.stdout), stderr: String(err.stderr) };
  }
  throw new Error("setup was expected to refuse, and did not");
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

    const out = runSetup(asking, donor);

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
    expect(out).toContain("stub just install");
    expect(out).toContain("stub just build");
    // Something was copied, so the build that owns readiness runs over it — a
    // good copy makes this a no-op, a stale one costs the rebuild it should.
    // After install and build, so a flake there cannot leave the checkout
    // without node_modules.
    // Whole lines: "stub just fetch-browser-runtime" would satisfy a substring
    // match, and that recipe is not the one this asserts.
    const lines = out.split("\n");
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

    const { stdout, stderr } = runSetupExpectingRefusal(asking);

    expect(stderr).toMatch(/will not adopt a\s+neighbour on its own/);
    expect(stderr).toContain(fs.realpathSync(neighbour));
    // And it stopped before the work, rather than building over a copy it
    // never made.
    expect(stdout).not.toContain("stub just");
  });

  it("sets up with no runtime at all when told to", () => {
    // The way past the refusal above. Without it a checkout beside any usable
    // neighbour could not be set up at all, since the refusal precedes install
    // and build — a worse trap than the one it was guarding against.
    const parent = fs.mkdtempSync(path.join(tmp, "nodonorflag-"));
    checkout(parent, "slot1", PAYLOADS);
    const asking = checkout(parent, "slot0", []);

    const out = runSetup(asking, "--no-donor");

    // Not "nothing nearby" — there is, and saying otherwise would be the one
    // thing that is untrue on this path.
    expect(out).toContain("--no-donor was passed, so nothing is being copied");
    expect(out).toContain("no vendor/vault-server to clone");
    expect(out).toContain("stub just build");
    expect(out).toContain("is ready.");
    // Named as a flag, not adopted as a path.
    expect(fs.existsSync(path.join(asking, "vendor", "python-runtime"))).toBe(false);
    expect(out).not.toContain("stub just fetch-browser");
  });

  it("refuses a named donor that is not a checkout of this repo", () => {
    // The only thing left to refuse. Whether its payloads are complete is not
    // asked here — the build below settles that — so the one mistake worth
    // catching up front is being pointed at the wrong directory entirely.
    const parent = fs.mkdtempSync(path.join(tmp, "baddonor-"));
    const asking = checkout(parent, "slot0", []);
    const stranger = path.join(parent, "elsewhere");
    fs.mkdirSync(stranger, { recursive: true });

    const { stdout, stderr } = runSetupExpectingRefusal(asking, stranger);

    expect(stderr).toMatch(/not a checkout of this repo/);
    expect(stdout).not.toContain("stub just");
  });

  it("does not start a cold build for a donor that had nothing to give", () => {
    // A worktree inherits its donor whether or not that checkout ever built a
    // runtime. Copying nothing is not a reason to fetch ~500 MB and cargo-build
    // vaultwarden here — setting a checkout up has never needed a Rust
    // toolchain, and the errand belongs to whoever wants the browser stack.
    const parent = fs.mkdtempSync(path.join(tmp, "emptydonor-"));
    const empty = checkout(parent, "slot1", []);
    const asking = checkout(parent, "slot0", []);

    const out = runSetup(asking, empty);

    expect(out).toContain("no vendor/python-runtime to clone");
    expect(out).not.toContain("stub just fetch-browser");
    expect(out).toContain("stub just build");
    expect(out).toContain("is ready.");
  });

  it("carries on with no donor when there is nothing nearby to name", () => {
    // A first checkout on a machine has nothing to inherit and nothing to be
    // offered, so there is no choice being withheld — install and build still
    // have to run, and the notes say what did not come across.
    const parent = fs.mkdtempSync(path.join(tmp, "nodonor-"));
    const asking = checkout(parent, "slot0", []);

    const out = runSetup(asking);

    expect(out).toContain("nothing nearby to copy from");
    expect(out).toContain("no vendor/vault-server to clone");
    // Nothing was copied, so there is no seed to validate — and a fetch from
    // scratch is a different, much longer errand than setting a checkout up.
    expect(out).not.toContain("stub just fetch-browser");
    expect(out).toContain("stub just build");
    expect(out).toContain("is ready.");
  });
});
