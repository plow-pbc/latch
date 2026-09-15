import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MINIMAL = {
  name: "fix",
  version: "1",
  command: "fix",
  exec: { cwd: "plugin", argv: ["/bin/sh", "cli.sh"] },
  env: { FIX_HOME: { fixed: "${plugin_home}" } },
  argv: { read: [["query"]], write: [["put"]] },
  skill: "skill.md",
};

/**
 * A git repo that is a plugin: a manifest, a shell CLI, a skill. Returns its
 * path (usable as a git URL). The CLI proves a secret reached its env
 * WITHOUT ever echoing the value — only its length, and argv.
 */
export function fixturePlugin(patch: object = {}, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugin-"));
  fs.writeFileSync(path.join(dir, "latch-plugin.json"), JSON.stringify({ ...MINIMAL, ...patch }));
  fs.writeFileSync(
    path.join(dir, "cli.sh"),
    '#!/bin/sh\necho "ARGV=$*"\necho "SECRET_LEN=${#FIX_SECRET}"\necho "HOME=$FIX_HOME"\n',
  );
  fs.writeFileSync(path.join(dir, "skill.md"), "---\nname: fix\ndescription: the fixture plugin\n---\nRun `fix query <text>`.\n");
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", ["-C", dir, ...args], {
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return dir;
}

export const FIXTURE_ENV = { FIX_HOME: { fixed: "${plugin_home}" }, FIX_SECRET: { secret: "token" } };
export const FIXTURE_MINT_ENV = { FIX_HOME: { fixed: "${plugin_home}" }, FIX_KEY: { mint: "llm:chat" } };
