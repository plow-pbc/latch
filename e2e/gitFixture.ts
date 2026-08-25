/**
 * Git, as the script suites need it: identity supplied and signing off, so a
 * fixture repo builds the same way on a machine whose developer has commit
 * signing, a global hooks path, or a different `init.defaultBranch` configured.
 *
 * Shared because all three of them build fixture checkouts, and a future guard
 * added here — another `-c` to neutralise some ambient config — has to arrive
 * in one place rather than be remembered in three.
 */
import { execFileSync } from "node:child_process";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
}
