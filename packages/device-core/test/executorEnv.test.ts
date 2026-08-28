/**
 * The two things `plow_run_command` needed before a vendored provider CLI
 * could run through it: an environment the caller can add to, and a PATH plus
 * a sandbox profile that reach the binary this app ships.
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

/** A vendor dir holding one executable that prints what it was given. */
function vendorDir(): string {
  const dir = tmp();
  const bin = path.join(dir, "echoenv");
  fs.writeFileSync(bin, '#!/bin/sh\necho "TOKEN=$FAKE_TOKEN PATH1=${PATH%%:*}"\n', { mode: 0o755 });
  return dir;
}

async function output(exec: Executor, argv: string[], env?: Record<string, string>) {
  const result = await exec.run({
    argv,
    readPaths: [],
    writePaths: [],
    network: false,
    appleEvents: false,
    waitMs: 8000,
    env,
  });
  return result.output.toString();
}

describe.skipIf(!ON_MAC)("Executor.run", () => {
  it("passes extra environment to the child", async () => {
    const dir = vendorDir();
    const exec = new Executor(tmp(), undefined, [dir]);
    // This is the whole mechanism a vendored provider needs: its token
    // reaches the child through the environment and nowhere else.
    expect(await output(exec, ["echoenv"], { FAKE_TOKEN: "sentinel-value" })).toContain(
      "TOKEN=sentinel-value",
    );
  });

  it("resolves a vendored command from the vendor dir, ahead of the owner's own bins", async () => {
    const dir = vendorDir();
    const exec = new Executor(tmp(), undefined, [dir]);
    // Prepended, not appended: the registry matches a BARE argv[0], so which
    // binary that name reaches is a security decision.
    expect(await output(exec, ["echoenv"])).toContain(`PATH1=${dir}`);
  });

  it("lets the sandbox read the vendor dir, which is outside the home grant", async () => {
    // A vendored CLI lives in the .app bundle, so the profile's broad home
    // read does not reach it — without an explicit grant the child cannot
    // exec the binary its PATH just resolved.
    const dir = vendorDir();
    const exec = new Executor(tmp(), undefined, [dir]);
    expect(await output(exec, ["echoenv"])).toContain("TOKEN=");
  });

  it("does not let the caller's env replace PATH or HOME", async () => {
    const dir = vendorDir();
    const exec = new Executor(tmp(), undefined, [dir]);
    // The curated values are applied AFTER the caller's, so a provider row
    // supplies a token and never the shape of the world its child runs in.
    const out = await output(exec, ["echoenv"], { PATH: "/nowhere", FAKE_TOKEN: "t" });
    expect(out).toContain(`PATH1=${dir}`);
    expect(out).not.toContain("PATH1=/nowhere");
  });
});
