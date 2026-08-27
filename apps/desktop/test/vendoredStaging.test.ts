/**
 * The skip predicate decides whether a vendored binary already on disk is
 * trusted enough to go into a signed app unread. Existence plus a size was what
 * it used to check, and a cached binary modified by anything with write access
 * to the checkout passed: it carried the current VERSION marker, so the fetch
 * was skipped and it was signed and handed minted tokens.
 *
 * The fetcher's argv check is at the bottom. It lives here rather than in a
 * file of its own because `fetch-vendored.mjs` exports nothing to test — the
 * only way to reach it is to spawn it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — a build-time .mjs with no type declarations.
import { isStaged } from "../../../scripts/vendored-staging.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const sha = (b: string) => createHash("sha256").update(b).digest("hex");

/** A provider whose pins are the digests of the bytes `stage` writes. */
const provider = () => ({
  command: "demo",
  version: "1.2.3",
  arches: {
    arm64: { asset: "darwin_arm64", sha256: "unused", binary: sha("arm64-bytes") },
    x64: { asset: "darwin_amd64", sha256: "unused", binary: sha("x64-bytes") },
  },
});

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "staged-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write `<root>/vendor/demo/<arch>/demo` for both arches, plus the marker. */
function stage(opts: { arm64?: string; x64?: string; version?: string } = {}) {
  for (const [arch, fallback] of [
    ["arm64", "arm64-bytes"],
    ["x64", "x64-bytes"],
  ] as const) {
    const dir = path.join(root, "vendor/demo", arch);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "demo"), opts[arch] ?? fallback);
  }
  fs.writeFileSync(path.join(root, "vendor/demo/VERSION"), `${opts.version ?? "1.2.3"}\n`);
}

describe("isStaged", () => {
  it("is true when both arches carry the pinned bytes at the pinned version", () => {
    stage();
    expect(isStaged(provider(), root)).toBe(true);
  });

  it("is false when a cached binary's bytes changed, marker notwithstanding", () => {
    // The case that matters: the marker still attests 1.2.3, so an
    // existence-only check skips the fetch and signs the tampered binary.
    stage({ arm64: "tampered" });
    expect(isStaged(provider(), root)).toBe(false);
  });

  it("is false when one arch is missing entirely", () => {
    // The case the skip exists for. A tree carrying only the packaging Mac's
    // arch reaches the other arch's users with no provider at all.
    stage();
    fs.rmSync(path.join(root, "vendor/demo/x64/demo"));
    expect(isStaged(provider(), root)).toBe(false);
  });

  it("is false when an arch's binary is empty", () => {
    stage({ x64: "" });
    expect(isStaged(provider(), root)).toBe(false);
  });

  it("is false when the marker names another version", () => {
    stage({ version: "1.2.2" });
    expect(isStaged(provider(), root)).toBe(false);
  });

  it("is false when nothing is staged at all", () => {
    expect(isStaged(provider(), root)).toBe(false);
  });
});

/**
 * `fetch-vendored.mjs` exports nothing and runs its CLI at module scope, so the
 * only way to exercise it is to spawn it. Both cases below stop at the argv
 * check and touch neither the network nor `vendor/`.
 */
describe("the fetcher's argv check", () => {
  const script = path.join(repoRoot, "scripts/fetch-vendored.mjs");
  const run = (args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  it.each([
    ["no provider named", []],
    ["one that is not in the manifest", ["not-a-provider"]],
  ])("exits 2 with usage when given %s", (_how, args) => {
    const { status, stderr } = run(args as string[]);
    expect(status).toBe(2);
    expect(stderr).toContain("usage: fetch-vendored.mjs");
  });
});
