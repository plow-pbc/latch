/**
 * A tunnelled call cannot wait for a human, so the approval outlives the call.
 * That makes the record on disk the only thing that says what was asked while
 * it is still unanswered.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Capability, Intent, makeIntent } from "@domo/protocol";
import { ApprovalStore, IntentDecision, PolicyDelegate } from "@domo/device-core";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-appr-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function intentFor(caps: Capability[] = [{ kind: "fs.read", paths: ["/tmp/x"] }]): Intent {
  return makeIntent({
    agentId: "sess_alice",
    agentDisplay: "Claude Code",
    deviceId: "device-1",
    goal: "tidy up",
    request: "read file: /tmp/x",
    capabilities: caps,
    sessionId: "s1",
  });
}

/** A delegate that never answers, so the store's own paths are what run. */
const silent: PolicyDelegate = { decideIntent: () => new Promise<IntentDecision>(() => {}) };

/** A delegate that answers after `ms`. */
const answersIn = (ms: number, decision: IntentDecision = "allow_once"): PolicyDelegate => ({
  decideIntent: () => new Promise((r) => setTimeout(() => r(decision), ms)),
});

/**
 * Start an approval the test will not answer, and finish it before the
 * directory goes.
 *
 * `decideIntent` keeps working after the assertions are done: it writes the
 * record a second time whenever the approval settles, and with a delegate that
 * never answers that is when the deadline timer fires — which can be long after
 * `afterEach` has removed the temp dir. That write then ENOENTs into an
 * unhandled rejection, turning a run whose tests all passed red. Fire-and-forget
 * is the bug, so the promise is held, denied, and awaited during cleanup — and
 * because `cleanups` unwinds last-in-first-out, that happens before the removal
 * this helper's directory registered.
 */
function startApproval(store: ApprovalStore, intent: Intent): void {
  let settled = false;
  let failure: unknown;
  // The outcome is absorbed from the first tick rather than at teardown, so an
  // approval that blows up mid-test cannot itself become the run-level
  // unhandled rejection this helper exists to remove. It is rethrown below.
  const pending = store.decideIntent(intent).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      failure = error;
    },
  );
  cleanups.push(async () => {
    // The waiter is registered a few awaits into `decideIntent`, so a teardown
    // that lands early has to wait for the store to become answerable at all.
    const deadline = Date.now() + 5_000;
    while (!settled && !store.resolve(intent.intentId, "deny", "teardown")) {
      if (Date.now() > deadline) throw new Error("the approval never became answerable in teardown");
      await new Promise((r) => setTimeout(r, 5));
    }
    await pending;
    // A write that genuinely failed should fail the test that started it, by
    // name, rather than being swallowed here.
    if (failure !== undefined) throw failure;
  });
}

/**
 * Wait for the pending record to actually be on disk.
 *
 * These tests used a fixed 30ms sleep, which is a race rather than a wait:
 * `decideIntent` writes the record asynchronously, and on a loaded machine that
 * write can take longer than the guess. `all()` then returns [] and the
 * assertion dies on `undefined.status` — reproduced once in four full-suite
 * runs while an Electron harness was running alongside. Wait for the thing we
 * are actually waiting for.
 */
async function pendingRecord(store: ApprovalStore, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [record] = await store.all();
    if (record) return record;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no approval record reached disk within the timeout");
}

/**
 * Wait until the store will actually accept an answer for it.
 *
 * `pendingRecord` is NOT enough for a test that then calls `resolve()`: the
 * record reaches disk before the in-memory waiter is registered, and `resolve`
 * refuses an intent nobody is waiting on. Polling for the record alone made
 * these two tests fail 8 times in 40 runs under load. `pending()` filters on
 * exactly the map `resolve` consults, so it is the honest signal.
 */
async function answerable(store: ApprovalStore, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await store.pending()).length > 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the approval never became answerable within the timeout");
}

describe("the record exists before the answer does", () => {
  it("writes a pending record before the human is asked", async () => {
    const dir = tempDir();
    const store = new ApprovalStore(dir, silent);
    const intent = intentFor();
    startApproval(store, intent);
    await pendingRecord(store);

    const [record] = await store.all();
    expect(record.status).toBe("pending");
    expect(record.intentId).toBe(intent.intentId);
    expect(record.agentId).toBe("sess_alice");
    expect(record.agentName).toBe("Claude Code");
    expect(record.request).toBe("read file: /tmp/x");
    expect(record.capabilities).toEqual(["Read: /tmp/x"]);
    // It is on disk, not just in the object.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, `${intent.intentId}.json`), "utf8"),
    );
    expect(onDisk.status).toBe("pending");
  });

  it("is owner-only — it carries the goal and the paths asked for", async () => {
    const dir = tempDir();
    const store = new ApprovalStore(dir, silent);
    const intent = intentFor();
    startApproval(store, intent);
    await pendingRecord(store);
    const file = path.join(dir, `${intent.intentId}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("records the outcome next to the request when the answer lands", async () => {
    const dir = tempDir();
    const store = new ApprovalStore(dir, answersIn(20, { decision: "allow_once", source: "ask" }));
    const intent = intentFor();
    const decision = await store.decideIntent(intent);
    expect(decision).toEqual({ decision: "allow_once", source: "ask" });

    const [record] = await store.all();
    expect(record.status).toBe("decided");
    expect(record.decision).toBe("allow_once");
    expect(record.source).toBe("dialog");
    expect(record.decidedAt).toBeTypeOf("string");
  });
});

describe("the wait is bounded", () => {
  it("an approval nobody answers expires and fails CLOSED", async () => {
    const dir = tempDir();
    // 30ms window: the human never answers.
    const store = new ApprovalStore(dir, silent, 30);
    const decision = await store.decideIntent(intentFor());
    expect(decision).toEqual({ decision: "deny", source: "expired" });

    const [record] = await store.all();
    expect(record.status).toBe("expired");
    expect(record.decision).toBe("deny");
  });

  it("a delegate that throws denies rather than hanging", async () => {
    const dir = tempDir();
    const store = new ApprovalStore(dir, {
      decideIntent: async () => {
        throw new Error("dialog exploded");
      },
    });
    const decision = await store.decideIntent(intentFor());
    expect(typeof decision === "string" ? decision : decision.decision).toBe("deny");
  });

  it("an answer that arrives before the deadline wins", async () => {
    const dir = tempDir();
    const store = new ApprovalStore(dir, answersIn(10), 5_000);
    const decision = await store.decideIntent(intentFor());
    expect(typeof decision === "string" ? decision : decision.decision).toBe("allow_once");
    expect((await store.all())[0].status).toBe("decided");
  });
});

describe("an answer can arrive from somewhere other than the dialog", () => {
  it("resolve() decides a waiting approval", async () => {
    const dir = tempDir();
    const store = new ApprovalStore(dir, silent, 5_000);
    const intent = intentFor();
    const pending = store.decideIntent(intent);
    await answerable(store);
    expect(await store.pending()).toHaveLength(1);

    expect(store.resolve(intent.intentId, "always_allow", "operator")).toBe(true);
    const decision = await pending;
    expect(typeof decision === "string" ? decision : decision.decision).toBe("always_allow");

    const [record] = await store.all();
    expect(record.status).toBe("decided");
    expect(record.source).toBe("operator");
  });

  it("resolve() on something nobody is waiting for is refused", () => {
    const store = new ApprovalStore(tempDir(), silent);
    expect(store.resolve("NOT-A-REAL-INTENT", "allow_once")).toBe(false);
  });

  it("refuses an intent id that would escape the directory", async () => {
    const store = new ApprovalStore(tempDir(), silent);
    const intent = { ...intentFor(), intentId: "../../../etc/passwd" };
    await expect(store.decideIntent(intent)).rejects.toThrow(/unusable intent id/);
  });
});

describe("across a restart", () => {
  it("a pending record from a previous run is marked abandoned, not left claiming to be live", async () => {
    const dir = tempDir();
    const first = new ApprovalStore(dir, silent, 5_000);
    const intent = intentFor();
    startApproval(first, intent);
    await pendingRecord(first);
    expect((await first.all())[0].status).toBe("pending");

    // A new process opens the same directory. The call that was waiting is gone
    // with the process; nothing can answer that record any more.
    const second = new ApprovalStore(dir, silent, 5_000);
    // Assigned in the same tick as construction, which the hook's contract
    // requires — the sweep must not have fired yet.
    const abandoned: string[] = [];
    second.onAbandoned = (r) => abandoned.push(r.intentId);
    await second.ready;
    const [record] = await second.all();
    expect(record.status).toBe("abandoned");
    expect(record.decidedAt).toBeTypeOf("string");
    // The hook saw it, so the abandonment can reach the audit log.
    expect(abandoned).toEqual([intent.intentId]);
    // And it is no longer offered as something answerable.
    expect(await second.pending()).toHaveLength(0);
    expect(second.resolve(intent.intentId, "allow_once")).toBe(false);
  });

  it("keeps decided records so the history survives", async () => {
    const dir = tempDir();
    const first = new ApprovalStore(dir, answersIn(5));
    await first.decideIntent(intentFor());
    const second = new ApprovalStore(dir, silent);
    await second.ready;
    expect(await second.all()).toHaveLength(1);
    expect((await second.all())[0].status).toBe("decided");
  });
});

describe("failing closed does not depend on the timer (review finding 2)", () => {
  it("an answer arriving after the deadline is denied, even though the timer has not run", async () => {
    // A long real TTL, so the setTimeout genuinely has not fired. The clock,
    // which is what the store checks, is moved past the deadline — this is what
    // a loop blocked past the deadline looks like from the store's point of
    // view.
    let clock = 1_000_000;
    const store = new ApprovalStore(tempDir(), silent, 60_000, () => clock);
    await store.ready;
    const intent = intentFor();
    const pending = store.decideIntent(intent);
    await answerable(store);

    clock += 60_001; // past the deadline; the 60s timer has not fired

    // Somebody clicks Allow. It must not be honoured.
    expect(store.resolve(intent.intentId, "allow_once", "human")).toBe(true);
    const decision = await pending;
    expect(decision).toEqual({ decision: "deny", source: "expired" });

    const [record] = await store.all();
    expect(record.status).toBe("expired");
    expect(record.decision).toBe("deny");
  });

  it("the dialog's own late answer is denied on the same check", async () => {
    let clock = 1_000_000;
    // The delegate answers "allow" only when this test says so, AFTER the clock
    // has moved past a deadline the timer will not reach for a minute.
    //
    // It used to answer on a real 40ms timer while the test waited a real 10ms
    // and hoped to win — which lost 1 run in 40 under load, letting the allow
    // land before the deadline and turning a deny into an allow. A test about
    // an answer arriving late must control when the answer arrives.
    let answer: (decision: IntentDecision) => void = () => {};
    const delegate: PolicyDelegate = {
      decideIntent: () => new Promise<IntentDecision>((resolve) => (answer = resolve)),
    };
    const store = new ApprovalStore(tempDir(), delegate, 60_000, () => clock);
    await store.ready;
    const pending = store.decideIntent(intentFor());
    await answerable(store);
    clock += 60_001;
    answer("allow_once");
    expect(await pending).toEqual({ decision: "deny", source: "expired" });
  });

  it("an answer inside the deadline is still honoured", async () => {
    let clock = 1_000_000;
    const store = new ApprovalStore(tempDir(), silent, 60_000, () => clock);
    await store.ready;
    const intent = intentFor();
    const pending = store.decideIntent(intent);
    await answerable(store);
    clock += 59_000; // still inside
    expect(store.resolve(intent.intentId, "allow_once", "human")).toBe(true);
    expect(await pending).toEqual({ decision: "allow_once", source: "human" });
  });
});
