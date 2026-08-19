/**
 * The continuation lifecycle: every legal move, no illegal ones, and an audit
 * timeline that describes the operation rather than the poller.
 *
 * Two properties carry the weight here. `backgrounded` may only ever come from
 * a relay acknowledgement — never from time passing, never from the result
 * landing — because the whole point of the state is telling a user whether the
 * agent actually received the handle. And an uncollected result must end
 * somewhere: either exactly one "the agent asked for it" record however many
 * times it polls, or an expiry.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JSONValue, jv } from "@domo/protocol";
import { DeviceAgent, HeadlessPolicy } from "@domo/device-core";
import {
  CONTINUATION_EVENTS,
  Continuations,
  ContinuationState,
  createDomoMcpServer,
  exchangeContext,
} from "@domo/mcp-server";
import { callTool } from "./client.js";

const AGENT = { agent_id: "agent-1", agent_name: "Agent One" };
const INTENT = "INTENT-1";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-cont-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A continuations registry over a recording audit, with one open operation. */
function tracked(handle = "H1"): {
  cont: Continuations;
  events: string[];
  fields: { [k: string]: JSONValue | undefined }[];
} {
  const events: string[] = [];
  const fields: { [k: string]: JSONValue | undefined }[] = [];
  const cont = new Continuations({
    record: (event, f) => {
      events.push(event);
      fields.push(f ?? {});
    },
  });
  cont.open(handle, AGENT.agent_id);
  cont.linkIntent(handle, INTENT);
  return { cont, events, fields };
}

/** Take the pending envelope down a named relay exchange. */
function deferOn(cont: Continuations, rid: string, handle = "H1"): void {
  exchangeContext.run({ rid }, () => cont.deferred(handle));
}

describe("every valid transition", () => {
  it("waiting_inline → backgrounded → approved_uncollected → collected", () => {
    const { cont, events } = tracked();
    expect(cont.state("H1")).toBe("waiting_inline");

    deferOn(cont, "RID-1");
    // Deferring is not backgrounding: the handle has gone out, but nothing has
    // said it arrived.
    expect(cont.state("H1")).toBe("waiting_inline");

    cont.acknowledgeExchange("RID-1");
    expect(cont.state("H1")).toBe("backgrounded");

    cont.ready("H1");
    expect(cont.state("H1")).toBe("approved_uncollected");

    cont.collected("H1");
    expect(cont.state("H1")).toBe("collected");

    expect(events).toEqual([
      CONTINUATION_EVENTS.backgrounded,
      CONTINUATION_EVENTS.ready,
      CONTINUATION_EVENTS.collected,
    ]);
  });

  it("reaches approved_uncollected without ever being backgrounded", () => {
    // The relay never acknowledged — a lost socket, an old relay. The result is
    // still ready and still collectable; only the claim about delivery is gone.
    const { cont, events } = tracked();
    deferOn(cont, "RID-2");
    cont.ready("H1");
    expect(cont.state("H1")).toBe("approved_uncollected");
    cont.collected("H1");
    expect(cont.state("H1")).toBe("collected");
    expect(events).toEqual([CONTINUATION_EVENTS.ready, CONTINUATION_EVENTS.collected]);
  });

  it("ends at expired when nobody comes back for the result", () => {
    const { cont, events } = tracked();
    deferOn(cont, "RID-3");
    cont.acknowledgeExchange("RID-3");
    cont.ready("H1");
    cont.expired("H1");
    expect(cont.state("H1")).toBe("expired");
    expect(events).toEqual([
      CONTINUATION_EVENTS.backgrounded,
      CONTINUATION_EVENTS.ready,
      CONTINUATION_EVENTS.expired,
    ]);
  });

  it("ends at denied and at failed, from either phase, with no new record", () => {
    // Both are already in the timeline — a denial as the decision, a failure as
    // whatever failed. The state moves; the log does not repeat itself.
    for (const [ending, drive] of [
      ["denied", (c: Continuations) => c.denied("H1")],
      ["failed", (c: Continuations) => c.failed("H1")],
    ] as [ContinuationState, (c: Continuations) => void][]) {
      const inline = tracked();
      drive(inline.cont);
      expect(inline.cont.state("H1")).toBe(ending);
      expect(inline.events).toEqual([]);

      const background = tracked();
      deferOn(background.cont, "RID-4");
      background.cont.acknowledgeExchange("RID-4");
      drive(background.cont);
      expect(background.cont.state("H1")).toBe(ending);
      expect(background.events).toEqual([CONTINUATION_EVENTS.backgrounded]);
    }
  });

  it("refuses every move a terminal state has no business making", () => {
    const { cont, events } = tracked();
    deferOn(cont, "RID-5");
    cont.ready("H1");
    cont.collected("H1");

    // Collected is the end. Nothing reopens it, and nothing else is recorded.
    cont.expired("H1");
    cont.acknowledgeExchange("RID-5");
    cont.ready("H1");
    expect(cont.state("H1")).toBe("collected");
    expect(events).toEqual([CONTINUATION_EVENTS.ready, CONTINUATION_EVENTS.collected]);

    // And an expired result cannot later be collected.
    const late = tracked("H2");
    late.cont.ready("H2");
    late.cont.expired("H2");
    late.cont.collected("H2");
    expect(late.cont.state("H2")).toBe("expired");
    expect(late.events).toEqual([CONTINUATION_EVENTS.ready, CONTINUATION_EVENTS.expired]);
  });

  it("carries the intent on every record and the handle on none", () => {
    const { cont, events, fields } = tracked();
    deferOn(cont, "RID-6");
    cont.acknowledgeExchange("RID-6");
    cont.ready("H1");
    cont.collected("H1");
    expect(events.length).toBe(3);
    for (const f of fields) {
      expect(f.intentId).toBe(INTENT);
      // The deferred handle is internal plumbing and never appears.
      expect(JSON.stringify(f)).not.toContain("H1");
    }
  });

  it("drops the record when the call answered inside its budget", () => {
    const { cont, events } = tracked();
    cont.closeInline("H1");
    expect(cont.state("H1")).toBeNull();
    expect(cont.size).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("backgrounding is an observation, never an inference", () => {
  it("stays waiting_inline until the relay acknowledges that exact exchange", () => {
    const { cont, events } = tracked();
    deferOn(cont, "RID-MINE");

    // Another exchange's acknowledgement says nothing about ours.
    cont.acknowledgeExchange("RID-SOMEONE-ELSE");
    expect(cont.state("H1")).toBe("waiting_inline");

    // Neither does the work landing, or the agent collecting it.
    cont.ready("H1");
    cont.collected("H1");
    expect(cont.state("H1")).toBe("collected");
    expect(events).not.toContain(CONTINUATION_EVENTS.backgrounded);
  });

  it("records delivery as unknown, and moves nothing, when no ack can come", () => {
    const { cont, events } = tracked();
    deferOn(cont, "RID-LOST");
    cont.exchangeDeliveryUnknown("RID-LOST");

    expect(events).toEqual([CONTINUATION_EVENTS.deliveryUnknown]);
    // Unknown is not failure and not success: the state is exactly where it was.
    expect(cont.state("H1")).toBe("waiting_inline");

    // And a late acknowledgement for that dead exchange cannot resurrect it.
    cont.acknowledgeExchange("RID-LOST");
    expect(cont.state("H1")).toBe("waiting_inline");
    expect(events).toEqual([CONTINUATION_EVENTS.deliveryUnknown]);
  });

  it("never backgrounds an operation whose envelope went nowhere", () => {
    // No exchange context — no relay, a direct call, a test harness. There is
    // no rid to acknowledge, so this operation can never claim backgrounding.
    const { cont, events } = tracked();
    cont.deferred("H1");
    cont.acknowledgeExchange("");
    expect(cont.state("H1")).toBe("waiting_inline");
    expect(events).toEqual([]);
  });
});

/** The audit event names recorded against `intentId`, in order. */
const timeline = (device: DeviceAgent, intentId: string): string[] =>
  device.audit
    .entries()
    .filter((e) => jv(e).get("intentId").str === intentId)
    .map((e) => jv(e).get("event").str ?? "");

describe("through the server, over repeated reads", () => {
  it("records the agent asking for the result exactly once, however often it polls", async () => {
    const home = tempDir();
    // The human takes longer than the budget, then says yes.
    let approve = () => {};
    const waited = new Promise<void>((r) => {
      approve = () => r();
    });
    const device = new DeviceAgent(home, "Test Mac", {
      decideIntent: async () => {
        await waited;
        return "allow_once" as const;
      },
    });
    const server = createDomoMcpServer(device, { budgetMs: 30 });
    cleanups.push(() => server.close());

    const file = path.join(tempDir(), "hello.txt");
    fs.writeFileSync(file, "the numbers");

    const { payload } = await callTool(server, "read_file", { path: file }, AGENT);
    expect(payload.status).toBe("pending");
    const handle = payload.handle as string;
    const intentId = server.continuations.intentOf(handle)!;
    expect(intentId).toBeTruthy();
    expect(server.continuations.state(handle)).toBe("waiting_inline");

    approve();
    let poll = payload;
    for (let i = 0; i < 80 && poll.status === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      poll = (await callTool(server, "get_result", { handle }, AGENT)).payload;
    }
    expect(poll.status).toBe("ready");
    expect(server.continuations.state(handle)).toBe("collected");

    // Three more reads of the same handle: non-consuming, same payload.
    for (let i = 0; i < 3; i++) {
      const again = (await callTool(server, "get_result", { handle }, AGENT)).payload;
      expect(again.status).toBe("ready");
    }

    const events = timeline(device, intentId);
    expect(events.filter((e) => e === CONTINUATION_EVENTS.collected)).toEqual([
      CONTINUATION_EVENTS.collected,
    ]);
    // One operation, one timeline: permission asked, decided, result ready,
    // agent asked for it.
    expect(events).toEqual([
      "intent_received",
      "intent_decision",
      "file_read",
      CONTINUATION_EVENTS.ready,
      CONTINUATION_EVENTS.collected,
    ]);
  });

  it("expires an uncollected result once, and says so in the timeline", async () => {
    const home = tempDir();
    const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "allow_once" }));
    // A clock the test drives, so retention can elapse without waiting it out.
    let clock = 1_000_000;
    const server = createDomoMcpServer(device, {
      budgetMs: 30,
      ttlMs: 60_000,
      now: () => clock,
    });
    cleanups.push(() => server.close());

    // Approved, but slower than the budget — so a handle goes back — and then
    // never collected.
    device.handleIntent = (async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { status: "ok", content_base64: Buffer.from("unread").toString("base64") };
    }) as never;

    const file = path.join(tempDir(), "hello.txt");
    fs.writeFileSync(file, "unread");
    const { payload } = await callTool(server, "read_file", { path: file }, AGENT);
    expect(payload.status).toBe("pending");
    const handle = payload.handle as string;
    const intentId = server.continuations.intentOf(handle)!;

    for (let i = 0; i < 40 && server.continuations.state(handle) !== "approved_uncollected"; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(server.continuations.state(handle)).toBe("approved_uncollected");

    // Retention elapses with nobody asking.
    clock += 60_001;
    const late = (await callTool(server, "get_result", { handle }, AGENT)).payload;
    expect(late.status).toBe("expired");
    expect(server.continuations.state(handle)).toBe("expired");

    // Asking again changes nothing and records nothing more.
    const later = (await callTool(server, "get_result", { handle }, AGENT)).payload;
    expect(later.status).toBe("expired");

    const events = timeline(device, intentId);
    expect(events).not.toContain(CONTINUATION_EVENTS.collected);
    expect(events.filter((e) => e === CONTINUATION_EVENTS.expired)).toEqual([
      CONTINUATION_EVENTS.expired,
    ]);
    // The decision path is stubbed out here to control the timing, so this
    // timeline is the continuation half alone: ready, then expired.
    expect(events).toEqual([CONTINUATION_EVENTS.ready, CONTINUATION_EVENTS.expired]);
  });
});
