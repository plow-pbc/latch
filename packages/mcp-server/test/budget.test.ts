/**
 * The call budget has to be able to fire while a tool is mid-flight, including
 * during the parts that are filesystem I/O rather than obvious "work".
 *
 * Resolving a path is filesystem I/O — `realpath` on a slow or unresponsive
 * mounted volume can take arbitrarily long. Done synchronously it blocks the
 * event loop, the budget's timer never runs, and the call returns late: after
 * the relay has already told the agent it failed, while this Mac went ahead and
 * did the work anyway. Same failure as a synchronous read, one step earlier.
 *
 * Rather than trying to find a genuinely slow filesystem (not deterministic,
 * and not portable), this file stubs `realpath` with a gate the test opens by
 * hand. That makes the ordering observable: the budget must have fired while
 * resolution was still outstanding, because the test does not open the gate
 * until after it has seen the pending answer.
 *
 * The mock lives in its own file so it cannot leak into the rest of the suite.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Opened by the test; until then every realpath call hangs. */
let gate: Promise<void> = Promise.resolve();
let openGate: () => void = () => {};
/** Resolves once the stubbed realpath has actually been entered. */
let entered: Promise<void>;
let markEntered: () => void = () => {};
let realpathCalls = 0;

function closeGate(): void {
  realpathCalls = 0;
  gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
}
closeGate();

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      realpath: async (...args: Parameters<typeof actual.realpath>) => {
        realpathCalls += 1;
        markEntered();
        await gate;
        return actual.realpath(...args);
      },
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      realpathCalls += 1;
      markEntered();
      await gate;
      return actual.realpath(...args);
    },
  };
});

const { canonicalizeAsync } = await import("@domo/protocol");
const { DeviceAgent, FileOps, HeadlessPolicy } = await import("@domo/device-core");
const { createDomoMcpServer, DeferredResults } = await import("@domo/mcp-server");
const { callTool } = await import("./client.js");

const AGENT = { agent_id: "agent-1", agent_name: "Agent One" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  openGate();
  while (cleanups.length) await cleanups.pop()!();
  vi.useRealTimers();
  closeGate();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-budget-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("the budget fires while a slow path resolution is still in flight", () => {
  it("read_file defers instead of returning late", async () => {
    // Sanity: the stub really is in the path resolution used by the tools.
    const probe = canonicalizeAsync("/tmp");
    await entered;
    openGate();
    await probe;
    closeGate();

    const home = tempDir();
    const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "allow_once" }));
    // 30ms budget, and a resolution that will not finish until we say so.
    const server = createDomoMcpServer(device, { budgetMs: 30 });
    cleanups.push(() => server.close());

    const dir = tempDir();
    const file = path.join(dir, "hello.txt");
    fs.writeFileSync(file, "hello mac");

    const call = callTool(server, "read_file", { path: file }, AGENT);
    // Resolution has begun and is stuck.
    await entered;
    expect(realpathCalls).toBeGreaterThan(0);

    // The budget must expire and answer WITHOUT the resolution having finished.
    const { payload, isError } = await call;
    expect(isError).toBe(false);
    expect(payload.status).toBe("pending");
    expect(payload.reason).toBe("awaiting_approval");
    const handle: string = payload.handle;

    // Only now let resolution complete; the work then runs to a real result.
    openGate();
    let poll = payload;
    for (let i = 0; i < 80 && poll.status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      poll = (await callTool(server, "get_result", { handle }, AGENT)).payload;
    }
    expect(poll.status).toBe("ready");
    expect(poll.result.content).toBe("hello mac");
  });

  it("run_command defers while its declared bounds are still resolving", async () => {
    const home = tempDir();
    const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "allow_once" }));
    const server = createDomoMcpServer(device, { budgetMs: 30 });
    cleanups.push(() => server.close());
    const dir = tempDir();

    const call = callTool(
      server,
      "run_command",
      { argv: ["/bin/echo", "x"], read_paths: [dir], cwd: dir, wait_ms: 5_000 },
      AGENT,
    );
    await entered;
    const { payload } = await call;
    expect(payload.status).toBe("pending");
    openGate();
  });
});

describe("scope resolution inside FileOps is async too", () => {
  it("a read does not complete while path resolution is gated", async () => {
    // FileOps re-resolves and scope-checks after approval. If it did that
    // synchronously it would block the loop just as effectively, only later —
    // so this asserts the read is genuinely waiting on the gated realpath.
    const dir = tempDir();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "data");

    let done = false;
    const read = FileOps.read(file, [dir]).then((buf) => {
      done = true;
      return buf;
    });
    // The gate holds ONLY the async realpath. A synchronous resolution would
    // sail past it and the read would finish in these few turns — which is
    // exactly what this asserts does not happen.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);

    openGate();
    expect((await read).toString()).toBe("data");
    expect(done).toBe(true);
  });
});

describe("the budget timer is armed before the work is invoked", () => {
  it("a timer is already scheduled when the work function is entered", async () => {
    // With the old ordering the work ran first and this saw no timer at all.
    vi.useFakeTimers();
    const store = new DeferredResults(50);
    let timersWhenWorkStarted = -1;

    const pending = store.run("agent-1", async () => {
      timersWhenWorkStarted = vi.getTimerCount();
      return new Promise<never>(() => {}); // never settles
    });

    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toMatchObject({ status: "pending" });
    expect(timersWhenWorkStarted).toBeGreaterThan(0);
  });

  it("work that never yields still cannot outlive the budget once it does", async () => {
    vi.useFakeTimers();
    const store = new DeferredResults(50);
    // A prologue that runs synchronously before the first await: with the timer
    // armed first, it is already racing a scheduled budget.
    const pending = store.run("agent-1", async () => {
      const armed = vi.getTimerCount();
      expect(armed).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 10_000));
      return { late: true };
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toMatchObject({ status: "pending" });
  });
});
