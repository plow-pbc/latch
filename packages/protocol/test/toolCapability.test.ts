/**
 * The `tool` capability's enforceable bound.
 *
 * A capability that names only an action ("may send Slack messages") is a rule
 * the owner cannot judge and an approval that never runs out: one "always
 * allow" would authorise every channel in every workspace, forever. So the
 * TARGET is part of the capability — and therefore part of the rule key and of
 * the sentence in the dialog — while the content stays in the payload, exactly
 * as an fs.write approves a path and not the bytes.
 */
import { describe, expect, it } from "vitest";
import { Capability, capabilityDisplay, RuleKey } from "../src/index.js";

const send = (target: string): Capability[] => [
  { kind: "tool", tool: "slack.messages.send", target },
];
const key = (caps: Capability[]) => RuleKey.compute("agent-1", "device-1", caps);

describe("tool capabilities", () => {
  it("names the target it acts on, so the dialog says what is being authorised", () => {
    expect(capabilityDisplay(send("T01234/C0123ABCD")[0])).toBe(
      "Tool: slack.messages.send in T01234/C0123ABCD",
    );
    // Nothing to name is said as nothing, never as a scope.
    expect(capabilityDisplay({ kind: "tool", tool: "slack.status" })).toBe("Tool: slack.status");
  });

  it("keys a rule to the target: another channel is another rule", () => {
    expect(key(send("T1/C1"))).toBe(key(send("T1/C1")));
    expect(key(send("T1/C2"))).not.toBe(key(send("T1/C1")));
    expect(key(send("T2/C1"))).not.toBe(key(send("T1/C1")));
    // An untargeted capability is not the same rule as a targeted one.
    expect(key([{ kind: "tool", tool: "slack.messages.send" }])).not.toBe(key(send("T1/C1")));
  });

  it("ignores display-only text, as every other kind does", () => {
    expect(key([{ ...send("T1/C1")[0], reason: "because I said so" }])).toBe(key(send("T1/C1")));
  });
});
