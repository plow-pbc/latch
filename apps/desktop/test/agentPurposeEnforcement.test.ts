/**
 * The purpose statement is advisory, and this is the file that says so in
 * executable terms.
 *
 * The rule the whole design rests on: enforcement derives from approved
 * capabilities, never from prose. The owner's purpose informs the reviewer and
 * the human, and it must reach nothing that binds — not a rule key, not a
 * grant, not a stored always-allow rule, not the audit log's record of what was
 * decided. An end-to-end run with a scripted policy is the only way to watch
 * all of those at once.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Capability, Intent, makeIntent } from "@domo/protocol";
import { DeviceAgent, HeadlessPolicy } from "@domo/device-core";
import { readAgentPurpose, setAgentPurpose } from "../src/settingsActions.js";

const PURPOSE = "Groceries and calendar only. Never touch ~/Developer.";
/** A word that appears in the purpose and nowhere else in this test's fixtures. */
const CANARY = "Groceries";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-purpose-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CAPS: Capability[] = [{ kind: "process.exec", argv: ["ls"], cwd: "/tmp" }];

function intentFor(deviceId: string): Intent {
  return makeIntent({
    agentId: "agent-1",
    agentDisplay: "Agent One",
    deviceId,
    goal: "list the folder",
    request: "run: ls",
    capabilities: CAPS,
    sessionId: "s1",
  });
}

describe("a stored purpose changes nothing that enforces", () => {
  it("never reaches the grant, the stored rule, or the audit log", async () => {
    const home = tempHome();
    setAgentPurpose(home, PURPOSE);
    expect(readAgentPurpose(home)).toContain(CANARY); // the fixture is really set

    const device = new DeviceAgent(home, "test-device", new HeadlessPolicy({ intent: "always_allow" }));
    // The intent also carries purpose-shaped prose on `planContext` — the slot a
    // "just put it on the intent" shortcut would reach for. Neither copy may
    // land in the record.
    const intent = { ...intentFor(device.identity.deviceId), planContext: PURPOSE };
    await device.handleIntent(intent);

    // The signed decision.
    const grant = await device.policy.decide(
      intentFor(device.identity.deviceId),
      new HeadlessPolicy({ intent: "always_allow" }),
    );
    expect(JSON.stringify(grant)).not.toContain(CANARY);

    // The rule that decision stored, in memory and on disk.
    expect(JSON.stringify(device.policy.allRules())).not.toContain(CANARY);
    expect(fs.readFileSync(path.join(home, "device/rules.json"), "utf8")).not.toContain(CANARY);

    // The audit log — the oracle. It carries the agent's goal, because a human
    // reads that; it must not carry the owner's standing instruction.
    const ndjson = fs.readFileSync(path.join(home, "device/audit.ndjson"), "utf8");
    expect(ndjson).toContain("list the folder");
    expect(ndjson).not.toContain(CANARY);
  });

  /**
   * The sharpest form of the rule. The key is a hash, so anything folded into
   * it changes what matches — and prose is exactly what must not be in there.
   * Two runs of the SAME operation whose prose differs (one carrying
   * purpose-shaped text on the very fields a "just put it on the intent"
   * shortcut would use) have to land on one key.
   */
  it("keys on capabilities, not on prose — differing goal and plan key identically", async () => {
    // Two Macs, one operation. Each decides ONCE, so the rule each stores is
    // the one its own intent produced — which is what lets the prose-carrying
    // side be inspected as a stored rule rather than as a lookup that matched
    // someone else's.
    const decideOnce = async (intent: Intent) => {
      const home = tempHome();
      setAgentPurpose(home, PURPOSE);
      const device = new DeviceAgent(
        home,
        "test-device",
        new HeadlessPolicy({ intent: "always_allow" }),
      );
      const grant = await device.policy.decide(intent, new HeadlessPolicy({ intent: "always_allow" }));
      return { grant, rules: device.policy.allRules(), home };
    };

    const plain = await decideOnce({ ...intentFor("device-1"), deviceId: "device-1" });
    const prosey = await decideOnce({
      ...intentFor("device-1"),
      deviceId: "device-1",
      goal: PURPOSE,
      planContext: PURPOSE,
    });

    expect(prosey.grant.ruleKey).toBe(plain.grant.ruleKey);
    // The prose reached neither the signed decision nor the rule it stored…
    expect(JSON.stringify(prosey.grant)).not.toContain(CANARY);
    expect(JSON.stringify(prosey.rules)).not.toContain(CANARY);
    // …nor the copy of that rule on disk.
    expect(fs.readFileSync(path.join(prosey.home, "device/rules.json"), "utf8")).not.toContain(
      CANARY,
    );
  });

  /**
   * The same property from the other side: a rule granted before the owner
   * wrote a purpose still matches afterwards. If purpose ever entered the key,
   * writing one would quietly revoke every rule already granted.
   */
  it("keeps an already-granted rule matching after the owner writes a purpose", async () => {
    const home = tempHome();
    const device = new DeviceAgent(
      home,
      "test-device",
      new HeadlessPolicy({ intent: "always_allow" }),
    );

    // Granted while the Mac had nothing to say about what agents are for.
    const first = await device.policy.decide(
      intentFor(device.identity.deviceId),
      new HeadlessPolicy({ intent: "always_allow" }),
    );
    expect(first.source).toBe("prompt");

    setAgentPurpose(home, PURPOSE);

    // The delegate would now DENY; the stored rule is what answers instead.
    const second = await device.policy.decide(
      { ...intentFor(device.identity.deviceId), goal: PURPOSE },
      new HeadlessPolicy({ intent: "deny" }),
    );
    expect(second.decision).toBe("always_allow");
    expect(second.source).toBe("rule");
    expect(second.ruleKey).toBe(first.ruleKey);
  });
});
