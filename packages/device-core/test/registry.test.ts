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
    // The one command check this Mac makes. An out-of-scope group is the case
    // that SPENDS the token — verified: `gog drive search x` reaches Google
    // and returns 401, while every in-group usage mistake fails locally.
    ["a group outside the token's scopes", ["gog", "drive", "search", "q"]],
    ["a group that does not exist", ["gog", "nonsense", "x"]],
    ["no group at all", ["gog"]],
  ])("refuses %s", (_why, argv) => {
    expect(gog.refuse(argv)).not.toBeNull();
  });

  it("leaves gog's own usage errors to gog", () => {
    // gog reports these better than a mirrored command list can — "unexpected
    // argument serach, did you mean \"search\"?" — and reports them LOCALLY,
    // with no network call and nothing spent. Mirroring its command grammar
    // bought a worse message for a case that costs nothing.
    for (const argv of [
      ["gog", "gmail", "serach", "q"],
      ["gog", "gmail", "drafts"],
      ["gog", "calendar", "nonsense"],
    ]) {
      expect(gog.refuse(argv)).toBeNull();
    }
  });

  it("allows --help, which the skill tells the agent to run", () => {
    expect(gog.refuse(["gog", "gmail", "--help"])).toBeNull();
    expect(gog.refuse(["gog", "--help"])).toBeNull();
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

  // Two predicates drifted apart once, so both are driven from the same rows.
  // Sameness held by convention is what produced that gap.
  it.each([
    { argv: ["gog", "gmail", "search", "q"], refused: false, token: true },
    { argv: ["gog", "gmail", "--help"], refused: false, token: false },
    { argv: ["gog", "calendar", "-h"], refused: false, token: false },
    // Top level: as inert as any group help, and the first thing an agent
    // discovering the surface tries.
    { argv: ["gog", "--help"], refused: false, token: false },
    // Verified against pinned 0.36.0: this PRINTS USAGE — kong takes --help
    // wherever it appears in the flag stream. So the gate accepts it as a real
    // command and it gets a token it will not use. Fail-safe, and the cost is
    // a spent delegation rather than an unauthenticated run.
    { argv: ["gog", "gmail", "search", "--help", "q"], refused: false, token: true },
    // After the terminator, -h is a positional — the query itself — so this is
    // a real search and correctly needs a token. The help predicate requires
    // the words before it to be plain, which "--" is not.
    { argv: ["gog", "gmail", "search", "--", "-h"], refused: false, token: true },
    // needsToken is only ever consulted after refuse passes, so these carry
    // the real value rather than one the guard below hides: an unknown path
    // is not a help invocation, so both are true.
    { argv: ["gog", "drive", "search", "q"], refused: true, token: true },
  ])("gate and mint agree on $argv", ({ argv, refused, token }) => {
    expect(gog.refuse(argv) !== null).toBe(refused);
    // Total, not guarded: a row that states the opposite of the truth is the
    // claims-more-than-the-code shape, in the one place a reader looks for the
    // contract.
    expect(needsToken(argv)).toBe(token);
  });
});
