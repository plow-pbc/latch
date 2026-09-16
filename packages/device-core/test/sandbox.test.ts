/**
 * Sandbox conformance:
 *   - SBPL byte-parity against fixtures/sbpl.json (machine-dependent: the
 *     fixture embeds $HOME, so it only asserts when generated on this machine).
 *   - Real sandboxed execution: write-outside-scope blocked, network deny
 *     blocks a fetch that succeeds when allowed — mirroring the Swift
 *     DeviceCoreTests sandbox assertions (DESIGN.md §10).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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
        appleEvents: c.appleEvents ?? false,
        scratch: c.scratch,
      });
      expect(profile).toBe(c.profile);
    });
  }

  it("grants appleevent-send only when the capability was approved", () => {
    const base = { readPaths: [], writePaths: [], network: false, scratch: "/tmp/s" };
    expect(SandboxProfile.generate({ ...base, appleEvents: true })).toContain("(allow appleevent-send)");
    expect(SandboxProfile.generate({ ...base, appleEvents: false })).not.toContain("appleevent-send");
  });
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
      appleEvents: false,
      waitMs: 10_000,
    });
    expect(result.running).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output.toString()).toContain("hello-sandbox");
  });

  // A PyInstaller onefile binary (the wiki plugin) coordinates its bootloader
  // and the Python child through a SysV semaphore; `semctl` is what the
  // profile denies, so a create-set-remove round trip is the behavior that
  // has to hold when `sysvSemaphores` is on, and must still be refused when
  // it is off, which is every ordinary command. Seatbelt gates the
  // operations, not creation — every `*get` returns an id under any profile
  // — so all three objects are made OUTSIDE the sandbox (removal is gated
  // too, and a child that cannot remove what it made leaks it into the
  // host's namespace) and removed there afterwards. The grant is semaphores
  // ONLY: shared memory must still refuse attach and the queue must still
  // refuse send, so a future `ipc-sysv-*` generalization fails here.
  const perl = (script: string): string =>
    execFileSync("/usr/bin/perl", ["-e", script], { encoding: "utf8" }).trim();
  it.each([
    { sysvSemaphores: true, semaphore: "SEM_OK" },
    { sysvSemaphores: false, semaphore: "SEM_DENIED" },
  ])("sysvSemaphores=$sysvSemaphores: $semaphore, and shared memory and message queues refused either way", async ({ sysvSemaphores, semaphore }) => {
    const [sem, shm, queue] = perl(
      'use IPC::SysV qw(IPC_PRIVATE IPC_CREAT); print semget(IPC_PRIVATE, 1, 0600|IPC_CREAT), " ", shmget(IPC_PRIVATE, 4096, 0600|IPC_CREAT), " ", msgget(IPC_PRIVATE, 0600|IPC_CREAT)',
    ).split(" ");
    cleanups.push(() => {
      perl(
        `use IPC::SysV qw(IPC_RMID); my @failed; semctl(${sem}, 0, IPC_RMID, 0) or push @failed, "semctl: $!"; shmctl(${shm}, IPC_RMID, 0) or push @failed, "shmctl: $!"; msgctl(${queue}, IPC_RMID, 0) or push @failed, "msgctl: $!"; die "@failed" if @failed`,
      );
    });
    const executor = new Executor(tempDir());
    const result = await executor.run({
      argv: [
        "/usr/bin/perl",
        "-e",
        `use IPC::SysV qw(SETVAL); print semctl(${sem}, 0, SETVAL, 1) ? "SEM_OK\n" : "SEM_DENIED\n"; ` +
          `my $b; shmread(${shm}, $b, 0, 4) and die "shm attach succeeded"; print "SHM_DENIED\n"; ` +
          `msgsnd(${queue}, pack("l! a*", 1, "x"), 0) and die "msgsnd succeeded"; print "MSG_DENIED\n"`,
      ],
      readPaths: [],
      writePaths: [],
      network: false,
      appleEvents: false,
      sysvSemaphores,
      waitMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.toString()).toContain(semaphore);
    expect(result.output.toString()).toContain("SHM_DENIED");
    expect(result.output.toString()).toContain("MSG_DENIED");
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
      appleEvents: false,
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
      appleEvents: false,
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
      appleEvents: false,
      waitMs: 10_000,
    });
    // Without network, the socket syscall is blocked by seatbelt.
    expect(denied.output.toString()).not.toContain("OK");

    const allowed = await executor.run({
      argv: [process.execPath, "-e", script],
      readPaths: [],
      writePaths: [],
      network: true,
      appleEvents: false,
      waitMs: 10_000,
    });
    // With network allowed, the syscall goes through (connection refused, but
    // that is a normal ECONNREFUSED — the sandbox didn't block it).
    expect(allowed.output.toString()).toMatch(/ERR:ECONNREFUSED|OK/);
  });

  it("can ask LaunchServices to open an app", async () => {
    // System Events is a faceless, launch-on-demand agent, so this opens no
    // window. Without `(allow lsopen)` LaunchServices refuses with -54.
    const executor = new Executor(tempDir());
    const result = await executor.run({
      argv: ["/usr/bin/open", "-g", "-a", "System Events"],
      readPaths: [],
      writePaths: [],
      network: false,
      appleEvents: false,
      waitMs: 10_000,
    });
    expect(result.output.toString()).not.toContain("-54");
    expect(result.exitCode).toBe(0);
  });

  it("runs an AppleScript bare, from a 0600 file in its own scratch, hands it its args, and keeps a handle for its output", async () => {
    const executor = new Executor(tempDir());
    const script = "on run argv\n\treturn (item 1 of argv) & (item 2 of argv)\nend run";
    // An arg that starts with `-` is still a value: the file ended osascript's options.
    const result = await executor.runAppleScript({ script, args: ["-e ", "42"], waitMs: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.output.toString().trim()).toBe("-e 42");
    const file = path.join(executor.scratchRoot, result.handle, "script.applescript");
    expect(fs.readFileSync(file, "utf8")).toBe(script);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(executor.output(result.handle, 0).exitCode).toBe(0);
    // No profile was generated for it, so it writes nowhere a hold would guard.
    expect(executor.writableRoots(result.handle)).toEqual([]);
  });
});
