/**
 * Git, as the script suites need it: identity supplied, signing off, and no
 * hooks, so a fixture repo builds the same way whatever the developer running
 * the suite has configured globally. Callers pass `-b` themselves, so
 * `init.defaultBranch` needs nothing here.
 *
 * Shared because all three of them build fixture checkouts, and a future guard
 * added here has to arrive in one place rather than be remembered in three.
 * Not only `-c`: the sharpest ambient configuration is ENVIRONMENT, which `-c`
 * cannot reach at all — see `hermeticEnv` below, which exists because a suite
 * run from inside a git hook was building its fixtures in the outer repo.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * The variables git exports to every hook it runs — and to `rebase --exec` and
 * `bisect run`. They do not bound repository discovery, they REPLACE it, so a
 * suite run from inside a hook (this machine puts one on every commit) builds
 * its fixtures against the outer repository instead of the temp directory: a
 * `git init` that inits nothing, a commit that lands elsewhere. `-c` cannot
 * reach them, since they are environment rather than config.
 */
const DISCOVERY_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];

/**
 * `process.env` with anything that would point git out of the fixture removed.
 * Pass `root` — the directory the fixtures live in, a real path — and discovery
 * is also stopped from climbing above it, for a TMPDIR that itself sits inside
 * a working tree; some CI images do this.
 *
 * The deletes are unconditional because those variables answer for another
 * repository wherever they are set. The bound is only wanted where a lookup may
 * run somewhere that is NOT itself a fixture repo — the scripts under test,
 * which is why `git` below passes no root: its cwd is always the repo it is
 * operating on, so there is no walk to bound.
 *
 * The ceiling is `root`'s PARENT, not `root`. GIT_CEILING_DIRECTORIES stops git
 * chdir-ing UP INTO a listed directory, so listing `root` does nothing for a
 * lookup that starts at `root` itself — it checks there, then ascends past a
 * ceiling it never enters. Owned here rather than left to callers, because that
 * is the shape of the mistake: it looks right and holds for every case that
 * starts one directory down.
 */
export function hermeticEnv(root?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of DISCOVERY_VARS) delete env[v];
  if (root) env.GIT_CEILING_DIRECTORIES = path.dirname(root);
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
