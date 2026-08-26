/**
 * argv → the leaf a `gog.<leaf>` capability names.
 *
 * The check against the pinned binary's own command list is NOT an allowlist —
 * every Gmail/Calendar leaf gog ships is accepted. It is what stops a typo
 * from minting a live Google token and spending it on a usage error, which is
 * a failure mode plow hit for real when a tool description documented flags a
 * command did not have.
 */
import { describe, expect, it } from "vitest";
import { gogLeaf, GogArgvError, GOG_VERSION } from "../src/providers/gogLeaf.js";
import { GOG_LEAVES } from "../src/providers/gogLeaves.js";

describe("gogLeaf", () => {
  it("reads the command path, ignoring flags and their values", () => {
    expect(gogLeaf(["gmail", "search", "newer_than:7d", "--json"])).toBe("gmail.search");
    expect(gogLeaf(["calendar", "events", "primary", "--from", "2026-09-01T00:00:00Z"])).toBe("calendar.events");
  });

  it("reads a three-level path", () => {
    expect(gogLeaf(["gmail", "drafts", "create", "--to", "a@b.com"])).toBe("gmail.drafts.create");
  });

  it("does not let a positional argument be mistaken for a deeper command", () => {
    // The exact example leaf.ts cites when explaining the longest-prefix walk.
    // Deleted once as a duplicate; it is not one — the neighbour proves flags
    // end the path, this proves a POSITIONAL does not extend it.
    expect(gogLeaf(["gmail", "get", "18abcdef"])).toBe("gmail.get");
  });

  it("still accepts a positional that legitimately contains a dot", () => {
    // The dot-break changes how EVERY argv is walked, and real Gmail queries,
    // calendar ids and dates all carry dots. Behaviour-preserving today only
    // because no leaf segment contains a dot — which nothing else asserts.
    expect(gogLeaf(["gmail", "search", "from:a@b.com"])).toBe("gmail.search");
    expect(gogLeaf(["calendar", "events", "sam@odio.com"])).toBe("calendar.events");
    expect(gogLeaf(["calendar", "events", "primary", "--from", "2026-09-01T00:00:00Z"])).toBe(
      "calendar.events",
    );
  });


  // One table rather than six near-identical functions: same arrange, same
  // act, different input. A new refusal is a row.
  it.each([
    ["a typo", ["gmail", "serach", "x"]],
    // Running a group prints help rather than acting: it would mint a token,
    // produce nothing, and leave an audit record naming an action that never
    // happened.
    ["a group that is not itself a leaf", ["gmail", "drafts"]],
    // drive/docs/sheets 403 at Google — the token carries four scopes.
    ["a leaf outside the minted token's scopes", ["drive", "search", "x"]],
    ["empty argv", []],
    ["a global flag in front of the command path", ["--json", "gmail", "search", "x"]],
    // The dotted spelling is the LIKELIEST mistake: every agent-facing surface
    // shows the leaf dotted, so copying that name back into argv lands here.
    // It resolved before the walk stopped at a dotted word.
    ["the dotted spelling of a real leaf", ["gmail.search"]],
    ["a dotted tail after a real group", ["gmail", "drafts.create"]],
  ])("refuses %s", (_why, argv) => {
    expect(() => gogLeaf(argv)).toThrow(GogArgvError);
  });

  it("tells the reader the dotted spelling is the problem, not a typo", () => {
    // The message is the whole remedy for a mistake the agent will make from
    // reading our own capability names back.
    expect(() => gogLeaf(["gmail.search"])).toThrow(/separate words/);
  });

  it("names the pinned version in the refusal, so a pin bump is legible", () => {
    expect(() => gogLeaf(["gmail", "serach", "x"])).toThrow(/0\.36\.0/);
    expect(GOG_VERSION).toContain("0.36.0");
  });

  it("covers the leaves the product actually calls", () => {
    // The 21-day audit log's top verbs. If a pin bump renames one of these,
    // this fails here rather than in front of a user.
    for (const argv of [
      ["gmail", "search", "q"],
      ["gmail", "get", "1"],
      ["gmail", "send", "--to", "a@b.com"],
      ["gmail", "drafts", "reply", "1"],
      ["calendar", "events", "primary"],
      ["calendar", "create", "primary"],
      ["calendar", "freebusy", "primary"],
      ["calendar", "conflicts"],
    ]) {
      expect(() => gogLeaf(argv)).not.toThrow();
    }
  });
});

describe("the generated leaf list", () => {
  it("has no leaf that is a dotted prefix of another", () => {
    // Longest-prefix resolution is only unambiguous while this holds. If a pin
    // bump ships both `a.b` and `a.b.c`, then `a b <positional c>` resolves to
    // `a.b.c` while gog — which gets the argv verbatim — runs `a b`. The
    // capability, rule key, card and audit record would name a different
    // command than the one that executes, and they can differ in posture.
    // The generator refuses to write such a list; this fails if one is
    // hand-edited in.
    const shadowed = GOG_LEAVES.filter((a) => GOG_LEAVES.some((b) => b !== a && b.startsWith(`${a}.`)));
    expect(shadowed).toEqual([]);
  });

  it("has not been gutted to something that looks generated", () => {
    // The generator's FLOOR catches this at generation time, but the generator
    // is a manual step CI never runs — and a list truncated to the eight
    // leaves named above would otherwise pass every other test here while
    // refusing almost every real call.
    expect(GOG_LEAVES.length).toBeGreaterThanOrEqual(80); // 101 at 0.36.0
  });
});

