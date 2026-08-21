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
import { createDomoMcpServer, DeferredResults, DomoMcpServer } from "@domo/mcp-server";
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

/** A human who never comes back to their desk. */
const NEVER_ANSWERS: PolicyDelegate = { decideIntent: () => new Promise(() => {}) };

/**
 * A server whose approvals go through a real store — so the deadline, and the
 * deny-by-deadline it produces, are the real ones.
 */
function serverWith(delegate: PolicyDelegate, opts: { ttlMs: number; budgetMs: number }): {
  server: DomoMcpServer;
  file: string;
} {
  const home = tempDir();
  const approvals = new ApprovalStore(path.join(home, "device/approvals"), delegate, opts.ttlMs);
  const device = new DeviceAgent(home, "Test Mac", approvals);
  const server = createDomoMcpServer(device, { budgetMs: opts.budgetMs });
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
  it("the first answer tells the agent to speak up, poll, and not ask twice", async () => {
    // Budget under the approval deadline, so the call defers while the human
    // is still (notionally) looking at a dialog.
    const { server, file } = serverWith(NEVER_ANSWERS, { ttlMs: 60_000, budgetMs: 30 });
    const { payload, isError } = await callTool(server, "plow_read_file", { path: file }, AGENT);

    expect(isError).toBe(false);
    expect(payload.status).toBe("pending");
    expect(payload.reason).toBe("awaiting_approval");
    expect(payload.retry_after_ms).toBeTypeOf("number");
    // The three things nothing used to say.
    expect(payload.note).toMatch(/tell the user/i);
    expect(payload.note).toMatch(/plow_get_result/);
    expect(payload.note).toMatch(/do not repeat the original call/i);
    // Honest about what awaiting_approval actually means: no decision yet,
    // which also covers the work before anyone is asked.
    expect(payload.note).toMatch(/not decided yet/i);
    // This note is not in the manifest, so the manifest sweep cannot see it —
    // and it shipped saying "poll get_result" an hour before the tools were
    // prefixed. Sweep it where it actually surfaces: on the payload.
    expect(bareToolNames(payload.note)).toEqual([]);
    // It must NOT claim a dialog is on screen. Often there is not one: the
    // adversarial reviewer runs on a 30s budget against this 15s one, and the
    // approve/deny modes never ask a human at all.
    expect(payload.note).not.toMatch(/on the user's Mac now/i);
  });

  it("polling the handle repeats the advice, so it survives a lost first answer", async () => {
    const { server, file } = serverWith(NEVER_ANSWERS, { ttlMs: 60_000, budgetMs: 30 });
    const first = await callTool(server, "plow_read_file", { path: file }, AGENT);
    const polled = await callTool(server, "plow_get_result", { handle: first.payload.handle }, AGENT);

    expect(polled.payload.status).toBe("pending");
    expect(polled.payload.note).toBe(first.payload.note);
  });

  // "running" means the human already answered; telling that agent a request
  // is sitting on someone's screen would be a lie.
  it("once approved and running, the note says so instead", async () => {
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
    expect(pending.note).toMatch(/approved/i);
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
