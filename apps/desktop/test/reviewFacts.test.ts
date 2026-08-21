/**
 * A credential fill used to be reviewed on opaque vault ids alone — a decision
 * about whether to type `bxk3…` into a page nobody had described. Everything
 * that makes that answerable is knowable on this Mac and nowhere in the
 * agent's request, so this is what the device establishes before asking.
 *
 * No display, no vault, no browser: the two device lookups are injected.
 */
import { describe, expect, it } from "vitest";
import { Capability, Intent, makeIntent } from "@domo/protocol";
import type { BrowserSessionInfo, CredentialItemSummary } from "@domo/device-core";
import { credentialFillFacts } from "../src/reviewFacts.js";

function intent(capabilities: Capability[]): Intent {
  return makeIntent({
    agentId: "agent-1",
    agentDisplay: "Agent One",
    deviceId: "device-1",
    request: "widen browser session — fill credentials: bxk3",
    capabilities,
    sessionId: "s1",
  });
}

const FILL: Capability[] = [
  { kind: "browser", origins: ["chase.com"] },
  { kind: "credential", access: "fill", items: ["bxk3"] },
];

const SESSION: BrowserSessionInfo = {
  origins: ["chase.com", "example.com"],
  agentId: "agent-1",
  lastUrl: "https://chase.com/login",
  inScope: true,
};

function item(over: Partial<CredentialItemSummary> = {}): CredentialItemSummary {
  return {
    id: "bxk3",
    title: "Chase",
    category: "LOGIN",
    username: "someone",
    urls: ["https://chase.com"],
    matchesThisPage: true,
    ...over,
  };
}

describe("credentialFillFacts", () => {
  it("says nothing about an operation that fills no credentials", async () => {
    const facts = await credentialFillFacts(
      intent([{ kind: "fs.read", paths: ["/tmp/x"] }]),
      { session: "h" },
      { session: () => SESSION, vault: async () => [item()] },
    );
    expect(facts).toEqual([]);
  });

  it("names the session's approved origins, its page, and the item's category and site match", async () => {
    const facts = await credentialFillFacts(
      intent(FILL),
      { session: "h" },
      { session: () => SESSION, vault: async () => [item()] },
    );
    expect(facts.join("\n")).toContain("already approved for: chase.com, example.com");
    expect(facts.join("\n")).toContain("https://chase.com/login");
    expect(facts.join("\n")).toContain('vault item bxk3 is "Chase", category LOGIN');
    expect(facts.join("\n")).toContain("lists the current page as one of its own sites");
  });

  /** The case the reviewer most needs told: this item is not this site's. */
  it("says so, and names the sites it IS for, when the item does not match the page", async () => {
    const facts = await credentialFillFacts(
      intent(FILL),
      { session: "h" },
      {
        session: () => SESSION,
        vault: async () => [item({ matchesThisPage: false, urls: ["https://bank.example"] })],
      },
    );
    expect(facts.join("\n")).toContain("does NOT list the current page");
    expect(facts.join("\n")).toContain("https://bank.example");
  });

  it("reports an id the vault does not hold as exactly that", async () => {
    const facts = await credentialFillFacts(
      intent(FILL),
      { session: "h" },
      { session: () => SESSION, vault: async () => [] },
    );
    expect(facts.join("\n")).toContain("vault item bxk3 is not in this vault");
  });

  /**
   * A gap said out loud. Left out, a missing answer looks exactly like "no
   * problem found" — the one misreading that would turn not knowing into a
   * reason to allow.
   */
  it("calls an unanswered vault UNRESOLVED rather than letting silence read as a match", async () => {
    const facts = await credentialFillFacts(
      intent(FILL),
      { session: "h" },
      { session: () => SESSION, vault: () => new Promise(() => {}), timeoutMs: 5 },
    );
    expect(facts.join("\n")).toContain("did not answer in time");
    expect(facts.join("\n")).toContain("UNRESOLVED");
  });

  it("says the vault could not be read when it throws", async () => {
    const facts = await credentialFillFacts(
      intent(FILL),
      { session: "h" },
      { session: () => SESSION, vault: async () => { throw new Error("locked"); } },
    );
    expect(facts.join("\n")).toContain("could not be read");
    expect(facts.join("\n")).toContain("UNRESOLVED");
  });

  it("says there is no page to match against before the session has opened one", async () => {
    const facts = await credentialFillFacts(
      intent(FILL),
      { session: "h" },
      { session: () => ({ ...SESSION, lastUrl: "" }), vault: async () => [item()] },
    );
    expect(facts.join("\n")).toContain("has not opened a page yet");
    expect(facts.join("\n")).toContain("no open page to match it against");
  });

  it("reports an unidentifiable session rather than describing some other one", async () => {
    const facts = await credentialFillFacts(
      intent(FILL),
      { session: "gone" },
      { session: () => null, vault: async () => [item()] },
    );
    expect(facts.join("\n")).toContain("could not identify the browser session");
  });

  /** The handle drives the browser. It goes in; it never comes back out. */
  it("never repeats the session handle back", async () => {
    const facts = await credentialFillFacts(
      intent(FILL),
      { session: "handle-is-a-capability" },
      { session: () => SESSION, vault: async () => [item()] },
    );
    expect(facts.join("\n")).not.toContain("handle-is-a-capability");
  });
});
