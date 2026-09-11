/**
 * What an agent is told while — and after — a human is being asked.
 *
 * Three field symptoms, one surface: agents went silent when an approval was
 * outstanding, gave up when it timed out, and re-asked the human by re-issuing
 * the original call. The first and third are things nothing ever told the agent
 * to do differently. The second was worse than silence: an approval nobody
 * answered produced the SAME sentence as a human pressing Deny, so an agent
 * that stopped was behaving correctly on a refusal that never happened.
 *
 * These tests pin the distinction and the advice. They are end-to-end on
 * purpose — a real DeviceAgent, a real ApprovalStore, a real deferred store —
 * because the thing under test is the payload that leaves the machine.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSONValue } from "@domo/protocol";
import {
  ApprovalStore,
  DeviceAgent,
  HeadlessPolicy,
  PolicyDelegate,
} from "@domo/device-core";
import { createDomoMcpServer, DeferredResults, DomoMcpServer, McpServerOptions } from "@domo/mcp-server";
import { bareToolNames } from "./toolNames.js";
import { callTool } from "./client.js";

const AGENT = { agent_id: "agent-1", agent_name: "Agent One" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-waiting-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A human who is shown the dialog and never comes back to their desk. */
const NEVER_ANSWERS: PolicyDelegate = {
  decideIntent: (_intent, progress) => {
    progress?.asking();
    return new Promise(() => {});
  },
};

/**
 * The same, plus a barrier that resolves once the dialog has been reported.
 *
 * Asserting `awaiting_approval` on the FIRST answer is a race: the budget is
 * armed before the work starts, so it can expire before the delegate is reached
 * and the envelope then says `deciding` — correct, and not what is under test.
 * Wait for the signal, then poll.
 */
function asksAndWaits(): { delegate: PolicyDelegate; asked: Promise<void> } {
  let reached!: () => void;
  const asked = new Promise<void>((r) => (reached = r));
  return {
    asked,
    delegate: {
      decideIntent: (_intent, progress) => {
        progress?.asking();
        reached();
        return new Promise(() => {});
      },
    },
  };
}

/**
 * The default mode: a reviewer decides and no dialog is ever raised. It takes
 * its time — the reviewer's own budget is minutes wide against the call's
 * fifteen seconds — so this is the ordinary way a call defers on a shipping
 * Mac, not an edge case.
 */
const DECIDES_ALONE: PolicyDelegate = { decideIntent: () => new Promise(() => {}) };

/**
 * A server whose approvals go through a real store — so the deadline, and the
 * deny-by-deadline it produces, are the real ones.
 */
function serverWith(
  delegate: PolicyDelegate,
  opts: { ttlMs: number } & McpServerOptions,
): {
  server: DomoMcpServer;
  file: string;
} {
  const { ttlMs, ...serverOptions } = opts;
  const home = tempDir();
  const approvals = new ApprovalStore(path.join(home, "device/approvals"), delegate, ttlMs);
  const device = new DeviceAgent(home, "Test Mac", approvals);
  const server = createDomoMcpServer(device, serverOptions);
  cleanups.push(() => server.close());
  const file = path.join(tempDir(), "a.txt");
  fs.writeFileSync(file, "contents");
  return { server, file };
}

describe("a timeout is not a refusal", () => {
  // The bug: this sentence used to be "the owner of this Mac denied the
  // request" — the default, because "expired" was not an explained source. An
  // agent reading that stops, correctly, and the user (who was making coffee)
  // never learns why nothing happened.
  it("an approval nobody answered says so, and says it can be retried", async () => {
    // TTL well under the budget, so the deadline lands inside the call and the
    // agent gets the denial directly rather than through a handle.
    const { server, file } = serverWith(NEVER_ANSWERS, { ttlMs: 20, budgetMs: 5_000 });
    const { payload, isError } = await callTool(server, "plow_read_file", { path: file }, AGENT);

    // Still a denial, and still an error: it fails closed, exactly as before.
    expect(isError).toBe(true);
    expect(payload.status).toBe("denied");
    // But an honest one.
    expect(payload.reason).toMatch(/no one answered/i);
    expect(payload.reason).toMatch(/timeout, not a refusal/i);
    expect(payload.reason).toMatch(/try again/i);
    // The sentence a human pressing Deny produces must not appear here.
    expect(payload.reason).not.toMatch(/denied the request/);
    // …and it must not send the user back to the prompt that just expired: it
    // is still on screen, it is inert, and clicking it only lets the retry's
    // dialog through. Retry first.
    expect(payload.reason).not.toMatch(/approve it on their Mac/i);
    expect(payload.reason).toMatch(/expired and does nothing/i);
    expect(bareToolNames(payload.reason)).toEqual([]);
  });

  // KEPT deliberately, against review: this looks like it duplicates the two
  // denial paths, and it is the only test that pins the bug. The defect was
  // those two paths converging on one sentence — every other assertion here
  // checks a path in isolation and would stay green through a regression that
  // made them identical again. A test that re-runs both is what the bug costs.
  it("the two denials are distinguishable", async () => {
    const timedOut = serverWith(NEVER_ANSWERS, { ttlMs: 20, budgetMs: 5_000 });
    const expired = await callTool(timedOut.server, "plow_read_file", { path: timedOut.file }, AGENT);

    const home = tempDir();
    const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "deny" }));
    const server = createDomoMcpServer(device);
    cleanups.push(() => server.close());
    const file = path.join(tempDir(), "a.txt");
    fs.writeFileSync(file, "contents");
    const refused = await callTool(server, "plow_read_file", { path: file }, AGENT);

    expect(expired.payload.reason).not.toBe(refused.payload.reason);
  });
});

describe("a pending handle says what to do about it", () => {
  it("the answer while a dialog is up tells the agent to speak up, poll, and not ask twice", async () => {
    // Budget under the approval deadline, so the call defers while the human
    // is still looking at a dialog.
    const asking = asksAndWaits();
    const { server, file } = serverWith(asking.delegate, { ttlMs: 60_000, budgetMs: 30 });
    const first = await callTool(server, "plow_read_file", { path: file }, AGENT);
    expect(first.payload.status).toBe("pending");

    await asking.asked;
    const { payload, isError } = await callTool(
      server,
      "plow_get_result",
      { handle: first.payload.handle },
      AGENT,
    );

    expect(isError).toBe(false);
    expect(payload.status).toBe("pending");
    expect(payload.reason).toBe("awaiting_approval");
    expect(payload.retry_after_ms).toBeTypeOf("number");
    // The three things nothing used to say.
    expect(payload.note).toMatch(/tell the user/i);
    expect(payload.note).toMatch(/plow_get_result/);
    expect(payload.note).toMatch(/do not repeat the original call/i);
    // One producer — the code that creates the window — so the note may say
    // plainly that a person is holding the call.
    expect(payload.note).toMatch(/waiting for them to answer/i);
    expect(payload.note).not.toMatch(/still being prepared|policy check/i);
    // This note is not in the manifest, so the manifest sweep cannot see it —
    // and it shipped saying "poll get_result" an hour before the tools were
    // prefixed. Sweep it where it actually surfaces: on the payload.
    expect(bareToolNames(payload.note)).toEqual([]);
    // When this reason is reported a dialog IS on screen. What must never claim
    // one is `deciding`, which the test below pins.
    expect(payload.note).toMatch(/on the user's Mac/i);
  });

  // The default mode raises no dialog, so an agent told "a request has gone out
  // to you for approval" sends its owner looking for one that cannot appear.
  it("a Mac that never asks its owner does not claim it is waiting on them", async () => {
    const { server, file } = serverWith(DECIDES_ALONE, { ttlMs: 60_000, budgetMs: 30 });
    const { payload } = await callTool(server, "plow_read_file", { path: file }, AGENT);

    expect(payload.status).toBe("pending");
    expect(payload.reason).toBe("deciding");
    // The two sentences that produced both symptoms.
    expect(payload.note).not.toMatch(/tell the user it is waiting/i);
    expect(payload.note).toMatch(/nobody has been asked to approve anything/i);
    // …but strictly as a PHASE. The same reason is what an Ask-mode Mac gets
    // while it resolves a path or queues behind another prompt, so a note that
    // described the Mac's SETTING would be false exactly there.
    expect(payload.note).not.toMatch(/not set up to ask/i);
    expect(payload.note).not.toMatch(/cannot ask/i);
    // And it has to say the other phase exists, or an agent told "nobody has
    // been asked" reads it as "nobody ever will".
    expect(payload.note).toMatch(/awaiting_approval/);
    // …and the advice that keeps the agent moving is still there.
    expect(payload.note).toMatch(/plow_get_result/);
    expect(payload.note).toMatch(/do not repeat the original call/i);
    expect(bareToolNames(payload.note)).toEqual([]);
  });

  // A dialog that opens after the envelope was already minted still moves the
  // handle: the owner walked over mid-call, and the next poll has to say so.
  it("a dialog raised after the handle was minted upgrades what polling says", async () => {
    let raise!: () => void;
    const opens = new Promise<void>((r) => (raise = r));
    // Awaiting `opens` would only prove the delegate was WOKEN — its own
    // continuation, and the asking() inside it, are a microtask later, so the
    // poll below could beat the signal it is testing for. Wait on the signal.
    let asked!: () => void;
    const hasAsked = new Promise<void>((r) => (asked = r));
    const late: PolicyDelegate = {
      decideIntent: (_intent, progress) =>
        opens.then(() => {
          progress?.asking();
          asked();
          return new Promise<never>(() => {});
        }),
    };
    const { server, file } = serverWith(late, { ttlMs: 60_000, budgetMs: 30 });

    const first = await callTool(server, "plow_read_file", { path: file }, AGENT);
    expect(first.payload.reason).toBe("deciding");

    raise();
    await hasAsked;
    const polled = await callTool(
      server,
      "plow_get_result",
      { handle: first.payload.handle },
      AGENT,
    );
    expect(polled.payload.reason).toBe("awaiting_approval");
  });

  // After the window closes this Mac still writes the approval record, appends
  // the audit line and carries the decision back. The barrier holds that
  // stretch open on purpose: it is the window under test, not the final answer.
  it("a dialog that has been answered stops claiming the user is holding it", async () => {
    let release!: () => void;
    const persisting = new Promise<void>((r) => (release = r));
    let answered!: () => void;
    const hasAnswered = new Promise<void>((r) => (answered = r));

    const clickedThenSlow: PolicyDelegate = {
      decideIntent: async (_intent, progress) => {
        progress?.asking();
        progress?.answered("chosen"); // they pressed a button; the window is gone
        answered();
        await persisting; // …and this Mac is still writing it down
        return "allow_once";
      },
    };
    const { server, file } = serverWith(clickedThenSlow, { ttlMs: 60_000, budgetMs: 30 });

    const first = await callTool(server, "plow_read_file", { path: file }, AGENT);
    expect(first.payload.status).toBe("pending");

    await hasAnswered;
    const polled = await callTool(
      server,
      "plow_get_result",
      { handle: first.payload.handle },
      AGENT,
    );

    // Not "go and look at your Mac": there is nothing there to look at. And not
    // `deciding` either, whose note says nobody has been asked — somebody has
    // just done the asking AND the answering. This stretch is its own phase.
    expect(polled.payload.reason).toBe("answered");
    expect(polled.payload.note).toMatch(/has ANSWERED/);
    expect(polled.payload.note).not.toMatch(/nobody has been asked/i);
    release();
  });

  // DECIDES_ALONE, not a delegate that asks: a delegate that calls `asking()`
  // can change the phase between the first answer and the poll, because the
  // budget may expire before the delegate is even reached. The notes would then
  // differ for a good reason, and this test is about neither phase — it is
  // about the same phase answering the same way twice.
  // Closing the window without pressing anything fails closed like any
  // unanswered approval — but it is not a choice, and saying the user "answered"
  // and that this Mac is recording "what they said" is an account of a decision
  // nobody made. It is also the one case where there is still a person to ask.
  it("a window dismissed without a button does not claim the user answered", async () => {
    let release!: () => void;
    const persisting = new Promise<void>((r) => (release = r));
    let gone!: () => void;
    const hasGone = new Promise<void>((r) => (gone = r));

    const walkedAway: PolicyDelegate = {
      decideIntent: async (_intent, progress) => {
        progress?.asking();
        progress?.answered("dismissed");
        gone();
        await persisting;
        return "deny";
      },
    };
    const { server, file } = serverWith(walkedAway, { ttlMs: 60_000, budgetMs: 30 });

    const first = await callTool(server, "plow_read_file", { path: file }, AGENT);
    await hasGone;
    const polled = await callTool(
      server,
      "plow_get_result",
      { handle: first.payload.handle },
      AGENT,
    );

    expect(polled.payload.reason).toBe("dismissed");
    expect(polled.payload.note).toMatch(/closed without an answer/i);
    expect(polled.payload.note).not.toMatch(/has ANSWERED/);
    release();
  });

  it("polling the handle repeats the advice, so it survives a lost first answer", async () => {
    const { server, file } = serverWith(DECIDES_ALONE, { ttlMs: 60_000, budgetMs: 30 });
    const first = await callTool(server, "plow_read_file", { path: file }, AGENT);
    const polled = await callTool(server, "plow_get_result", { handle: first.payload.handle }, AGENT);

    expect(polled.payload.status).toBe("pending");
    expect(polled.payload.note).toBe(first.payload.note);
  });

  // "running" means execution has started; it does not imply that every
  // action-specific authorization inside that execution has succeeded.
  it("once decided and running, the note claims only that execution started", async () => {
    const store = new DeferredResults(20);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const pending = (await store.run("agent-1", async (progress) => {
      progress.decided();
      await held;
      return { ok: true } as JSONValue;
    })) as { status: string; reason: string; note: string; handle: string };

    expect(pending.status).toBe("pending");
    expect(pending.reason).toBe("running");
    expect(pending.note).toMatch(/execution is underway/i);
    expect(pending.note).not.toMatch(/approved/i);
    expect(pending.note).not.toMatch(/tell the user you are waiting/i);
    expect(pending.note).toMatch(/plow_get_result/);
    expect(bareToolNames(pending.note)).toEqual([]);
    release();
  });

  // The note is advice to a model. It must not read as a promise about what
  // the tool may do — the capability set the human approves is the bound.
  it("the note promises nothing", async () => {
    const { server, file } = serverWith(NEVER_ANSWERS, { ttlMs: 60_000, budgetMs: 30 });
    const { payload } = await callTool(server, "plow_read_file", { path: file }, AGENT);
    expect(payload.note).not.toMatch(/will be approved|guaranteed|always/i);
  });
});
