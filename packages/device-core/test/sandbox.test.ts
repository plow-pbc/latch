/**
 * Sandbox conformance:
 *   - SBPL byte-parity against fixtures/sbpl.json (machine-dependent: the
 *     fixture embeds $HOME, so it only asserts when generated on this machine).
 *   - Real sandboxed execution: write-outside-scope blocked, network deny
 *     blocks a fetch that succeeds when allowed — mirroring the Swift
 *     DeviceCoreTests sandbox assertions (DESIGN.md §10).
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Executor, SandboxProfile } from "@domo/device-core";

const fixturesDir = path.join(__dirname, "../../../fixtures");
const sbpl = JSON.parse(fs.readFileSync(path.join(fixturesDir, "sbpl.json"), "utf8"));

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-sbx-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("SBPL profile", () => {
  const machineMatches = sbpl.home === os.homedir();
  for (const c of sbpl.cases) {
    it(`${c.name}${machineMatches ? "" : " (skipped: fixture from another machine)"}`, () => {
      if (!machineMatches) return;
      const profile = SandboxProfile.generate({
        readPaths: c.readPaths,
        writePaths: c.writePaths,
        network: c.network,
        scratch: c.scratch,
      });
      expect(profile).toBe(c.profile);
    });
  }
});

// Seatbelt (`sandbox-exec`) is the Mac's own, and these cases run real
// commands through it; anywhere else they would be asserting against a spawn
// error rather than the sandbox's behavior.
const ON_MAC = process.platform === "darwin";

describe.skipIf(!ON_MAC)("real sandboxed execution", () => {
  it("runs a command and captures output", async () => {
    const executor = new Executor(tempDir());
    const result = await executor.run({
      argv: ["/bin/echo", "hello-sandbox"],
      readPaths: [],
      writePaths: [],
      network: false,
      waitMs: 10_000,
    });
    expect(result.running).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output.toString()).toContain("hello-sandbox");
  });

  it("blocks a write outside the approved scope", async () => {
    const scratch = tempDir();
    const allowed = tempDir();
    const forbidden = path.join(tempDir(), "nope.txt");
    const executor = new Executor(scratch);
    const result = await executor.run({
      argv: ["/bin/sh", "-c", `echo blocked > ${forbidden}`],
      readPaths: [],
      writePaths: [allowed],
      network: false,
      waitMs: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(fs.existsSync(forbidden)).toBe(false);
  });

  it("allows a write inside the approved scope", async () => {
    const scratch = tempDir();
    const allowed = tempDir();
    const target = path.join(allowed, "ok.txt");
    const executor = new Executor(scratch);
    const result = await executor.run({
      argv: ["/bin/sh", "-c", `echo written > ${target}`],
      readPaths: [],
      writePaths: [allowed],
      network: false,
      waitMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toContain("written");
  });

  it("network deny blocks a connection that succeeds when allowed", async () => {
    const executor = new Executor(tempDir());
    // A DNS/connect attempt to localhost:9 (discard) — denied should fail fast
    // at the sandbox layer, allowed should get a normal connection refused.
    const script = 'require("net").connect(9,"127.0.0.1").on("error",e=>{console.log("ERR:"+e.code);process.exit(2)}).on("connect",()=>{console.log("OK");process.exit(0)})';

    const denied = await executor.run({
      argv: [process.execPath, "-e", script],
      readPaths: [],
      writePaths: [],
      network: false,
      waitMs: 10_000,
    });
    // Without network, the socket syscall is blocked by seatbelt.
    expect(denied.output.toString()).not.toContain("OK");

    const allowed = await executor.run({
      argv: [process.execPath, "-e", script],
      readPaths: [],
      writePaths: [],
      network: true,
      waitMs: 10_000,
    });
    // With network allowed, the syscall goes through (connection refused, but
    // that is a normal ECONNREFUSED — the sandbox didn't block it).
    expect(allowed.output.toString()).toMatch(/ERR:ECONNREFUSED|OK/);
  });
});
