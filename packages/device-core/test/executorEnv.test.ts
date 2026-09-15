/**
 * What `plow_run_command` gives a child: an environment the caller can add to,
 * and a curated PATH and HOME the caller cannot replace with its own.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Executor } from "../src/executor.js";

/** Every test here spawns; /usr/bin/sandbox-exec exists only on macOS. */
const ON_MAC = process.platform === "darwin";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "latch-exec-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** An executable that reports what it was handed, at an absolute path. */
function echoEnv(): string {
  const bin = path.join(tmp(), "echoenv");
  fs.writeFileSync(bin, '#!/bin/sh\necho "TOKEN=$FAKE_TOKEN PATH1=${PATH%%:*}"\n', { mode: 0o755 });
  return bin;
}

async function output(exec: Executor, argv: string[], env?: Record<string, string>) {
  const result = await exec.run({
    argv,
    // A binary must be readable to be exec'd, and this one lives outside the
    // profile's home grant — as a staged plugin's does.
    readPaths: [path.dirname(argv[0]!)],
    writePaths: [],
    network: false,
    appleEvents: false,
    waitMs: 8000,
    env,
  });
  return result.output.toString();
}

describe.skipIf(!ON_MAC)("Executor.run", () => {
  it("merges stderr into output for the stream, and keeps stdout alone for a parser", async () => {
    const exec = new Executor(tmp());
    const result = await exec.run({
      argv: ["/bin/sh", "-c", 'echo "note" >&2; echo \'{"ok":true}\''],
      readPaths: [],
      writePaths: [],
      network: false,
      appleEvents: false,
      waitMs: 8000,
    });
    expect(result.output.toString()).toContain("note");
    expect(JSON.parse(exec.stdout(result.handle).toString())).toEqual({ ok: true });
  });

  it("passes extra environment to the child", async () => {
    const exec = new Executor(tmp());
    // This is the whole mechanism a provider needs: its token reaches the
    // child through the environment and nowhere else.
    expect(await output(exec, [echoEnv()], { FAKE_TOKEN: "sentinel-value" })).toContain(
      "TOKEN=sentinel-value",
    );
  });

  it("does not let the caller's env replace PATH or HOME", async () => {
    const exec = new Executor(tmp());
    // The curated values are applied AFTER the caller's, so a provider row
    // supplies a token and never the shape of the world its child runs in.
    const out = await output(exec, [echoEnv()], { PATH: "/nowhere", FAKE_TOKEN: "t" });
    expect(out).toContain("TOKEN=t");
    expect(out).toContain(`PATH1=${os.homedir()}/.local/bin`);
  });
});
