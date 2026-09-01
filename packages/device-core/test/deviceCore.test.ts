/**
 * Device-core unit tests mirroring the Swift DeviceCoreTests: file bounds
 * (traversal, symlink escape), policy rule reuse / deny-not-stored, audit log
 * shape, and the intent validation path.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Capability,
  Intent,
  KeyPair,
  makeIntent,
} from "@domo/protocol";
import {
  AuditLog,
  DeviceAgent,
  FileOps,
  FileOpsError,
  HeadlessPolicy,
  MAX_FILE_BYTES,
  PolicyEngine,
} from "@domo/device-core";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-dc-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("FileOps bounds", () => {
  it("reads within scope, rejects outside", async () => {
    const dir = tempDir();
    const inside = path.join(dir, "a.txt");
    fs.writeFileSync(inside, "data");
    expect((await FileOps.read(inside, [dir])).toString()).toBe("data");
    await expect(FileOps.read("/etc/hosts", [dir])).rejects.toThrow(FileOpsError);
  });

  it("rejects ../ traversal escaping the root", async () => {
    const dir = tempDir();
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(dir, "secret.txt"), "s");
    // sub/../secret.txt canonicalizes to dir/secret.txt — outside [sub].
    await expect(FileOps.read(path.join(sub, "../secret.txt"), [sub])).rejects.toThrow(
      /approved scope/,
    );
  });

  it("rejects a symlink escaping the root", async () => {
    const root = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, "target.txt"), "leak");
    const link = path.join(root, "link.txt");
    fs.symlinkSync(path.join(outside, "target.txt"), link);
    // The symlink resolves outside root, so canonicalization catches it.
    await expect(FileOps.read(link, [root])).rejects.toThrow(/approved scope/);
  });

  it("writes within scope and creates parent dirs", async () => {
    const dir = tempDir();
    const target = path.join(dir, "nested/deep/out.txt");
    await FileOps.write(target, Buffer.from("hi"), [dir]);
    expect(fs.readFileSync(target, "utf8")).toBe("hi");
  });

  it("refuses a read over the single-call size ceiling", async () => {
    const dir = tempDir();
    const big = path.join(dir, "big.bin");
    // Sparse file: the ceiling is checked from stat, so no bytes are written.
    const fd = fs.openSync(big, "w");
    fs.ftruncateSync(fd, MAX_FILE_BYTES + 1);
    fs.closeSync(fd);
    await expect(FileOps.read(big, [dir])).rejects.toThrow(/single-call limit/);
  });

  it("refuses a write over the single-call size ceiling", async () => {
    const dir = tempDir();
    await expect(
      FileOps.write(path.join(dir, "big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1), [dir]),
    ).rejects.toThrow(/single-call limit/);
    expect(fs.existsSync(path.join(dir, "big.bin"))).toBe(false);
  });

  // "does not block the event loop" is asserted in fileOpsAsync.test.ts, which
  // gates the read by hand. The version that used to live here armed a 0ms
  // timer, awaited the read, then CLEARED the timer before asserting it had
  // fired — so it was racing the loop and passing by luck. It flaked.
});

describe("PolicyEngine", () => {
  // A single agent identity — rule keys are (agent, device, caps), so reuse
  // across intents requires the same agent, as it would be in a real session.
  const agentKey = new KeyPair();
  function intentWith(caps: Capability[]): Intent {
    return makeIntent({
      agentId: agentKey.fingerprint,
      agentDisplay: "Agent",
      deviceId: "device-1",
      request: "test",
      capabilities: caps,
      sessionId: "s1",
    });
  }

  it("always_allow stores a rule reused on the next matching intent", async () => {
    const engine = new PolicyEngine(path.join(tempDir(), "rules.json"));
    const always = new HeadlessPolicy({ intent: "always_allow" });
    const caps: Capability[] = [{ kind: "process.exec", argv: ["ls"], cwd: "/tmp" }];

    const first = await engine.decide(intentWith(caps), always);
    expect(first.decision).toBe("always_allow");
    expect(first.source).toBe("prompt");
    expect(engine.allRules()).toHaveLength(1);

    // A fresh intent with the same capabilities matches the stored rule —
    // even though the delegate would now deny.
    const denyAll = new HeadlessPolicy({ intent: "deny" });
    const second = await engine.decide(intentWith(caps), denyAll);
    expect(second.decision).toBe("always_allow");
    expect(second.source).toBe("rule");
  });

  it("apple_events intents are never stored as rules, and never replayed from one", async () => {
    const engine = new PolicyEngine(path.join(tempDir(), "rules.json"));
    const always = new HeadlessPolicy({ intent: "always_allow" });
    const caps: Capability[] = [
      { kind: "process.exec", argv: ["/usr/bin/osascript", "-e", "on run argv"] },
      { kind: "apple_events", allowed: true },
    ];

    // The grant still lands for THIS run — but nothing is cached.
    const first = await engine.decide(intentWith(caps), always);
    expect(first.decision).toBe("always_allow");
    expect(engine.allRules()).toHaveLength(0);

    // A byte-identical repeat goes back to the delegate, not to a rule; and a
    // rule persisted by an older build cannot answer either (the match side
    // checks eligibility too).
    const denyAll = new HeadlessPolicy({ intent: "deny" });
    const second = await engine.decide(intentWith(caps), denyAll);
    expect(second.decision).toBe("deny");
  });

  it("deny is never stored as a rule", async () => {
    const engine = new PolicyEngine(path.join(tempDir(), "rules.json"));
    const deny = new HeadlessPolicy({ intent: "deny" });
    const grant = await engine.decide(
      intentWith([{ kind: "network", allowed: true }]),
      deny,
    );
    expect(grant.decision).toBe("deny");
    expect(engine.allRules()).toHaveLength(0);
  });

  it("denyKinds forces a deny for matching capabilities", async () => {
    const engine = new PolicyEngine(path.join(tempDir(), "rules.json"));
    const policy = new HeadlessPolicy({
      intent: "allow_once",
      denyKinds: ["process.exec"],
    });
    const grant = await engine.decide(
      intentWith([{ kind: "process.exec", argv: ["rm"] }]),
      policy,
    );
    expect(grant.decision).toBe("deny");
  });

  it("a delegate's source flows into the grant; a bare Decision defaults to prompt", async () => {
    const engine = new PolicyEngine(path.join(tempDir(), "rules.json"));
    // Delegate returning {decision, source} — the source is recorded.
    const annotated = {
      decideIntent: async () => ({ decision: "allow_once" as const, source: "approve" }),
    };
    const g1 = await engine.decide(intentWith([{ kind: "network", allowed: true }]), annotated);
    expect(g1.decision).toBe("allow_once");
    expect(g1.source).toBe("approve");

    // Back-compat: a delegate returning a bare Decision is sourced "prompt".
    const bare = {
      decideIntent: async () => "deny" as const,
    };
    const g2 = await engine.decide(intentWith([{ kind: "network", allowed: false }]), bare);
    expect(g2.source).toBe("prompt");
  });
});

describe("AuditLog", () => {
  it("appends one NDJSON event per line, oldest first", () => {
    const log = new AuditLog(path.join(tempDir(), "audit.ndjson"));
    log.record("first", { a: 1 });
    log.record("second", { b: "two" });
    const entries = log.entries();
    expect(entries.map((e) => (e as { event: string }).event)).toEqual(["first", "second"]);
    // Each entry carries an event + ts stamp.
    for (const e of entries) {
      expect((e as { ts?: string }).ts).toBeTypeOf("string");
    }
    // One JSON object per physical line.
    const lines = fs
      .readFileSync(log.file, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
  });

  it("does not fail record() when a change listener throws", () => {
    const log = new AuditLog(path.join(tempDir(), "audit.ndjson"));
    // The desktop listener calls webContents.send, which throws once the
    // renderer is torn down.
    log.events.on("change", () => {
      throw new Error("webContents destroyed");
    });

    // record() succeeds when the event is durably on disk. Callers gate real
    // access on that — BrowserSessions records a session before it publishes
    // one — so an escaping listener error would refuse access the log already
    // says was granted.
    expect(() => log.record("browser_session_opened", { session: "S" })).not.toThrow();
    expect(log.entries()).toHaveLength(1);
    expect(() => log.clear()).not.toThrow();
    expect(log.entries()).toHaveLength(0);
  });

  it("rolls over by rename once the file is full, and reads both generations as one log", () => {
    const dir = tempDir();
    const file = path.join(dir, "audit.ndjson");
    // A ceiling one event fits under: the second append finds the file full.
    const log = new AuditLog(file, 40);
    log.record("first");
    log.record("second");
    log.record("third");

    // Two generations, whole lines each, nothing rewritten and nothing lost.
    expect(log.previous).toBe(path.join(dir, "audit.1.ndjson"));
    const events = (f: string) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events(file)).toEqual(["third"]);
    expect(events(log.previous)).toEqual(["second"]);
    expect(log.entries().map((e) => (e as { event: string }).event)).toEqual(["second", "third"]);

    // Clearing takes both generations with it.
    log.clear();
    expect(fs.existsSync(log.previous)).toBe(false);
    expect(log.entries()).toHaveLength(0);
  });

  it("never rotates a log that has not reached its ceiling", () => {
    const dir = tempDir();
    const log = new AuditLog(path.join(dir, "audit.ndjson"));
    for (let i = 0; i < 50; i++) log.record("e", { i });
    expect(fs.existsSync(log.previous)).toBe(false);
    expect(log.entries()).toHaveLength(50);
  });
});

describe("shutting the machine down", () => {
  it("surfaces a browser-cleanup failure — there is no vault process left to stop", async () => {
    // The vault used to run as a detached child that shutdown had to stop even
    // when browser cleanup threw. It is a file and a Keychain item now, so
    // shutdown's only job here is to close sessions and report honestly.
    const device = new DeviceAgent(tempDir(), "Test Mac", new HeadlessPolicy({ intent: "allow_once" }));
    Object.assign(device, {
      browserSessions: { closeAll: () => Promise.reject(new Error("audit log is full")) },
    });

    await expect(device.shutdown()).rejects.toThrow("audit log is full");
  });
});

describe("browser fingerprint pinning is wired to the runtime", () => {
  it("sets DOMO_FINGERPRINT_PIN to a stable per-install path in the browser env", () => {
    // The frozen pool is pinned per install only if the device hands the server
    // a persistent path to record its pick at; a runtime whose env omitted it
    // fell back to a random fingerprint every launch (the property DESIGN.md §11a
    // relies on, silently lost).
    const home = tempDir();
    const runtime = {
      serverCommand: ["node", "/x/server.js"],
      credentialBrokerCommand: null,
      mergeCookiesCommand: ["node", "/x/mergeCookies.js"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      executablePath: "/x/camoufox",
    };
    const device = new DeviceAgent(home, "Test Mac", new HeadlessPolicy({ intent: "allow_once" }), runtime);
    const env = (device as unknown as { browserConfig: { env: Record<string, string> } }).browserConfig.env;
    expect(env.DOMO_FINGERPRINT_PIN).toBe(path.join(home, "device/browser", "fingerprint-pin.json"));
    // The runtime's own env survives alongside it.
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});
