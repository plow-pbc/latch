/**
 * Host gates through the device: an approved read, write or command that this
 * Mac itself then refused, and what the agent and the audit log are told.
 *
 * The refusals are real where a fixture can produce one (a locked file, a
 * chmod 000 file, a FIFO that parks an open, a sandboxed write outside its
 * profile); the macOS answers the fixtures cannot produce — a TCC-guarded
 * folder, Automation consent — come from scripted probes, so the verdict
 * tree is driven end to end without a real grant in play. The audit log is
 * the oracle throughout.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize, Capability, Intent, JSONValue, jv, makeIntent } from "@domo/protocol";
import {
  DeviceAgent,
  Executor,
  HeadlessPolicy,
  HostProbes,
  scriptedProbes,
} from "@domo/device-core";

const ON_MAC = process.platform === "darwin";
const AS_ROOT = process.getuid?.() === 0;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-hg-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return canonicalize(dir);
}

/** A device whose owner's home is a fixture, so `~/Desktop` and friends are
 *  guarded paths the test can create files under. */
function device(home: string, probes: HostProbes | null = null): DeviceAgent {
  return new DeviceAgent(
    home,
    "Test Mac",
    new HeadlessPolicy({ intent: "allow_once" }),
    null,
    home,
    null,
    [],
    null,
    probes,
  );
}

function intentFor(d: DeviceAgent, request: string, capabilities: Capability[]): Intent {
  return makeIntent({
    agentId: "agent-1",
    agentDisplay: "Agent",
    deviceId: d.identity.deviceId,
    request,
    capabilities,
    sessionId: "s1",
  });
}

const events = (d: DeviceAgent) => d.audit.entries().map((e) => jv(e as JSONValue).get("event").str);
const lastBlocked = (d: DeviceAgent) =>
  jv([...d.audit.entries()].reverse().find((e) => jv(e as JSONValue).get("event").str === "host_permission_blocked") ?? null);

function lockedFile(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "old");
  execFileSync("/usr/bin/chflags", ["uchg", file]);
  cleanups.push(() => execFileSync("/usr/bin/chflags", ["nouchg", file]));
  return file;
}

describe("a file operation this Mac refused", () => {
  it.skipIf(!ON_MAC || AS_ROOT)("a locked file is diagnosed for real: immutable_file, blocked, audited", async () => {
    const home = tempDir();
    const d = device(home);
    const file = lockedFile(path.join(home, "Plow"), "locked.txt");
    const response = jv(
      await d.handleIntent(
        intentFor(d, "write", [{ kind: "fs.write", paths: [file] }]),
        { content_base64: Buffer.from("new").toString("base64") },
      ),
    );
    expect(response.get("status").str).toBe("blocked");
    expect(response.get("error").str).toMatch(/EPERM/);
    expect(response.get("diagnosis").get("cause").str).toBe("immutable_file");
    expect(response.get("diagnosis").get("confidence").str).toBe("confirmed");
    expect(response.get("diagnosis").get("owner_action").str).toMatch(/chflags nouchg/);
    expect(response.get("probes").get("immutable_flag").bool).toBe(true);
    expect(response.get("probes").get("app_process_open").str).toBe("ok");
    // The owner's account name never rides the response: paths are ~-relative.
    expect(response.get("probes").get("path").str).toBe("~/Plow/locked.txt");

    expect(events(d)).toEqual(["intent_received", "intent_decision", "host_permission_blocked"]);
    const audited = lastBlocked(d);
    expect(audited.get("cause").str).toBe("immutable_file");
    expect(audited.get("path").str).toBe(file);
    expect(audited.get("probes").get("errno").str).toBe("EPERM");
    expect(fs.readFileSync(file, "utf8")).toBe("old");
  });

  it.skipIf(!ON_MAC || AS_ROOT)("a TCC refusal, driven by scripted probes over a real EPERM", async () => {
    const home = tempDir();
    const file = lockedFile(path.join(home, "Desktop"), "notes.txt");
    // The kernel's EPERM is real (the lock); the probes say what a Mac whose
    // owner has not granted the Desktop folder would say.
    const probes = scriptedProbes({
      inspect: { [file]: { isDirectory: false, readable: true, writable: true, flags: [] } },
      openAsApp: { [file]: "EPERM" },
      fullDiskAccess: false,
    });
    const d = device(home, probes);
    const response = jv(
      await d.handleIntent(
        intentFor(d, "write", [{ kind: "fs.write", paths: [file] }]),
        { content_base64: Buffer.from("new").toString("base64") },
      ),
    );
    expect(response.get("status").str).toBe("blocked");
    const diagnosis = response.get("diagnosis");
    expect(diagnosis.get("cause").str).toBe("macos_permission");
    expect(diagnosis.get("permission").str).toBe("files_desktop");
    expect(diagnosis.get("confidence").str).toBe("confirmed");
    expect(diagnosis.get("retry").str).toBe("after_owner_grants");
    expect(diagnosis.get("owner_action").str).toMatch(/Desktop Folder, allow Plow Latch/);
    expect(diagnosis.get("ruled_out").arr).toEqual(expect.arrayContaining(["sandbox bound", "file missing"]));
    expect(response.get("probes").get("full_disk_access_granted").bool).toBe(false);
    expect(lastBlocked(d).get("permission").str).toBe("files_desktop");
  });

  it.skipIf(AS_ROOT)("ordinary permissions: chmod 000 is posix_permissions, confirmed by the mode bits", async () => {
    const home = tempDir();
    const d = device(home);
    const file = path.join(home, "Plow", "secret.txt");
    fs.writeFileSync(file, "x");
    fs.chmodSync(file, 0o000);
    cleanups.push(() => fs.chmodSync(file, 0o600));
    const response = jv(await d.handleIntent(intentFor(d, "read", [{ kind: "fs.read", paths: [file] }])));
    expect(response.get("status").str).toBe("blocked");
    expect(response.get("diagnosis").get("cause").str).toBe("posix_permissions");
    expect(response.get("diagnosis").get("confidence").str).toBe("confirmed");
    expect(response.get("probes").get("posix_readable").bool).toBe(false);
    expect(events(d)).toContain("host_permission_blocked");
  });

  it("a missing file is an error with a not_found diagnosis, not a block", async () => {
    const home = tempDir();
    const d = device(home);
    const file = path.join(home, "Plow", "absent.txt");
    const response = jv(await d.handleIntent(intentFor(d, "read", [{ kind: "fs.read", paths: [file] }])));
    expect(response.get("status").str).toBe("error");
    expect(response.get("error").str).toMatch(/ENOENT/);
    expect(response.get("diagnosis").get("cause").str).toBe("not_found");
    expect(response.get("diagnosis").get("owner_action").isNull).toBe(true);
    expect(events(d)).toEqual(["intent_received", "intent_decision", "denied_operation"]);
    const denied = jv(d.audit.entries()[2] as JSONValue);
    expect(denied.get("cause").str).toBe("not_found");
  });

  it("a refusal that is this app's own rule, not the kernel's, probes nothing", async () => {
    const home = tempDir();
    const probes = scriptedProbes();
    const d = device(home, probes);
    // A directory is "not a file" by FileOps' own rule — no errno, no host
    // gate, nothing to investigate.
    const dir = path.join(home, "Plow");
    const response = jv(await d.handleIntent(intentFor(d, "read", [{ kind: "fs.read", paths: [dir] }])));
    expect(response.get("status").str).toBe("error");
    expect(response.get("error").str).toMatch(/not a file/);
    expect(response.get("diagnosis").isNull).toBe(true);
    expect(probes.calls).toEqual([]);
    expect(events(d)).toEqual(["intent_received", "intent_decision", "denied_operation"]);
    // Named as the app's own rule, so the audit view does not call it the bound.
    expect(jv(d.audit.entries()[2] as JSONValue).get("cause").str).toBe("app_rule");
  });

  it.skipIf(!ON_MAC)("a read parked on a consent dialog is reported as prompt_waiting within the hang window", async () => {
    const home = tempDir();
    const downloads = path.join(home, "Downloads");
    fs.mkdirSync(downloads);
    const fifo = path.join(downloads, "blocked.pipe");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    // A FIFO with no writer is what would park a real touch; the scripted
    // probe answers "hung" outright, which is what a dialog looks like. The
    // read itself is never attempted, so nothing is left parked to release.
    const probes = scriptedProbes({ openAsApp: { [fifo]: "hung" } });
    const d = device(home, probes);
    d.fileOpHangMs = 200;

    const started = Date.now();
    const response = jv(await d.handleIntent(intentFor(d, "read", [{ kind: "fs.read", paths: [fifo] }])));
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(response.get("status").str).toBe("blocked");
    expect(response.get("error").str).toMatch(/permission dialog/);
    const diagnosis = response.get("diagnosis");
    expect(diagnosis.get("cause").str).toBe("prompt_waiting");
    expect(diagnosis.get("confidence").str).toBe("confirmed");
    expect(diagnosis.get("permission").str).toBe("files_downloads");
    expect(diagnosis.get("retry").str).toBe("after_owner_answers_prompt");
    expect(response.get("probes").get("hung").bool).toBe(true);
    expect(lastBlocked(d).get("cause").str).toBe("prompt_waiting");
  });

  it.skipIf(!ON_MAC)("a write answered blocked never lands, however the dialog is answered later", async () => {
    // What parks is the touch — the probe's child opening the path — not the
    // write. Here the probe says "hung" (a FIFO with no writer would park a
    // real child the same way). The call is answered blocked. Then the
    // "owner clicks Allow" — a writer opens the FIFO — and nothing is
    // written: a write let through minutes later would land over whatever
    // the file holds by then.
    const home = tempDir();
    const downloads = path.join(home, "Downloads");
    fs.mkdirSync(downloads);
    const fifo = path.join(downloads, "parked.pipe");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    const d = device(home, scriptedProbes({ openAsApp: { [fifo]: "hung" } }));
    d.fileOpHangMs = 200;
    const response = jv(
      await d.handleIntent(
        intentFor(d, "write", [{ kind: "fs.write", paths: [fifo] }]),
        { content_base64: Buffer.from("late").toString("base64") },
      ),
    );
    expect(response.get("status").str).toBe("blocked");
    expect(response.get("diagnosis").get("cause").str).toBe("prompt_waiting");
    // Nothing is waiting to write into the pipe: a non-blocking open for
    // writing finds no reader on the other end (ENXIO), and no write is
    // ever recorded.
    expect(() => fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)).toThrow(/ENXIO/);
    await new Promise((r) => setTimeout(r, 300));
    expect(events(d)).not.toContain("file_write");
  });

  it("a touch that returns in time is followed by the operation, which meets the same answer", async () => {
    // A guarded path this Mac can open at once: the write goes ahead.
    const home = tempDir();
    fs.mkdirSync(path.join(home, "Desktop"));
    const file = path.join(home, "Desktop", "new.txt");
    const d = device(home, scriptedProbes());
    d.fileOpHangMs = 500;
    const response = jv(
      await d.handleIntent(
        intentFor(d, "write", [{ kind: "fs.write", paths: [file] }]),
        { content_base64: Buffer.from("hello").toString("base64") },
      ),
    );
    expect(response.get("status").str).toBe("completed");
    expect(fs.readFileSync(file, "utf8")).toBe("hello");
    expect(events(d)).toContain("file_write");
  });

  it("an unguarded path is never raced against the hang window", async () => {
    const home = tempDir();
    const d = device(home);
    d.fileOpHangMs = 1;
    const file = path.join(home, "Plow", "quick.txt");
    fs.writeFileSync(file, "hello");
    const response = jv(await d.handleIntent(intentFor(d, "read", [{ kind: "fs.read", paths: [file] }])));
    expect(response.get("status").str).toBe("completed");
  });
});

describe.skipIf(!ON_MAC)("a command this Mac refused", () => {
  /** A command whose stderr is a refusal on `target`, with exit 1. */
  const refusing = (target: string) => [
    "/bin/sh",
    "-c",
    `echo "cat: ${target}: Operation not permitted" >&2; exit 1`,
  ];

  it("a TCC refusal in stderr, confirmed by scripted probes: blocked, with the run's exit code kept", async () => {
    const home = tempDir();
    const target = path.join(home, "Library/Messages/chat.db");
    const probes = scriptedProbes({ openAsApp: { [target]: "EPERM" }, fullDiskAccess: false });
    const d = device(home, probes);
    const response = jv(
      await d.handleIntent(
        // The database is what the owner approved reading; only then is
        // the refusal in the output followed up on the disk.
        intentFor(d, "run", [{ kind: "process.exec", argv: refusing(target), cwd: home }, { kind: "fs.read", paths: [target] }]),
        { wait_ms: 5_000 },
      ),
    );
    expect(response.get("status").str).toBe("blocked");
    expect(response.get("exit_code").int).toBe(1);
    expect(response.get("output").str).toMatch(/Operation not permitted/);
    const diagnosis = response.get("diagnosis");
    expect(diagnosis.get("cause").str).toBe("macos_permission");
    expect(diagnosis.get("permission").str).toBe("full_disk_access");
    expect(diagnosis.get("requires_relaunch").bool).toBe(true);
    expect(response.get("probes").get("ran_sandboxed").bool).toBe(true);
    expect(response.get("probes").get("path").str).toBe("~/Library/Messages/chat.db");
    expect(events(d)).toEqual(["intent_received", "intent_decision", "exec_start", "exec_end", "host_permission_blocked"]);
    expect(lastBlocked(d).get("handle").str).toBe(response.get("handle").str);
    // The same story from a later poll.
    const polled = jv(await d.getOutput(response.get("handle").str!));
    expect(polled.get("status").str).toBe("blocked");
    expect(polled.get("diagnosis").get("cause").str).toBe("macos_permission");
  });

  it("our own seatbelt, diagnosed for real: a write outside the profile is outside_approved_bound", async () => {
    const home = tempDir();
    const d = device(home);
    const elsewhere = tempDir();
    const target = path.join(elsewhere, "out.txt");
    const response = jv(
      await d.handleIntent(
        intentFor(d, "run", [
          { kind: "process.exec", argv: ["/bin/sh", "-c", `echo hi > ${JSON.stringify(target)}`], cwd: home },
        ]),
        { wait_ms: 5_000 },
      ),
    );
    expect(response.get("status").str).toBe("blocked");
    expect(response.get("exit_code").int).not.toBe(0);
    const diagnosis = response.get("diagnosis");
    expect(diagnosis.get("cause").str).toBe("outside_approved_bound");
    expect(diagnosis.get("retry").str).toBe("with_declared_path");
    expect(diagnosis.get("owner_action").str).toMatch(/write_paths/);
    expect(response.get("probes").get("sandbox_allows_write").bool).toBe(false);
    expect(response.get("probes").get("path").str).toBe(target);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("the same write declared is not a gate at all", async () => {
    const home = tempDir();
    const d = device(home);
    const elsewhere = tempDir();
    const target = path.join(elsewhere, "out.txt");
    const response = jv(
      await d.handleIntent(
        intentFor(d, "run", [
          { kind: "process.exec", argv: ["/bin/sh", "-c", `echo hi > ${JSON.stringify(target)}`], cwd: home },
          { kind: "fs.write", paths: [elsewhere] },
        ]),
        { wait_ms: 5_000 },
      ),
    );
    expect(response.get("status").str).toBe("completed");
    expect(response.get("exit_code").int).toBe(0);
    expect(response.get("diagnosis").isNull).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("hi\n");
  });

  it("an ordinary non-zero exit gets no diagnosis and no probes", async () => {
    const home = tempDir();
    const probes = scriptedProbes();
    const d = device(home, probes);
    const response = jv(
      await d.handleIntent(
        intentFor(d, "run", [{ kind: "process.exec", argv: ["/bin/sh", "-c", "echo nope >&2; exit 3"], cwd: home }]),
        { wait_ms: 5_000 },
      ),
    );
    expect(response.get("status").str).toBe("completed");
    expect(response.get("exit_code").int).toBe(3);
    expect(response.get("diagnosis").isNull).toBe(true);
    expect(probes.calls).toEqual([]);
    expect(events(d)).not.toContain("host_permission_blocked");
  });

  it("a denied Automation consent, from the run's -1743", async () => {
    const home = tempDir();
    const probes = scriptedProbes({ automation: { Messages: "denied" } });
    const d = device(home, probes);
    // The script rides as its own argv word, the way osascript -e takes it;
    // here it is `$1` to a shell that only prints what osascript would have.
    const script = 'tell application "Messages" to send "hi" to buddy "x"';
    const response = jv(
      await d.handleIntent(
        intentFor(d, "run", [
          {
            kind: "process.exec",
            argv: ["/bin/sh", "-c", "echo 'execution error: Not authorized to send Apple events to Messages. (-1743)' >&2; exit 1", "sh", script],
            cwd: home,
          },
          { kind: "apple_events", allowed: true },
        ]),
        { wait_ms: 5_000 },
      ),
    );
    expect(response.get("status").str).toBe("blocked");
    const diagnosis = response.get("diagnosis");
    expect(diagnosis.get("cause").str).toBe("macos_permission");
    expect(diagnosis.get("permission").str).toBe("automation");
    expect(diagnosis.get("owner_action").str).toMatch(/allow Plow Latch to control Messages/);
    expect(response.get("probes").get("automation_target").str).toBe("Messages");
    expect(probes.calls).toContain("automationStatus Messages");
  });

  it("a silent run parked on a consent dialog: running with the diagnosis, then blocked once reaped", async () => {
    const home = tempDir();
    const downloads = path.join(home, "Downloads");
    fs.mkdirSync(downloads);
    const fifo = path.join(downloads, "blocked.pipe");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    const probes = scriptedProbes({ openAsApp: { [fifo]: "hung" } });
    const d = device(home, probes);
    Object.assign(d, { executor: new Executor(path.join(home, "device/scratch"), 400) });

    const response = jv(
      await d.handleIntent(
        intentFor(d, "run", [{ kind: "process.exec", argv: ["/bin/cat", fifo], cwd: home }, { kind: "fs.read", paths: [fifo] }]),
        { wait_ms: 50 },
      ),
    );
    // Still running — the owner's click would let it finish — but the agent
    // is told now what it is waiting on, not at the reaper's fifteen minutes.
    expect(response.get("status").str).toBe("running");
    expect(response.get("diagnosis").get("cause").str).toBe("prompt_waiting");
    expect(response.get("diagnosis").get("permission").str).toBe("files_downloads");
    const handle = response.get("handle").str!;
    expect(events(d).filter((e) => e === "host_permission_blocked")).toHaveLength(1);

    // The reaper kills it; the poll then carries the killed verdict.
    const deadline = Date.now() + 5_000;
    let polled = jv(await d.getOutput(handle));
    while (polled.get("status").str === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      polled = jv(await d.getOutput(handle));
    }
    expect(polled.get("status").str).toBe("blocked");
    expect(polled.get("error").str).toMatch(/killed by this Mac/);
    expect(polled.get("diagnosis").get("cause").str).toBe("prompt_waiting");
    expect(polled.get("probes").get("hung").bool).toBe(true);
    // One story in the log, not two: the run was blocked once.
    expect(events(d).filter((e) => e === "host_permission_blocked")).toHaveLength(1);
    expect(events(d)).toContain("exec_end");
  });

  it.skipIf(!ON_MAC)("a parked run the owner lets through is completed, not blocked", async () => {
    // The verdict while parked was provisional. The owner clicks Allow (a
    // writer opens the FIFO), cat exits 0, and the poll must say so: a
    // finished command wearing "blocked" would send the owner to a switch
    // they just flipped.
    const home = tempDir();
    const downloads = path.join(home, "Downloads");
    fs.mkdirSync(downloads);
    const fifo = path.join(downloads, "blocked.pipe");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    const d = device(home, scriptedProbes({ openAsApp: { [fifo]: "hung" } }));
    const response = jv(
      await d.handleIntent(
        intentFor(d, "run", [{ kind: "process.exec", argv: ["/bin/cat", fifo], cwd: home }, { kind: "fs.read", paths: [fifo] }]),
        { wait_ms: 50 },
      ),
    );
    expect(response.get("status").str).toBe("running");
    expect(response.get("diagnosis").get("cause").str).toBe("prompt_waiting");
    const handle = response.get("handle").str!;
    // The owner answers.
    const fd = fs.openSync(fifo, "w");
    fs.writeSync(fd, "through\n");
    fs.closeSync(fd);
    const deadline = Date.now() + 5_000;
    let polled = jv(await d.getOutput(handle));
    while (polled.get("status").str === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      polled = jv(await d.getOutput(handle));
    }
    expect(polled.get("status").str).toBe("completed");
    expect(polled.get("exit_code").int).toBe(0);
    expect(polled.get("output").str).toBe("through\n");
    expect(polled.get("diagnosis").isNull).toBe(true);
    // The block stays in the log — it happened — beside the clean exit, and
    // the clearing is recorded for the owner's views to stop counting it.
    expect(events(d).filter((e) => e === "host_permission_blocked")).toHaveLength(1);
    expect(events(d)).toContain("exec_end");
    expect(events(d)).toContain("host_permission_cleared");
  });

  it("a run that ends well while its first probes are still running is completed, not blocked", async () => {
    // The silent-run diagnosis is asked inside the call; the command may
    // finish while the probes are out. The verdict they come back with is
    // then about a run that no longer exists, and must not be stored over
    // the exit handler's clearing — or the poll says exit 0, blocked.
    const home = tempDir();
    fs.mkdirSync(path.join(home, "Desktop"));
    const file = path.join(home, "Desktop", "notes.txt");
    fs.writeFileSync(file, "x");
    const inner = scriptedProbes({ openAsApp: { [file]: "hung" }, fullDiskAccess: false });
    const slow: HostProbes = {
      ...inner,
      openAsApp: async (p) => { await new Promise((r) => setTimeout(r, 400)); return inner.openAsApp(p); },
    };
    const d = device(home, slow);
    const response = jv(
      await d.handleIntent(
        intentFor(d, "run", [{ kind: "process.exec", argv: ["/bin/sh", "-c", `sleep 0.2; cat ${JSON.stringify(file)}`], cwd: home }, { kind: "fs.read", paths: [file] }]),
        { wait_ms: 50 },
      ),
    );
    // The call answers with where the run is now: over, cleanly.
    expect(response.get("status").str).toBe("completed");
    expect(response.get("exit_code").int).toBe(0);
    expect(response.get("diagnosis").isNull).toBe(true);
    const polled = jv(await d.getOutput(response.get("handle").str!));
    expect(polled.get("status").str).toBe("completed");
    expect(polled.get("diagnosis").isNull).toBe(true);
    expect(events(d)).not.toContain("host_permission_blocked");
  });

  it("a provisional 'parked' verdict that returns after the exit's own never overwrites it", async () => {
    // The in-call silent-run probe is slow; the run fails with a refusal
    // while it is out; the exit's diagnosis (fast) lands first and says
    // macos_permission. The slow probe then comes back saying "parked" —
    // about a run that has ended — and must be discarded, or the agent is
    // told to answer a dialog instead of flipping the switch.
    const home = tempDir();
    const target = path.join(home, "Library", "Messages", "chat.db");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "x");
    const inner = scriptedProbes({ openAsApp: { [target]: "EPERM" }, fullDiskAccess: false });
    // The provisional battery's probe of the target is slow and comes back
    // "parked"; every later probe — the rest of that battery, and all of
    // the exit's — is quick and answers as the Mac would. Decided before
    // the wait, on the target's own first probe: the batteries probe several
    // paths at once (the shell first), so a plain invocation count would
    // pick the wrong one.
    let targetProbes = 0;
    const firstSlow: HostProbes = {
      ...inner,
      openAsApp: async (p) => {
        const provisional = p === target && ++targetProbes === 1;
        await new Promise((r) => setTimeout(r, provisional ? 900 : 10));
        return provisional ? "hung" : inner.openAsApp(p);
      },
    };
    const d = device(home, firstSlow);
    const response = jv(
      await d.handleIntent(
        intentFor(d, "run", [{ kind: "process.exec", argv: ["/bin/sh", "-c", `sleep 0.2; echo "sh: ${target}: Operation not permitted" >&2; exit 1`], cwd: home }, { kind: "fs.read", paths: [target] }]),
        { wait_ms: 50 },
      ),
    );
    expect(response.get("status").str).toBe("blocked");
    expect(response.get("diagnosis").get("cause").str).toBe("macos_permission");
    const polled = jv(await d.getOutput(response.get("handle").str!));
    expect(polled.get("diagnosis").get("cause").str).toBe("macos_permission");
    const blocks = d.audit.entries().filter((e) => jv(e as JSONValue).get("event").str === "host_permission_blocked");
    expect(blocks).toHaveLength(1);
    expect(jv(blocks[0] as JSONValue).get("cause").str).toBe("macos_permission");
  });

  it.skipIf(!ON_MAC)("a parked run that resumes and then fails on its own terms is Failed, not blocked", async () => {
    // Parked, then the owner answers, then the command exits 1 for a reason
    // of its own. The "parked" verdict is gone with the dialog; an ordinary
    // exit gets no diagnosis; the poll says completed, exit 1.
    const home = tempDir();
    const downloads = path.join(home, "Downloads");
    fs.mkdirSync(downloads);
    const fifo = path.join(downloads, "blocked.pipe");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    const d = device(home, scriptedProbes({ openAsApp: { [fifo]: "hung" } }));
    const response = jv(
      await d.handleIntent(
        intentFor(d, "run", [{ kind: "process.exec", argv: ["/bin/sh", "-c", `cat ${JSON.stringify(fifo)}; exit 1`], cwd: home }, { kind: "fs.read", paths: [fifo] }]),
        { wait_ms: 50 },
      ),
    );
    expect(response.get("status").str).toBe("running");
    expect(response.get("diagnosis").get("cause").str).toBe("prompt_waiting");
    const handle = response.get("handle").str!;
    // The owner answers: cat is the reader, so this open completes.
    const fd = fs.openSync(fifo, "w");
    fs.writeSync(fd, "through\n");
    fs.closeSync(fd);
    const deadline = Date.now() + 5_000;
    let polled = jv(await d.getOutput(handle));
    while (polled.get("status").str === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      polled = jv(await d.getOutput(handle));
    }
    expect(polled.get("status").str).toBe("completed");
    expect(polled.get("exit_code").int).toBe(1);
    expect(polled.get("diagnosis").isNull).toBe(true);
  });

  it("a poll that lands between the exit and its diagnosis waits for the verdict", async () => {
    // The exit-time diagnosis is asynchronous. A poll answered in the gap
    // would read "completed, exit 1" with no diagnosis, and an agent takes
    // that as the whole story. The probes here are slow on purpose, so the
    // gap is wide enough to land in.
    const home = tempDir();
    const target = path.join(home, "Library", "Messages", "chat.db");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "x");
    const inner = scriptedProbes({ openAsApp: { [target]: "EPERM" }, fullDiskAccess: false });
    const slow: HostProbes = {
      ...inner,
      openAsApp: async (p) => { await new Promise((r) => setTimeout(r, 300)); return inner.openAsApp(p); },
    };
    const d = device(home, slow);
    const response = jv(
      await d.handleIntent(
        intentFor(d, "run", [{ kind: "process.exec", argv: ["/bin/sh", "-c", `sleep 0.7; echo "sh: ${target}: Operation not permitted" >&2; exit 1`], cwd: home }, { kind: "fs.read", paths: [target] }]),
        { wait_ms: 50 },
      ),
    );
    // The call's own silent-run probes take ~300ms; the run outlives them.
    expect(response.get("status").str).toBe("running");
    const handle = response.get("handle").str!;
    // Wait for the exit itself, then poll at once — inside the diagnosis.
    await new Promise((r) => setTimeout(r, 800));
    const polled = jv(await d.getOutput(handle));
    expect(polled.get("status").str).toBe("blocked");
    expect(polled.get("diagnosis").get("cause").str).toBe("macos_permission");
  });

  it("a run's output naming a guarded path it never touched raises no probe there", async () => {
    // Approved to read ~/Plow; prints a refusal for ~/Desktop/secret and
    // exits 1. Neither probe is asked about the Desktop path — the app's
    // own open there would raise the owner's dialog for something they
    // never approved — and the verdict is the bound.
    const home = tempDir();
    fs.mkdirSync(path.join(home, "Desktop"));
    const secret = path.join(home, "Desktop", "secret.txt");
    const probes = scriptedProbes({ openAsApp: { [secret]: "hung" } });
    const d = device(home, probes);
    const response = jv(
      await d.handleIntent(
        intentFor(d, "run", [
          { kind: "process.exec", argv: ["/bin/sh", "-c", `echo "cat: ${secret}: Operation not permitted" >&2; exit 1`], cwd: home },
          { kind: "fs.read", paths: [path.join(home, "Plow")] },
        ]),
        { wait_ms: 5_000 },
      ),
    );
    expect(probes.calls.filter((c) => c.includes("Desktop"))).toEqual([]);
    expect(response.get("status").str).toBe("blocked");
    expect(response.get("diagnosis").get("cause").str).toBe("outside_approved_bound");
    expect(response.get("probes").get("path_approved").bool).toBe(false);
  });

  it.skipIf(!ON_MAC)("a parked run the owner refuses is corrected under its handle, and both records say so", async () => {
    // Parked (the probe says "hung"), then the owner clicks Don't Allow: the
    // run fails with a refusal. The verdict on record — a dialog — is now
    // wrong, so the clearing is recorded and the refusal is recorded as a
    // second block under the same handle: the poll, the audit row and the
    // Capabilities tab all take the newest.
    const home = tempDir();
    const downloads = path.join(home, "Downloads");
    fs.mkdirSync(downloads);
    const fifo = path.join(downloads, "blocked.pipe");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    const inner = scriptedProbes({ openAsApp: { [fifo]: "EPERM" }, fullDiskAccess: false });
    let opens = 0;
    const probes: HostProbes = { ...inner, openAsApp: async (p) => (p === fifo && ++opens === 1 ? "hung" : inner.openAsApp(p)) };
    const d = device(home, probes);
    const response = jv(
      await d.handleIntent(
        intentFor(d, "run", [
          { kind: "process.exec", argv: ["/bin/sh", "-c", `cat ${JSON.stringify(fifo)} >/dev/null; echo "cat: ${fifo}: Operation not permitted" >&2; exit 1`], cwd: home },
          { kind: "fs.read", paths: [fifo] },
        ]),
        { wait_ms: 50 },
      ),
    );
    expect(response.get("status").str).toBe("running");
    expect(response.get("diagnosis").get("cause").str).toBe("prompt_waiting");
    const handle = response.get("handle").str!;
    // "Don't Allow": the reader is released with nothing, cat fails, the shell reports a refusal.
    const fd = fs.openSync(fifo, "w");
    fs.closeSync(fd);
    const deadline = Date.now() + 5_000;
    let polled = jv(await d.getOutput(handle));
    while (polled.get("status").str === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      polled = jv(await d.getOutput(handle));
    }
    expect(polled.get("status").str).toBe("blocked");
    expect(polled.get("diagnosis").get("cause").str).toBe("macos_permission");
    const rows = d.audit.entries().map((e) => jv(e as JSONValue));
    const blocks = rows.filter((r) => r.get("event").str === "host_permission_blocked");
    expect(blocks.map((b) => b.get("cause").str)).toEqual(["prompt_waiting", "macos_permission"]);
    expect(blocks.every((b) => b.get("handle").str === handle)).toBe(true);
    const cleared = rows.find((r) => r.get("event").str === "host_permission_cleared")!;
    expect(cleared.get("handle").str).toBe(handle);
    expect(cleared.get("permission").str).toBe("files_downloads");
  });

  it("a silent run that is simply running is left alone", async () => {
    const home = tempDir();
    const probes = scriptedProbes();
    const d = device(home, probes);
    const response = jv(
      await d.handleIntent(
        intentFor(d, "run", [{ kind: "process.exec", argv: ["/bin/sleep", "0.3"], cwd: home }]),
        { wait_ms: 50 },
      ),
    );
    expect(response.get("status").str).toBe("running");
    expect(response.get("diagnosis").isNull).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(jv(await d.getOutput(response.get("handle").str!)).get("status").str).toBe("completed");
  });
});
