/**
 * runtime-donor.sh decides which checkout may hand this one a ~500 MB browser
 * runtime — payloads that then get executed here, outside the seatbelt, with
 * this checkout's vault and relay credential in reach. So the load-bearing
 * behaviour is what it REFUSES: it never picks a neighbour, however perfect,
 * because a checkout is an ordinary thing to hand an agent and qualification is
 * cheap to forge. A worktree inherits from the checkout it was made out of;
 * anything else a human names, and `--check` is what vets that name.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { git } from "./gitFixture.js";
import { ARCH, markBuilt, markStarted, writeMarker } from "./payloadFixture.js";

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

/**
 * What a complete donor carries, asked of the script rather than restated: it
 * owns the list. Read, not asserted — so the two members this file exists to
 * protect are named once below.
 */
const FULL = execFileSync("sh", [script, "--payloads"], { encoding: "utf8" }).trim().split("\n");

const OURS = '{"python":"3.12"}';
const THEIRS = '{"python":"3.11"}';
const OUR_REQS = "camoufox==1\n";

interface Spec {
  name: string;
  payloads: string[];
  lock?: string;
  reqs?: string;
  /** A payload to leave with none of its markers — a fetch caught in flight. */
  unfinished?: string;
  /** One marker path to withhold, when the payload's others should stay. */
  withoutMarker?: string;
  /** A directory under vendor/ to remove entirely, after markers are written. */
  withoutPayloadDir?: string;
  /** One extra marker path to write, for the trees a donor may build instead. */
  alsoMarker?: string;
}

function checkout(parent: string, spec: Spec): string {
  const dir = path.join(parent, spec.name);
  fs.mkdirSync(path.join(dir, "vendor", "browser-server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "vendor/browser-server/runtime.lock.json"), spec.lock ?? OURS);
  fs.writeFileSync(path.join(dir, "vendor/browser-server/requirements.txt"), spec.reqs ?? OUR_REQS);
  for (const payload of spec.payloads) {
    fs.mkdirSync(path.join(dir, "vendor", payload), { recursive: true });
    if (payload === spec.unfinished) markStarted(dir, payload);
    else markBuilt(dir, payload);
  }
  if (spec.withoutMarker) fs.rmSync(path.join(dir, "vendor", spec.withoutMarker));
  if (spec.withoutPayloadDir) {
    fs.rmSync(path.join(dir, "vendor", spec.withoutPayloadDir), { recursive: true, force: true });
  }
  if (spec.alsoMarker) writeMarker(dir, spec.alsoMarker);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

it("gates on the payloads the browser and the vault actually live in", () => {
  // Everything else here derives from `payloads()`, so it would follow that
  // list anywhere, including off a cliff. These two are the point of the script.
  expect(FULL).toContain("vault-server");
  expect(FULL).toContain("camoufox-browser");
});

describe("runtime-donor.sh picks nobody on its own", () => {
  it("leaves a plain clone with no donor, however good the neighbour", () => {
    // The whole security posture in one case. Qualification is forgeable —
    // empty directories and empty marker files, which is what this fixture
    // literally builds — so a neighbour is never promoted to donor by
    // proximity. A human names one, and `--check` vets it.
    const parent = fs.mkdtempSync(path.join(tmp, "plain-"));
    const asking = checkout(parent, { name: "slot0", payloads: [] });
    const neighbour = checkout(parent, { name: "slot1", payloads: FULL });

    expect(donor(asking)).toBe("");
    // Not because it was unusable — the same directory passes when NAMED.
    expect(accepts(asking, neighbour)).toBe(true);
  });

  it("inherits from the checkout a linked worktree was made out of", () => {
    // The one donor that needs no naming: a worktree already runs on that
    // checkout's git dir, so the trust is one it was created with.
    const main = checkout(fs.mkdtempSync(path.join(tmp, "main-")), {
      name: "repo",
      payloads: FULL,
    });
    const wt = path.join(fs.mkdtempSync(path.join(tmp, "far-")), "wt");
    git(main, "worktree", "add", "-q", "-b", "feature", wt);
    fs.mkdirSync(path.join(wt, "vendor", "browser-server"), { recursive: true });
    fs.writeFileSync(path.join(wt, "vendor/browser-server/runtime.lock.json"), OURS);
    fs.writeFileSync(path.join(wt, "vendor/browser-server/requirements.txt"), OUR_REQS);

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
  const cases: { why: string; spec: Spec; usable: boolean }[] = [
    {
      why: "takes a checkout carrying the whole runtime",
      spec: { name: "d", payloads: FULL },
      usable: true,
    },
    {
      why: "takes one carrying only Python, the half worth not rebuilding",
      // ~5 min and ~200 MB; the copy loop reports per dir what did not come.
      spec: { name: "d", payloads: ["python-runtime"] },
      usable: true,
    },
    {
      why: "refuses one with no Python runtime at all",
      spec: { name: "d", payloads: ["camoufox-browser", "vault-server"] },
      usable: false,
    },
    {
      why: "refuses one whose lock file is not ours",
      spec: { name: "d", payloads: FULL, lock: THEIRS },
      usable: false,
    },
    {
      why: "refuses one whose requirements are not ours",
      // Pins move two ways, and a dependency bump under an unchanged lock file
      // is the one a single-file comparison would wave through.
      spec: { name: "d", payloads: FULL, reqs: "camoufox==2\n" },
      usable: false,
    },
    {
      why: "refuses one whose Python is still being written",
      spec: { name: "d", payloads: FULL, unfinished: "python-runtime" },
      usable: false,
    },
    {
      why: "refuses one whose Camoufox is still being written",
      // The dir appears when extraction starts and the marker when it ends, so
      // this window is minutes wide and copying it hands over a broken browser.
      spec: { name: "d", payloads: FULL, unfinished: "camoufox-browser" },
      usable: false,
    },
    {
      why: "refuses one whose vault server is still being written",
      spec: { name: "d", payloads: FULL, unfinished: "vault-server" },
      usable: false,
    },
    {
      why: "refuses one whose vault binary is compiling behind a fetched web UI",
      // The half that made this a High: fetchVaultWebUi() runs before the
      // vaultwarden compile, so the web marker is there for the whole of a
      // slow Rust build that has produced no binary yet.
      spec: { name: "d", payloads: FULL, withoutMarker: `vault-server/${ARCH}/.commit` },
      usable: false,
    },
    {
      why: "refuses one whose vault CLI is still being unpacked",
      spec: { name: "d", payloads: FULL, unfinished: "vault-cli" },
      usable: false,
    },
    {
      why: "takes one whose Camoufox is only the fused universal tree",
      // A donor that ran --browser-both and kept no per-arch tree. camoufoxIn()
      // falls through to universal, so this is usable.
      spec: {
        name: "d",
        payloads: FULL,
        withoutPayloadDir: `camoufox-browser/${ARCH}`,
        alsoMarker: "camoufox-browser/universal/.sha256",
      },
      usable: true,
    },
    {
      why: "refuses a Camoufox still extracting, whatever sits beside it",
      // The earlier half of the same window: the per-arch tree has been made
      // and `ditto` is still filling it, so there is no config.json yet and a
      // finished universal tree next door must not answer for it.
      spec: {
        name: "d",
        payloads: FULL,
        unfinished: "camoufox-browser",
        withoutPayloadDir: `camoufox-browser/${ARCH}/config.json`,
        alsoMarker: "camoufox-browser/universal/.sha256",
      },
      usable: false,
    },
    {
      why: "refuses a Camoufox fetching its addon that an older universal tree excuses",
      // The gap a bare "some marker exists" check leaves open. The per-arch
      // tree is half-written and the universal one beside it is finished and
      // stale — and camoufoxIn() PREFERS the per-arch tree, so this is the
      // browser the recipient would actually load.
      spec: {
        name: "d",
        payloads: FULL,
        withoutMarker: `camoufox-browser/${ARCH}/.sha256`,
        alsoMarker: "camoufox-browser/universal/.sha256",
      },
      usable: false,
    },
  ];

  it.each(cases)("$why", ({ spec, usable }) => {
    const parent = fs.mkdtempSync(path.join(tmp, "check-"));
    const asking = checkout(parent, { name: "asking", payloads: [] });
    expect(accepts(asking, checkout(parent, spec))).toBe(usable);
  });

  it("refuses this checkout itself", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "self-"));
    const asking = checkout(parent, { name: "slot0", payloads: FULL });
    expect(accepts(asking, asking)).toBe(false);
  });
});

describe("runtime-donor.sh --candidates advises without choosing", () => {
  it("names the neighbours a human could pass, and nothing else", () => {
    const parent = fs.mkdtempSync(path.join(tmp, "cand-"));
    const asking = checkout(parent, { name: "slot0", payloads: [] });
    const good = checkout(parent, { name: "slot1", payloads: FULL });
    checkout(parent, { name: "slot2", payloads: FULL, lock: THEIRS });
    checkout(parent, { name: "slot3", payloads: [] });

    // Listing is not choosing: the same run still inherits no donor.
    expect(donor(asking, "--candidates").split("\n")).toEqual([fs.realpathSync(good)]);
    expect(donor(asking)).toBe("");
  });
});
