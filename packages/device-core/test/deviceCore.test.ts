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
  signIntent,
} from "@domo/protocol";
import {
  AuditLog,
  FileOps,
  FileOpsError,
  HeadlessPolicy,
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
  it("reads within scope, rejects outside", () => {
    const dir = tempDir();
    const inside = path.join(dir, "a.txt");
    fs.writeFileSync(inside, "data");
    expect(FileOps.read(inside, [dir]).toString()).toBe("data");
    expect(() => FileOps.read("/etc/hosts", [dir])).toThrow(FileOpsError);
  });

  it("rejects ../ traversal escaping the root", () => {
    const dir = tempDir();
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(dir, "secret.txt"), "s");
    // sub/../secret.txt canonicalizes to dir/secret.txt — outside [sub].
    expect(() => FileOps.read(path.join(sub, "../secret.txt"), [sub])).toThrow(/approved scope/);
  });

  it("rejects a symlink escaping the root", () => {
    const root = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, "target.txt"), "leak");
    const link = path.join(root, "link.txt");
    fs.symlinkSync(path.join(outside, "target.txt"), link);
    // The symlink resolves outside root, so canonicalization catches it.
    expect(() => FileOps.read(link, [root])).toThrow(/approved scope/);
  });

  it("writes within scope and creates parent dirs", () => {
    const dir = tempDir();
    const target = path.join(dir, "nested/deep/out.txt");
    FileOps.write(target, Buffer.from("hi"), [dir]);
    expect(fs.readFileSync(target, "utf8")).toBe("hi");
  });
});

describe("PolicyEngine", () => {
  // A single agent identity — rule keys are (agent, device, caps), so reuse
  // across intents requires the same agent, as it would be in a real session.
  const agentKey = new KeyPair();
  function intentWith(caps: Capability[]): Intent {
    const intent = makeIntent({
      agentId: agentKey.fingerprint,
      agentDisplay: "Agent",
      agentPublicKey: agentKey.publicKeyBase64,
      deviceId: "device-1",
      request: "test",
      capabilities: caps,
      sessionId: "s1",
    });
    signIntent(intent, agentKey);
    return intent;
  }

  it("always_allow stores a rule reused on the next matching intent", async () => {
    const engine = new PolicyEngine(path.join(tempDir(), "rules.json"));
    const always = new HeadlessPolicy({ access: "allow", intent: "always_allow" });
    const caps: Capability[] = [{ kind: "process.exec", argv: ["ls"], cwd: "/tmp" }];

    const first = await engine.decide(intentWith(caps), always);
    expect(first.decision).toBe("always_allow");
    expect(first.source).toBe("prompt");
    expect(engine.allRules()).toHaveLength(1);

    // A fresh intent with the same capabilities matches the stored rule —
    // even though the delegate would now deny.
    const denyAll = new HeadlessPolicy({ access: "allow", intent: "deny" });
    const second = await engine.decide(intentWith(caps), denyAll);
    expect(second.decision).toBe("always_allow");
    expect(second.source).toBe("rule");
  });

  it("deny is never stored as a rule", async () => {
    const engine = new PolicyEngine(path.join(tempDir(), "rules.json"));
    const deny = new HeadlessPolicy({ access: "allow", intent: "deny" });
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
      access: "allow",
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
      decideAccess: async () => true,
      decideIntent: async () => ({ decision: "allow_once" as const, source: "approve" }),
    };
    const g1 = await engine.decide(intentWith([{ kind: "network", allowed: true }]), annotated);
    expect(g1.decision).toBe("allow_once");
    expect(g1.source).toBe("approve");

    // Back-compat: a delegate returning a bare Decision is sourced "prompt".
    const bare = {
      decideAccess: async () => true,
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
});
