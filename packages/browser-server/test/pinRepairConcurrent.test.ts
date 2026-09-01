/**
 * Concurrent stale-pin repair, across REAL processes — the single-process tests
 * cannot exercise the cross-process lock. Many processes hit one stale pin at
 * once; each must return the SAME fingerprint id. Without the lock the atomic
 * rename converged the file but let in-flight launches return their own pick,
 * so one stale pin yielded several fingerprints.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const CHILD = fileURLToPath(new URL("./pinRepairChild.mjs", import.meta.url));
const DIST = fileURLToPath(new URL("../dist/launch.js", import.meta.url));

const pool = {
  browserVersion: "official/152.0.4-beta.28",
  entries: Array.from({ length: 20 }, (_v, i) => ({
    id: `id-${i}`,
    env: { CAMOU_CONFIG_1: `cfg-${i}` },
    firefoxUserPrefs: {},
    args: [],
  })),
};

let dir: string;

beforeAll(() => {
  // The children run the compiled dist directly.
  if (!fs.existsSync(DIST)) {
    execFileSync("npx", ["tsc", "-b", "packages/browser-server"], { cwd: repoRoot });
  }
});
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function child(poolFile: string, pinPath: string, startAt: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CHILD, poolFile, pinPath, String(startAt)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`child exited ${code}: ${err}`)),
    );
  });
}

describe("concurrent stale-pin repair (multi-process)", () => {
  it("every concurrent repairer returns the SAME fingerprint id", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinrace-"));
    const poolFile = path.join(dir, "pool.json");
    fs.writeFileSync(poolFile, JSON.stringify(pool));
    const pinPath = path.join(dir, "device", "browser", "pin.json");
    fs.mkdirSync(path.dirname(pinPath), { recursive: true });
    // Stale: this id is not in the current pool (a browser bump regenerated it).
    fs.writeFileSync(pinPath, JSON.stringify({ id: "id-removed-by-a-bump" }));

    // Spawn all children, then release them together at a shared barrier so they
    // truly contend on the repair (without the barrier, spawn jitter lets one win
    // before the others arrive, and even the racy code looks convergent).
    const startAt = Date.now() + 500;
    const ids = await Promise.all(
      Array.from({ length: 40 }, () => child(poolFile, pinPath, startAt)),
    );

    expect(new Set(ids).size).toBe(1); // all 40 converged on one fingerprint
    expect(pool.entries.some((e) => e.id === ids[0])).toBe(true); // a current entry
    expect(JSON.parse(fs.readFileSync(pinPath, "utf8"))).toEqual({ id: ids[0] }); // recorded
    expect(fs.existsSync(`${pinPath}.lock`)).toBe(false); // lock released
  }, 30_000);
});
