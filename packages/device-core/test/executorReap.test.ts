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

describe("a run that produces nothing and never exits", () => {
  it("is killed once it outlives the reap window, and says so", async () => {
    const dir = tempDir();
    const fifo = blockingPipe(dir);
    const executor = new Executor(path.join(dir, "scratch"), 300);

    const started = await executor.run({
      argv: ["/bin/cat", fifo],
      cwd: dir,
      readPaths: [dir],
      writePaths: [],
      network: false,
      waitMs: 50,
    });
    expect(started.running).toBe(true);

    const ended = await settle(executor, started.handle);
    expect(ended.reaped).toBe(true);
    expect(ended.exitCode).not.toBe(0);
    await until(() => alive(fifo).length === 0);
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

  it("takes the descendants of a shell that does not exec", async () => {
    const dir = tempDir();
    const fifo = blockingPipe(dir);
    const executor = new Executor(path.join(dir, "scratch"), 300);

    // `sh -c 'cmd'` execs, so the wedged process IS the child and one signal
    // would do. A compound command does not: the shell forks, and signalling
    // the shell alone leaves the blocked `cat` holding the stdout pipe — which
    // is the original bug wearing a different hat, since `close` waits on that
    // pipe and the job would answer `running` forever.
    const started = await executor.run({
      argv: ["/bin/sh", "-c", `/bin/cat ${JSON.stringify(fifo)}; echo unreachable`],
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
    await until(() => alive(fifo).length === 0);
  });

  it("settles a run whose command exited but whose background job holds the pipes", async () => {
    const dir = tempDir();
    const fifo = blockingPipe(dir);
    const executor = new Executor(path.join(dir, "scratch"), 300);

    // The shell exits immediately; the job it backgrounded inherits stdout and
    // blocks forever. `close` waits on that pipe, so the run never settles on
    // its own — a second route to #155's forever-`running` job, and one that
    // "did the child exit?" must not be read as permission to walk away from.
    const started = await executor.run({
      argv: ["/bin/sh", "-c", `/bin/cat ${JSON.stringify(fifo)} & exit 0`],
      cwd: dir,
      readPaths: [dir],
      writePaths: [],
      network: false,
      waitMs: 50,
    });
    cleanups.push(() => killAll(fifo));
    expect(started.running).toBe(true);

    const ended = await settle(executor, started.handle);
    // Its own command ended, so this is not a run this Mac killed — but the
    // strays still go, and the job answers instead of hanging.
    expect(ended.reaped).toBe(false);
    expect(ended.exitCode).toBe(0);
    await until(() => alive(fifo).length === 0);
  });
});

describe("the audit record of a reaped run", () => {
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
