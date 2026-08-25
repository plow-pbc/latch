/**
 * worktree-setup.sh end to end, with `just` stubbed out.
 *
 * Nothing ran this script before, and it cost: a loop variable renamed to
 * `name` silently took over the checkout's branch name, so the closing report
 * told every owner their state lived in a Plow-Latch-downloads that does not
 * exist. It survived two review rounds because the only thing that would have
 * noticed was a run. The install and build at the end are the reason there was
 * no test, so they are what the stub replaces — everything above them is the
 * script's actual work and runs for real.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS = ["worktree-setup.sh", "runtime-donor.sh", "worktree-name.sh"];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "domo-setup-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A `just` that records nothing and succeeds, so `install`/`build` are inert. */
const stubBin = path.join(tmp, "bin");
fs.mkdirSync(stubBin);
fs.writeFileSync(path.join(stubBin, "just"), '#!/bin/sh\necho "stub just $*"\n');
fs.chmodSync(path.join(stubBin, "just"), 0o755);

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
}

/** A checkout carrying this repo's real scripts and the two pin files. */
function checkout(parent: string, name: string, payloads: string[], branch?: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, "vendor", "browser-server"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  for (const s of SCRIPTS) fs.copyFileSync(path.join(repo, "scripts", s), path.join(dir, "scripts", s));
  // The real pin files, so a donor beside it compares equal on the genuine ones.
  for (const f of ["runtime.lock.json", "requirements.txt"]) {
    fs.copyFileSync(path.join(repo, "vendor/browser-server", f), path.join(dir, "vendor/browser-server", f));
  }
  for (const p of payloads) fs.mkdirSync(path.join(dir, "vendor", p), { recursive: true });
  git(dir, "init", "-q", "-b", branch ?? "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

function runSetup(dir: string): string {
  return execFileSync("bash", [path.join(dir, "scripts", "worktree-setup.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
  });
}

describe("worktree-setup.sh", () => {
  it("copies the donor's payloads and signs off with this checkout's own name", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "run-"));
    const payloads = execFileSync("sh", [path.join(repo, "scripts/runtime-donor.sh"), "--payloads"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    checkout(parent, "slot1", [...payloads, "downloads"]);
    const asking = checkout(parent, "slot0", [], "feature/vault-fix");
    // One payload already built here. The branch that leaves it alone guards a
    // ~500 MB tree from being overwritten by a donor's copy of it, so the proof
    // has to be that this file is still here afterwards.
    fs.mkdirSync(path.join(asking, "vendor", payloads[0]), { recursive: true });
    fs.writeFileSync(path.join(asking, "vendor", payloads[0], "ours"), "keep me");

    const out = runSetup(asking);

    // Everything the donor had, actually on disk — not merely reported.
    for (const p of [...payloads, "downloads"]) {
      expect(fs.existsSync(path.join(asking, "vendor", p))).toBe(true);
    }
    expect(fs.readFileSync(path.join(asking, "vendor", payloads[0], "ours"), "utf8")).toBe("keep me");
    expect(out).toContain(`vendor/${payloads[0]} already present`);
    // The install and build are the point of running setup at all, and the stub
    // is what makes them observable — so assert they were reached.
    expect(out).toContain("stub just install");
    expect(out).toContain("stub just build");
    // The closing hand-off names this checkout's branch and its real home. This
    // is the line the shadowing bug corrupted, and it is what the owner copies.
    expect(out).toContain("Checkout 'feature-vault-fix' is ready.");
    expect(out).toContain("Plow-Latch-feature-vault-fix");
    expect(out).not.toContain("Plow-Latch-downloads");
  });

  it("carries on when nothing nearby qualifies, and says so per payload", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "nodonor-"));
    const asking = checkout(parent, "slot0", []);

    const out = runSetup(asking);

    expect(out).toContain("none nearby has a runtime built from these pins");
    expect(out).toContain("no vendor/vault-server to clone");
    // A checkout with no donor is the ordinary first case, so setup still has
    // to reach the end — the install and build are the point of running it.
    expect(out).toContain("is ready.");
  });

  // Every way the donor script can let setup down. All of them would otherwise
  // be taken by errexit, which exits without printing, so the owner would see
  // the run stop with nothing saying what stopped it — and an empty payload
  // list would not even stop it: the copy loop would do nothing and setup would
  // install, build, and report success over it.
  it.each([
    {
      how: "the payload list names nothing",
      // Fails only for --payloads, so it is that guard being tested and not
      // the donor lookup one line above it.
      stub: '#!/bin/sh\n[ "$1" = "--payloads" ] && exit 0\nexit 0\n',
      says: /failed or named nothing/,
    },
    {
      how: "the payload list fails outright",
      stub: '#!/bin/sh\n[ "$1" = "--payloads" ] && exit 3\nexit 0\n',
      says: /failed or named nothing/,
    },
    {
      how: "the donor lookup fails outright",
      stub: '#!/bin/sh\n[ "$1" = "--payloads" ] && exit 0\nexit 4\n',
      says: /runtime-donor\.sh failed/,
    },
  ])("stops and says so when $how", ({ stub, says }) => {
    const parent = fs.mkdtempSync(path.join(tmp, "brokendonor-"));
    const asking = checkout(parent, "slot0", []);
    fs.writeFileSync(path.join(asking, "scripts", "runtime-donor.sh"), stub);

    expect(() => runSetup(asking)).toThrow(says);
  });
});
