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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "domo-setup-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A `just` that records nothing and succeeds, so `install`/`build` are inert. */
const stubBin = path.join(tmp, "bin");
fs.mkdirSync(stubBin);
fs.writeFileSync(path.join(stubBin, "just"), '#!/bin/sh\necho "stub just $*"\n');
fs.chmodSync(path.join(stubBin, "just"), 0o755);

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
  for (const p of payloads) {
    fs.mkdirSync(path.join(dir, "vendor", p), { recursive: true });
    // Named so a copy that landed a directory deeper is distinguishable from
    // one that landed right — the dir itself exists either way.
    fs.writeFileSync(path.join(dir, "vendor", p, "payload-marker"), p);
  }
  // What build-browser-runtime.mjs writes last, once the build it describes
  // finished — the donor gate reads it to tell a built payload from a fetch
  // still in progress.
  if (payloads.includes("python-runtime")) {
    fs.writeFileSync(path.join(dir, "vendor/python-runtime/.stamp"), "stamped\n");
  }
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
    // What a ^C'd run leaves behind. The copy clears its staging dir before
    // each attempt, so this must not end up inside the payload that lands.
    fs.mkdirSync(path.join(asking, "vendor", `${payloads[1]}.partial`), { recursive: true });
    fs.writeFileSync(path.join(asking, "vendor", `${payloads[1]}.partial`, "junk"), "from a killed run");

    const out = runSetup(asking);

    // Everything the donor had, at the depth it had it — all but the payload
    // this checkout already had, which the branch below is about. Asserting the
    // donor's marker rather than the directory is what separates a copy renamed
    // into place from one nested inside its own staging dir.
    for (const p of [...payloads.slice(1), "downloads"]) {
      expect(fs.readFileSync(path.join(asking, "vendor", p, "payload-marker"), "utf8")).toBe(p);
    }
    expect(fs.readFileSync(path.join(asking, "vendor", payloads[0], "ours"), "utf8")).toBe("keep me");
    expect(fs.existsSync(path.join(asking, "vendor", payloads[1], "junk"))).toBe(false);
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
});
