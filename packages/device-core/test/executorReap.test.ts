/**
 * A run that can never finish (#155).
 *
 * macOS blocks — it does not refuse — an unconsented open of another app's
 * container: the child parks in `__guarded_open_np` waiting on a consent
 * decision nobody is there to answer. Nothing here ever ended that run, so the
 * job reported `running` for the life of the app and the process leaked with
 * it. These assert the reaper, on real sandboxed children: a writer-less FIFO
 * blocks in `open(2)` exactly as the TCC case does.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Capability, jv, KeyPair, makeIntent } from "@domo/protocol";
import { DeviceAgent, Executor, HeadlessPolicy } from "@domo/device-core";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-reap-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A path that blocks any reader in open(2) until a writer appears — none does. */
function blockingPipe(dir: string): string {
  const fifo = path.join(dir, "blocked.pipe");
  execFileSync("/usr/bin/mkfifo", [fifo]);
  return fifo;
}

/** Wait for a condition, so a test never races SIGKILL delivery. */
async function until(done: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Kill anything left over from a run, so no test can orphan a blocked child. */
function killAll(marker: string): void {
  for (const line of alive(marker)) {
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone — which is the outcome being asked for.
      }
    }
  }
}

/** Processes still on the process table for this run's command line. */
function alive(marker: string): string[] {
  return execFileSync("/bin/ps", ["-ax", "-o", "pid,command"], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(marker) && !l.includes("ps -ax"));
}

async function settle(
  executor: Executor,
  handle: string,
  timeoutMs = 10_000,
): Promise<ReturnType<Executor["output"]>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = executor.output(handle, 0);
    if (!snap.running) return snap;
    if (Date.now() > deadline) throw new Error("run never settled");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Seatbelt (`sandbox-exec`) and the FIFO these cases block on are the Mac's
// own; anywhere else they assert against a spawn error rather than the
// behavior. Same guard the real-sandbox suite next door uses.
const ON_MAC = process.platform === "darwin";

/** The two shapes a wedged silent run takes: the child itself, and a shell's descendant. */
const silentBlockedRuns = [
  { name: "the child itself", argv: (fifo: string) => ["/bin/cat", fifo] },
  {
    // `sh -c 'cmd'` execs, so that case IS the child above. A compound command
    // does not: the shell forks, and signalling the shell alone would leave
    // the blocked `cat` holding the stdout pipe — the original bug wearing a
    // different hat, since `close` waits on that pipe.
    name: "a descendant of a shell that does not exec",
    argv: (fifo: string) => ["/bin/sh", "-c", `/bin/cat ${JSON.stringify(fifo)}; echo unreachable`],
  },
];

describe.skipIf(!ON_MAC)("a run that produces nothing and never exits", () => {
  it.each(silentBlockedRuns)("is killed once it outlives the reap window: $name", async ({ argv }) => {
    const dir = tempDir();
    const fifo = blockingPipe(dir);
    const executor = new Executor(path.join(dir, "scratch"), 300);

    const started = await executor.run({
      argv: argv(fifo),
      cwd: dir,
      readPaths: [dir],
      writePaths: [],
      network: false,
      waitMs: 50,
    });
    cleanups.push(() => killAll(fifo));
    expect(started.running).toBe(true);

    const ended = await settle(executor, started.handle);
    expect(ended.reaped).toBe(true);
    expect(ended.exitCode).not.toBe(0);
    await until(() => alive(fifo).length === 0);
  });

  // Same wedged shape as the reaped cases, one capability apart — and both
  // capabilities, because either alone makes a run un-reapable: it could be
  // silently mid-work, and a truncated file or a half-applied remote call is
  // worse than the wait.
  it.each([
    { name: "write", write: true, network: false },
    { name: "network", write: false, network: true },
  ])("leaves a silent run approved for $name alone", async ({ write, network }) => {
    const dir = tempDir();
    const fifo = blockingPipe(dir);
    const executor = new Executor(path.join(dir, "scratch"), 300);

    const started = await executor.run({
      argv: ["/bin/cat", fifo],
      cwd: dir,
      readPaths: [dir],
      writePaths: write ? [dir] : [],
      network,
      waitMs: 50,
    });
    cleanups.push(() => killAll(fifo));

    await new Promise((r) => setTimeout(r, 900));
    const later = executor.output(started.handle, 0);
    expect(later.running).toBe(true);
    expect(later.reaped).toBe(false);
  });

  it("leaves a run that has produced output alone", async () => {
    const dir = tempDir();
    const fifo = blockingPipe(dir);
    const executor = new Executor(path.join(dir, "scratch"), 300);

    // Speaks first, then blocks forever: visibly doing something, so the
    // reaper must not touch it however long it sits there.
    const started = await executor.run({
      argv: ["/bin/sh", "-c", `echo working; exec /bin/cat ${JSON.stringify(fifo)}`],
      cwd: dir,
      readPaths: [dir],
      writePaths: [],
      network: false,
      waitMs: 1000,
    });
    expect(started.output.toString()).toContain("working");

    // Registered before the assertions, not after: a failing expectation must
    // not be the thing that orphans a blocked child — that is the leak this
    // whole file is about.
    cleanups.push(() => killAll(fifo));

    await new Promise((r) => setTimeout(r, 900));
    const later = executor.output(started.handle, 0);
    expect(later.running).toBe(true);
    expect(later.reaped).toBe(false);
  });

  it("ends when the command ends, not when a job it backgrounded lets go", async () => {
    const dir = tempDir();
    const executor = new Executor(path.join(dir, "scratch"), 60_000);

    // The shell exits at once; the job it backgrounded inherits stdout and
    // blocks forever. `close` waits on that pipe, so a run that settled on
    // `close` would answer `running` until something reaped it — fifteen
    // minutes for a command that finished immediately, or forever once it had
    // printed a line. What the owner approved has ended; the job says so.
    // The straggler speaks AFTER the command is gone, which is the only way to
    // tell the settled job from one still quietly capturing: it holds the
    // stdout pipe, sleeps past the drain, then writes and exits.
    const marker = `stray-${path.basename(dir)}`;
    const started = await executor.run({
      argv: ["/bin/sh", "-c", `echo started; (sleep 1; echo ${marker}) & exit 0`],
      cwd: dir,
      readPaths: [dir],
      writePaths: [],
      network: false,
      waitMs: 3_000,
    });
    cleanups.push(() => killAll(marker));
    expect(started.running).toBe(false);
    expect(started.exitCode).toBe(0);
    // Its command ended on its own, so nothing here killed it.
    expect(started.reaped).toBe(false);
    expect(started.output.toString()).toContain("started");

    // Whatever the straggler writes, and whatever its late `close` says, the
    // outcome the agent and the audit log already have does not move.
    await until(() => alive(marker).length === 0, 4_000);
    await new Promise((r) => setTimeout(r, 250));
    const after = executor.output(started.handle, 0);
    expect(after.exitCode).toBe(0);
    expect(after.reaped).toBe(false);
    expect(after.output.toString()).not.toContain(marker);
    expect(after.outputLength).toBe(started.outputLength);
  });

  it("leaves a backgrounded job that redirected its output running", async () => {
    const dir = tempDir();
    const executor = new Executor(path.join(dir, "scratch"), 60_000);

    // The other half of the contract `plow_run_command` states: a job that
    // redirects both streams is not holding the run's pipes, so nothing this
    // Mac does to end the run reaches it.
    const marker = `survivor-${path.basename(dir)}`;
    const started = await executor.run({
      argv: ["/bin/sh", "-c", `echo started; (sleep 5; echo ${marker}) >/dev/null 2>&1 & exit 0`],
      cwd: dir,
      readPaths: [dir],
      writePaths: [],
      network: false,
      waitMs: 3_000,
    });
    cleanups.push(() => killAll(marker));
    expect(started.running).toBe(false);
    expect(started.exitCode).toBe(0);
    expect(started.reaped).toBe(false);
    expect(alive(marker).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!ON_MAC)("a run closing out", () => {
  it("is not a waiter's to skip by throwing", async () => {
    const dir = tempDir();
    const executor = new Executor(path.join(dir, "scratch"), 60_000);
    const started = await executor.run({
      argv: ["/bin/echo", "hi"],
      cwd: dir,
      readPaths: [dir],
      writePaths: [],
      network: false,
      waitMs: 0,
    });

    // `onExit` is public, so a registrant that throws is reachable — and it
    // must cost neither the run its outcome nor the registrants behind it.
    let second = false;
    executor.onExit(started.handle, () => {
      throw new Error("a registrant's problem");
    });
    executor.onExit(started.handle, () => {
      second = true;
    });

    const ended = await settle(executor, started.handle);
    expect(second).toBe(true);
    expect(ended.exitCode).toBe(0);
    expect(ended.output.toString()).toContain("hi");
  });

  it("holds the same rule for a registrant that arrives after the run closed", async () => {
    const dir = tempDir();
    const executor = new Executor(path.join(dir, "scratch"), 60_000);
    const started = await executor.run({
      argv: ["/bin/echo", "hi"],
      cwd: dir,
      readPaths: [dir],
      writePaths: [],
      network: false,
      waitMs: 0,
    });
    await settle(executor, started.handle);

    // A registrant arriving after the run has closed reaches its callback by a
    // different path — called straight through, no waiter list — so the seam
    // has to hold the rule twice over rather than once in the loop.
    let seen: number | null = null;
    expect(() =>
      executor.onExit(started.handle, (exitCode) => {
        seen = exitCode;
        throw new Error("a late registrant's problem");
      }),
    ).not.toThrow();
    // Recorded before the throw, so one case covers both halves of the rule:
    // the late registrant is reached with the run's real outcome, and its
    // throw stays its own.
    expect(seen).toBe(0);
  });
});

describe.skipIf(!ON_MAC)("the audit record of a reaped run", () => {
  it("closes the run out once, marked reaped", async () => {
    const home = tempDir();
    const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "allow_once" }));
    // The reap window is a policy constant, not a knob on the agent: a test
    // that needs a short one swaps the executor rather than growing the
    // constructor a parameter only tests would ever pass.
    Object.assign(device, { executor: new Executor(path.join(home, "device/scratch"), 300) });

    const dir = tempDir();
    const fifo = blockingPipe(dir);
    const capabilities: Capability[] = [
      { kind: "process.exec", argv: ["/bin/cat", fifo], cwd: dir },
      { kind: "fs.read", paths: [dir] },
    ];
    const intent = makeIntent({
      agentId: new KeyPair().fingerprint,
      agentDisplay: "Agent",
      deviceId: device.identity.deviceId,
      request: "read the pipe",
      capabilities,
      sessionId: "s1",
    });

    const response = await device.handleIntent(intent, { wait_ms: 50 });
    expect(jv(response).get("status").str).toBe("running");
    const handle = jv(response).get("handle").str!;

    const ended = await settle(device.executor, handle);
    expect(ended.reaped).toBe(true);
    // The agent polling the job learns why it stopped, not just that it did.
    const payload = device.getOutput(handle);
    expect(jv(payload).get("status").str).toBe("completed");
    expect(jv(payload).get("error").str).toMatch(/produced no output/);

    const ends = device.audit
      .entries()
      .filter((e) => jv(e).get("event").str === "exec_end");
    expect(ends).toHaveLength(1);
    expect(jv(ends[0]!).get("reaped").bool).toBe(true);
  });
});
