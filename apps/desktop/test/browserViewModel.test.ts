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
    // The card must not promise more than the browser keeps: the value is typed
    // here, and the agent driving that page can read it back.
    expect(cred.display).toContain("typed on this Mac");
    expect(cred.display).not.toContain("never leave");
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
    { event: "intent_received", intentId: "i1", agent: "313", agent_name: "Daniel's Test", request: "browse: dominos.com", goal: "Order dinner", capabilities: ["Browse: dominos.com"], ts: "2026-08-10T09:59:58Z" },
    { event: "intent_decision", intentId: "i1", decision: "allow_once", source: "approve", ts: "2026-08-10T09:59:59Z" },
    { event: "browser_session_opened", intentId: "i1", session: "S", origins: ["dominos.com"], ts: "2026-08-10T10:00:00Z" },
    { event: "browser_command", session: "S", action: "goto", url: "https://dominos.com/menu", ts: "2026-08-10T10:00:01Z" },
    { event: "browser_navigated", session: "S", url: "https://dominos.com/menu", ts: "2026-08-10T10:00:01Z" },
    { event: "browser_scope_violation", session: "S", action: "text", origin: "paypal.com", ts: "2026-08-10T10:00:02Z" },
    { event: "credential_filled", session: "S", item: "L1", field: "password", origin: "dominos.com", ts: "2026-08-10T10:00:03Z" },
    // The agent came back for more, and got it: this widening is part of what
    // the session was allowed to do.
    { event: "intent_received", intentId: "i2", agent: "313", agent_name: "Daniel's Test", request: "widen to paypal.com", capabilities: ["Browse: paypal.com", "Credentials: fill L1 into approved sites"], ts: "2026-08-10T10:00:04Z" },
    { event: "intent_decision", intentId: "i2", decision: "allow_once", source: "approve", ts: "2026-08-10T10:00:05Z" },
    { event: "browser_session_extended", intentId: "i2", session: "S", origins: ["paypal.com"], items: ["L1"], ts: "2026-08-10T10:00:06Z" },
    // Sessions land back on the blank staging page; it is not where they went.
    { event: "browser_navigated", session: "S", url: "about:blank", ts: "2026-08-10T10:00:06Z" },
    { event: "browser_session_closed", session: "S", reason: "agent", ts: "2026-08-10T10:00:07Z" },
  ];

  it("the session row says who drove the browser and everything they were allowed", () => {
    // The reported bug, in one assertion set: the row that named the agent held
    // no browsing and the row that held the browsing named nobody, so neither
    // answered "was my browser used, and by whom". The session row now carries
    // the request that authorised it — including every later widening, whose
    // added origins and credential grants are otherwise invisible here and
    // understate the session's real bound.
    const browser = auditActivities(events).find((a) => a.id === "browser:S")!;
    expect(browser.agentId).toBe("313");
    expect(browser.agentDisplay).toBe("Daniel's Test");
    expect(browser.goal).toBe("Order dinner");
    expect(browser.capabilities).toEqual([
      "Browse: dominos.com",
      "Browse: paypal.com",
      "Credentials: fill L1 into approved sites",
    ]);
    // Titled by where it actually went, never by the blank staging page it
    // ends on — which titled real sessions "Browsing — about:blank".
    expect(browser.title).toBe("Browsing — https://dominos.com/menu");
    // The widening is in the session's own story, not only the intent's.
    expect(browser.timeline.some((t) => t.text.startsWith("Session widened"))).toBe(true);
    // The cage refused it something, so the Failed filter must hold it.
    expect(browser.category).toBe("failed");
    // The decision stays on the intent row: copying it in would outrank the
    // browser branch and replace the live status with "Allowed once".
    expect(browser.status).toBe("Closed · scope blocks");
  });

  it("collapses one session into one activity (plus the opening intent's)", () => {
    const activities = auditActivities(events);
    // The opened event carries both ids, so it opens the intent activity AND
    // the browser:S activity, which the rest of the session's events share.
    const browser = activities.find((a) => a.id === "browser:S")!;
    expect(browser).toBeDefined();
    expect(browser.kind).toBe("browser");
    expect(browser.title).toContain("dominos.com/menu");
    expect(browser.status).toContain("scope blocks");
    expect(browser.timeline.length).toBe(10);
    // The request that authorised the session opens its story.
    expect(browser.timeline[0]!.text).toContain("Request: browse: dominos.com");
    expect(browser.timeline[1]!.text).toContain("Browser session opened");
    const violation = browser.timeline.find((s) => s.text.includes("paypal.com"))!;
    expect(violation.state).toBe("bad");
    const filled = browser.timeline.find((s) => s.text.includes("Credential typed"))!;
    expect(filled.text).toContain("L1");
    expect(filled.text).not.toContain("password: "); // never a value
  });

  // The reported bug's owner half: a session where every action returned ok
  // while the site answered 429 was green in the pane, so the one place the
  // refusals were recorded never showed them. Both while it is still open —
  // the case the pane is watched for — and after it closes.
  it.each([
    { when: "still open", close: [], status: "Requests refused", closeText: null },
    {
      when: "closed",
      // What the browser had not reported yet is drained onto the closing
      // line, which is what the device half of this branch exists to
      // guarantee; this is the only place a human ever sees it.
      close: [{ event: "browser_session_closed", session: "S", reason: "agent", failed_requests: [
        { status: 503, method: "GET", origin: "https://costco.com" },
      ], ts: "2026-08-10T10:00:05Z" }],
      status: "Closed · requests refused",
      closeText: "Browser session closed (agent) — refused: 503 GET https://costco.com",
    },
  ])("a session whose page was refused reads as failed while $when, and says by whom", ({ close, status, closeText }) => {
    const browser = auditActivities([
      { event: "browser_command", session: "S", action: "click", url: "https://costco.com/cart", failed_requests: [
        { status: 429, method: "POST", origin: "https://costco.com" },
        { status: 403, method: "GET", origin: "https://cdn.costco.com" },
      ], ts: "2026-08-10T10:00:00Z" },
      ...close,
    ]).find((a) => a.id === "browser:S")!;
    expect(browser.status).toBe(status);
    expect(browser.tone).toBe("amber");
    expect(browser.category).toBe("failed");
    const cmd = browser.timeline.find((t) => t.text.startsWith("Browser: click"))!;
    expect(cmd.text).toContain("429 POST https://costco.com");
    expect(cmd.text).toContain("(+1 more)");
    expect(cmd.state).toBe("bad");
    if (closeText !== null) {
      const closeRow = browser.timeline.find((t) => t.text.includes("session closed"))!;
      expect(closeRow.text).toBe(closeText);
      expect(closeRow.state).toBe("bad");
    }
  });

  // How a session's close reads, from both ends of the same verdict. A crash
  // outranks what the session accumulated before it, so the badge is not the
  // milder "Closed · scope blocks" this session also earned — and the parting
  // refusals drained onto the crash line do not soften it either. An ordinary
  // close is the inverse, and it is the row that keeps every other row honest:
  // without it, marking every close bad would go unnoticed.
  it.each([
    {
      when: "a crash with a parting refusal", reason: "crashed", scopeViolation: true,
      failed_requests: [{ status: 599, method: "GET", origin: "https://dominos.com" }],
      status: "Crashed", tone: "red", category: "failed", closeState: "bad",
      closeText: "Browser session closed (crashed) — refused: 599 GET https://dominos.com",
    },
    {
      when: "a crash with nothing left to say", reason: "crashed", scopeViolation: true, failed_requests: [],
      status: "Crashed", tone: "red", category: "failed", closeState: "bad",
      closeText: "Browser session closed (crashed)",
    },
    {
      when: "an ordinary close", reason: "agent", scopeViolation: false, failed_requests: [],
      status: "Closed", tone: "zinc", category: "other", closeState: "neutral",
      closeText: "Browser session closed (agent)",
    },
  ])("$when reads as $status", ({ reason, scopeViolation, failed_requests, status, tone, category, closeState, closeText }) => {
    const acts = auditActivities([
      { event: "browser_command", session: "S", action: "goto", url: "https://dominos.com", ts: "2026-08-10T10:00:00Z" },
      ...(scopeViolation
        ? [{ event: "browser_scope_violation", session: "S", action: "text", origin: "paypal.com", ts: "2026-08-10T10:00:01Z" }]
        : []),
      { event: "browser_session_closed", session: "S", reason, failed_requests, ts: "2026-08-10T10:00:05Z" },
    ]);
    expect(acts[0]!.status).toBe(status);
    expect(acts[0]!.tone).toBe(tone);
    // The bucket, not only the badge: they disagreed once already, and the
    // bucket is what an owner scanning for trouble actually filters on.
    expect(acts[0]!.category).toBe(category);
    const closeRow = acts[0]!.timeline.find((t) => t.text.includes("session closed"))!;
    expect(closeRow.state).toBe(closeState);
    // Which makes each row's name a claim the test reads: the parting refusal
    // is on the line, or there was nothing to put there.
    expect(closeRow.text).toBe(closeText);
  });

  it.each([
    // The open arm is the one the pane is watched for: the agent is still
    // working, and this is where the owner learns their sign-ins are gone.
    { when: "still open", close: [] as Record<string, unknown>[], status: "Started over" },
    {
      when: "closed",
      close: [{ event: "browser_session_closed", session: "S", reason: "agent", ts: "2026-08-10T10:00:09Z" }],
      status: "Closed · started over",
    },
    // And it stays under a refusal: the cage stopping the agent outranks the
    // agent deciding to start over. Unpinned, that order drifts back silently.
    {
      when: "outranked by a scope block",
      close: [{ event: "browser_scope_violation", session: "S", action: "text", origin: "paypal.com", ts: "2026-08-10T10:00:04Z" }],
      status: "Scope blocked",
    },
  ])("a session that threw its profile away does not read as ordinary browsing ($when)", ({ close, status }) => {
    // Sign-ins the owner does not get back, same as a failed merge — on
    // purpose rather than by accident, but they filter on the outcome. Green
    // here would hide the one destructive thing a session does on its own
    // authority, and the raw event token is what the row renders without a
    // case for it, which nothing else would notice.
    const acts = auditActivities([
      { event: "browser_session_opened", session: "S", origins: ["costco.com"], ts: "2026-08-10T10:00:00Z" },
      { event: "browser_profile_reset", session: "S", origins: ["costco.com"], ts: "2026-08-10T10:00:03Z" },
      ...close,
    ]);
    expect(acts[0]!.status).toBe(status);
    expect(acts[0]!.tone).toBe("amber");
    expect(acts[0]!.category).toBe("failed");
    const row = acts[0]!.timeline.find((t) => t.text.includes("started over"))!;
    expect(row.text).toBe(
      "Browser started over on an empty profile — costco.com — signed out, and nothing it does now is saved.",
    );
    expect(row.state).toBe("bad");
  });

  it("a browser death stands beside the session it took down, not inside it", () => {
    // What production writes when a browser dies under a live session: the
    // session closes as crashed, and BrowserHost separately audits the death
    // with only a code — no session, no intent — so it can join nothing. Both
    // rows are the owner's, and the crash is not absorbed into the session's.
    const acts = auditActivities([
      { event: "browser_command", session: "S", action: "goto", url: "https://dominos.com", ts: "2026-08-10T10:00:00Z" },
      { event: "browser_crashed", code: 9, ts: "2026-08-10T10:00:05Z" },
      { event: "browser_session_closed", session: "S", reason: "crashed", failed_requests: [], ts: "2026-08-10T10:00:05Z" },
    ]);
    expect(acts.map((a) => a.id).sort()).toEqual(["browser:S", "browser_crashed:1"]);
    const crash = acts.find((a) => a.id === "browser_crashed:1")!;
    expect(crash.status).toBe("Crashed");
    expect(crash.tone).toBe("red");
    expect(crash.category).toBe("failed");
    // The code is the only thing the host has to say about how it died.
    expect(crash.timeline[0]!.text).toBe("Browser crashed (code 9)");
    expect(crash.timeline[0]!.state).toBe("bad");
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

// Two ways a credential can go wrong in front of the owner: one that could not
// be typed, and one that was typed into a page that would not keep it hidden.
// Both must read as failures rather than as a healthy browsing session.
describe.each([
  {
    what: "a fill that could not be typed",
    event: {
      event: "credential_fill_failed",
      session: "T",
      item: "L1",
      field: "password",
      selector: "#pass",
      origin: "dominos.com",
      reason: "the browser could not type it into that field",
      ts: "2026-08-10T11:00:02Z",
    } as JSONValue,
    status: "Fill failed",
    says: "Credential fill failed",
    mentions: ["L1", "#pass", "dominos.com"],
  },
  {
    what: "a page that would not keep it hidden",
    event: {
      event: "credential_mask_failed",
      session: "T",
      action: "screenshot",
      url: "https://dominos.com/pay",
      ts: "2026-08-10T11:00:02Z",
    } as JSONValue,
    status: "Mask failed",
    says: "could not be kept hidden",
    mentions: ["dominos.com/pay", "screenshot"],
  },
])("$what is visible to the owner", ({ event, status, says, mentions }) => {
  const events: JSONValue[] = [
    { event: "browser_session_opened", intentId: "i2", session: "T", origins: ["dominos.com"], ts: "2026-08-10T11:00:00Z" },
    { event: "browser_command", session: "T", action: "goto", url: "https://dominos.com/login", ts: "2026-08-10T11:00:01Z" },
    event,
  ];

  it("does not read as a healthy browsing session", () => {
    const browser = auditActivities(events).find((a) => a.id === "browser:T")!;
    // Green "Browsing" would tell the owner all is well when it is not.
    expect(browser.status).toBe(status);
    // ...and the Failed filter must show it, or they only find it by luck.
    expect(browser.category).toBe("failed");
    const line = browser.timeline.find((step) => step.text.includes(says))!;
    expect(line.state).toBe("bad");
    for (const fragment of mentions) expect(line.text).toContain(fragment);
  });
});
