import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A throwaway dir for one test; its removal is queued on `cleanups`, which the file's `afterEach` drains. */
export function scratchDir(prefix: string, cleanups: { push(cleanup: () => void): unknown }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
