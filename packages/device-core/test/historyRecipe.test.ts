/**
 * The History recipe, RUN.
 *
 * Same reasoning as `imessageRecipes.test.ts` next to this file: "the body
 * contains this substring" cannot tell a working reader from a broken one.
 * This builds a two-generation audit log the way `AuditLog` writes one, runs
 * the exact perl text the agent is handed, and asserts on the rows that come
 * back — in particular that a denied request and a failed one do NOT read as
 * work done, which is the whole reason the join exists.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HISTORY_FILES, HISTORY_SCRIPT, historyCwd, historySkillFor } from "@domo/device-core";

const PERL = "/usr/bin/perl";

function received(id: string, agent: string, goal: string, request: string, ts: string): object {
  return { event: "intent_received", ts, intentId: id, agent: "1152", agent_name: agent, goal, request, capabilities: [] };
}

/** Run the recipe exactly as the skill body spells it: cwd + relative files. */
function read(dir: string, limit = "200"): string[][] {
  const out = execFileSync(PERL, ["-e", HISTORY_SCRIPT, "--", limit, ...HISTORY_FILES], {
    cwd: dir,
    encoding: "utf8",
    stdio: "pipe",
  }).trimEnd();
  return out.split("\n").map((line) => line.split("\t"));
}

describe("history recipe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-"));
  // Previous generation: one completed command from an earlier agent.
  fs.writeFileSync(
    path.join(dir, "audit.1.ndjson"),
    [
      received("a", "Elm", "Cancel the Hipcamp booking", "curl …", "2026-09-08T03:02:23Z"),
      { event: "intent_decision", ts: "2026-09-08T03:02:24Z", intentId: "a", decision: "allow_once", source: "owner" },
      { event: "exec_start", ts: "2026-09-08T03:02:25Z", intentId: "a", argv: ["curl"] },
      { event: "exec_end", ts: "2026-09-08T03:02:26Z", intentId: "a", exit_code: 0 },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  // Current generation: a denied request, a failed one, a non-zero exit, a
  // timed-out approval, one allowed but never finished, one blocked by a macOS
  // permission, one blocked by the sandbox, one whose approval never reached
  // the owner, and two lines the reader must step over: one that is not JSON
  // and one that is JSON but not an object.
  fs.writeFileSync(
    path.join(dir, "audit.ndjson"),
    [
      received("b", "Elm", "Pay the mortgage\tnow", "open https://bank", "2026-09-09T10:00:00Z"),
      { event: "intent_decision", ts: "2026-09-09T10:00:01Z", intentId: "b", decision: "deny", source: "owner" },
      received("c", "Willow", "Read the calendar", "plow-gog calendar list", "2026-09-10T11:00:00Z"),
      { event: "intent_decision", ts: "2026-09-10T11:00:01Z", intentId: "c", decision: "always_allow", source: "rule" },
      { event: "exec_start", ts: "2026-09-10T11:00:02Z", intentId: "c", argv: ["plow-gog"] },
      { event: "exec_error", ts: "2026-09-10T11:00:03Z", intentId: "c", error: "boom" },
      received("d", "Willow", "Check the weather", "curl wttr.in", "2026-09-10T12:00:00Z"),
      { event: "intent_decision", ts: "2026-09-10T12:00:01Z", intentId: "d", decision: "allow_once", source: "owner" },
      { event: "exec_start", ts: "2026-09-10T12:00:02Z", intentId: "d", argv: ["curl"] },
      { event: "exec_end", ts: "2026-09-10T12:00:03Z", intentId: "d", exit_code: 7 },
      { event: "intent_received", ts: "2026-09-10T13:00:00Z", intentId: "e", agent_name: "Willow", goal: "Timed out", request: "x", capabilities: [] },
      { event: "intent_decision", ts: "2026-09-10T13:00:01Z", intentId: "e", decision: "deny", source: "expired" },
      received("f", "Willow", "Still running", "sleep 999", "2026-09-10T14:00:00Z"),
      { event: "intent_decision", ts: "2026-09-10T14:00:01Z", intentId: "f", decision: "allow_once", source: "owner" },
      { event: "exec_start", ts: "2026-09-10T14:00:02Z", intentId: "f", argv: ["sleep"] },
      received("g", "Willow", "Read Messages", "sqlite3 chat.db", "2026-09-10T15:00:00Z"),
      { event: "intent_decision", ts: "2026-09-10T15:00:01Z", intentId: "g", decision: "allow_once", source: "owner" },
      { event: "host_permission_blocked", ts: "2026-09-10T15:00:02Z", intentId: "g", permission: "automation" },
      { event: "host_permission_cleared", ts: "2026-09-10T15:00:03Z", intentId: "g" },
      { event: "host_permission_blocked", ts: "2026-09-10T15:00:04Z", intentId: "g", permission: "full_disk_access" },
      { event: "exec_end", ts: "2026-09-10T15:00:05Z", intentId: "g", exit_code: 1 },
      received("h", "Willow", "Write outside the grant", "cp a b", "2026-09-10T16:00:00Z"),
      { event: "intent_decision", ts: "2026-09-10T16:00:01Z", intentId: "h", decision: "allow_once", source: "owner" },
      { event: "denied_operation", ts: "2026-09-10T16:00:02Z", intentId: "h", path: "/etc", error: "outside" },
      received("i", "Willow", "Ask the owner", "open x", "2026-09-10T17:00:00Z"),
      { event: "intent_decision", ts: "2026-09-10T17:00:01Z", intentId: "i", decision: "deny", source: "error" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\nnot json\n[1,2]\n",
  );

  it("joins each request to its decision and outcome across both generations, oldest first", () => {
    const rows = read(dir);
    expect(rows[0]).toEqual(["ts", "agent", "decision", "outcome", "goal", "request"]);
    expect(rows.slice(1)).toEqual([
      ["2026-09-08T03:02:23Z", "Elm", "allowed", "completed", "Cancel the Hipcamp booking", "curl …"],
      ["2026-09-09T10:00:00Z", "Elm", "denied", "", "Pay the mortgage now", "open https://bank"],
      ["2026-09-10T11:00:00Z", "Willow", "always allowed", "error", "Read the calendar", "plow-gog calendar list"],
      ["2026-09-10T12:00:00Z", "Willow", "allowed", "exit 7", "Check the weather", "curl wttr.in"],
      ["2026-09-10T13:00:00Z", "Willow", "timed out", "", "Timed out", "x"],
      ["2026-09-10T14:00:00Z", "Willow", "allowed", "", "Still running", "sleep 999"],
      ["2026-09-10T15:00:00Z", "Willow", "allowed", "blocked by this Mac", "Read Messages", "sqlite3 chat.db"],
      ["2026-09-10T16:00:00Z", "Willow", "allowed", "blocked by sandbox", "Write outside the grant", "cp a b"],
      ["2026-09-10T17:00:00Z", "Willow", "approval failed", "", "Ask the owner", "open x"],
    ]);
  });

  it("keeps only the newest N rows when a limit is given", () => {
    const rows = read(dir, "2");
    expect(rows.slice(1).map((r) => r[4])).toEqual(["Write outside the grant", "Ask the owner"]);
  });

  it("reads a log that has never rotated", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "history-fresh-"));
    fs.copyFileSync(path.join(dir, "audit.ndjson"), path.join(fresh, "audit.ndjson"));
    expect(read(fresh).length).toBe(9);
  });
});

describe("history skill", () => {
  it("names the device dir ~-relative under the owner's home and as-is elsewhere", () => {
    expect(historyCwd("/Users/o/Library/Application Support/Plow-Latch", "/Users/o")).toBe(
      "~/Library/Application Support/Plow-Latch/device",
    );
    expect(historyCwd("/tmp/domo-dev", "/Users/o")).toBe("/tmp/domo-dev/device");
  });

  it("hands the agent the exact reader this test ran, from that cwd", () => {
    const skill = historySkillFor("~/Library/Application Support/Plow-Latch/device");
    expect(skill.name).toBe("history");
    expect(skill.body).toContain(JSON.stringify(HISTORY_SCRIPT));
    expect(skill.body).toContain('cwd: "~/Library/Application Support/Plow-Latch/device"');
    expect(skill.body).not.toContain("/Users/");
    expect(skill.body).toContain(
      'read_paths: ["~/Library/Application Support/Plow-Latch/device/audit.1.ndjson","~/Library/Application Support/Plow-Latch/device/audit.ndjson"]',
    );
  });
});
