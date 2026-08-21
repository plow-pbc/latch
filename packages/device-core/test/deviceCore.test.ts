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

    const { grant: first } = await engine.decide(intentWith(caps), always);
    expect(first.decision).toBe("always_allow");
    expect(first.source).toBe("prompt");
    expect(engine.allRules()).toHaveLength(1);

    // A fresh intent with the same capabilities matches the stored rule —
    // even though the delegate would now deny.
    const denyAll = new HeadlessPolicy({ intent: "deny" });
    const { grant: second } = await engine.decide(intentWith(caps), denyAll);
    expect(second.decision).toBe("always_allow");
    expect(second.source).toBe("rule");
  });

  it("deny is never stored as a rule", async () => {
    const engine = new PolicyEngine(path.join(tempDir(), "rules.json"));
    const deny = new HeadlessPolicy({ intent: "deny" });
    const { grant } = await engine.decide(
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
    const { grant } = await engine.decide(
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
    const { grant: g1 } = await engine.decide(
      intentWith([{ kind: "network", allowed: true }]),
      annotated,
    );
    expect(g1.decision).toBe("allow_once");
    expect(g1.source).toBe("approve");

    // Back-compat: a delegate returning a bare Decision is sourced "prompt".
    const bare = {
      decideIntent: async () => "deny" as const,
    };
    const { grant: g2, reason } = await engine.decide(
      intentWith([{ kind: "network", allowed: false }]),
      bare,
    );
    expect(g2.source).toBe("prompt");
    // A bare Decision has nothing to say to the calling agent, and the engine
    // does not invent one.
    expect(reason).toBeUndefined();
  });

  it("carries a delegate's reason out beside the grant, not inside it", async () => {
    const engine = new PolicyEngine(path.join(tempDir(), "rules.json"));
    const explained = {
      decideIntent: async () => ({
        decision: "deny" as const,
        source: "adversarial",
        reason: "the origin list reaches well past the shop",
      }),
    };
    const { grant, reason } = await engine.decide(
      intentWith([{ kind: "network", allowed: true }]),
      explained,
    );
    expect(reason).toBe("the origin list reaches well past the shop");
    // `Grant` is the signed protocol object: display text must not appear in it.
    expect(JSON.stringify(grant)).not.toContain("reaches well past");
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
});

describe("shutting the machine down", () => {
  it("stops the vault even when the browser cleanup fails", async () => {
    // The vault runs as a detached child: it survives the app unless it is
    // told to stop. A close that throws — a full disk on the audit append —
    // used to skip that line and leave the vault serving after the app quit.
    const device = new DeviceAgent(tempDir(), "Test Mac", new HeadlessPolicy({ intent: "allow_once" }));
    let stopped = false;
    Object.assign(device, {
      browserSessions: { closeAll: () => Promise.reject(new Error("audit log is full")) },
      vaultServer: { stop: () => { stopped = true; } },
    });

    await expect(device.shutdown()).rejects.toThrow("audit log is full");
    expect(stopped).toBe(true);
  });
});
