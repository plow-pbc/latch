/**
 * Git, as the script suites need it: identity supplied, signing off, and no
 * hooks, so a fixture repo builds the same way whatever the developer running
 * the suite has configured globally. Callers pass `-b` themselves, so
 * `init.defaultBranch` needs nothing here.
 *
 * Shared because all three of them build fixture checkouts, and a future guard
 * added here — another `-c` to neutralise some ambient config — has to arrive
 * in one place rather than be remembered in three.
 */
import { execFileSync } from "node:child_process";

/**
 * The variables git exports to every hook it runs — and to `rebase --exec` and
 * `bisect run`. They do not bound repository discovery, they REPLACE it, so a
 * suite run from inside a hook (this machine puts one on every commit) builds
 * its fixtures against the outer repository instead of the temp directory: a
 * `git init` that inits nothing, a commit that lands elsewhere. `-c` cannot
 * reach them, since they are environment rather than config.
 */
const DISCOVERY_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];

/** `process.env` with anything that would point git out of the fixture removed. */
export function hermeticEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of DISCOVERY_VARS) delete env[v];
  return env;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      // Emptied, not pointed somewhere harmless: a global hooks path is a real
      // configuration here, and without this every throwaway fixture commit
      // fires whatever the developer has installed — on this machine, the code
      // reviewer, queueing reviews of temp directories that no longer exist by
      // the time it looks.
      "-c",
      "core.hooksPath=",
      ...args,
    ],
    { cwd, encoding: "utf8", env: hermeticEnv() },
  );
}
