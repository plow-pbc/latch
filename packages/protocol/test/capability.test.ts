/**
 * Apple events capability kind. This kind is an additive protocol extension:
 * the frozen fixtures don't exercise it, so the invariants (display, rule-key
 * determinism) are pinned here instead.
 */
import { describe, expect, it } from "vitest";
import { Capability, RuleKey, capabilityDisplay } from "@domo/protocol";

describe("capabilityDisplay", () => {
  it("displays apple_events", () => {
    expect(capabilityDisplay({ kind: "apple_events", allowed: true }))
      .toBe("Apple events: may control this Mac's apps");
  });
});

describe("apple_events capability rule key", () => {
  it("adding apple_events changes the rule key", () => {
    const base: Capability[] = [
      { kind: "process.exec", argv: ["/usr/bin/osascript", "-e", "x"] },
      { kind: "network", allowed: false },
    ];
    expect(
      RuleKey.compute("a", "d", [...base, { kind: "apple_events", allowed: true }]),
    ).not.toBe(RuleKey.compute("a", "d", base));
  });
});
