/**
 * Browser/credential capability kinds and origin matching. These kinds are an
 * additive protocol extension: the frozen fixtures never exercise them, so the
 * invariants (normalization sorting, display, rule-key determinism) are pinned
 * here instead.
 */
import { describe, expect, it } from "vitest";
import {
  Capability,
  RuleKey,
  capabilityDisplay,
  normalizeOrigin,
  normalizedCapability,
  originMatches,
} from "@domo/protocol";

describe("normalizeOrigin", () => {
  it("lowercases and strips scheme, port, path, trailing dot", () => {
    expect(normalizeOrigin("HTTPS://WWW.Dominos.COM:443/menu?x=1#f")).toBe("www.dominos.com");
    expect(normalizeOrigin("dominos.com.")).toBe("dominos.com");
    expect(normalizeOrigin("  Example.org ")).toBe("example.org");
  });

  it("preserves the wildcard prefix", () => {
    expect(normalizeOrigin("*.Dominos.com")).toBe("*.dominos.com");
    expect(normalizeOrigin("*.dominos.com:8080")).toBe("*.dominos.com");
  });
});

describe("originMatches", () => {
  const patterns = ["dominos.com", "*.dominos.com"];

  it("exact pattern matches the apex only", () => {
    expect(originMatches("dominos.com", ["dominos.com"])).toBe(true);
    expect(originMatches("www.dominos.com", ["dominos.com"])).toBe(false);
  });

  it("wildcard matches proper subdomains only", () => {
    expect(originMatches("www.dominos.com", ["*.dominos.com"])).toBe(true);
    expect(originMatches("a.b.dominos.com", ["*.dominos.com"])).toBe(true);
    expect(originMatches("dominos.com", ["*.dominos.com"])).toBe(false);
  });

  it("suffix tricks do not match", () => {
    expect(originMatches("evildominos.com", patterns)).toBe(false);
    expect(originMatches("dominos.com.evil.net", patterns)).toBe(false);
    expect(originMatches("paypal.com", patterns)).toBe(false);
  });

  it("is case-insensitive and ignores ports on the host", () => {
    expect(originMatches("WWW.DOMINOS.COM", patterns)).toBe(true);
    expect(originMatches("www.dominos.com:443", patterns)).toBe(true);
  });

  it("empty host and bare wildcard never match", () => {
    expect(originMatches("", patterns)).toBe(false);
    expect(originMatches("anything.com", ["*."])).toBe(false);
  });
});

describe("browser/credential capability normalization", () => {
  it("sorts and lowercases origins; sorts items; strips reason", () => {
    const cap: Capability = {
      kind: "browser",
      origins: ["*.Dominos.com", "dominos.com", "API.dominos.com"],
      reason: "order pizza",
    };
    expect(normalizedCapability(cap)).toEqual({
      kind: "browser",
      origins: ["*.dominos.com", "api.dominos.com", "dominos.com"],
    });

    const cred: Capability = { kind: "credential", access: "fill", items: ["z9", "a1"], reason: "pay" };
    expect(normalizedCapability(cred)).toEqual({ kind: "credential", access: "fill", items: ["a1", "z9"] });
  });

  it("rule keys are invariant under origin/item order and case, and reason", () => {
    const a = RuleKey.compute("agent", "device", [
      { kind: "browser", origins: ["*.dominos.com", "Dominos.com"], reason: "x" },
      { kind: "credential", access: "fill", items: ["b", "a"] },
    ]);
    const b = RuleKey.compute("agent", "device", [
      { kind: "credential", access: "fill", items: ["a", "b"], reason: "y" },
      { kind: "browser", origins: ["dominos.com", "*.DOMINOS.COM"] },
    ]);
    expect(a).toBe(b);
  });

  it("rule keys differ when the enforceable bound differs", () => {
    const base = RuleKey.compute("agent", "device", [{ kind: "browser", origins: ["dominos.com"] }]);
    const wider = RuleKey.compute("agent", "device", [
      { kind: "browser", origins: ["dominos.com", "paypal.com"] },
    ]);
    const fill = RuleKey.compute("agent", "device", [
      { kind: "credential", access: "fill", items: ["a"] },
    ]);
    const otherItem = RuleKey.compute("agent", "device", [
      { kind: "credential", access: "fill", items: ["b"] },
    ]);
    expect(new Set([base, wider, fill, otherItem]).size).toBe(4);
  });
});

describe("capabilityDisplay", () => {
  it("browser shows the origin list", () => {
    expect(capabilityDisplay({ kind: "browser", origins: ["*.dominos.com", "dominos.com"] })).toBe(
      "Browse: *.dominos.com, dominos.com",
    );
  });

  it("credential names the items it may fill", () => {
    expect(capabilityDisplay({ kind: "credential", access: "fill", items: ["a1", "b2"] })).toBe(
      "Credentials: fill a1, b2 into approved sites (typed on this Mac; the agent can see the page it types into)",
    );
  });

  // rules.json can still hold a credential rule saved before the metadata
  // capability was removed. It grants nothing, and the owner reviewing stored
  // grants must not read it as a fill grant they never gave.
  it("a credential rule that is not a fill says it grants nothing", () => {
    expect(capabilityDisplay({ kind: "credential", items: [] })).toBe(
      "Credentials: a shape no longer requested (grants nothing)",
    );
  });

  // rules.json is parsed and cast without validation, so a stored kind can sit
  // outside the union. Its slug beats `undefined` on the revoke screen.
  it("an out-of-union kind renders its own slug", () => {
    expect(capabilityDisplay({ kind: "mail.send" } as unknown as Capability)).toBe("mail.send");
  });
});
