/**
 * The app's side of the 1Password sync (device-core/onePasswordSync.ts holds the
 * logic): where the service-account token comes from and how `op` is run.
 *
 * The token stays in the owner's own env file — the one their agents already
 * read — and is handed to `op` through its environment only, never argv (`ps`
 * shows argv). A file anyone else on the Mac could read is refused rather than
 * used. Every error here is a fixed sentence: none quotes the file, the token or
 * anything `op` printed.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import type { OpRunner } from "@domo/device-core";

/** Where Homebrew and the 1Password installer put `op`; a GUI app has no shell PATH. */
const OP_PATHS = ["/opt/homebrew/bin/op", "/usr/local/bin/op"];

export function findOp(paths = OP_PATHS): string | null {
  return paths.find((p) => fs.existsSync(p)) ?? null;
}

/** OP_SERVICE_ACCOUNT_TOKEN out of a shell-style env file (`export` and quotes allowed). */
export function tokenFromEnvFile(file: string): string {
  const resolved = file.replace(/^~(?=\/)/, os.homedir());
  let st: fs.Stats;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw new Error("the 1Password token file is missing");
  }
  if (st.mode & 0o077) throw new Error("the 1Password token file is readable by others; refusing to use it");
  for (const line of fs.readFileSync(resolved, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?OP_SERVICE_ACCOUNT_TOKEN=(["']?)(.+)\1\s*$/.exec(line);
    if (m) return m[2]!;
  }
  throw new Error("the 1Password token file holds no OP_SERVICE_ACCOUNT_TOKEN");
}

export function opRunner(opPath: string, token: string): OpRunner {
  const run = promisify(execFile);
  return async (args) => {
    try {
      const { stdout } = await run(opPath, args, {
        env: { PATH: "/usr/bin:/bin", HOME: os.homedir(), OP_SERVICE_ACCOUNT_TOKEN: token },
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch {
      throw new Error(`op ${args.slice(0, 2).join(" ")} failed`);
    }
  };
}
