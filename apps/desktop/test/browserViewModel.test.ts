/**
 * Approval card + audit grouping for browser/credential intents: the card
 * shows the enforceable origin list, credential item titles come only from
 * local resolution (spoof-resistant), and browser session events collapse
 * into one activity.
 */
import { describe, expect, it } from "vitest";
import { Intent, JSONValue, makeIntent } from "@domo/protocol";
import { approvalViewModel, auditActivities, CredentialTitles } from "../src/viewModel.js";

function browserIntent(): Intent {
  return makeIntent({
    agentId: "agent-1",
    agentDisplay: "Pizza Agent",
    agentPublicKey: "pk",
    deviceId: "device-1",
    goal: "Order a pizza",
    request: "browse: dominos.com, *.dominos.com",
    capabilities: [
      { kind: "browser", origins: ["dominos.com", "*.dominos.com"] },
      { kind: "credential", access: "fill", items: ["L1", "C1"] },
    ],
    sessionId: "s1",
  });
}

describe("approvalViewModel for browser intents", () => {
  it("sets the browser flags and origin list", () => {
    const vm = approvalViewModel(browserIntent());
    expect(vm.usesBrowser).toBe(true);
    expect(vm.fillsCredentials).toBe(true);
    expect(vm.origins).toEqual(["dominos.com", "*.dominos.com"]);
    expect(vm.runsCommand).toBe(false);
  });

  it("shows locally-resolved titles, and flags unresolvable ids", () => {
    const titles: CredentialTitles = new Map([["L1", { title: "Dominos", category: "LOGIN" }]]);
    const vm = approvalViewModel(browserIntent(), titles);
    const cred = vm.capabilities.find((c) => c.kind === "credential")!;
    expect(cred.display).toContain("'Dominos' (LOGIN)");
    expect(cred.display).toContain("C1 (unknown item)");
    expect(cred.display).toContain("values never leave this Mac");
    expect(vm.credentialItems).toEqual([
      { id: "L1", title: "Dominos", category: "LOGIN" },
      { id: "C1", title: null, category: null },
    ]);
  });

  it("without local resolution the display falls back to raw ids", () => {
    const vm = approvalViewModel(browserIntent());
    const cred = vm.capabilities.find((c) => c.kind === "credential")!;
    expect(cred.display).toContain("L1 (unknown item)");
  });
});

describe("audit grouping for browser sessions", () => {
  const events: JSONValue[] = [
    { event: "browser_session_opened", intentId: "i1", session: "S", origins: ["dominos.com"], ts: "2026-08-10T10:00:00Z" },
    { event: "browser_command", session: "S", action: "goto", url: "https://dominos.com/menu", ts: "2026-08-10T10:00:01Z" },
    { event: "browser_navigated", session: "S", url: "https://dominos.com/menu", ts: "2026-08-10T10:00:01Z" },
    { event: "browser_scope_violation", session: "S", action: "text", origin: "paypal.com", ts: "2026-08-10T10:00:02Z" },
    { event: "credential_filled", session: "S", item: "L1", field: "password", origin: "dominos.com", ts: "2026-08-10T10:00:03Z" },
    { event: "browser_session_closed", session: "S", reason: "agent", ts: "2026-08-10T10:00:04Z" },
  ];

  it("collapses one session into one activity (plus the opening intent's)", () => {
    const activities = auditActivities(events);
    // The opened event carries both ids, so it opens the intent activity AND
    // the browser:S activity, which the rest of the session's events share.
    const browser = activities.find((a) => a.id === "browser:S")!;
    expect(browser).toBeDefined();
    expect(browser.kind).toBe("browser");
    expect(browser.title).toContain("dominos.com/menu");
    expect(browser.status).toContain("scope blocks");
    expect(browser.timeline.length).toBe(6);
    expect(browser.timeline[0]!.text).toContain("Browser session opened");
    const violation = browser.timeline.find((s) => s.text.includes("paypal.com"))!;
    expect(violation.state).toBe("bad");
    const filled = browser.timeline.find((s) => s.text.includes("Credential typed"))!;
    expect(filled.text).toContain("L1");
    expect(filled.text).not.toContain("password: "); // never a value
  });

  it("a session ended by a crash reads as Crashed, not Closed or Browsing", () => {
    const acts = auditActivities([
      { event: "browser_command", session: "S", action: "goto", url: "https://dominos.com", ts: "2026-08-10T10:00:00Z" },
      { event: "browser_session_closed", session: "S", reason: "crashed", ts: "2026-08-10T10:00:05Z" },
    ]);
    expect(acts[0]!.status).toBe("Crashed");
    expect(acts[0]!.tone).toBe("red");
    expect(acts[0]!.category).toBe("failed");
  });

  it("a session-scoped metadata read stays with its session, not a row of its own", () => {
    const acts = auditActivities([
      { event: "browser_command", session: "S", action: "goto", url: "https://dominos.com", ts: "2026-08-10T10:00:00Z" },
      { event: "credential_metadata", session: "S", op: "list", ts: "2026-08-10T10:00:01Z" },
    ]);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.status).toBe("Browsing"); // the vault-read "Completed" is for sessionless reads
  });
});

describe("a failed credential fill is visible to the owner", () => {
  const events: JSONValue[] = [
    { event: "browser_session_opened", intentId: "i2", session: "T", origins: ["dominos.com"], ts: "2026-08-10T11:00:00Z" },
    { event: "browser_command", session: "T", action: "goto", url: "https://dominos.com/login", ts: "2026-08-10T11:00:01Z" },
    {
      event: "credential_fill_failed",
      session: "T",
      item: "L1",
      field: "password",
      selector: "#pass",
      origin: "dominos.com",
      reason: "the browser could not type it into that field",
      ts: "2026-08-10T11:00:02Z",
    },
  ];

  it("does not read as a healthy browsing session", () => {
    const browser = auditActivities(events).find((a) => a.id === "browser:T")!;
    // Green "Browsing" would tell the owner a credential went in when it did not.
    expect(browser.status).toBe("Fill failed");
    const line = browser.timeline.find((s) => s.text.includes("Credential not typed"))!;
    expect(line.state).toBe("bad");
    expect(line.text).toContain("L1");
    expect(line.text).toContain("#pass");
    expect(line.text).toContain("dominos.com");
    // ...and the Failed filter must show it, or the owner only finds it by luck.
    expect(browser.category).toBe("failed");
  });
});

describe("a page that would not keep a secret hidden is visible to the owner", () => {
  const events: JSONValue[] = [
    { event: "browser_session_opened", intentId: "i3", session: "M", origins: ["dominos.com"], ts: "2026-08-10T12:00:00Z" },
    { event: "browser_command", session: "M", action: "goto", url: "https://dominos.com/pay", ts: "2026-08-10T12:00:01Z" },
    {
      event: "credential_filled",
      session: "M",
      item: "C1",
      field: "number",
      origin: "dominos.com",
      ts: "2026-08-10T12:00:02Z",
    },
    {
      event: "credential_mask_failed",
      session: "M",
      action: "screenshot",
      url: "https://dominos.com/pay",
      ts: "2026-08-10T12:00:03Z",
    },
  ];

  it("does not read as a healthy browsing session", () => {
    const browser = auditActivities(events).find((a) => a.id === "browser:M")!;
    // Green "Browsing" would say all is well while a card number sits legible
    // on a page the agent is working in.
    expect(browser.status).toBe("Mask failed");
    expect(browser.category).toBe("failed");
    const line = browser.timeline.find((s) => s.text.includes("could not be kept hidden"))!;
    expect(line.state).toBe("bad");
    expect(line.text).toContain("dominos.com/pay");
    expect(line.text).toContain("screenshot");
    // The value itself is nowhere near any of this.
    expect(JSON.stringify(browser)).not.toContain("4111");
  });
});
