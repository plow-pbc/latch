/**
 * Running one of the Python probes under `e2e/fixtures/`.
 *
 * The bytecode cache is pointed at a throwaway directory every time. The system
 * python3 here caches .pyc files OUTSIDE the source tree and validates them on
 * (mtime, size) alone — an edit that changes neither, such as a mutation test
 * that happens to be byte-length-neutral applied and reverted inside one
 * second, leaves a stale .pyc that Python believes is current, and every later
 * run executes code that is not on disk. That cost an afternoon once. A fresh
 * prefix per run means there is never a cache to be stale.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** True when a python3 exists at all; the probes skip when it does not. */
export function havePython(): boolean {
  try {
    execFileSync("python3", ["-c", "pass"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a probe and parse what it printed.
 *
 * `env` overlays the default environment, for a probe that needs to see
 * something particular — a `PATH` with a fake binary on it, say. The
 * bytecode-cache policy above is the reason to come through here rather than
 * spawn python3 directly.
 */
export function runProbe<T>(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): T {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "domo-pyc-"));
  try {
    const out = execFileSync("python3", [script, ...args], {
      encoding: "utf8",
      // The cache prefix wins: it is the one policy this helper exists to
      // enforce, and the `finally` below removes exactly that directory.
      env: { ...process.env, ...env, PYTHONPYCACHEPREFIX: cache },
    });
    return JSON.parse(out) as T;
  } finally {
    // A fresh prefix per run means one directory per CALL, and a table-driven
    // suite makes dozens — they were accumulating under the system temp dir
    // with nothing ever removing them.
    fs.rmSync(cache, { recursive: true, force: true });
  }
}
