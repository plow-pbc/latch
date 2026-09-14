import { describe, expect, it } from "vitest";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { makeIntent, type Intent } from "@domo/protocol";
import { HeadlessPolicy, PolicyEngine } from "@domo/device-core";

const intent = (argv: string[]): Intent => makeIntent({ agentId: "a", agentDisplay: "a", deviceId: "d", request: "run", sessionId: "s",
  capabilities: [{ kind: "process.exec", argv }, { kind: "network", allowed: true }] });
const truncate = (i: Intent): Intent => ({ ...i, capabilities: i.capabilities.map((c) => c.kind === "process.exec" ? { ...c, argv: c.argv!.slice(0, 2) } : c) });

describe("PolicyEngine ruleView", () => {
  it("stores a rule under the viewed capabilities and answers a sibling from it", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rules-")), "rules.json");
    const engine = new PolicyEngine(file, truncate);
    const always = new HeadlessPolicy({ intent: "always_allow" });
    await engine.decide(intent(["fix", "query", "first"]), always);
    expect(engine.allRules()[0].capabilities.find((c) => c.kind === "process.exec")?.argv).toEqual(["fix", "query"]);
    const grant = await engine.decide(intent(["fix", "query", "second"]), new HeadlessPolicy({ intent: "deny" }));
    expect(grant.decision).toBe("always_allow");
  });
  it("is the identity by default", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rules-")), "rules.json");
    const engine = new PolicyEngine(file);
    await engine.decide(intent(["fix", "query", "first"]), new HeadlessPolicy({ intent: "always_allow" }));
    const grant = await engine.decide(intent(["fix", "query", "second"]), new HeadlessPolicy({ intent: "deny" }));
    expect(grant.decision).toBe("deny");
  });
});
