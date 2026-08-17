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
    // The opened event carries an intentId so it groups as the intent activity;
    // everything else shares the browser:S activity.
    const browser = activities.find((a) => a.id === "browser:S")!;
    expect(browser).toBeDefined();
    expect(browser.kind).toBe("browser");
    expect(browser.title).toContain("dominos.com/menu");
    expect(browser.status).toContain("scope blocks");
    expect(browser.timeline.length).toBe(5);
    const violation = browser.timeline.find((s) => s.text.includes("paypal.com"))!;
    expect(violation.state).toBe("bad");
    const filled = browser.timeline.find((s) => s.text.includes("Credential typed"))!;
    expect(filled.text).toContain("L1");
    expect(filled.text).not.toContain("password: "); // never a value
  });
});
