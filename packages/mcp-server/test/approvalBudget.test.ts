/**
 * Persisting the approval happens while a tunnelled call is running against its
 * budget. If that write is synchronous, a slow or unresponsive volume blocks
 * the event loop, the already-armed budget timer cannot fire, and the call
 * overruns the relay's timeout instead of returning a handle — the caller has
 * been told it failed while this Mac is still working.
 *
 * A transcript on a fast local disk cannot catch that, so the write is gated
 * here by hand: it does not complete until the test says so. The budget must
 * still fire while it is outstanding.
 *
 * The mock lives in its own file so it cannot leak into the rest of the suite,
 * and it gates ONLY writes into an approvals directory — everything else goes
 * to the real filesystem.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let gate: Promise<void> = Promise.resolve();
let openGate: () => void = () => {};
let entered: Promise<void>;
let markEntered: () => void = () => {};
let gatedWrites = 0;

function closeGate(): void {
  gatedWrites = 0;
  gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
}
closeGate();

const isApprovalWrite = (target: unknown) =>
  typeof target === "string" && target.includes("/approvals/");

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs/promises");
  const writeFile = async (...args: Parameters<typeof actual.writeFile>) => {
    if (isApprovalWrite(args[0])) {
      gatedWrites += 1;
      markEntered();
      await gate;
    }
    return actual.writeFile(...args);
  };
  return { ...actual, default: { ...actual, writeFile }, writeFile };
});

const { ApprovalStore, DeviceAgent } = await import("@domo/device-core");
const { createDomoMcpServer } = await import("@domo/mcp-server");
const { callTool } = await import("./client.js");

const AGENT = { agent_id: "agent-1", agent_name: "Agent One" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  openGate();
  while (cleanups.length) await cleanups.pop()!();
  closeGate();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-appr-budget-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("the budget fires while persisting the approval is still in flight", () => {
  it("returns a handle instead of overrunning, and the result lands later", async () => {
    const home = tempDir();
    const approvals = new ApprovalStore(
      path.join(home, "device/approvals"),
      // The human would say yes immediately — so if the call overruns, it is
      // the WRITE that blocked it, not the decision.
      { decideIntent: async () => "allow_once" as const },
      60_000,
    );
    const device = new DeviceAgent(home, "Test Mac", approvals);
    const BUDGET = 40;
    const server = createDomoMcpServer(device, { budgetMs: BUDGET });
    cleanups.push(() => server.close());

    const dir = tempDir();
    const file = path.join(dir, "hello.txt");
    fs.writeFileSync(file, "the numbers");

    const started = Date.now();
    const call = callTool(server, "read_file", { path: file }, AGENT);

    // The persistence has begun and is stuck.
    await entered;
    expect(gatedWrites).toBeGreaterThan(0);

    // With a synchronous write this call could not return at all until the
    // write finished; the budget must answer while it is still outstanding.
    const { payload, isError } = await call;
    expect(isError).toBe(false);
    expect(payload.status).toBe("pending");
    expect(Date.now() - started).toBeLessThan(5_000);

    // Let the write finish; the approval then resolves and the result lands.
    openGate();
    let poll = payload;
    for (let i = 0; i < 80 && poll.status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      poll = (await callTool(server, "get_result", { handle: payload.handle }, AGENT)).payload;
    }
    expect(poll.status).toBe("ready");
    expect(poll.result.content).toBe("the numbers");
  });

  it("the record is on disk before the human is asked, not after", async () => {
    const home = tempDir();
    const approvalsDir = path.join(home, "device/approvals");
    let asked = false;
    const approvals = new ApprovalStore(
      approvalsDir,
      {
        decideIntent: async () => {
          asked = true;
          return "allow_once" as const;
        },
      },
      60_000,
    );
    const device = new DeviceAgent(home, "Test Mac", approvals);
    const server = createDomoMcpServer(device, { budgetMs: 40 });
    cleanups.push(() => server.close());
    const dir = tempDir();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "x");

    const call = callTool(server, "read_file", { path: file }, AGENT);
    await entered;
    // The write is stuck, so the human has NOT been asked yet: the record is
    // written first, which is the whole point of writing it.
    expect(asked).toBe(false);
    openGate();
    await call;
    // `call` is not the join point: under load the 40ms budget can fire first,
    // in which case it answers with a handle and the human is asked just after.
    // Either way the ask follows the write, which is what this is about.
    for (let i = 0; i < 200 && !asked; i++) await new Promise((r) => setTimeout(r, 25));
    expect(asked).toBe(true);
  });
});
