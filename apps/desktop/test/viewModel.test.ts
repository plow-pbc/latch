/**
 * The approval/audit view models are a security surface (DESIGN.md §13.2): the
 * consent window must show the ENFORCEABLE capability set, and agent-controlled
 * text must be carried as inert data. These tests pin that mapping. They run
 * without Electron because the logic is pure.
 */
import { describe, expect, it } from "vitest";
import { Intent, JSONValue, makeIntent } from "@domo/protocol";
import { approvalViewModel, auditRows } from "../src/viewModel.js";

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

describe("auditRows", () => {
  const events: JSONValue[] = [
    { event: "device_started", device: "d", ts: "2026-08-09T12:00:00Z" },
    { event: "access_request", agent: "a", display: "Family Coordinator", goals: "help", ts: "2026-08-09T12:00:10Z" },
    { event: "access_decision", agent: "a", approved: true, ts: "2026-08-09T12:00:12Z" },
    { event: "intent_received", intentId: "i1", request: "run: df -h", goal: "disk", agent: "a", ts: "2026-08-09T12:00:20Z" },
    { event: "intent_decision", intentId: "i1", decision: "allow_once", source: "prompt", ts: "2026-08-09T12:00:21Z" },
    { event: "exec_end", intentId: "i1", exit_code: 0, ts: "2026-08-09T12:00:23Z" },
    { event: "intent_rejected", intentId: "i2", reason: "bad signature", ts: "2026-08-09T12:00:30Z" },
    { event: "denied_operation", intentId: "i3", path: "/etc/passwd", ts: "2026-08-09T12:00:40Z" },
  ];

  it("maps events to human status rows, newest first", () => {
    const rows = auditRows(events);
    // Newest first: denied_operation is last in, first out.
    expect(rows[0].status).toBe("Blocked");
    expect(rows[0].kind).toBe("file");
    const started = rows.find((r) => r.activity === "Device started");
    expect(started?.tone).toBe("zinc");
  });

  it("tones map to the mockup vocabulary", () => {
    const rows = auditRows(events);
    expect(rows.find((r) => r.status === "Granted")?.tone).toBe("green");
    expect(rows.find((r) => r.status === "Blocked" && r.activity.includes("bad signature"))?.tone).toBe("red");
    expect(rows.find((r) => r.status === "Finished · exit 0")?.tone).toBe("green");
  });

  it("survives unknown event types", () => {
    const rows = auditRows([{ event: "future_event", ts: "2026-08-09T12:00:00Z" }]);
    expect(rows[0].status).toBe("Info");
    expect(rows[0].activity).toBe("future_event");
  });
});
