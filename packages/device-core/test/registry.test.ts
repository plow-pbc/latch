/**
 * Which argv is a provider's, and which argv a provider refuses.
 *
 * The refusal is the security-relevant half: it runs before an intent exists
 * and again at the device, and what it catches are the hazards a human cannot
 * see by reading the command — the command itself looks legitimate.
 */
import { describe, expect, it } from "vitest";
import { GOG_ALIASES, GOG_CANONICAL } from "../src/providers/gogGroups.js";
import {
  impliesNetwork,
  needsToken,
  PROVIDERS,
  vendoredProvider,
} from "../src/providers/registry.js";
import { overrideVar } from "../src/providers/vendoredBinary.js";

const gog = vendoredProvider(["gog"])!;

describe("vendoredProvider", () => {
  it("matches a bare command name", () => {
    expect(vendoredProvider(["gog", "gmail", "search"])?.command).toBe("gog");
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
    ["a flag that would disarm the belt", ["gog", "gmail", "search", "q", "--wrap-untrusted=false"], "--wrap-untrusted"],
    // Last-wins parsing means an appended one WIDENS the scope bound —
    // confirmed reaching Google — so it has to be unsupplyable like the rest.
    // An IN-SCOPE group, so the flag is the only thing refusing it — with an
    // out-of-scope one the row passes on branch ordering instead.
    ["a flag that would widen the scope bound", ["gog", "gmail", "search", "q", "--enable-commands=drive"], "--enable-commands"],
    ["a flag that reads a local file into an outbound message", ["gog", "gmail", "send", "--body-file", "/etc/passwd"], "a --*-file flag"],
    ["a flag that writes to a caller-chosen path", ["gog", "gmail", "attachment", "1", "2", "--out", "/tmp/x"], "a --out* flag"],
    // The check that refuses every wrong-command shape; the other branches
    // only change the sentence. `refuse`'s doc owns the account.
    // Each row pins WHICH sentence, not just that one came back. Collapsing
    // the spelling branches into the scope branch — restoring "told its scope
    // was wrong when its spelling was" — leaves a not-null assertion green.
    ["a group outside the token's scopes", ["gog", "drive", "search", "q"], "only Gmail and Calendar"],
    ["a group that does not exist", ["gog", "nonsense", "x"], "only Gmail and Calendar"],
    ["no group at all", ["gog"], "command is missing"],
    // The two mistakes the skill flags as likeliest, refused for DIFFERENT
    // reasons — see `refuse`'s doc. Each needs its own sentence.
    ["a leading global flag", ["gog", "--json", "gmail", "search", "q"], "before any flags"],
    ["the dotted spelling", ["gog", "gmail.search", "q"], "separate words"],
  ])("refuses %s", (_why, argv, expected) => {
    expect(gog.refuse(argv)).toContain(expected);
  });

  it("leaves gog's own usage errors to gog", () => {
    // gog reports these better than a mirrored command list can — "unexpected
    // argument serach, did you mean \"search\"?" — and reports them LOCALLY,
    // without reaching Google. Mirroring its command grammar bought a worse
    // message for a case gog already handles; `refuse`'s doc has the cost.
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

  it("names the rule, never the caller's argv", () => {
    // These reach the approval dialog and the append-only audit log, so the
    // same rule gogFlags follows applies here.
    for (const argv of [
      ["gog", "--sneaky-agent-text", "gmail", "search"],
      ["gog", "sneaky.agent.text", "q"],
      ["gog", "sneakyagenttext", "q"],
    ]) {
      expect(gog.refuse(argv)).not.toContain("sneaky");
    }
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
    // This PRINTS USAGE — kong takes --help wherever it appears in the flag
    // stream. So the gate accepts it as a real command and it gets a token it
    // will not use. Fail-safe, and the cost is a spent delegation rather than
    // an unauthenticated run.
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

describe("overrideVar", () => {
  it("folds what a shell cannot export", () => {
    // A name Node reads back through process.env[...] perfectly well and no
    // shell can `export`, so an unfolded one fails for the human only — and
    // only on the second provider, which is the whole failure this prevents.
    expect(overrideVar("gog")).toBe("DOMO_GOG");
    expect(overrideVar("gh-cli")).toBe("DOMO_GH_CLI");
    expect(overrideVar("gh.cli")).toBe("DOMO_GH_CLI");
  });

  it("stays unique across PROVIDERS, because the fold is not injective", () => {
    // Those last two collide on purpose. Two rows differing only in
    // punctuation would silently share one override: the resolver returns a
    // path, just the wrong one.
    const names = PROVIDERS.map((p) => overrideVar(p.command));
    expect(new Set(names).size).toBe(PROVIDERS.length);
  });
});

describe("impliesNetwork", () => {
  // Decides two things in two packages — the capability `mcp-server` builds,
  // and through `Executor.isReapable` whether the run escapes the silent-run
  // reaper. Spelled twice, one copy dropped the provider gate inside a single
  // commit and approved network for `/bin/echo`.
  it.each([
    [["gog", "gmail", "search", "q"], true],
    [["gog", "--help"], false],
    [["gog", "gmail", "-h"], false],
    // TRAILING only, which is the subtlety both the agent-facing sentence and
    // `Executor.isReapable` now rest on: --help anywhere else is a real
    // invocation, and this one runs a search.
    [["gog", "gmail", "search", "--help", "q"], true],
    [["gog", "gmail", "search", "--", "-h"], true],
    [["gog"], true],
    [["/bin/echo", "x"], false],
    [["/usr/local/bin/gog", "gmail", "search"], false],
    [[], false],
  ])("%j implies network: %s", (argv, expected) => {
    expect(impliesNetwork(argv)).toBe(expected);
  });
});

describe("the scope bound", () => {
  // gog enforces this ITSELF, before any network call. `refuse` still checks
  // the group because it does so before the dialog and the mint; this is the
  // layer beneath it. Per-version verdicts: step 5 of the checklist in
  // `scripts/fetch-gog.mjs`.
  // Across the interpolation seam: the page an agent reads is built from the
  // same list, so an empty or doubled substitution shows up here rather than
  // in someone's transcript.
  it("is the same bound on the page the agent reads", () => {
    const bound = `--enable-commands=${[...GOG_CANONICAL].join(",")}`;
    expect(gog.belt).toContain(bound);
    // EVERY occurrence, not any: the page names it more than once, and
    // `toContain` passes while one of them says something else.
    const named = gog.skill.body.match(/--enable-commands=[^`\s]*/g) ?? [];
    // Every naming agrees, and there is at least one: an empty match set
    // fails this too, since `[]` is not `[bound]`.
    expect([...new Set(named)]).toEqual([bound]);
  });

  it("rides the belt, and names exactly the canonical groups", () => {
    const bound = gog.belt.find((f) => f.startsWith("--enable-commands="));
    expect(bound).toBeDefined();
    const named = bound!.slice("--enable-commands=".length).split(",");
    // The derivation itself. Asserting only that each name is one `refuse`
    // accepts cannot fail — `GOG_GROUPS` is a superset of `GOG_CANONICAL` by
    // construction — so it has to be equality against the list the bound is
    // built from, which a hand-written string can drift away from.
    expect(named).toEqual([...GOG_CANONICAL]);
    // ...and no alias, for ANY of them: gog resolves its own, so sending one
    // asks it to do that twice.
    for (const alias of GOG_ALIASES) expect(named).not.toContain(alias);
  });

  // gog answers to `gog gmail (mail,email)` and `gog calendar (cal)`. Refusing
  // those said a Gmail command was out of scope. Which spellings dispatch is a
  // per-version fact; step 5 of the checklist owns it.
  it.each([["mail"], ["email"], ["cal"]])("accepts the alias %s", (group) => {
    expect(gog.refuse(["gog", group, "search", "q"])).toBeNull();
  });
});
