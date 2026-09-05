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
    expect(a.ts).toBe("2026-08-09T12:00:20Z"); // the date filter's key
    expect(a.blockedAt).toBeNull();
    // Two cells: the decision, and what happened to the work.
    expect(a.decision).toBe("Allowed");
    expect(a.decisionTone).toBe("green");
    expect(a.status).toBe("Completed");
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
    // An access grant is a decision with no outcome of its own.
    expect(acts[0]!.decision).toBe("Granted");
    expect(acts[0]!.status).toBe("");
    expect(acts[0]!.kind).toBe("access");
    expect(acts[0]!.timeline).toHaveLength(2);
  });

  it.each([
    ["connector_connected", "Connected Google account mary@x.com", "Google account connected — mary@x.com"],
    ["connector_disconnected", "Disconnected Google account mary@x.com", "Google account disconnected — mary@x.com"],
    ["connector_default_changed", "Made Google account mary@x.com the default", "Default Google account changed — mary@x.com"],
  ])("renders %s as a completed account activity", (event, title, step) => {
    const [activity] = auditActivities([{
      event,
      provider: "google",
      account: "mary@x.com",
      ts: "2026-09-02T12:00:00Z",
    }]);

    expect(activity).toMatchObject({
      title,
      status: "Completed",
      tone: "green",
      decisionKind: "none",
      statusKind: "completed",
      kind: "access",
      timeline: [{ text: step, state: "ok" }],
    });
  });

  it("separates distinct operations, drops device_started, orders newest first", () => {
    const acts = auditActivities([
      { event: "device_started", ts: "2026-08-09T12:00:00Z" }, // never surfaced
      ...commandRun,
      { event: "intent_rejected", intentId: "i2", reason: "bad signature", ts: "2026-08-09T12:00:40Z" },
    ]);
    // device_started is dropped. A rejection is a decision with no outcome;
    // a clean run is a decision AND an outcome.
    expect(acts.map((a) => a.decision)).toEqual(["Rejected", "Allowed"]);
    expect(acts.map((a) => a.status)).toEqual(["", "Completed"]);
    expect(acts[0]!.decisionKind).toBe("denied");
    expect(acts[0]!.statusKind).toBe("none");
  });

  it("a failed run keeps its decision and says how it failed", () => {
    const failed = auditActivities([
      { event: "intent_received", intentId: "i1", request: "run: false", ts: "2026-08-09T12:00:00Z" },
      { event: "intent_decision", intentId: "i1", decision: "always_allow", source: "prompt", ts: "2026-08-09T12:00:01Z" },
      { event: "exec_end", intentId: "i1", exit_code: 1, ts: "2026-08-09T12:00:02Z" },
    ]);
    expect(failed[0]!.decision).toBe("Always allowed");
    expect(failed[0]!.status).toBe("Failed · exit 1");
    expect(failed[0]!.tone).toBe("amber");
    expect(failed[0]!.decisionKind).toBe("allowed");
    expect(failed[0]!.statusKind).toBe("failed");
  });

  it("a run that has started and not ended is Running, still approved", () => {
    const acts = auditActivities(commandRun.slice(0, 3)); // no exec_end yet
    expect(acts[0]!.decision).toBe("Allowed");
    expect(acts[0]!.status).toBe("Running");
    expect(acts[0]!.tone).toBe("blue");
    expect(acts[0]!.decisionKind).toBe("allowed");
    expect(acts[0]!.statusKind).toBe("running");
  });

  it("a denied request has a decision and no outcome", () => {
    const acts = auditActivities([
      { event: "intent_received", intentId: "i1", request: "run: rm x", ts: "2026-08-09T12:00:00Z" },
      { event: "intent_decision", intentId: "i1", decision: "deny", source: "prompt", ts: "2026-08-09T12:00:01Z" },
    ]);
    expect(acts[0]!.decision).toBe("Denied");
    expect(acts[0]!.decisionTone).toBe("red");
    expect(acts[0]!.status).toBe("");
    expect(acts[0]!.decisionKind).toBe("denied");
    expect(acts[0]!.statusKind).toBe("none");
  });

  it("a clean success is allowed and completed, and no other bucket", () => {
    const acts = auditActivities(commandRun);
    expect(acts[0]!.decisionKind).toBe("allowed");
    expect(acts[0]!.statusKind).toBe("completed");
  });

  it("a denied_operation reads by its cause: the bound is Blocked, the app's own rules and a missing file merely Failed", () => {
    const denied = (cause?: string) => auditActivities([
      { event: "intent_received", intentId: "i1", request: "read file: /x", ts: "2026-08-09T12:00:00Z" },
      { event: "intent_decision", intentId: "i1", decision: "allow_once", source: "prompt", ts: "2026-08-09T12:00:01Z" },
      { event: "denied_operation", intentId: "i1", path: "/x", error: "nope", ...(cause ? { cause } : {}), ts: "2026-08-09T12:00:02Z" },
    ])[0]!;
    expect(denied("outside_approved_bound")).toMatchObject({ status: "Blocked · outside approved paths", statusKind: "blocked" });
    // A line from before causes were recorded is the bound, which was all it could be.
    expect(denied()).toMatchObject({ status: "Blocked · outside approved paths", statusKind: "blocked" });
    expect(denied("not_found")).toMatchObject({ status: "Failed · not found", tone: "amber", statusKind: "failed" });
    expect(denied("app_rule")).toMatchObject({ status: "Failed", statusKind: "failed" });
    expect(denied("busy")).toMatchObject({ status: "Failed · path in use by a command", statusKind: "failed" });
    expect(denied("app_rule").timeline.at(-1)!.text).toMatch(/^Failed: \/x/);
    expect(denied().timeline.at(-1)!.text).toMatch(/^Blocked: \/x/);
  });

  it("a sandbox block is Blocked in both the word and the Status filter", () => {
    const blocked = auditActivities([
      { event: "intent_received", intentId: "i1", request: "run: rm -rf /x", ts: "2026-08-09T12:00:00Z" },
      { event: "intent_decision", intentId: "i1", decision: "allow_once", source: "prompt", ts: "2026-08-09T12:00:01Z" },
      { event: "denied_operation", intentId: "i1", path: "/x", error: "outside scope", ts: "2026-08-09T12:00:02Z" },
    ]);
    expect(blocked[0]!.decision).toBe("Allowed");
    expect(blocked[0]!.status).toBe("Blocked · outside approved paths");
    expect(blocked[0]!.tone).toBe("red");
    expect(blocked[0]!.decisionKind).toBe("allowed");
    expect(blocked[0]!.statusKind).toBe("blocked");
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
    expect(listRead.statusKind).toBe("completed");
    expect(describeRead.title).toBe("Credential fields read — L1");
    expect(describeRead.status).toBe("Completed");
    expect(listRead.timeline.map((s) => s.text)).toEqual(["Credential list read (names only)"]);
  });

  it("survives unknown event types — as a record, not a pending operation", () => {
    const acts = auditActivities([{ event: "future_event", ts: "2026-08-09T12:00:00Z" }]);
    expect(acts[0]!.status).toBe("Info");
    expect(acts[0]!.title).toBe("future_event");
  });

  it.each([
    [
      { outcome: "revoked", keyId: 42 },
      { status: "Revoked", tone: "green", statusKind: "completed", step: "Activation session revoked — key 42", state: "ok" },
    ],
    [
      { outcome: "failed", keyId: 42, error: "Plow returned 500." },
      { status: "Failed", tone: "red", statusKind: "failed", step: "Activation session cleanup failed — key 42 — Plow returned 500.", state: "bad" },
    ],
    [
      { outcome: "no_match" },
      { status: "Skipped", tone: "zinc", statusKind: "none", step: "Activation session cleanup skipped — no matching session", state: "neutral" },
    ],
    [
      { outcome: "ambiguous", candidateCount: 2 },
      { status: "Skipped", tone: "zinc", statusKind: "none", step: "Activation session cleanup skipped — 2 matches", state: "neutral" },
    ],
    [
      { outcome: "no_credential" },
      { status: "Skipped", tone: "zinc", statusKind: "none", step: "Activation session cleanup skipped — this Mac is not signed in", state: "neutral" },
    ],
  ])("renders activation-session cleanup outcome %#", (fields, expected) => {
    const [activity] = auditActivities([{
      event: "activation_session_cleanup",
      ...fields,
      ts: "2026-08-30T22:00:00Z",
    }]);

    expect(activity).toMatchObject({
      title: "Activation session cleanup",
      status: expected.status,
      tone: expected.tone,
      statusKind: expected.statusKind,
      timeline: [{ text: expected.step, state: expected.state }],
    });
  });

  it("an expired approval reads as a timeout, not a refusal", () => {
    const acts = auditActivities([
      { event: "intent_received", intentId: "i1", request: "run: df -h", ts: "2026-08-18T12:00:00Z" },
      { event: "intent_decision", intentId: "i1", decision: "deny", source: "expired", ts: "2026-08-18T12:15:00Z" },
    ]);
    expect(acts[0]!.decision).toBe("Timed out");
    expect(acts[0]!.decisionTone).toBe("amber");
    expect(acts[0]!.status).toBe("");
    expect(acts[0]!.decidedBy).toBe("No one (timed out)");
    // Still failed closed — but it is not a refusal, so it files under
    // Unanswered, with the abandoned and the pending.
    expect(acts[0]!.decisionKind).toBe("unanswered");
  });

  it("an approval abandoned by an app quit reads as unanswered, not pending", () => {
    const acts = auditActivities([
      { event: "intent_received", intentId: "i1", request: "run: df -h", ts: "2026-08-18T12:00:00Z" },
      { event: "approval_abandoned", intentId: "i1", ts: "2026-08-18T12:05:00Z" },
    ]);
    expect(acts[0]!.decision).toBe("Not answered");
    expect(acts[0]!.decisionTone).toBe("zinc");
    expect(acts[0]!.status).toBe("");
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
    expect(intent.decision).toBe("Allowed");
    expect(intent.status).toBe("Completed");
    expect(intent.tone).toBe("green");
    const session = acts.find((a) => a.id === "browser:S")!;
    expect(session.decision).toBe("");
    expect(session.status).toBe("Browsing");
    expect(session.tone).toBe("green");
  });

  it("a handle-only exec_end from an old log shows its exit, not Pending", () => {
    const acts = auditActivities([
      { event: "exec_end", handle: "H1", exit_code: 0, ts: "2026-08-18T12:00:00Z" },
      { event: "exec_end", handle: "H2", exit_code: 3, ts: "2026-08-18T12:00:05Z" },
    ]);
    const [failed, finished] = [acts[0]!, acts[1]!]; // newest first
    expect(finished.decision).toBe("");
    expect(finished.status).toBe("Completed");
    expect(finished.tone).toBe("green");
    expect(finished.statusKind).toBe("completed");
    expect(finished.title).toBe("Command finished");
    expect(failed.status).toBe("Failed · exit 3");
    expect(failed.tone).toBe("amber");
    expect(failed.statusKind).toBe("failed");
  });

  it("a run this Mac killed reads as killed, not as a command that failed", () => {
    // The owner is the only person who can answer the permission prompt that
    // usually wedges a run, so "failed (exit -1)" would hide the one thing
    // they can act on.
    const [orphan, decided] = [
      auditActivities([
        { event: "exec_end", handle: "H1", exit_code: -1, reaped: true, ts: "2026-08-18T12:00:00Z" },
      ])[0]!,
      auditActivities([
        { event: "intent_received", intentId: "i1", request: "run: sqlite3", ts: "2026-08-18T12:00:00Z" },
        { event: "intent_decision", intentId: "i1", decision: "allow_once", ts: "2026-08-18T12:00:01Z" },
        { event: "exec_start", intentId: "i1", argv: ["/usr/bin/sqlite3"], ts: "2026-08-18T12:00:01Z" },
        { event: "exec_end", intentId: "i1", exit_code: -1, reaped: true, ts: "2026-08-18T12:15:01Z" },
      ])[0]!,
    ];
    const reason = "no output — a permission prompt may be waiting";
    expect(orphan.status).toBe("Killed · no output");
    expect(decided.decision).toBe("Allowed");
    expect(decided.status).toBe("Killed · no output");
    for (const act of [orphan, decided]) {
      expect(act.tone).toBe("amber");
      expect(act.statusKind).toBe("failed");
    }
    // The line the owner opens to find out why must not contradict the badge.
    expect(decided.timeline.map((s) => s.text)).toContain(`Run killed — ${reason}`);
  });

  it("a run parked on a dialog that then exited cleanly reads as Completed, not Blocked", () => {
    // The owner answered the dialog; the verdict was provisional. The block
    // stays in the timeline, but the outcome is the recovery.
    const run = (cause: string) => auditActivities([
      { event: "intent_received", intentId: "i1", request: "run: cat ~/Desktop/a.txt", ts: "2026-08-18T12:00:00Z" },
      { event: "intent_decision", intentId: "i1", decision: "allow_once", source: "prompt", ts: "2026-08-18T12:00:01Z" },
      { event: "exec_start", intentId: "i1", argv: ["/bin/cat"], ts: "2026-08-18T12:00:01Z" },
      { event: "host_permission_blocked", intentId: "i1", handle: "H1", path: "~/Desktop/a.txt", cause, confidence: "confirmed", permission: "files_desktop", owner_action: "A dialog is open.", ts: "2026-08-18T12:00:02Z" },
      { event: "exec_end", intentId: "i1", exit_code: 0, ts: "2026-08-18T12:00:30Z" },
    ])[0]!;
    const recovered = run("prompt_waiting");
    expect(recovered.status).toBe("Completed");
    expect(recovered.statusKind).toBe("completed");
    expect(recovered.timeline.some((s) => s.text.startsWith("This Mac refused"))).toBe(true);
    // Answered, resumed, and then failed for a reason of its own: the exit
    // is the outcome, not the dialog that is gone.
    const failed = auditActivities([
      { event: "intent_received", intentId: "i1", request: "run: x", ts: "2026-08-18T12:00:00Z" },
      { event: "intent_decision", intentId: "i1", decision: "allow_once", source: "prompt", ts: "2026-08-18T12:00:01Z" },
      { event: "exec_start", intentId: "i1", argv: ["/bin/sh"], ts: "2026-08-18T12:00:01Z" },
      { event: "host_permission_blocked", intentId: "i1", handle: "H1", path: "~/Desktop/a.txt", cause: "prompt_waiting", confidence: "confirmed", permission: "files_desktop", owner_action: "A dialog is open.", ts: "2026-08-18T12:00:02Z" },
      { event: "exec_end", intentId: "i1", exit_code: 1, ts: "2026-08-18T12:00:30Z" },
    ])[0]!;
    expect(failed.status).toBe("Failed · exit 1");
    // The device's own record of the clearing, and a correction after it:
    // the newest verdict under the handle is the one the row wears.
    const corrected = auditActivities([
      { event: "intent_received", intentId: "i1", request: "run: x", ts: "2026-08-18T12:00:00Z" },
      { event: "intent_decision", intentId: "i1", decision: "allow_once", source: "prompt", ts: "2026-08-18T12:00:01Z" },
      { event: "exec_start", intentId: "i1", argv: ["/bin/sh"], ts: "2026-08-18T12:00:01Z" },
      { event: "host_permission_blocked", intentId: "i1", handle: "H1", path: "~/Desktop/a.txt", cause: "prompt_waiting", confidence: "confirmed", permission: "files_desktop", owner_action: "A dialog is open.", ts: "2026-08-18T12:00:02Z" },
      { event: "exec_end", intentId: "i1", exit_code: 1, ts: "2026-08-18T12:00:30Z" },
      { event: "host_permission_cleared", intentId: "i1", handle: "H1", path: "~/Desktop/a.txt", permission: "files_desktop", ts: "2026-08-18T12:00:30Z" },
      { event: "host_permission_blocked", intentId: "i1", handle: "H1", path: "~/Desktop/a.txt", cause: "macos_permission", confidence: "confirmed", permission: "files_desktop", owner_action: "Allow the Desktop folder.", ts: "2026-08-18T12:00:31Z" },
    ])[0]!;
    expect(corrected.status).toBe("Blocked · Desktop folder");
    expect(corrected.blockedAt).toBe("2026-08-18T12:00:31Z");
    expect(corrected.timeline.some((s) => s.text.startsWith("The dialog was answered"))).toBe(true);
    // Reaped while parked: still blocked on the dialog.
    const reaped = auditActivities([
      { event: "intent_received", intentId: "i1", request: "run: x", ts: "2026-08-18T12:00:00Z" },
      { event: "intent_decision", intentId: "i1", decision: "allow_once", source: "prompt", ts: "2026-08-18T12:00:01Z" },
      { event: "host_permission_blocked", intentId: "i1", handle: "H1", path: "~/Desktop/a.txt", cause: "prompt_waiting", confidence: "confirmed", permission: "files_desktop", owner_action: "A dialog is open.", ts: "2026-08-18T12:00:02Z" },
      { event: "exec_end", intentId: "i1", exit_code: -1, reaped: true, ts: "2026-08-18T12:15:00Z" },
    ])[0]!;
    expect(reaped.status).toBe("Blocked · dialog waiting");
    // A confirmed refusal followed by exit 0 is not a recovery: only the
    // parked verdict is provisional.
    expect(run("macos_permission").status).toBe("Blocked · Desktop folder");
  });

  it("a block by this Mac itself names the permission, outranks the exit code, and carries the owner sentence", () => {
    // The owner is the one person who can flip the switch; "failed (exit 1)"
    // would hide the one thing they can act on.
    const action = "In System Settings > Privacy & Security > Full Disk Access, turn on Plow Latch, then quit and reopen it.";
    const [run, file, orphan] = [
      auditActivities([
        { event: "intent_received", intentId: "i1", request: "run: sqlite3 ~/Library/Messages/chat.db", ts: "2026-08-18T12:00:00Z" },
        { event: "intent_decision", intentId: "i1", decision: "allow_once", source: "prompt", ts: "2026-08-18T12:00:01Z" },
        { event: "exec_start", intentId: "i1", argv: ["/usr/bin/sqlite3"], ts: "2026-08-18T12:00:01Z" },
        { event: "exec_end", intentId: "i1", exit_code: 1, ts: "2026-08-18T12:00:02Z" },
        { event: "host_permission_blocked", intentId: "i1", handle: "H1", path: "~/Library/Messages/chat.db", cause: "macos_permission", confidence: "confirmed", permission: "full_disk_access", owner_action: action, ts: "2026-08-18T12:00:03Z" },
      ])[0]!,
      auditActivities([
        { event: "intent_received", intentId: "i2", request: "read file: /Users/o/Desktop/a.txt", ts: "2026-08-18T12:00:00Z" },
        { event: "intent_decision", intentId: "i2", decision: "always_allow", source: "rule", ts: "2026-08-18T12:00:01Z" },
        { event: "host_permission_blocked", intentId: "i2", path: "/Users/o/Desktop/a.txt", cause: "prompt_waiting", confidence: "likely", permission: "files_desktop", owner_action: "A macOS permission dialog is open on the Mac's screen.", ts: "2026-08-18T12:00:03Z" },
      ])[0]!,
      auditActivities([
        { event: "host_permission_blocked", handle: "H9", path: "~/x", cause: "outside_approved_bound", confidence: "confirmed", owner_action: null, ts: "2026-08-18T12:00:03Z" },
      ])[0]!,
    ];
    // The pill names the switch; the sentence is the timeline's.
    expect(run.decision).toBe("Allowed");
    expect(run.status).toBe("Blocked · Full Disk Access");
    expect(run.tone).toBe("amber");
    // Its own bucket: the Capabilities tab's "Show in Audit" filters to it.
    expect(run.decisionKind).toBe("allowed");
    expect(run.statusKind).toBe("blocked");
    expect(run.exitCode).toBe(1);
    expect(run.timeline.map((s) => s.text)).toContain(
      `This Mac refused ~/Library/Messages/chat.db: needs a macOS permission (Full Disk Access) — ${action}`,
    );
    expect(file.decision).toBe("Always allowed");
    expect(file.status).toBe("Blocked · dialog waiting");
    expect(file.kind).toBe("file");
    expect(file.timeline.at(-1)!.text).toMatch(/\(probably\) — A macOS permission dialog/);
    expect(file.timeline.at(-1)!.state).toBe("bad");
    expect(orphan.decision).toBe("");
    expect(orphan.status).toBe("Blocked · outside approved paths");
    expect(orphan.decisionKind).toBe("none");
    expect(orphan.statusKind).toBe("blocked");
    // The switch a block named is searchable, in System Settings' words —
    // the Capabilities tab's "Show in Audit" relies on it — and so is the
    // timeline line, so what the detail pane shows is what the box finds.
    expect(run.permission).toBe("Full Disk Access");
    // The block's own time, for the Capabilities tab's "Show in Audit" cutoff:
    // the request began before a dismissal could, the refusal after.
    expect(run.blockedAt).toBe("2026-08-18T12:00:03Z");
    expect(activityMatches(run, "full disk access")).toBe(true);
    expect(activityMatches(run, "quit and reopen")).toBe(true);
    expect(activityMatches(file, "Desktop folder")).toBe(true);
    expect(activityMatches(orphan, "Full Disk Access")).toBe(false);
    expect(orphan.permission).toBeNull();
  });

  it("browser runtime start/stop are lifecycle noise, never rows", () => {
    const acts = auditActivities([
      { event: "browser_started", pid: 12, browser_version: "1.0", ts: "2026-08-18T12:00:00Z" },
      { event: "browser_stopped", ts: "2026-08-18T12:01:00Z" },
    ]);
    expect(acts).toHaveLength(0);
  });
});
