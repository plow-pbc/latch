/**
 * The approval/audit view models are a security surface (DESIGN.md §13.2): the
 * consent window must show the ENFORCEABLE capability set, and agent-controlled
 * text must be carried as inert data. These tests pin that mapping. They run
 * without Electron because the logic is pure.
 */
import { describe, expect, it } from "vitest";
import { Intent, JSONValue, makeIntent } from "@domo/protocol";
import { activityMatches, approvalViewModel, auditActivities } from "../src/viewModel.js";

function intentOf(overrides: Partial<Intent> = {}): Intent {
  return {
    ...makeIntent({
      agentId: "agent-1",
      agentDisplay: "Family Coordinator",
      agentPublicKey: "pk",
      deviceId: "device-1",
      goal: "Check how much disk space I have",
      planContext: "session plan",
      request: "run: df -h",
      capabilities: [
        { kind: "process.exec", argv: ["/bin/sh", "-c", "df -h"], cwd: "/tmp" },
        { kind: "network", allowed: false },
        { kind: "fs.write", paths: ["/tmp"], reason: "output" },
      ],
      sessionId: "s1",
    }),
    ...overrides,
  };
}

describe("approvalViewModel", () => {
  it("surfaces the enforceable capabilities and their displays", () => {
    const vm = approvalViewModel(intentOf());
    expect(vm.agentDisplay).toBe("Family Coordinator");
    expect(vm.runsCommand).toBe(true);
    expect(vm.writesFiles).toBe(true);
    expect(vm.needsNetwork).toBe(false);
    expect(vm.capabilities.map((c) => c.display)).toEqual([
      "Run: /bin/sh -c df -h (in /tmp)",
      "Network: denied",
      "Write: /tmp",
    ]);
  });

  it("flags network when a network capability is allowed", () => {
    const vm = approvalViewModel(
      intentOf({ capabilities: [{ kind: "network", allowed: true }] }),
    );
    expect(vm.needsNetwork).toBe(true);
  });

  it("carries goal/request as plain strings (no markup interpretation)", () => {
    const vm = approvalViewModel(
      intentOf({ goal: "<img src=x onerror=alert(1)>", request: "run: ls" }),
    );
    // The value is preserved verbatim as data; the renderer inserts it via
    // textContent, so the markup is never interpreted.
    expect(vm.goal).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("auditActivities (grouping)", () => {
  // A full command lifecycle for one intent: received → decided → ran → finished.
  const commandRun: JSONValue[] = [
    { event: "intent_received", intentId: "i1", request: "run: df -h", goal: "disk", agent: "agentA", capabilities: ["Run: df -h", "Network: denied"], ts: "2026-08-09T12:00:20Z" },
    { event: "intent_decision", intentId: "i1", decision: "allow_once", source: "prompt", ts: "2026-08-09T12:00:21Z" },
    { event: "exec_start", intentId: "i1", argv: ["/bin/sh", "-c", "df -h"], ts: "2026-08-09T12:00:21Z" },
    { event: "exec_end", intentId: "i1", exit_code: 0, ts: "2026-08-09T12:00:23Z" },
  ];

  it("collapses all events of one intent into a single activity with a full timeline", () => {
    const acts = auditActivities(commandRun);
    expect(acts).toHaveLength(1);
    const a = acts[0]!;
    expect(a.title).toBe("run: df -h");
    // A clean success shows just the base — no "· finished"/"· done".
    expect(a.status).toBe("Allowed once");
    expect(a.tone).toBe("green");
    expect(a.command).toBe("/bin/sh -c df -h");
    expect(a.exitCode).toBe(0);
    expect(a.capabilities).toEqual(["Run: df -h", "Network: denied"]);
    // Timeline is every underlying event, oldest first, with per-step state.
    expect(a.timeline.map((s) => s.text)).toEqual([
      "Request: run: df -h",
      "Decision: allow_once (prompt)",
      "Run started: /bin/sh -c df -h",
      "Run finished (exit 0)",
    ]);
    expect(a.timeline.find((s) => s.text.startsWith("Run finished"))!.state).toBe("ok");
  });

  it("pairs an access request with its decision into one activity", () => {
    const acts = auditActivities([
      { event: "access_request", agent: "agentA", display: "Family Coordinator", goals: "help", ts: "2026-08-09T12:00:10Z" },
      { event: "access_decision", agent: "agentA", approved: true, ts: "2026-08-09T12:00:12Z" },
    ]);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.title).toBe("Access — Family Coordinator");
    expect(acts[0]!.status).toBe("Granted");
    expect(acts[0]!.kind).toBe("access");
    expect(acts[0]!.timeline).toHaveLength(2);
  });

  it("separates distinct operations, drops device_started, orders newest first", () => {
    const acts = auditActivities([
      { event: "device_started", ts: "2026-08-09T12:00:00Z" }, // never surfaced
      ...commandRun,
      { event: "intent_rejected", intentId: "i2", reason: "bad signature", ts: "2026-08-09T12:00:40Z" },
    ]);
    // device_started is dropped; a clean success is just "Allowed once".
    expect(acts.map((a) => a.status)).toEqual(["Rejected", "Allowed once"]);
    expect(acts[0]!.category).toBe("denied");
  });

  it("keeps failure/blocked suffixes but not success ones", () => {
    const failed = auditActivities([
      { event: "intent_received", intentId: "i1", request: "run: false", ts: "2026-08-09T12:00:00Z" },
      { event: "intent_decision", intentId: "i1", decision: "always_allow", source: "prompt", ts: "2026-08-09T12:00:01Z" },
      { event: "exec_end", intentId: "i1", exit_code: 1, ts: "2026-08-09T12:00:02Z" },
    ]);
    expect(failed[0]!.status).toBe("Always allowed · failed (exit 1)");
    expect(failed[0]!.category).toBe("failed");
  });

  it("a clean success categorizes as approved, not failed", () => {
    const acts = auditActivities(commandRun);
    expect(acts[0]!.category).toBe("approved");
  });

  it("sandbox-block keeps its status label but categorizes as failed", () => {
    const blocked = auditActivities([
      { event: "intent_received", intentId: "i1", request: "run: rm -rf /x", ts: "2026-08-09T12:00:00Z" },
      { event: "intent_decision", intentId: "i1", decision: "allow_once", source: "prompt", ts: "2026-08-09T12:00:01Z" },
      { event: "denied_operation", intentId: "i1", path: "/x", error: "outside scope", ts: "2026-08-09T12:00:02Z" },
    ]);
    expect(blocked[0]!.status).toBe("Allowed once · blocked");
    expect(blocked[0]!.category).toBe("failed");
  });

  it("search matches across title, command, agent, and goal", () => {
    const a = auditActivities(commandRun)[0]!;
    expect(activityMatches(a, "df")).toBe(true);
    expect(activityMatches(a, "disk")).toBe(true);
    expect(activityMatches(a, "agentA")).toBe(true);
    expect(activityMatches(a, "nonexistent")).toBe(false);
  });

  it("survives unknown event types", () => {
    const acts = auditActivities([{ event: "future_event", ts: "2026-08-09T12:00:00Z" }]);
    expect(acts[0]!.status).toBe("Pending");
    expect(acts[0]!.title).toBe("future_event");
  });
});
