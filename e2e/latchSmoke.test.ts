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

function call(request: Record<string, unknown>, tokenFile = "", binDir?: string): unknown {
  const out = execFileSync("python3", [probe, script, JSON.stringify(request), tokenFile], {
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPYCACHEPREFIX: fs.mkdtempSync(path.join(tmp, "pyc-")),
      ...(binDir ? { PATH: `${binDir}:${process.env.PATH ?? ""}` } : {}),
    },
  });
  return JSON.parse(out) as unknown;
}

/** A directory holding a fake `ssh` that behaves as told. */
function fakeSsh(body: string): string {
  const dir = fs.mkdtempSync(path.join(tmp, "bin-"));
  fs.writeFileSync(path.join(dir, "ssh"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
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
  // The distinction the whole script turns on. A log that does not exist YET
  // is no evidence — `AuditLog` creates the file on its first record, so a
  // freshly installed build has none, and that is this skill's headline case.
  // A log that could not be READ is a different answer and must refuse.
  const dir = fs.mkdtempSync(path.join(tmp, "logs-"));

  it("a not-yet-written log is no evidence, not a failure", () => {
    const populated = path.join(dir, "full.ndjson");
    fs.writeFileSync(populated, `{"event":"intent_received"}\nnot json\n{"event":"exec_end"}\n`);
    // Unparseable lines are skipped, not fatal — the log is append-only and a
    // record can be half-written when the read lands.
    expect(call({ call: "read", path: populated })).toEqual({ count: 2, problem: "" });
    expect(call({ call: "read", path: path.join(dir, "absent.ndjson") })).toEqual({ count: 0, problem: "" });
  });

  // Root bypasses the permission bits, so this row inverts rather than failing
  // honestly — a red test meaning "cannot run here", on the row that guards
  // the refusal path.
  it.skipIf(process.getuid?.() === 0)("an unreadable one refuses", () => {
    const locked = path.join(dir, "locked.ndjson");
    fs.writeFileSync(locked, "{}\n");
    fs.chmodSync(locked, 0o000);
    const read = call({ call: "read", path: locked }) as { count: number; problem: string };
    expect(read.count).toBe(0);
    expect(read.problem).not.toBe("");
  });

  // 4: exit 3 is "no log yet" and must stay ABOVE the generic non-zero check —
  // moving it below would reinstate the fresh-install regression on the remote
  // path this is normally driven over, which a command-STRING test cannot see.
  it("a remote exit 3 is a fresh install, and any other failure refuses", () => {
    expect(call({ call: "read", path: "/x", ssh: "u@h" }, "", fakeSsh("exit 3")))
      .toEqual({ count: 0, problem: "" });
    const noisy = fakeSsh(
      'echo "Warning: Permanently added \'h\' to the list of known hosts." >&2\n' +
      'echo "cat: /x: Permission denied" >&2\nexit 255',
    );
    const { problem } = call({ call: "read", path: "/x", ssh: "u@h" }, "", noisy) as { problem: string };
    // The LAST line: the warning is about a connection that succeeded.
    expect(problem).toContain("Permission denied");
    expect(problem).not.toContain("known hosts");
  });


  // A tilde inside `shlex.quote` is a literal, and the remote shell would look
  // for a directory actually named `~`. The read then fails, and a failed read
  // is the shape that reports "ruled out" having opened nothing.
  const q = `"$HOME"/'Library/Application Support/Plow-Latch/device/audit.ndjson'`;
  const cases: [string, string, string][] = [
    ["~ expands on the FAR side", "~/Library/Application Support/Plow-Latch/device/audit.ndjson",
      `if [ -e ${q} ]; then cat -- ${q}; else exit 3; fi`],
    ["an absolute path is quoted whole", "/Users/x/L S/audit.ndjson",
      `if [ -e '/Users/x/L S/audit.ndjson' ]; then cat -- '/Users/x/L S/audit.ndjson'; else exit 3; fi`],
    // A missing file exits 3, distinctly from every other way cat can fail —
    // that is what keeps a fresh install from reading as an unreachable host.
    ["and a hostile one stays one argument", "/tmp/a; rm -rf ~",
      `if [ -e '/tmp/a; rm -rf ~' ]; then cat -- '/tmp/a; rm -rf ~'; else exit 3; fi`],
  ];
  it.each(cases)("%s", (_name, path, expected) => {
    expect(call({ call: "remote", path })).toBe(expected);
  });
});

describe.skipIf(!havePython())("latch-smoke treats a response as evidence and an exception as none", () => {
  // Seven review rounds went into this table, each one classifying some
  // exception as proof the call had or had not gone out, and each wrong for
  // one more subclass. There are no sides now: only a RESPONSE decides, and
  // every one of these rows is a call whose fate the audit log has to settle.
  const tokenFile = path.join(tmp, "transport-token");
  fs.writeFileSync(tokenFile, "t\n", { mode: 0o600 });

  const cases: [string, string, string, string][] = [
    ["a read timeout arrives bare", "https://relay.invalid/mcp", "read-timeout", "TimeoutError"],
    ["so does a relay that drops the socket", "https://relay.invalid/mcp", "reset", "ConnectionResetError"],
    ["a refused connection is wrapped", "https://relay.invalid/mcp", "refused", "URLError"],
    ["and so is a connect timeout", "https://relay.invalid/mcp", "connect-timeout", "URLError"],
    // Neither of these is an OSError; both escaped as a traceback once.
    ["a body that stops mid-read", "https://relay.invalid/mcp", "incomplete", "IncompleteRead"],
    ["a URL with a control character", "https://relay.invalid/mcp", "invalid-url", "InvalidURL"],
    // The real production guard, not a stub: `Request()`'s own setter rejects
    // this before any socket exists, and it used to escape as a traceback.
    ["a URL with no scheme, from the constructor", "relay.plow.com/mcp", "http", "unknown url type"],
  ];

  it.each(cases)("%s", (_name, url, raises, contains) => {
    const sent = call({ call: "send", url, status: 0, token: "t", raises }, tokenFile) as
      { reason: string; unknown: boolean };
    expect(sent.unknown).toBe(true);
    expect(sent.reason).toContain(contains);
  });

  // The one branch that DOES know, because a response came back and said so.
  it.each([[401, false], [502, true]] as [number, boolean][])(
    "a %i is a response, and decides", (status, unknown) => {
      const sent = call({ call: "send", url: "https://relay.invalid/mcp", status, token: "t", raises: "http" }, tokenFile) as
        { reason: string; unknown: boolean };
      expect(sent.unknown).toBe(unknown);
    },
  );
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
  // Both statuses, because they are different return paths built by different
  // code — and a 5xx must additionally NOT claim the log is empty.
  it.each([401, 502])("reports status %i, and nothing the relay echoed back", (status) => {
    const tokenFile = path.join(tmp, "token");
    const token = "relay-token-DoNotEcho";
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    const { reason, unknown } = call(
      { call: "send", url: "https://relay.invalid/mcp", status, token },
      tokenFile,
    ) as { reason: string; unknown: boolean };
    expect(reason).toContain(String(status));
    // A 5xx is the relay abandoning an exchange it may already have forwarded.
    expect(unknown).toBe(status >= 500);
    if (status >= 500) expect(reason).toContain("already have forwarded");
    else expect(reason).toContain("Nothing was written");
    expect(reason).not.toContain(token);
    // Not just the literal: no fragment of it, and no encoding of it either.
    expect(reason).not.toMatch(/DoNotEcho|Bearer|relay-token/i);
    expect(Buffer.from(reason).toString("base64")).not.toContain(
      Buffer.from(token).toString("base64").slice(0, 12),
    );
  });
});
