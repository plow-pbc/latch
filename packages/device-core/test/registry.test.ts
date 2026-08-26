/**
 * Which argv is a provider's, and which argv a provider refuses.
 *
 * The refusal is the security-relevant half: it runs before an intent exists
 * and again at the device, and what it catches are the hazards a human cannot
 * see by reading the command — the command itself looks legitimate.
 */
import { describe, expect, it } from "vitest";
import { needsToken, vendoredProvider, VENDORED_COMMANDS } from "../src/providers/registry.js";

const gog = vendoredProvider(["gog"])!;

describe("vendoredProvider", () => {
  it("matches a bare command name", () => {
    expect(vendoredProvider(["gog", "gmail", "search"])?.command).toBe("gog");
    expect(VENDORED_COMMANDS).toContain("gog");
  });

  it("does NOT match a path", () => {
    // The vendored binary is reached through the PATH this Mac controls.
    // Honouring a caller-supplied path would let an agent point the mint at a
    // binary of its choosing.
    for (const argv of [["/usr/local/bin/gog"], ["./gog"], ["../gog"]]) {
      expect(vendoredProvider(argv)).toBeNull();
    }
  });

  it("is null for an ordinary command, and for nothing at all", () => {
    expect(vendoredProvider(["ls", "-la"])).toBeNull();
    expect(vendoredProvider([])).toBeNull();
  });

  it("matches the NAME regardless of staging, so an unstaged one is refused rather than passed through", () => {
    // Returning null for an unstaged provider would let the command fall
    // through to the ordinary exec path and run whatever `gog` the owner
    // happens to have on their own PATH — unbelted, unrefused, against their
    // own credentials. The device turns this into a refusal instead.
    expect(vendoredProvider(["gog", "gmail", "search", "q"])?.command).toBe("gog");
  });
});

describe("the gog provider's refusal", () => {
  it("accepts an ordinary command", () => {
    expect(gog.refuse(["gog", "gmail", "search", "newer_than:7d", "--json"])).toBeNull();
  });

  it.each([
    ["a flag that would disarm the belt", ["gog", "gmail", "search", "q", "--wrap-untrusted=false"]],
    ["a flag that reads a local file into an outbound message", ["gog", "gmail", "send", "--body-file", "/etc/passwd"]],
    ["a flag that writes to a caller-chosen path", ["gog", "gmail", "attachment", "1", "2", "--out", "/tmp/x"]],
    ["a command the bundled binary does not have", ["gog", "gmail", "serach", "q"]],
    ["the dotted spelling of a real command", ["gog", "gmail.search", "q"]],
    ["a group, which prints help rather than acting", ["gog", "gmail", "drafts"]],
    ["a command outside the token's scopes", ["gog", "drive", "search", "q"]],
  ])("refuses %s", (_why, argv) => {
    expect(gog.refuse(argv)).not.toBeNull();
  });

  it("allows --help, which the skill tells the agent to run", () => {
    // A group is not a leaf, so without an explicit allowance the gate would
    // refuse the exact command the skill teaches. It is inert: gog prints
    // usage and exits, with no network call and nothing mutated.
    expect(gog.refuse(["gog", "gmail", "--help"])).toBeNull();
    expect(gog.refuse(["gog", "calendar", "-h"])).toBeNull();
  });

  it("still refuses a reserved flag hiding behind --help", () => {
    expect(gog.refuse(["gog", "gmail", "--help", "--home", "/tmp/evil"])).not.toBeNull();
  });

  it("never reports a spelling the caller chose", () => {
    // The reason reaches an error, the approval dialog and the audit log.
    const reason = gog.refuse(["gog", "gmail", "send", "--sneaky-agent-text-file", "/x"])!;
    expect(reason).not.toContain("sneaky-agent-text");
  });
});

describe("needsToken", () => {
  it("is false for a help invocation, which touches no network", () => {
    // Minting for it would spend a delegation that has left Plow whether or
    // not anything used it, on a command that cannot use one.
    expect(needsToken(["gog", "gmail", "--help"])).toBe(false);
    expect(needsToken(["gog", "calendar", "-h"])).toBe(false);
  });

  it("is true for anything that reaches Google", () => {
    expect(needsToken(["gog", "gmail", "search", "q"])).toBe(true);
  });
});
