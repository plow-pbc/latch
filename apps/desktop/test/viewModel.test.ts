/**
 * The approval/audit view models are a security surface (DESIGN.md §13.2): the
 * consent window must show the ENFORCEABLE capability set, and agent-controlled
 * text must be carried as inert data. These tests pin that mapping. They run
 * without Electron because the logic is pure.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intent, JSONValue, makeIntent } from "@domo/protocol";
import { DeviceAgent, HeadlessPolicy } from "@domo/device-core";
import { activityMatches, approvalViewModel, auditActivities } from "../src/viewModel.js";

function intentOf(overrides: Partial<Intent> = {}): Intent {
  return {
    ...makeIntent({
      agentId: "agent-1",
      agentDisplay: "Family Coordinator",
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
    expect(vm.sendsToConnectedAccount).toBe(false);
    expect(vm.capabilities.map((c) => c.display)).toEqual([
      "Run: /bin/sh -c df -h (in /tmp)",
      "Network: denied",
      "Write: /tmp",
    ]);
  });

  // The card's ⚠ line renders only when one of these five flags is set
  // (renderer/approval.js). A `tool` capability matched none of them, so a
  // Slack send — irreversible, off this Mac, read by other people as the
  // owner — carried no warning at all, while `plow_write_file` to a scratch
  // file warned "writes files".
  it("warns on a Slack send: nothing else on the card would have", () => {
    const vm = approvalViewModel(
      intentOf({
        request: "send a Slack message to C1: ship it",
        capabilities: [{ kind: "tool", tool: "slack.messages.send", target: "T1/C1" }],
      }),
    );
    expect(vm.sendsToConnectedAccount).toBe(true);
    expect([
      vm.runsCommand,
      vm.writesFiles,
      vm.needsNetwork,
      vm.usesBrowser,
      vm.fillsCredentials,
    ]).toEqual([false, false, false, false, false]);
    expect(vm.capabilities.map((c) => c.display)).toEqual(["Slack: messages.send in T1/C1"]);
  });

  // A read (listing channels) is not the same risk as a send: it doesn't act
  // as the owner anywhere another person can see it. Firing the same "acts in
  // your connected accounts" warning on both stops the warning from meaning
  // anything on the three tools where it matters.
  it("does not warn on a Slack read", () => {
    const vm = approvalViewModel(
      intentOf({
        request: "list Slack channels",
        capabilities: [{ kind: "tool", tool: "slack.channels.list", target: "T1" }],
      }),
    );
    expect(vm.sendsToConnectedAccount).toBe(false);
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
      "Decision: allow_once — You (asked)",
      "Run started: /bin/sh -c df -h",
      "Run finished (exit 0)",
    ]);
    expect(a.timeline.find((s) => s.text.startsWith("Run finished"))!.state).toBe("ok");
  });

  it("records how each intent was decided (decidedBy from source)", () => {
    const mk = (source: string, decision = "allow_once") =>
      auditActivities([
        { event: "intent_received", intentId: "i", request: "run: x", ts: "2026-08-09T12:00:00Z" },
        { event: "intent_decision", intentId: "i", decision, source, ts: "2026-08-09T12:00:01Z" },
      ])[0]!;
    expect(mk("approve").decidedBy).toBe("Auto-approved");
    expect(mk("adversarial").decidedBy).toBe("AI Reviewer");
    // Not the raw source string: the human's view says what happened, and
    // "no_credits" is a label for us, not for them.
    expect(mk("no_credits").decidedBy).toBe("AI Reviewer (out of credits)");
    expect(mk("ask").decidedBy).toBe("You (asked)");
    expect(mk("policy", "deny").decidedBy).toBe("Policy (deny mode)");
    // A rule-matched decision (source set by the engine) reads as the rule.
    expect(mk("rule").decidedBy).toBe("Always-allow rule");
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

  it("a vault metadata read is over when logged — never Pending", () => {
    const acts = auditActivities([
      { event: "credential_metadata", op: "list", source: "vault", ts: "2026-08-18T12:00:00Z" },
      { event: "credential_metadata", op: "describe", item: "L1", source: "vault", ts: "2026-08-18T12:00:05Z" },
    ]);
    expect(acts).toHaveLength(2); // standalone events, one row each (newest first)
    const describeRead = acts[0]!;
    const listRead = acts[1]!;
    expect(listRead.title).toBe("Credential list read");
    expect(listRead.status).toBe("Completed");
    expect(listRead.tone).toBe("green");
    expect(listRead.category).toBe("approved");
    expect(describeRead.title).toBe("Credential fields read — L1");
    expect(describeRead.status).toBe("Completed");
    expect(listRead.timeline.map((s) => s.text)).toEqual(["Credential list read (names only)"]);
  });

  it("survives unknown event types — as a record, not a pending operation", () => {
    const acts = auditActivities([{ event: "future_event", ts: "2026-08-09T12:00:00Z" }]);
    expect(acts[0]!.status).toBe("Info");
    expect(acts[0]!.title).toBe("future_event");
  });

  it("an expired approval reads as a timeout, not a refusal", () => {
    const acts = auditActivities([
      { event: "intent_received", intentId: "i1", request: "run: df -h", ts: "2026-08-18T12:00:00Z" },
      { event: "intent_decision", intentId: "i1", decision: "deny", source: "expired", ts: "2026-08-18T12:15:00Z" },
    ]);
    expect(acts[0]!.status).toBe("Timed out");
    expect(acts[0]!.tone).toBe("amber");
    expect(acts[0]!.decidedBy).toBe("No one (timed out)");
    expect(acts[0]!.category).toBe("denied"); // still failed closed
  });

  it("an approval abandoned by an app quit reads as unanswered, not pending", () => {
    const acts = auditActivities([
      { event: "intent_received", intentId: "i1", request: "run: df -h", ts: "2026-08-18T12:00:00Z" },
      { event: "approval_abandoned", intentId: "i1", ts: "2026-08-18T12:05:00Z" },
    ]);
    expect(acts[0]!.status).toBe("Not answered");
    expect(acts[0]!.tone).toBe("zinc");
    expect(acts[0]!.timeline.map((s) => s.text)).toContain(
      "Never answered — the app closed while the approval was pending",
    );
  });

  it("a browser_open intent shows its decision; the session row is live from the open", () => {
    const acts = auditActivities([
      { event: "intent_received", intentId: "i1", request: "open browser: dominos.com", ts: "2026-08-18T12:00:00Z" },
      { event: "intent_decision", intentId: "i1", decision: "allow_once", source: "prompt", ts: "2026-08-18T12:00:01Z" },
      { event: "browser_session_opened", intentId: "i1", session: "S", origins: ["dominos.com"], ts: "2026-08-18T12:00:02Z" },
    ]);
    // The open event belongs to both stories: the intent row says how it was
    // decided, and browser:S exists — Browsing — before any command runs.
    const intent = acts.find((a) => a.id === "intent:i1")!;
    expect(intent.status).toBe("Allowed once");
    expect(intent.tone).toBe("green");
    const session = acts.find((a) => a.id === "browser:S")!;
    expect(session.status).toBe("Browsing");
    expect(session.tone).toBe("green");
  });

  it("a handle-only exec_end from an old log shows its exit, not Pending", () => {
    const acts = auditActivities([
      { event: "exec_end", handle: "H1", exit_code: 0, ts: "2026-08-18T12:00:00Z" },
      { event: "exec_end", handle: "H2", exit_code: 3, ts: "2026-08-18T12:00:05Z" },
    ]);
    const [failed, finished] = [acts[0]!, acts[1]!]; // newest first
    expect(finished.status).toBe("Finished");
    expect(finished.tone).toBe("green");
    expect(finished.category).toBe("approved");
    expect(finished.title).toBe("Command finished");
    expect(failed.status).toBe("Failed (exit 3)");
    expect(failed.tone).toBe("amber");
    expect(failed.category).toBe("failed");
  });

  it("browser runtime start/stop are lifecycle noise, never rows", () => {
    const acts = auditActivities([
      { event: "browser_started", pid: 12, browser_version: "1.0", ts: "2026-08-18T12:00:00Z" },
      { event: "browser_stopped", ts: "2026-08-18T12:01:00Z" },
    ]);
    expect(acts).toHaveLength(0);
  });
});

/**
 * Event names are a contract between two packages with nothing shared but the
 * string, so the only test that can catch them drifting apart is one that runs
 * the producer and reads the consumer. `tool_call` passed every test either
 * side owned, and rendered in the timeline as the literal "tool_call".
 */
describe("the audit names the device writes are the names this reads", () => {
  it("a Slack tool call reads as a used tool, not as a raw event name", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "latch-viewmodel-"));
    try {
      const device = new DeviceAgent(
        home,
        "Test Mac",
        new HeadlessPolicy({ intent: "allow_once" }),
        null,
        undefined,
        { call: async () => ({ messages: [] }) },
      );
      const intent = makeIntent({
        agentId: "agent-1",
        agentDisplay: "Agent",
        deviceId: device.identity.deviceId,
        // `request` is agent-controlled free text (deviceAgent.ts), chosen
        // here to collide with the file-kind heuristic below it: if
        // `has("tool_invoked")` were removed from activityKind, this would
        // fall through and read as "file" instead of "command".
        request: "read file: not actually a file",
        capabilities: [{ kind: "tool", tool: "slack.messages.list", target: "T1/C1" }],
        sessionId: "s1",
      });
      await device.handleIntent(intent, { account: "T1", channel_id: "C1" });

      const [activity] = auditActivities(device.audit.entries());
      const lines = activity.timeline.map((s) => s.text);
      expect(lines).toContain("Tool used: slack.messages.list");
      expect(activity.kind).toBe("command");
      expect(activity.capabilities).toContain("Slack: messages.list in T1/C1");
      // An event this file does not know falls through to `default: text =
      // event` — the raw name, shown to the owner as if it were a sentence.
      expect(lines.filter((l) => l.startsWith("tool_"))).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // A `tool_error` before any `tool_invoked` is a real producer path — an
  // action this Mac's table doesn't know throws inside executeToolIntent
  // before the invoked record is written (deviceAgent.ts) — so this is not a
  // hypothetical shape. Same colliding request text as above: only an
  // explicit `has("tool_error")` check keeps this "command".
  it("a Slack tool error reads as a used tool too, even with no tool_invoked", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "latch-viewmodel-"));
    try {
      const device = new DeviceAgent(
        home,
        "Test Mac",
        new HeadlessPolicy({ intent: "allow_once" }),
        null,
        undefined,
        { call: async () => ({ messages: [] }) },
      );
      const intent = makeIntent({
        agentId: "agent-1",
        agentDisplay: "Agent",
        deviceId: device.identity.deviceId,
        request: "read file: not actually a file",
        capabilities: [{ kind: "tool", tool: "slack.channels.delete", target: "T1" }],
        sessionId: "s1",
      });
      await device.handleIntent(intent, { account: "T1" });

      const [activity] = auditActivities(device.audit.entries());
      const lines = activity.timeline.map((s) => s.text);
      expect(lines).toContain("Tool error: slack.channels.delete — not a Slack action this Mac can perform");
      expect(lines.some((l) => l.startsWith("Tool used"))).toBe(false);
      expect(activity.kind).toBe("command");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
