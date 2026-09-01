/**
 * A tunnelled call cannot wait for a human, so the approval outlives the call.
 * That makes the record on disk the only thing that says what was asked while
 * it is still unanswered — and once it is answered, the audit log is the
 * history, and the record goes.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Capability, Intent, makeIntent } from "@domo/protocol";
import { ApprovalStore, IntentDecision, PolicyDelegate } from "@domo/device-core";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
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
    void store.decideIntent(intent);
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
    void store.decideIntent(intent);
    await pendingRecord(store);
    const file = path.join(dir, `${intent.intentId}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("removes the record when the answer lands — the audit log is the history", async () => {
    const dir = tempDir();
    const store = new ApprovalStore(dir, answersIn(20, { decision: "allow_once", source: "ask" }));
    const intent = intentFor();
    const decision = await store.decideIntent(intent);
    expect(decision).toEqual({ decision: "allow_once", source: "ask" });

    expect(await store.all()).toEqual([]);
    expect(fs.existsSync(path.join(dir, `${intent.intentId}.json`))).toBe(false);
  });
});

describe("the wait is bounded", () => {
  it("an approval nobody answers expires and fails CLOSED", async () => {
    const dir = tempDir();
    // 30ms window: the human never answers.
    const store = new ApprovalStore(dir, silent, 30);
    const decision = await store.decideIntent(intentFor());
    expect(decision).toEqual({ decision: "deny", source: "expired" });

    // Settled by the deadline is settled: nothing is left claiming to wait.
    expect(await store.all()).toEqual([]);
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
    expect(await store.all()).toEqual([]);
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
    expect(await store.all()).toEqual([]);
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
  it("a pending record from a previous run is reported abandoned and removed, not left claiming to be live", async () => {
    const dir = tempDir();
    const first = new ApprovalStore(dir, silent, 5_000);
    const intent = intentFor();
    void first.decideIntent(intent);
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
    // The hook saw it, so the abandonment can reach the audit log — which is
    // where it lives from here; the directory holds only what is in flight.
    expect(abandoned).toEqual([intent.intentId]);
    expect(await second.all()).toEqual([]);
    // And it is no longer offered as something answerable.
    expect(await second.pending()).toHaveLength(0);
    expect(second.resolve(intent.intentId, "allow_once")).toBe(false);
  });

  it("sweeps outcomes an earlier build left behind, without calling them abandoned", async () => {
    // Builds before this one rewrote the record with its outcome and kept it
    // forever. Their audit log already has the decision, so the file is only
    // weight — and it was answered, so the abandonment hook must not fire.
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    const intent = intentFor();
    fs.writeFileSync(
      path.join(dir, `${intent.intentId}.json`),
      JSON.stringify({
        intentId: intent.intentId,
        agentId: "sess_alice",
        agentName: "Claude Code",
        request: "read file: /tmp/x",
        goal: "tidy up",
        capabilities: ["Read: /tmp/x"],
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-01-01T00:15:00Z",
        status: "decided",
        decision: "allow_once",
        source: "dialog",
        decidedAt: "2026-01-01T00:01:00Z",
      }),
    );
    const store = new ApprovalStore(dir, silent);
    const abandoned: string[] = [];
    store.onAbandoned = (r) => abandoned.push(r.intentId);
    await store.ready;
    expect(abandoned).toEqual([]);
    expect(await store.all()).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
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
    expect(await store.all()).toEqual([]);
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

/**
 * The store sits between `PolicyEngine` and whoever really decides, so a veto
 * it does not forward is a veto that never happens in production — the engine
 * asks the store, not the delegate the app installed.
 */
describe("the stored-rule veto passes through", () => {
  it("forwards the inner delegate's answer, both ways", async () => {
    const inner = (allow: boolean): PolicyDelegate => ({
      decideIntent: async () => "deny" as const,
      mayGrantFromStoredRule: () => allow,
    });

    const no = new ApprovalStore(tempDir(), inner(false));
    expect(await no.mayGrantFromStoredRule(intentFor())).toBe(false);

    const yes = new ApprovalStore(tempDir(), inner(true));
    expect(await yes.mayGrantFromStoredRule(intentFor())).toBe(true);
  });

  it("keeps the plain behaviour when the inner delegate has no veto", async () => {
    const store = new ApprovalStore(tempDir(), silent);
    expect(await store.mayGrantFromStoredRule(intentFor())).toBe(true);
  });
});
