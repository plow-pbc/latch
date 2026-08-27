/**
 * `scripts/latch-smoke` is the only path in this repo that drives a real relay,
 * so nothing here can exercise it end to end (README-ts.md § Integration
 * coverage). What it CAN exercise is the part that was wrong three times while
 * it lived as pasted shell in a skill file: the outcome table, and the promise
 * that a refusal never carries the credential.
 *
 * `verdict` is pure over audit records, which is what makes both reachable
 * without standing anything up.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { havePython } from "../packages/device-core/test/pythonProbe.js";

const script = fileURLToPath(new URL("../scripts/latch-smoke", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/latchSmokeProbe.py", import.meta.url));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "latch-smoke-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NONCE = "latch-smoke-20260826T000000Z-1";
const ID = "intent-1";

/** The correlating record, plus whatever followed it. */
function log(...tail: Record<string, unknown>[]): Record<string, unknown>[] {
  return [
    // Other traffic, deliberately: a second agent's whole successful call, and
    // an id-less rejection. Nothing here may satisfy a condition below.
    { event: "intent_received", intentId: "other", goal: "someone else's call" },
    { event: "intent_decision", intentId: "other", decision: "allow" },
    { event: "exec_end", intentId: "other", exit_code: 0 },
    { event: "intent_received", intentId: ID, goal: `smoke test: ${NONCE}` },
    ...tail,
  ];
}
const allow = { event: "intent_decision", intentId: ID, decision: "allow" };
const start = { event: "exec_start", intentId: ID, argv: ["/bin/echo", "latch-smoke"] };

function call(request: Record<string, unknown>, tokenFile = ""): unknown {
  const out = execFileSync("python3", [probe, script, JSON.stringify(request), tokenFile], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPYCACHEPREFIX: fs.mkdtempSync(path.join(tmp, "pyc-")) },
  });
  return JSON.parse(out) as unknown;
}

describe.skipIf(!havePython())("latch-smoke verdict", () => {
  // One row per outcome the report table names. `expired: false` rows are the
  // in-flight half: the same records must NOT be terminal while the window is
  // still open, which is the false-success bug that shipped once.
  const cases: [string, Record<string, unknown>[], boolean, number | null, string][] = [
    ["exit 0 is the only success", log(allow, start, { event: "exec_end", intentId: ID, exit_code: 0 }), false, 0, "OK — it executed"],
    ["a nonzero exit failed", log(allow, start, { event: "exec_end", intentId: ID, exit_code: 3 }), false, 1, "and exited 3"],
    ["a reaped run failed", log(allow, start, { event: "exec_end", intentId: ID, exit_code: 0, reaped: true }), false, 1, "was reaped by this Mac"],
    ["exec_error failed", log(allow, { event: "exec_error", intentId: ID, error: "gog is not installed" }), false, 1, "executor threw"],
    ["a denial is not a fault", log({ event: "intent_decision", intentId: ID, decision: "deny" }), false, 1, "DENIED"],
    ["exec_start alone is not terminal", log(allow, start), false, null, ""],
    ["...and times out as still running", log(allow, start), true, 1, "started, still running"],
    ["an undecided intent is not terminal", log(), false, null, ""],
    ["...and times out at the dialog", log(), true, 1, "unanswered at the approval dialog"],
    ["allowed but never started", log(allow), true, 1, "approved, never started"],
    ["another call's exec_end is not ours", log(allow, start), true, 1, "started, still running"],
    ["no nonce is not terminal early", [], false, null, ""],
    ["...and names three causes at timeout", [], true, 1, "cause 3 ruled out"],
    ["a fresh intent_rejected is quoted", [{ event: "intent_rejected", intentId: "x", reason: "replayed nonce" }], true, 1, "replayed nonce"],
  ];

  it.each(cases)("%s", (_name, events, expired, code, contains) => {
    const outcome = call({ call: "verdict", events, nonce: NONCE, expired, since: 0 }) as
      | { code: number; text: string }
      | null;
    if (code === null) {
      expect(outcome).toBeNull();
      return;
    }
    expect(outcome?.code).toBe(code);
    expect(outcome?.text).toContain(contains);
  });
});

describe.skipIf(!havePython())("latch-smoke bounds only what carries no nonce", () => {
  const older = { event: "intent_rejected", intentId: "old", reason: "expired long ago" };
  const mine = { event: "intent_rejected", intentId: "new", reason: "replayed nonce" };

  it("does not blame a rejection written before the send", () => {
    const outcome = call({ call: "verdict", events: [older, mine], nonce: NONCE, expired: true, since: 1 }) as
      { code: number; text: string };
    expect(outcome.text).toContain("replayed nonce");
    expect(outcome.text).not.toContain("expired long ago");
  });

  it("still correlates this call's own records from anywhere in the file", () => {
    // The baseline is a count from a SEPARATE read, so it can be short. The
    // nonce carries a timestamp and a pid, so correlation must not depend on it.
    const outcome = call({
      call: "verdict", expired: false, nonce: NONCE, since: 99,
      events: log(allow, start, { event: "exec_end", intentId: ID, exit_code: 0 }),
    }) as { code: number; text: string };
    expect(outcome.code).toBe(0);
  });
});

describe.skipIf(!havePython())("latch-smoke reads the log where it lives", () => {
  // A tilde inside `shlex.quote` is a literal, and the remote shell would look
  // for a directory actually named `~`. The read then fails, and a failed read
  // is the shape that reports "ruled out" having opened nothing.
  const cases: [string, string, string][] = [
    ["~ expands on the FAR side", "~/Library/Application Support/Plow-Latch/device/audit.ndjson",
      `cat -- "$HOME"/'Library/Application Support/Plow-Latch/device/audit.ndjson'`],
    ["an absolute path is quoted whole", "/Users/x/L S/audit.ndjson", `cat -- '/Users/x/L S/audit.ndjson'`],
    ["and a hostile one stays one argument", "/tmp/a; rm -rf ~", `cat -- '/tmp/a; rm -rf ~'`],
  ];
  it.each(cases)("%s", (_name, path, expected) => {
    expect(call({ call: "remote", path })).toBe(expected);
  });
});

describe.skipIf(!havePython())("latch-smoke command split", () => {
  // The commands worth smoking carry flags of their own, so `--` is the seam
  // the gog invocation in the skill depends on.
  const cases: [string, string[], string[], string[]][] = [
    ["no separator means the default command", ["--url", "u"], ["--url", "u"], []],
    ["everything after -- is the command", ["--url", "u", "--", "gog", "gmail", "search", "--json"], ["--url", "u"], ["gog", "gmail", "search", "--json"]],
    ["a bare -- is an empty command", ["--url", "u", "--"], ["--url", "u"], []],
    ["only the FIRST -- splits", ["--", "sh", "-c", "--"], [], ["sh", "-c", "--"]],
  ];
  it.each(cases)("%s", (_name, raw, options, command) => {
    expect(call({ call: "split", raw })).toEqual([options, command]);
  });
});

describe.skipIf(!havePython())("latch-smoke never repeats the credential", () => {
  it("reports the status, and nothing the relay echoed back", () => {
    const tokenFile = path.join(tmp, "token");
    const token = "relay-token-DoNotEcho";
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    const { reason } = call(
      { call: "send", url: "https://relay.invalid/mcp", status: 401, token },
      tokenFile,
    ) as { reason: string };
    expect(reason).toContain("401");
    expect(reason).not.toContain(token);
    // Not just the literal: no fragment of it, and no encoding of it either.
    expect(reason).not.toMatch(/DoNotEcho|Bearer|relay-token/i);
    expect(Buffer.from(reason).toString("base64")).not.toContain(
      Buffer.from(token).toString("base64").slice(0, 12),
    );
  });
});
