/**
 * The Audit tab's live index (auditIndex.ts) folds the log one event at a
 * time. Its one promise is that a fold never disagrees with the batch
 * `auditActivities` the tests and tools use — and that a listing is a page
 * of rows, filtered the way the renderer used to filter them itself.
 */
import { describe, expect, it } from "vitest";
import { JSONValue } from "@domo/protocol";
import { AuditIndex } from "../src/auditIndex.js";
import { capabilitiesView } from "../src/capabilitiesModel.js";
import { activityMatches, auditActivities } from "../src/viewModel.js";

const at = (s: number) => `2026-09-10T17:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}Z`;

/** A log an agent might write in a minute: two runs, a browsing session
 *  widened once, a block by this Mac and its clearing, an access pair, and
 *  the lifecycle noise the grouper drops. */
function sampleLog(): JSONValue[] {
  return [
    { event: "device_started", ts: at(0) },
    { event: "access_request", agent: "a1", display: "Family Coordinator", goals: "help", ts: at(1) },
    { event: "access_decision", agent: "a1", approved: true, ts: at(2) },
    {
      event: "intent_received", intentId: "I1", agent: "a1", agent_name: "Family Coordinator",
      request: "run: df -h", goal: "disk space", capabilities: ["Run: df -h"], ts: at(3),
    },
    { event: "intent_decision", intentId: "I1", decision: "allow_once", source: "adversarial", ts: at(4) },
    { event: "exec_start", intentId: "I1", argv: ["df", "-h"], ts: at(5) },
    { event: "exec_end", intentId: "I1", exit_code: 0, ts: at(6) },
    {
      event: "intent_received", intentId: "I2", agent: "a1", agent_name: "Family Coordinator",
      request: "browse pizza.example", goal: "order dinner", capabilities: ["Browse: pizza.example"], ts: at(7),
    },
    { event: "intent_decision", intentId: "I2", decision: "allow_once", source: "prompt", ts: at(8) },
    { event: "browser_started", ts: at(9) },
    { event: "browser_session_opened", intentId: "I2", session: "S1", origins: ["pizza.example"], ts: at(9) },
    { event: "browser_navigated", session: "S1", url: "https://pizza.example/menu", ts: at(10) },
    { event: "browser_command", session: "S1", action: "screenshot", url: "https://pizza.example/menu", ts: at(11) },
    {
      event: "intent_received", intentId: "I3", agent: "a1", agent_name: "Family Coordinator",
      request: "browse more", goal: "order dinner", capabilities: ["Browse: pay.example"], ts: at(12),
    },
    { event: "browser_session_extended", intentId: "I3", session: "S1", origins: ["pay.example"], ts: at(13) },
    {
      event: "intent_received", intentId: "I4", agent: "a2", agent_name: "Spruce",
      request: "read: ~/Desktop/notes.txt", goal: "notes", capabilities: ["Read: ~/Desktop/notes.txt"], ts: at(14),
    },
    { event: "intent_decision", intentId: "I4", decision: "allow_once", source: "adversarial", ts: at(15) },
    {
      event: "host_permission_blocked", intentId: "I4", permission: "files_desktop", cause: "macos_permission",
      confidence: "confirmed", ts: at(16),
    },
    { event: "host_permission_cleared", intentId: "I4", permission: "files_desktop", ts: at(17) },
    { event: "exec_end", intentId: "I4", exit_code: 0, ts: at(18) },
    { event: "browser_stopped", ts: at(19) },
    { event: "browser_session_closed", session: "S1", ts: at(20) },
    { event: "connector_connected", account: "sam@example.com", ts: at(21) },
  ];
}

describe("AuditIndex", () => {
  it("folded one event at a time, equals the batch fold of the whole log", () => {
    const events = sampleLog();
    const index = new AuditIndex();
    for (const e of events) index.add(e);
    expect(index.activities()).toEqual(auditActivities(events));
    expect(index.size).toBe(auditActivities(events).length);

    // ...and equals itself rebuilt from scratch (a rotation, a clear).
    const rebuilt = new AuditIndex();
    rebuilt.reset(events);
    expect(rebuilt.activities()).toEqual(index.activities());
  });

  it("equals the batch fold at every prefix of the log, so a live view is never behind or ahead", () => {
    const events = sampleLog();
    const index = new AuditIndex();
    events.forEach((e, i) => {
      index.add(e);
      expect(index.activities()).toEqual(auditActivities(events.slice(0, i + 1)));
    });
  });

  it("reports the rows an event touched — none for noise, two for a session opening", () => {
    const index = new AuditIndex();
    expect(index.add({ event: "device_started", ts: at(0) })).toEqual([]);
    expect(index.add({ event: "intent_received", intentId: "I2", request: "browse", ts: at(1) })).toEqual(["intent:I2"]);
    expect(index.add({ event: "browser_session_opened", intentId: "I2", session: "S1", ts: at(2) })).toEqual([
      "intent:I2",
      "browser:S1",
    ]);
    expect(index.add({ event: "browser_navigated", session: "S1", url: "https://x.example/", ts: at(3) })).toEqual([
      "browser:S1",
    ]);
    // Only the touched row is rebuilt: the intent row is the same object.
    const before = index.get("intent:I2");
    index.add({ event: "browser_command", session: "S1", action: "text", ts: at(4) });
    expect(index.get("intent:I2")).toBe(before);
  });

  it("pages the listing newest first, rows without timelines, and says how many there are", () => {
    const index = new AuditIndex();
    index.reset(sampleLog());
    const all = index.activities();
    const page = index.page({ offset: 0, limit: 2 });
    expect(page.rows.map((r) => r.id)).toEqual(all.slice(0, 2).map((a) => a.id));
    expect(page.rows[0]).not.toHaveProperty("timeline");
    expect(page.total).toBe(all.length);
    expect(page.size).toBe(all.length);
    expect(page.topId).toBe(all[0]!.id);
    const next = index.page({ offset: 2, limit: 2 });
    expect(next.rows.map((r) => r.id)).toEqual(all.slice(2, 4).map((a) => a.id));
    // The whole activity, timeline and all, by id.
    expect(index.get(all[0]!.id)).toEqual(all[0]);
    expect(index.get("nope")).toBeNull();
  });

  it("keeps a selected row in the window when new activity pushes it past the page", () => {
    const index = new AuditIndex();
    index.reset(sampleLog());
    const all = index.activities();
    const oldest = all[all.length - 1]!;
    // The selection sits on the last row of a two-row page...
    const limit = all.length - 1;
    const kept = all[limit - 1]!;
    expect(index.page({ limit, keepId: kept.id }).rows.map((r) => r.id)).toEqual(all.slice(0, limit).map((a) => a.id));
    // ...and a new activity arriving above it would drop it off the page.
    // With keepId the window extends through it — and no further.
    index.add({ event: "connector_disconnected", account: "sam@example.com", ts: at(30) });
    const page = index.page({ limit, keepId: kept.id });
    expect(page.rows).toHaveLength(limit + 1);
    expect(page.rows.at(-1)!.id).toBe(kept.id);
    expect(page.rows.map((r) => r.id)).not.toContain(oldest.id);
    // A kept row already inside the window changes nothing; one the filters
    // exclude is not smuggled in (the renderer falls back to the newest).
    expect(index.page({ limit: 3, keepId: page.rows[0]!.id }).rows).toHaveLength(3);
    expect(index.page({ limit: 1, keepId: kept.id, search: "zzz" }).rows).toHaveLength(0);
    expect(index.page({ limit: 1, keepId: "nope" }).rows).toHaveLength(1);
  });

  it("filters the way the renderer did: decision, status, a date cutoff, and the search", () => {
    const index = new AuditIndex();
    index.reset(sampleLog());
    const all = index.activities();
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

    expect(ids(index.page({ decision: "allowed" }).rows)).toEqual(
      ids(all.filter((a) => a.decisionKind === "allowed")),
    );
    expect(ids(index.page({ status: "completed" }).rows)).toEqual(
      ids(all.filter((a) => a.statusKind === "completed")),
    );
    // Search matches what the detail pane would show — a timeline line
    // included — exactly as `activityMatches` does, without the rows
    // carrying their timelines.
    for (const term of ["df -h", "pizza.example/menu", "spruce", "Desktop folder", "zzz"]) {
      expect(ids(index.page({ search: term }).rows)).toEqual(ids(all.filter((a) => activityMatches(a, term))));
    }
    // A cutoff keys on when the row began...
    const cutoffMs = new Date(at(12)).getTime();
    expect(ids(index.page({ cutoffMs }).rows)).toEqual(
      ids(all.filter((a) => new Date(a.ts).getTime() >= cutoffMs)),
    );
    // ...or, for the Capabilities tab's "Show in Audit", on the block's own
    // time, falling back to the start for a row that was never blocked.
    const sinceBlock = new Date(at(16)).getTime();
    expect(ids(index.page({ cutoffMs: sinceBlock, cutoffKey: "blocked", status: "blocked" }).rows)).toEqual(
      ids(all.filter((a) => a.statusKind === "blocked" && new Date(a.blockedAt ?? a.ts).getTime() >= sinceBlock)),
    );
    // Nothing matching is a filters problem, not an empty log.
    const none = index.page({ search: "zzz" });
    expect(none.total).toBe(0);
    expect(none.size).toBe(all.length);
  });

  it("hands the Capabilities tab the lines it reads, and they fold to the same tab as the whole log", () => {
    const events = sampleLog();
    const index = new AuditIndex();
    for (const e of events) index.add(e);
    const subset = index.permissionEvents();
    // Every host_permission line, in order, and the request behind the block.
    expect(subset.map((e) => (e as { event: string }).event)).toEqual([
      "intent_received",
      "host_permission_blocked",
      "host_permission_cleared",
    ]);
    expect((subset[0] as { intentId: string }).intentId).toBe("I4");
    const input = (evs: readonly JSONValue[]) => ({
      inventory: null,
      automation: [],
      events: evs,
      dismissals: {},
      bannerSeenAt: null,
    });
    expect(capabilitiesView(input(subset))).toEqual(capabilitiesView(input(events)));

    // A block whose request the log has not seen yet still names it once
    // it arrives (the log is append-only, but a reader may start mid-way).
    const late = new AuditIndex();
    late.add({ event: "host_permission_blocked", intentId: "I9", permission: "contacts", cause: "macos_permission", ts: at(1) });
    expect(late.permissionEvents()).toHaveLength(1);
    late.add({ event: "intent_received", intentId: "I9", request: "contacts", ts: at(2) });
    expect(late.permissionEvents().map((e) => (e as { event: string }).event)).toEqual([
      "intent_received",
      "host_permission_blocked",
    ]);
  });

  it("starts over on reset: the old rows are gone, the new log is what there is", () => {
    const index = new AuditIndex();
    index.reset(sampleLog());
    expect(index.size).toBeGreaterThan(0);
    index.reset([]);
    expect(index.size).toBe(0);
    expect(index.page().rows).toEqual([]);
    expect(index.permissionEvents()).toEqual([]);
    index.reset([{ event: "exec_end", intentId: "X", exit_code: 1, ts: at(1) }]);
    expect(index.activities().map((a) => a.id)).toEqual(["intent:X"]);
  });
});
