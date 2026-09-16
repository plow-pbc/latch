import { describe, expect, it } from "vitest";
import { Capability, capabilityDisplay, normalizedCapability, RuleKey } from "../src/capability.js";

describe("msgvault capability", () => {
  it("displays as a read-only archive grant", () => {
    expect(capabilityDisplay({ kind: "msgvault", access: "read" })).toBe(
      "Messages: search & read this Mac's message archive (read-only)",
    );
  });

  it("normalization strips reason and nothing else", () => {
    const cap: Capability = { kind: "msgvault", access: "read", reason: "find flight info" };
    expect(normalizedCapability(cap)).toEqual({ kind: "msgvault", access: "read" });
  });

  it("rule key ignores reason, so every read query shares one rule", () => {
    const a = RuleKey.compute("agent", "device", [
      { kind: "msgvault", access: "read", reason: "x" },
    ]);
    const b = RuleKey.compute("agent", "device", [{ kind: "msgvault", access: "read" }]);
    expect(a).toBe(b);
  });

  it("rule key differs from other kinds", () => {
    const msgvault = RuleKey.compute("agent", "device", [{ kind: "msgvault", access: "read" }]);
    const credential = RuleKey.compute("agent", "device", [
      { kind: "credential", access: "metadata" },
    ]);
    expect(msgvault).not.toBe(credential);
  });
});
