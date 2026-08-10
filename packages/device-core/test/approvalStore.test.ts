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

describe("the record exists before the answer does", () => {
  it("writes a pending record before the human is asked", async () => {
    const dir = tempDir();
    const store = new ApprovalStore(dir, silent);
    const intent = intentFor();
    void store.decideIntent(intent);
    await new Promise((r) => setTimeout(r, 30));

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
    await new Promise((r) => setTimeout(r, 30));
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
    await new Promise((r) => setTimeout(r, 30));
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
    void first.decideIntent(intent);
    await new Promise((r) => setTimeout(r, 30));
    expect((await first.all())[0].status).toBe("pending");

    // A new process opens the same directory. The call that was waiting is gone
    // with the process; nothing can answer that record any more.
    const second = new ApprovalStore(dir, silent, 5_000);
    await second.ready;
    const [record] = await second.all();
    expect(record.status).toBe("abandoned");
    expect(record.decidedAt).toBeTypeOf("string");
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
    await new Promise((r) => setTimeout(r, 30));

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
    // The delegate answers "allow" after a real 40ms, by which time the clock
    // has moved past a deadline the timer will not reach for a minute.
    const store = new ApprovalStore(tempDir(), answersIn(40, "allow_once"), 60_000, () => clock);
    await store.ready;
    const pending = store.decideIntent(intentFor());
    await new Promise((r) => setTimeout(r, 10));
    clock += 60_001;
    expect(await pending).toEqual({ decision: "deny", source: "expired" });
  });

  it("an answer inside the deadline is still honoured", async () => {
    let clock = 1_000_000;
    const store = new ApprovalStore(tempDir(), silent, 60_000, () => clock);
    await store.ready;
    const intent = intentFor();
    const pending = store.decideIntent(intent);
    await new Promise((r) => setTimeout(r, 30));
    clock += 59_000; // still inside
    expect(store.resolve(intent.intentId, "allow_once", "human")).toBe(true);
    expect(await pending).toEqual({ decision: "allow_once", source: "human" });
  });
});
