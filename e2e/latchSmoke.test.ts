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
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { havePython, runProbe } from "../packages/device-core/test/pythonProbe.js";

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
  return runProbe<unknown>(probe, [script, JSON.stringify(request), tokenFile],
    binDir ? { PATH: `${binDir}:${process.env.PATH ?? ""}` } : {});
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
      | { code: number; text: string; arrived: boolean }
      | null;
    if (code === null) {
      expect(outcome).toBeNull();
      return;
    }
    expect(outcome?.code).toBe(code);
    expect(outcome?.text).toContain(contains);
  });
});

// Everything above reaches one function. Nothing reached `main`, and a glue
// bug — destructuring `verdict`'s tuple by the wrong arity — shipped as a
// crash on every completed run because of it. One real invocation covers the
// seam, and needs nothing stood up: a send that fails, a home with no log, and
// a one-second window put the loop through a verdict and both of its hints.
describe.skipIf(!havePython())("latch-smoke, run for real", () => {
  /**
   * A home with `device/` and a 0600 token, and the argv to run against it.
   *
   * `home` overrides the temp dir this creates — including with "". `log`
   * follows whichever home the run will actually use, so it never names a
   * directory the run under test does not read.
   */
  function fixture(timeout: string, home?: string): { log: string; argv: string[] } {
    const real = fs.mkdtempSync(path.join(tmp, "home-"));
    fs.mkdirSync(path.join(real, "device"));
    const tokenFile = path.join(real, "token");
    fs.writeFileSync(tokenFile, "t\n", { mode: 0o600 });
    return {
      log: path.join(home ?? real, "device", "audit.ndjson"),
      argv: [script, "--url", "http://127.0.0.1:9/mcp", "--token-file", tokenFile,
        "--home", home ?? real, "--timeout", timeout],
    };
  }

  // These drive the real `urllib` stack, which reads the environment through
  // `getproxies_environment` — so a developer with a proxy exported sends the
  // loopback URL to it and gets a different failure than the row names.
  //
  // `no_proxy: "*"` is what actually protects this: it makes
  // `getproxies_environment()` non-empty, so `proxy_bypass()` takes the
  // environment branch and returns True for every host, whatever `http_proxy`
  // resolved to. The empty lowercase pair is belt on top — CPython's second
  // pass matches names that are ALREADY lowercase and pops the entry when the
  // value is empty, which is why clearing the lowercase one also clears an
  // uppercase one. Both checked against this Python rather than asserted; an
  // earlier comment here had the pass backwards and added uppercase clears
  // that did nothing:
  //
  //     HTTP_PROXY set                     -> {'http': 'http://evil:3128'}
  //     ...plus http_proxy=""              -> {}
  //     HTTP_PROXY set, plus no_proxy="*"  -> proxy_bypass("127.0.0.1") is True
  const env = { ...process.env, http_proxy: "", https_proxy: "", no_proxy: "*" };

  it("reaches a verdict and annotates it, without a traceback", () => {
    const started = Date.now();
    // Above MIN_SEND_S — below it the run refuses before sending, which is a
    // different (also correct) outcome, covered by its own row.
    const run = spawnSync("python3", fixture("3").argv, { encoding: "utf8", env });
    // The window an operator asks for is roughly the window they get: an
    // unbounded sleep overshot fivefold and nothing here saw it.
    expect(Date.now() - started).toBeLessThan(4_500);
    const out = run.stdout + run.stderr;
    expect(out).not.toContain("Traceback");
    expect(run.status).toBe(1);
    expect(out).toContain("UNVERIFIED");
    expect(out).toContain("TIMEOUT — nothing carrying");
    // The send-side hint is the branch's OWN, because a shared line blamed a
    // send that had returned 200 the moment `isError` became non-terminal.
    // (This row cannot separate hint 2's two guards — nothing was ever read
    // here, so `not saw_any` and `not arrived` are both true.)
    expect(out).toContain("The send never completed");
    expect(out).toContain("Nothing has ever been written at");
  });

  // Every refusal that happens before an intent exists. The columns are what
  // actually differs: the argparse rows never reach the run, so they print no
  // `home=` — and a row that reaches `send` has already printed a nonce by
  // then, so it must RETRACT it rather than never having offered one.
  //
  // The home column is the expected string, not a boolean: `home=` exists so a
  // wrong one is visible, and asserting only that some home was named would
  // not catch it naming the wrong one.
  const NOT_A_HOME = path.join(tmp, "not-a-home");
  // A real home for the row that gets far enough to name one.
  const REAL_HOME = fs.mkdtempSync(path.join(tmp, "refusal-home-"));
  fs.mkdirSync(path.join(REAL_HOME, "device"));
  const refusals: [string, () => string[], number, string, string | null, boolean][] = [
    ["a local home that does not exist", () => fixture("5", NOT_A_HOME).argv,
      1, "REFUSED — no such home", NOT_A_HOME, false],
    ["an empty --home, which is a failed command substitution", () => fixture("5", "").argv,
      2, "--home was empty", null, false],
    ["a window of 1s", () => fixture("1").argv, 2, "--timeout must be more than", null, false],
    // `2` is the case that makes the bound exclusive: the baseline read always
    // consumes something, so exactly MIN_SEND_S leaves less than it.
    ["a window of exactly 2s", () => fixture("2").argv, 2, "--timeout must be more than", null, false],
    // One spawning row for the credential branch, so `main`'s refusal — and
    // the two negatives the move to `read_token` exists for — actually run.
    ["a token file that is not there", () => {
      const argv = fixture("5", REAL_HOME).argv;
      const i = argv.indexOf("--token-file");
      return [...argv.slice(0, i + 1), "/nonexistent/token", ...argv.slice(i + 2)];
    }, 1, "REFUSED — /nonexistent/token", null, false],
    ["a URL that never reaches a socket", () => {
      const argv = fixture("5", REAL_HOME).argv;
      const i = argv.indexOf("--url");
      return [...argv.slice(0, i + 1), "relay.plow.com/mcp", ...argv.slice(i + 2)];
    }, 1, "The request never left this Mac", REAL_HOME, true],
  ];
  it.each(refusals)("refuses %s", (_name, build, status, says, home, retractsNonce) => {
    const run = spawnSync("python3", build(), { encoding: "utf8", env });
    const out = run.stdout + run.stderr;
    expect(run.status).toBe(status);
    expect(out).toContain(says);
    // Never a traceback: this script refuses with sentences.
    expect(out).not.toContain("Traceback");
    if (home === null) expect(out).not.toContain("home=");
    else expect(out).toContain(`home=${home}`);
    // Either it never offered a handle, or it took it back.
    expect(out.includes("nonce=")).toBe(retractsNonce);
    if (retractsNonce) expect(out).toContain("corresponds to no call");
  });

  // The two that need a fake ssh, so they cannot be rows above.
  it("refuses a remote run whose home is not there", () => {
    const noHome = fakeSsh("exit 4");
    const run = spawnSync("python3", [...fixture("5", "/remote/home").argv, "--ssh", "u@h"],
      { encoding: "utf8", env: { ...env, PATH: `${noHome}:${process.env.PATH ?? ""}` } });
    const out = run.stdout + run.stderr;
    expect(run.status).toBe(1);
    expect(out).toContain("home=/remote/home");
    expect(out).toContain("no such home on u@h");
    expect(out).not.toContain("waiting up to");
    expect(out).not.toContain("nonce=");
  });

  // The regression the read floor exists for: at expiry the poll loop used to
  // starve its own last read and report an unreadable log instead of the
  // verdict it had the evidence for. Deleted by accident in a table collapse;
  // it is a fake-ssh case, so it cannot be a row above.
  it("names the real cause when an ssh read outlives the window", () => {
    const slow = fakeSsh("sleep 1\necho '{\"event\":\"intent_received\",\"intentId\":\"z\",\"goal\":\"other\"}'");
    const run = spawnSync("python3", [...fixture("4", "/remote/home").argv, "--ssh", "u@h"],
      { encoding: "utf8", env: { ...env, PATH: `${slow}:${process.env.PATH ?? ""}` } });
    const out = run.stdout + run.stderr;
    expect(out).not.toContain("Traceback");
    expect(out).toContain("TIMEOUT — nothing carrying");
    expect(out).not.toContain("stopped being readable");
  });

  it("refuses when the baseline read ate the window", () => {
    // The only refusal that depends on how long the read took, so it needs a
    // slow ssh rather than a bad argument.
    const slow = fakeSsh("sleep 2\necho '{}'");
    const run = spawnSync("python3", [...fixture("3", "/remote/home").argv, "--ssh", "u@h"],
      { encoding: "utf8", env: { ...env, PATH: `${slow}:${process.env.PATH ?? ""}` } });
    const out = run.stdout + run.stderr;
    expect(run.status).toBe(1);
    expect(out).toContain("REFUSED — under 2s left");
    expect(out).not.toContain("nonce=");
  });

  // The suppression case, reached for real. The nonce is generated inside the
  // run, so the record is written from the outside once the script has printed
  // it — which is also the only way anything external can correlate with a
  // run, and worth having demonstrated.
  it("does not blame the send when the verdict proves it arrived", async () => {
    const { log, argv } = fixture("25");
    const child = spawn("python3", argv, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    const answer = (chunk: string) => {
      out += chunk;
      // Anchored to the newline: without it a chunk landing mid-line matches a
      // PREFIX of the nonce, the seeded goal carries that prefix, and the run
      // correlates nothing — a flake that looks like a real failure.
      const nonce = /nonce=(\S+)\n/.exec(out)?.[1];
      if (!nonce || fs.existsSync(log)) return;
      // A denial: itself proof the send arrived, and the verdict both hints
      // must stay off.
      fs.writeFileSync(log,
        `{"event":"intent_received","intentId":"seeded","goal":"smoke test: ${nonce}"}\n` +
        `{"event":"intent_decision","intentId":"seeded","decision":"deny"}\n`);
    };
    child.stdout.on("data", (c: Buffer) => answer(c.toString()));
    child.stderr.on("data", (c: Buffer) => { out += c.toString(); });
    const code = await new Promise<number>((done) => child.on("close", (c) => done(c ?? -1)));

    expect(out).not.toContain("Traceback");
    expect(out).toContain("DENIED");
    expect(code).toBe(1);
    // The send DID fail here — and neither hint may fire, because the verdict
    // is proof the call arrived anyway. Asserted against the strings the
    // script can actually print: a rename once made this row vacuous.
    expect(out).toContain("UNVERIFIED");
    expect(out).not.toContain("The send never completed");
    expect(out).not.toContain("The relay gave up mid-exchange");
    expect(out).not.toContain("Cause 2 is the likeliest");
    expect(out).not.toContain("Nothing has ever been written at");
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
    expect(call({ call: "read", path: populated, home: dir })).toEqual({ count: 2, problem: "" });
    expect(call({ call: "read", path: path.join(dir, "absent.ndjson"), home: dir })).toEqual({ count: 0, problem: "" });
  });

  // Root bypasses the permission bits, so this row inverts rather than failing
  // honestly — a red test meaning "cannot run here", on the row that guards
  // the refusal path.
  it.skipIf(process.getuid?.() === 0)("an unreadable one refuses", () => {
    const locked = path.join(dir, "locked.ndjson");
    fs.writeFileSync(locked, "{}\n");
    fs.chmodSync(locked, 0o000);
    const read = call({ call: "read", path: locked, home: dir }) as { count: number; problem: string };
    expect(read.count).toBe(0);
    expect(read.problem).not.toBe("");
  });

  // 4: exit 3 is "no log yet" and must stay ABOVE the generic non-zero check —
  // moving it below would reinstate the fresh-install regression on the remote
  // path this is normally driven over, which a command-STRING test cannot see.
  it("a remote exit 3 is a fresh install, and any other failure refuses", () => {
    expect(call({ call: "read", path: "/x", ssh: "u@h", home: "/h" }, "", fakeSsh("exit 3")))
      .toEqual({ count: 0, problem: "" });
    const noisy = fakeSsh(
      'echo "Warning: Permanently added \'h\' to the list of known hosts." >&2\n' +
      'echo "cat: /x: Permission denied" >&2\nexit 255',
    );
    const { problem } = call({ call: "read", path: "/x", ssh: "u@h", home: "/h" }, "", noisy) as { problem: string };
    // The LAST line: the warning is about a connection that succeeded.
    expect(problem).toContain("Permission denied");
    expect(problem).not.toContain("known hosts");
  });


  // A tilde inside `shlex.quote` is a literal, and the remote shell would look
  // for a directory actually named `~`. The read then fails, and a failed read
  // is the shape that reports "ruled out" having opened nothing.
  const q = `"$HOME"/'Library/Application Support/Plow-Latch/device/audit.ndjson'`;
  // The home travels alongside the log path — one expression owns the
  // derivation — and is checked FIRST, at exit 4, because a missing log
  // (exit 3) is normal on a fresh install and collapsing the two makes a wrong
  // --home silent.
  const cases: [string, [string, string], string][] = [
    ["~ expands on the FAR side, for both paths",
      ["~/Library/Application Support/Plow-Latch/device/audit.ndjson",
       "~/Library/Application Support/Plow-Latch"],
      `if [ ! -d "$HOME"/'Library/Application Support/Plow-Latch' ]; then exit 4; ` +
      `elif [ -e "$HOME"/'Library/Application Support/Plow-Latch/device/audit.ndjson' ]; ` +
      `then cat -- "$HOME"/'Library/Application Support/Plow-Latch/device/audit.ndjson'; else exit 3; fi`],
    ["an absolute path is quoted whole", ["/Users/x/L S/audit.ndjson", "/Users/x"],
      `if [ ! -d /Users/x ]; then exit 4; ` +
      `elif [ -e '/Users/x/L S/audit.ndjson' ]; then cat -- '/Users/x/L S/audit.ndjson'; else exit 3; fi`],
    ["and a hostile one stays one argument", ["/tmp/a; rm -rf ~", "/tmp/b; whoami"],
      `if [ ! -d '/tmp/b; whoami' ]; then exit 4; ` +
      `elif [ -e '/tmp/a; rm -rf ~' ]; then cat -- '/tmp/a; rm -rf ~'; else exit 3; fi`],
  ];
  it.each(cases)("%s", (_name, [logPath, home], expected) => {
    expect(call({ call: "remote", path: logPath, home })).toBe(expected);
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
  ];

  it.each(cases)("%s", (_name, url, raises, contains) => {
    const sent = call({ call: "send", url, status: 0, token: "t", raises }, tokenFile) as
      { reason: string; unknown: boolean };
    expect(sent.unknown).toBe(true);
    expect(sent.reason).toContain(contains);
  });

  // The real production guard, not a stub: `Request()`'s own setter rejects
  // this before any socket exists, and it used to escape as a traceback. Its
  // own branch, because it can safely quote what was wrong — nothing has
  // touched the headers at that point, so the credential cannot be in it.
  it("a URL with no scheme never reaches the socket, and says why", () => {
    const sent = call({ call: "send", url: "relay.plow.com/mcp", status: 0, token: "t", raises: "http" }, tokenFile) as
      { reason: string; unknown: boolean };
    expect(sent.unknown).toBe(false);
    expect(sent.reason).toContain("unknown url type");
  });

  // `urllib` carries a request's custom headers across a redirect — verified
  // on this Python, a 302 to another origin delivered the bearer to that
  // origin in full. So this follows none, and says so terminally: no intent
  // exists, and the fix is the --url rather than a retry.
  it("refuses a redirect instead of forwarding the credential to it", () => {
    const token = "sk-secret-MustNotAppear";
    const file = path.join(tmp, "redirect-token");
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    const sent = call({ call: "send", url: "https://relay.invalid/mcp", status: 302, token,
      raises: "http", headers: { Location: "https://evil.invalid/steal" } },
      file) as { reason: string; unknown: boolean };
    expect(sent.unknown).toBe(false);
    expect(sent.reason).toContain("does not follow redirects");
    // Neither the credential nor the destination reaches the output — the
    // Location is a real header here, so this can actually fail.
    expect(sent.reason).not.toContain("MustNotAppear");
    expect(sent.reason).not.toContain("evil.invalid");
  });

  // ...and the mechanism itself, which the row above cannot reach: every send
  // row stubs `_OPENER.open`, so deleting the handler entirely would leave
  // them all green.
  it("carries a handler that declines redirects, in the opener send uses", () => {
    expect(call({ call: "redirect-mechanism" })).toEqual({ declines: true, inOpener: true });
  });

  // The catch-all returns the class NAME, never the message — `putheader`
  // raises one that quotes the header value, which is the bearer itself.
  it("a header error names its class and not the credential", () => {
    const token = "sk-secret-MustNotAppear";
    const file = path.join(tmp, "wrapped-token");
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    const sent = call({ call: "send", url: "https://relay.invalid/mcp", status: 0, token, raises: "header" }, file) as
      { reason: string; unknown: boolean };
    expect(sent.reason).toBe("ValueError");
    expect(sent.reason).not.toContain("MustNotAppear");
  });


  // `--timeout` is the whole run's budget, not the poll loop's. Hard-coding
  // 90s here made `--timeout 1` take 91 seconds against a relay that accepts
  // and never answers — measured before the fix, 1.0s after.
  it("spends the run's remaining budget on the send, not a fixed 90s", () => {
    const file = path.join(tmp, "budget-token");
    fs.writeFileSync(file, "t\n", { mode: 0o600 });
    const sent = call({ call: "send", url: "https://relay.invalid/mcp", status: 0, token: "t",
      raises: "refused" }, file) as { urlopenTimeout: number };
    // The probe passes 30; a hard-coded 90 (or an unset timeout) fails here.
    expect(sent.urlopenTimeout).toBe(30);
  });

  it("gives up on an ssh read that outlives the window", () => {
    // The read sits INSIDE the poll loop, so an unbounded one meant a hung
    // host made `--timeout` bound nothing at all.
    const slow = fakeSsh("sleep 30");
    const started = Date.now();
    const read = call({ call: "read", path: "/x", ssh: "u@h", home: "/h", budget: 1 }, "", slow) as
      { count: number; problem: string };
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(read.problem).toContain("did not finish within the window");
  });

  it("points a pre-intent isError at cause 2, not at the send", () => {
    // `isError` is ALSO how the MCP layer refuses before an intent exists, so
    // nothing is written to the log and the run times out — with a 200 on
    // record. Blaming the send there points away from the answer already on
    // screen.
    const sent = call({ call: "send", url: "https://relay.invalid/mcp", status: 0, token: "t", raises: "is-error" },
      tokenFile) as { hint: string };
    expect(sent.hint).toContain("Cause 2");
    expect(sent.hint).not.toContain("never completed");
  });

  // A 200 is still a response, and two of them are refusals — but only one is
  // terminal. `isError` is what an ordinary DENIAL comes back as, after its
  // audit records already exist, so exiting on it reported "nothing reached
  // this Mac" about a call the owner had just refused. And the relay's own
  // error text is server-authored on an authenticated response, so it can
  // reflect the request back.
  const responses: [string, string, boolean, string | null][] = [
    ["a JSON-RPC error is terminal", "rpc-error", false, "relay answered"],
    ["isError is not, because a denial looks like this", "is-error", true, "isError"],
    ["and a 200 that went through reports nothing", "ok", false, null],
  ];
  it.each(responses)("%s", (_name, raises, unknown, contains) => {
    const token = "sk-secret-MustNotAppear";
    const file = path.join(tmp, `${raises}-token`);
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    const sent = call({ call: "send", url: "https://relay.invalid/mcp", status: 0, token, raises }, file) as
      { reason: string | null; unknown: boolean };
    expect(sent.unknown).toBe(unknown);
    if (contains === null) expect(sent.reason).toBeNull();
    else expect(sent.reason).toContain(contains);
    expect(sent.reason ?? "").not.toMatch(/Bearer|MustNotAppear/);
  });
});

describe.skipIf(!havePython())("latch-smoke reads the credential before it spends anything", () => {
  // In `main`, not inside `send`: an unreadable path is found before the
  // baseline read spends budget and before a nonce is printed, which is why
  // these refusals need no retraction — nothing was ever offered.
  const dir = fs.mkdtempSync(path.join(tmp, "tokens-"));
  const write = (name: string, bytes: string | Buffer) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes, { mode: 0o600 });
    return p;
  };
  const cases: [string, () => string, string][] = [
    ["a path that is not there", () => "/nonexistent/token", "No such file or directory"],
    ["an empty file", () => write("empty", ""), "is empty"],
    ["one holding only whitespace", () => write("blank", "  \n"), "is empty"],
    // Text mode decodes, so this raises UnicodeDecodeError — a ValueError, not
    // an OSError, which is how it escaped the first guard.
    ["a binary file", () => write("binary", Buffer.from([0xff, 0xfe, 0x00])), "is not text"],
    // `.strip()` removes surrounding whitespace only, so a token pasted across
    // two lines keeps its newline — and `putheader` quotes the header value.
    ["one wrapped across two lines",
      () => write("wrapped", "sk-secret-MustNotAppear\nsecond\n"), "line break inside"],
  ];
  it.each(cases)("refuses %s", (_name, make, says) => {
    const file = make();
    const { ok, problem } = call({ call: "token", path: file }) as { ok: boolean; problem: string };
    expect(ok).toBe(false);
    expect(problem).toContain(says);
    // The script's own contribution, not just the OS's strerror: the FILE is
    // named, and never its contents.
    expect(problem).toContain(file);
    expect(problem).not.toContain("MustNotAppear");
  });

  it("accepts a one-line token, trimmed", () => {
    const file = write("good", "  sk-secret-abc  \n");
    expect(call({ call: "token", path: file })).toEqual({ ok: true, problem: "" });
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
  // Both statuses, because they are different return paths built by different
  // code — and a 5xx must additionally NOT claim the log is empty.
  it.each([401, 502])("reports status %i, and nothing the relay echoed back", (status) => {
    const tokenFile = path.join(tmp, "token");
    const token = "relay-token-DoNotEcho";
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    const { reason, unknown, hint } = call(
      { call: "send", url: "https://relay.invalid/mcp", status, token },
      tokenFile,
    ) as { reason: string; unknown: boolean; hint: string | null };
    expect(reason).toContain(String(status));
    // A 5xx is the relay abandoning an exchange it may already have forwarded.
    expect(unknown).toBe(status >= 500);
    if (status >= 500) {
      expect(reason).toContain("already have forwarded");
      // The third of the three hints, and the only one nothing pinned.
      expect(hint).toContain("The relay gave up mid-exchange");
    } else {
      expect(reason).toContain("Nothing was written");
      expect(hint).toBeNull();
    }
    expect(reason).not.toContain(token);
    // Not just the literal: no fragment of it, and no encoding of it either.
    expect(reason).not.toMatch(/DoNotEcho|Bearer|relay-token/i);
    expect(Buffer.from(reason).toString("base64")).not.toContain(
      Buffer.from(token).toString("base64").slice(0, 12),
    );
  });
});
