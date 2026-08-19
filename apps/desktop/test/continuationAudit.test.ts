/**
 * The continuation lifecycle, as the activity view shows it.
 *
 * The audit is where a user goes after the window is gone, and the five
 * continuation events are exactly the part they cannot reconstruct for
 * themselves: whether the handoff was confirmed, whether the result was ever
 * collected, whether it expired unread. Raw event names in the timeline would
 * tell them none of that.
 *
 * Wording is load-bearing here. This Mac observes that a lookup ARRIVED, never
 * that a model read anything, and the timeline says so.
 */
import { describe, expect, it } from "vitest";
import { JSONValue } from "@domo/protocol";
import { auditActivities } from "../src/viewModel.js";

const INTENT = "i1";

/** One approved read, plus whatever continuation events a test adds. */
function operation(...extra: JSONValue[]): JSONValue[] {
  return [
    {
      event: "intent_received",
      intentId: INTENT,
      agent: "sess_1",
      agent_name: "Claude Code",
      request: "read file: /Users/you/report.txt",
      goal: "summarise it",
      capabilities: ["Read: /Users/you/report.txt"],
      ts: "2026-08-19T10:00:00Z",
    },
    {
      event: "intent_decision",
      intentId: INTENT,
      decision: "allow_once",
      source: "ask",
      ts: "2026-08-19T10:00:05Z",
    },
    ...extra,
  ];
}

const step = (e: string, ts: string): JSONValue => ({ event: e, intentId: INTENT, ts });
const only = (events: JSONValue[]) => auditActivities(events)[0];

describe("timeline descriptions", () => {
  it("describes every continuation event in words, not event names", () => {
    const activity = only(
      operation(
        step("continuation_backgrounded", "2026-08-19T10:00:06Z"),
        step("continuation_result_ready", "2026-08-19T10:00:07Z"),
        step("continuation_result_requested", "2026-08-19T10:00:20Z"),
      ),
    );
    const lines = activity.timeline.map((s) => s.text);
    expect(lines).toEqual([
      "Request: read file: /Users/you/report.txt",
      "Decision: allow_once — You (asked)",
      "Agent's call handed off — the relay confirmed it received the pending handle",
      "Result ready, waiting to be collected",
      "Agent requested the result",
    ]);
    // Never a raw event name.
    for (const line of lines) expect(line).not.toContain("continuation_");
  });

  it("says the agent REQUESTED the result — never that it read one", () => {
    // The local observation boundary: an authorized lookup reached this Mac.
    // What the model did with the payload is not something this Mac can see,
    // and the audit must not imply it can.
    const activity = only(operation(step("continuation_result_requested", "2026-08-19T10:00:20Z")));
    const line = activity.timeline.at(-1)!;
    expect(line.text).toBe("Agent requested the result");
    expect(line.text).not.toMatch(/read|received|saw/i);
    expect(line.state).toBe("ok");
  });

  it("marks an unconfirmed delivery and an expiry as neither done nor failed", () => {
    const activity = only(
      operation(
        step("continuation_delivery_unknown", "2026-08-19T10:00:06Z"),
        step("continuation_result_ready", "2026-08-19T10:00:07Z"),
        step("continuation_result_expired", "2026-08-19T10:15:07Z"),
      ),
    );
    const byText = new Map(activity.timeline.map((s) => [s.text, s.state]));
    expect([...byText.keys()]).toContain(
      "Delivery unconfirmed — the connection dropped before the relay acknowledged the handoff",
    );
    expect([...byText.keys()]).toContain(
      "Result expired — nobody collected it before retention ran out",
    );
    // `warn`, not `bad`: the work ran and the answer was there. What is
    // unresolved is whether it landed.
    for (const [text, state] of byText) {
      if (text.startsWith("Delivery unconfirmed") || text.startsWith("Result expired")) {
        expect(state).toBe("warn");
      }
    }
  });
});

describe("the row's status and filter bucket", () => {
  it("says a result is awaiting collection while nobody has asked", () => {
    const activity = only(
      operation(
        step("continuation_backgrounded", "2026-08-19T10:00:06Z"),
        step("continuation_result_ready", "2026-08-19T10:00:07Z"),
      ),
    );
    expect(activity.status).toBe("Allowed once · awaiting collection");
    expect(activity.tone).toBe("blue");
    // Still an approved operation: nothing failed.
    expect(activity.category).toBe("approved");
  });

  it("drops the suffix once the agent has asked for it", () => {
    const activity = only(
      operation(
        step("continuation_result_ready", "2026-08-19T10:00:07Z"),
        step("continuation_result_requested", "2026-08-19T10:00:20Z"),
        { event: "file_read", intentId: INTENT, path: "/Users/you/report.txt", bytes: 12, ts: "2026-08-19T10:00:21Z" },
      ),
    );
    expect(activity.status).toBe("Allowed once");
    expect(activity.tone).toBe("green");
    expect(activity.category).toBe("approved");
  });

  it("flags an expired result, and files it with the things worth reading", () => {
    const activity = only(
      operation(
        step("continuation_result_ready", "2026-08-19T10:00:07Z"),
        step("continuation_result_expired", "2026-08-19T10:15:07Z"),
      ),
    );
    expect(activity.status).toBe("Allowed once · result expired");
    expect(activity.tone).toBe("amber");
    // Not "approved": the work ran, but the answer never landed anywhere, and
    // a clean green row would hide that.
    expect(activity.category).toBe("failed");
  });

  it("flags an unconfirmed delivery until a lookup proves otherwise", () => {
    const unconfirmed = only(
      operation(step("continuation_delivery_unknown", "2026-08-19T10:00:06Z")),
    );
    expect(unconfirmed.status).toBe("Allowed once · delivery unconfirmed");
    expect(unconfirmed.tone).toBe("amber");

    // The agent came back for it after all: whatever happened to that one
    // exchange, the result reached whoever asked.
    const resolved = only(
      operation(
        step("continuation_delivery_unknown", "2026-08-19T10:00:06Z"),
        step("continuation_result_ready", "2026-08-19T10:00:07Z"),
        step("continuation_result_requested", "2026-08-19T10:00:30Z"),
      ),
    );
    expect(resolved.status).toBe("Allowed once");
    expect(resolved.tone).toBe("green");
  });

  it("keeps a denial a denial, whatever the continuation recorded", () => {
    const activity = only([
      {
        event: "intent_received",
        intentId: INTENT,
        agent: "sess_1",
        request: "read file: /x",
        ts: "2026-08-19T10:00:00Z",
      },
      {
        event: "intent_decision",
        intentId: INTENT,
        decision: "deny",
        source: "ask",
        ts: "2026-08-19T10:00:05Z",
      },
      step("continuation_delivery_unknown", "2026-08-19T10:00:06Z"),
    ]);
    expect(activity.status).toBe("Denied");
    expect(activity.category).toBe("denied");
  });

  it("groups every continuation event into the one operation", () => {
    // They all carry the intent id, which is what the activity view keys on —
    // a lifecycle scattered across five rows would be unreadable.
    const activities = auditActivities(
      operation(
        step("continuation_backgrounded", "2026-08-19T10:00:06Z"),
        step("continuation_result_ready", "2026-08-19T10:00:07Z"),
        step("continuation_result_requested", "2026-08-19T10:00:20Z"),
      ),
    );
    expect(activities.length).toBe(1);
    expect(activities[0].id).toBe(`intent:${INTENT}`);
    expect(activities[0].timeline.length).toBe(5);
  });
});
