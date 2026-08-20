/**
 * The decision path: approval mode × inference provider × credential
 * availability. This is the gate the whole app exists to be, and until the
 * branching moved out of `main.ts` none of it was reachable by a test.
 *
 * What must hold, whatever the settings say:
 *   - a review that cannot run never becomes an approval — it becomes a dialog;
 *   - the audit log names the model that actually ran;
 *   - the relay credential reaches the reviewer and nothing else.
 *
 * Nothing here touches a network or a display: the reviewer and the approval
 * dialog are both injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Intent, JSONValue, makeIntent } from "@domo/protocol";
import { adversarialReview } from "../src/adversarialAgent.js";
import type { ReviewArgs, ReviewFailureCause, Verdict } from "../src/adversarialAgent.js";
import { DENIAL_SOURCE_NO_REVIEWER } from "@domo/device-core";
import { Settings } from "../src/settings.js";
import { auditActivities, decidedByLabel } from "../src/viewModel.js";
import {
  ReviewHint,
  activeProvider,
  decideIntent,
  inferenceStatus,
  providerAvailability,
  reviewerAvailable,
  reviewerInfo,
  reviewerModel,
} from "../src/reviewPolicy.js";

const PLOW_CREDENTIAL = "plow_sk_do_not_leak_me";
const ANTHROPIC_KEY = "sk-ant-do-not-leak-me";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    relayCredential: "",
    accountUid: "",
    mcpUrl: "",
    selectedTab: "audit",
    approvalMode: "ask",
    showAgentSuggestions: true,
    anthropicApiKey: "",
    inferenceProvider: "plow",
    agentPurpose: "",
    ...overrides,
  };
}

function intent(): Intent {
  return makeIntent({
    agentId: "agent-1",
    agentDisplay: "Agent One",
    deviceId: "device-1",
    request: "run: ls",
    capabilities: [{ kind: "process.exec", argv: ["ls"] }],
    sessionId: "s1",
  });
}

/** A harness capturing what the policy asked of the world. */
function harness(
  s: Settings,
  opts: {
    verdict?: Verdict;
    reason?: string;
    cause?: ReviewFailureCause;
    decision?: "allow_once" | "always_allow" | "deny";
  } = {},
) {
  const records: { event: string; fields: Record<string, JSONValue> }[] = [];
  const reviewCalls: ReviewArgs[] = [];
  const dialogs: (Promise<ReviewHint> | null)[] = [];
  const review = vi.fn(async (args: ReviewArgs) => {
    reviewCalls.push(args);
    return {
      verdict: opts.verdict ?? "ask",
      reason: opts.reason ?? "because",
      ...(opts.cause ? { cause: opts.cause } : {}),
    };
  });
  const openApproval = vi.fn(async (hint: Promise<ReviewHint> | null) => {
    dialogs.push(hint);
    return opts.decision ?? ("deny" as const);
  });
  const run = () =>
    decideIntent(intent(), {
      settings: s,
      apiBaseUrl: "https://api.plow.co",
      auditEntries: () => [],
      record: (event, fields) => records.push({ event, fields }),
      review,
      openApproval,
    });
  return { run, records, reviewCalls, dialogs, review, openApproval };
}

describe("provider selection reads the stored setting safely", () => {
  it("defaults to plow when the field is absent", () => {
    const s = settings();
    delete (s as Partial<Settings>).inferenceProvider;
    expect(activeProvider(s)).toBe("plow");
  });

  it("defaults to plow for a value nobody recognises", () => {
    // A hand-edited settings.json must not be able to park the reviewer in an
    // undefined state.
    for (const junk of ["openai", "", "PLOW", null, 7]) {
      expect(activeProvider({ inferenceProvider: junk as never })).toBe("plow");
    }
  });

  it("honours a real selection", () => {
    expect(activeProvider(settings({ inferenceProvider: "anthropic" }))).toBe("anthropic");
  });
});

describe("availability is credential presence, per provider", () => {
  it("neither, one, or both", () => {
    expect(providerAvailability(settings())).toEqual({ plow: false, anthropic: false });
    expect(providerAvailability(settings({ relayCredential: PLOW_CREDENTIAL }))).toEqual({
      plow: true,
      anthropic: false,
    });
    expect(providerAvailability(settings({ anthropicApiKey: ANTHROPIC_KEY }))).toEqual({
      plow: false,
      anthropic: true,
    });
    expect(
      providerAvailability(settings({ relayCredential: PLOW_CREDENTIAL, anthropicApiKey: ANTHROPIC_KEY })),
    ).toEqual({ plow: true, anthropic: true });
  });

  it("whitespace is not a credential", () => {
    expect(providerAvailability(settings({ relayCredential: "   ", anthropicApiKey: "  " }))).toEqual({
      plow: false,
      anthropic: false,
    });
  });

  it("the other provider's credential does not make the active one usable", () => {
    // The trap this replaces: a single `hasKey` boolean that made a pasted
    // Anthropic key look like it powered the Plow reviewer.
    expect(reviewerAvailable(settings({ inferenceProvider: "plow", anthropicApiKey: ANTHROPIC_KEY }))).toBe(false);
    expect(
      reviewerAvailable(settings({ inferenceProvider: "anthropic", relayCredential: PLOW_CREDENTIAL })),
    ).toBe(false);
  });
});

describe("the model reported is the model that runs", () => {
  it("per provider", () => {
    // The wire id, provider prefix included — a bare id is rejected by
    // Plow's allowlist, and this is the value the audit log records.
    expect(reviewerModel("plow")).toBe("anthropic/claude-sonnet-4-6");
    expect(reviewerModel("anthropic")).toBe("claude-haiku-4-5");
    expect(reviewerInfo("plow")).toContain("anthropic/claude-sonnet-4-6");
    expect(reviewerInfo("anthropic")).toContain("claude-haiku-4-5");
  });

  it("the audit record names the provider and its model, not a fixed one", async () => {
    // The audit log is the test oracle (CLAUDE.md). A review recorded under a
    // model that never saw the intent makes it lie.
    for (const [provider, model] of [
      ["plow", "anthropic/claude-sonnet-4-6"],
      ["anthropic", "claude-haiku-4-5"],
    ] as const) {
      const h = harness(
        settings({
          approvalMode: "adversarial",
          inferenceProvider: provider,
          relayCredential: PLOW_CREDENTIAL,
          anthropicApiKey: ANTHROPIC_KEY,
        }),
        { verdict: "allow" },
      );
      await h.run();
      const started = h.records.find((r) => r.event === "adversarial_review_started");
      expect(started?.fields).toMatchObject({ provider, model });
    }
  });
});

describe("decideIntent — modes that never reach the reviewer", () => {
  it("approve auto-allows without reviewing or prompting", async () => {
    const h = harness(settings({ approvalMode: "approve", relayCredential: PLOW_CREDENTIAL }));
    expect(await h.run()).toEqual({ decision: "allow_once", source: "approve" });
    expect(h.review).not.toHaveBeenCalled();
    expect(h.openApproval).not.toHaveBeenCalled();
  });

  it("deny auto-denies without reviewing or prompting", async () => {
    const h = harness(settings({ approvalMode: "deny", relayCredential: PLOW_CREDENTIAL }));
    expect(await h.run()).toEqual({ decision: "deny", source: "policy" });
    expect(h.review).not.toHaveBeenCalled();
    expect(h.openApproval).not.toHaveBeenCalled();
  });
});

describe("decideIntent — adversarial mode", () => {
  const adversarial = (over: Partial<Settings> = {}) =>
    settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL, ...over });

  // One review, three verdicts, three outcomes — and no dialog in any of them.
  // The owner chose "the reviewer decides"; a modal in this mode contradicts
  // that, so an `ask` is a denial here rather than a handover.
  const decisionCases = [
    { verdict: "allow" as const, decision: "allow_once", source: "adversarial" },
    { verdict: "deny" as const, decision: "deny", source: "adversarial" },
    { verdict: "ask" as const, decision: "deny", source: "reviewer_undecided" },
  ];

  for (const c of decisionCases) {
    it(`a ${c.verdict} verdict is sourced to ${c.source}`, async () => {
      const h = harness(adversarial(), {
        verdict: c.verdict,
        reason: "genuinely ambiguous",
        decision: "allow_once",
      });
      expect(await h.run()).toEqual({ decision: c.decision, source: c.source });
      expect(h.openApproval).not.toHaveBeenCalled();
    });
  }

  /**
   * The routes into a dialog were never one route. A model can answer `ask`; a
   * call can time out; a provider can error or rate-limit; an answer can fail
   * to parse. Each arrives as the same `ask` verdict and each used to open the
   * same window, so each needs its own proof that it no longer does.
   */
  describe("no route reaches a modal", () => {
    const routes = [
      { name: "the model answers ask", reason: "genuinely ambiguous", cause: undefined, source: "reviewer_undecided" },
      { name: "the call times out", reason: "reviewer timed out", cause: "unavailable" as const, source: "reviewer_unavailable" },
      { name: "the provider errors", reason: "reviewer error", cause: "unavailable" as const, source: "reviewer_unavailable" },
      { name: "the provider rate-limits", reason: "Plow returned HTTP 429", cause: "unavailable" as const, source: "reviewer_unavailable" },
      { name: "the verdict does not parse", reason: "reviewer returned no usable verdict", cause: "unavailable" as const, source: "reviewer_unavailable" },
    ];

    for (const r of routes) {
      it(`${r.name} → deny, sourced ${r.source}`, async () => {
        // `decision` is what the dialog WOULD have answered. Nothing may turn
        // it into execution, because nothing may open it.
        const h = harness(adversarial(), {
          verdict: "ask",
          reason: r.reason,
          cause: r.cause,
          decision: "allow_once",
        });
        expect(await h.run()).toEqual({ decision: "deny", source: r.source });
        expect(h.openApproval).not.toHaveBeenCalled();
        // The reason the reviewer gave is still recorded, so the source is a
        // summary of the timeline rather than a replacement for it.
        expect(h.records[1].fields).toMatchObject({ verdict: "ask", reason: r.reason });
      });
    }

    it("leaves Ask mode's dialog exactly where it was", async () => {
      const h = harness(settings({ relayCredential: PLOW_CREDENTIAL }), {
        verdict: "ask",
        reason: "genuinely ambiguous",
        decision: "allow_once",
      });
      expect(await h.run()).toEqual({ decision: "allow_once", source: "ask" });
      expect(h.openApproval).toHaveBeenCalledOnce();
    });
  });

  it("out of credits denies, and says so through the decision's source", async () => {
    // The reviewer the user configured can never run, so falling back to a
    // human would quietly change the mode they chose. Deny, and label it in a
    // way the device can turn into an answer the calling agent can read.
    //
    // Fails closed whatever the dialog would have said: there is no dialog, and
    // neither an allow_once nor an always_allow can turn this into execution.
    for (const decision of ["allow_once", "always_allow", "deny"] as const) {
      const h = harness(adversarial(), { verdict: "ask", cause: "no_credits", decision });
      expect(await h.run()).toEqual({ decision: "deny", source: "no_credits" });
      expect(h.openApproval).not.toHaveBeenCalled();
    }
  });

  it("records the review's start and its verdict, in that order", async () => {
    const h = harness(adversarial(), { verdict: "deny", reason: "reads credentials" });
    await h.run();
    expect(h.records.map((r) => r.event)).toEqual([
      "adversarial_review_started",
      "adversarial_review_result",
    ]);
    expect(h.records[1].fields).toMatchObject({ verdict: "deny", reason: "reads credentials" });
  });

  // The security property, per shape of "the active provider cannot run": an
  // unusable reviewer DENIES, never approves — and a credential belonging to
  // the OTHER provider does not quietly stand in for the one that was selected.
  //
  // This used to fall to the dialog, because selecting a provider without its
  // credential was refused and the mode was retired to Ask behind the user. The
  // gate is gone: the state is reachable, so it has to answer for itself. Deny
  // is the fail-closed answer, and `no_reviewer` is what makes it legible
  // instead of looking like a decision somebody made.
  //
  // Nothing is CALLED to find this out. The reviewer's absence is on disk, so
  // asking it would only buy an audit pair naming a model that never saw the
  // intent — which is why `reviewerAvailable` decides before `review()` runs.
  const unusableReviewers = [
    { name: "the Plow reviewer has no credential at all", over: { inferenceProvider: "plow" as const, relayCredential: "" } },
    {
      name: "the Plow reviewer has only the other provider's credential",
      over: { inferenceProvider: "plow" as const, relayCredential: "", anthropicApiKey: ANTHROPIC_KEY },
    },
    { name: "the Anthropic reviewer has no key", over: { inferenceProvider: "anthropic" as const, anthropicApiKey: "" } },
  ];

  for (const c of unusableReviewers) {
    it(`denies, explaining itself, when ${c.name}`, async () => {
      const h = harness(
        settings({ approvalMode: "adversarial", ...c.over }),
        // What the dialog WOULD have said. It must not be reachable.
        { verdict: "ask", reason: "nobody to call", decision: "allow_once" },
      );
      const result = await h.run();
      expect(result.decision).toBe("deny");
      // The sentence itself lives in device-core (EXPLAINED_DENIALS) and is
      // pinned end to end by mcpServer.test.ts; here the contract is that this
      // path picks the explained source rather than a bare deny.
      expect(result.source).toBe(DENIAL_SOURCE_NO_REVIEWER);
      // No call, and therefore no timeline claiming a model started reviewing.
      expect(h.review).not.toHaveBeenCalled();
      expect(h.records).toEqual([]);
      // No dialog: the mode the user chose is honoured, not swapped for Ask.
      expect(h.openApproval).not.toHaveBeenCalled();
    });
  }

});

describe("decideIntent — ask mode and suggestions", () => {
  it("suggests when the toggle is on and the active provider has a credential", async () => {
    const h = harness(
      settings({ approvalMode: "ask", relayCredential: PLOW_CREDENTIAL, showAgentSuggestions: true }),
      { verdict: "allow", decision: "always_allow" },
    );
    expect(await h.run()).toEqual({ decision: "always_allow", source: "ask" });
    expect(h.dialogs).toHaveLength(1);
    await expect(h.dialogs[0]).resolves.toEqual({
      decision: "allow_once",
      reason: "because",
    });
  });

  it("maps a deny verdict to the deny button, and ask to no hint", async () => {
    for (const [verdict, hint] of [
      ["deny", "deny"],
      ["ask", null],
    ] as const) {
      const h = harness(settings({ approvalMode: "ask", relayCredential: PLOW_CREDENTIAL }), { verdict });
      await h.run();
      await expect(h.dialogs[0]).resolves.toMatchObject({ decision: hint });
    }
  });

  it("skips the review entirely when suggestions are off", async () => {
    const h = harness(
      settings({ approvalMode: "ask", relayCredential: PLOW_CREDENTIAL, showAgentSuggestions: false }),
    );
    await h.run();
    expect(h.review).not.toHaveBeenCalled();
    expect(h.dialogs).toEqual([null]);
  });

  it("skips the review when the active provider has no credential", async () => {
    const h = harness(settings({ approvalMode: "ask", showAgentSuggestions: true }));
    await h.run();
    expect(h.review).not.toHaveBeenCalled();
    expect(h.dialogs).toEqual([null]);
  });

  it("out of credits in ASK mode costs only the hint — the human still decides", async () => {
    // The user did not delegate the decision here, so a billing problem must
    // not turn into a denial. The dialog opens exactly as it always does.
    const h = harness(
      settings({ approvalMode: "ask", relayCredential: PLOW_CREDENTIAL, showAgentSuggestions: true }),
      { verdict: "ask", cause: "no_credits", reason: "insufficient Plow balance", decision: "allow_once" },
    );
    expect(await h.run()).toEqual({ decision: "allow_once", source: "ask" });
    expect(h.openApproval).toHaveBeenCalledOnce();
    await expect(h.dialogs[0]).resolves.toMatchObject({ decision: null });
  });

  it("a suggestion is only ever a hint — the human's click is the decision", async () => {
    const h = harness(settings({ approvalMode: "ask", relayCredential: PLOW_CREDENTIAL }), {
      verdict: "allow",
      decision: "deny",
    });
    expect(await h.run()).toEqual({ decision: "deny", source: "ask" });
  });
});

describe("decideIntent — what reaches the reviewer", () => {
  it("passes the selected provider and the Plow credential and base URL", async () => {
    const h = harness(
      settings({
        approvalMode: "adversarial",
        inferenceProvider: "plow",
        relayCredential: PLOW_CREDENTIAL,
      }),
      { verdict: "allow" },
    );
    await h.run();
    expect(h.reviewCalls[0]).toMatchObject({
      provider: "plow",
      plowCredential: PLOW_CREDENTIAL,
      apiBaseUrl: "https://api.plow.co",
    });
  });

  it("passes the selected provider and the Anthropic key", async () => {
    const h = harness(
      settings({
        approvalMode: "adversarial",
        inferenceProvider: "anthropic",
        anthropicApiKey: ANTHROPIC_KEY,
      }),
      { verdict: "allow" },
    );
    await h.run();
    expect(h.reviewCalls[0]).toMatchObject({ provider: "anthropic", apiKey: ANTHROPIC_KEY });
  });

  it("puts neither credential into the audit log", async () => {
    // CLAUDE.md's highest-severity rule for this change. The reviewer gets the
    // credential; the audit trail must not.
    const h = harness(
      settings({
        approvalMode: "adversarial",
        relayCredential: PLOW_CREDENTIAL,
        anthropicApiKey: ANTHROPIC_KEY,
      }),
      { verdict: "deny", reason: "nope" },
    );
    await h.run();
    const serialized = JSON.stringify(h.records);
    expect(serialized).not.toContain(PLOW_CREDENTIAL);
    expect(serialized).not.toContain(ANTHROPIC_KEY);
  });
});

describe("the approval dialog's advice note carries no credential either", () => {
  // The FOURTH surface a credential-bearing `reason` reaches — after the
  // reviewer's return value, audit.ndjson, and the activity view. Every other
  // test in this file injects a fake reviewer, so none of them exercise the
  // provider's guard; this one runs the REAL reviewer against a hostile body.
  const hostileBody = (reason: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ decision: "deny", reason }) } }],
    }),
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const hintFor = async (reason: string) => {
    vi.stubGlobal("fetch", async () => hostileBody(reason));
    const dialogs: (Promise<ReviewHint> | null)[] = [];
    await decideIntent(intent(), {
      settings: settings({
        approvalMode: "ask",
        relayCredential: PLOW_CREDENTIAL,
        showAgentSuggestions: true,
      }),
      apiBaseUrl: "https://api.plow.co",
      auditEntries: () => [],
      record: () => {},
      review: adversarialReview, // the REAL one, guard included
      openApproval: async (hint) => {
        dialogs.push(hint);
        return "deny";
      },
    });
    return dialogs[0] === null ? null : await dialogs[0];
  };

  it("a verdict repeating the credential never reaches the note", async () => {
    const said = await hintFor(PLOW_CREDENTIAL);
    expect(JSON.stringify(said)).not.toContain(PLOW_CREDENTIAL);
    expect(JSON.stringify(said)).not.toContain(PLOW_CREDENTIAL.slice(0, 10));
    // Discarded, so there is no button to highlight either.
    expect(said?.decision).toBeNull();
  });

  it("an ordinary verdict still reaches the note, in the reviewer's words", async () => {
    const said = await hintFor("reads credentials from ~/.ssh");
    expect(said).toEqual({ decision: "deny", reason: "reads credentials from ~/.ssh" });
  });
});

describe("the renderer's view of inference carries no credentials", () => {
  const full = settings({
    inferenceProvider: "plow",
    relayCredential: PLOW_CREDENTIAL,
    anthropicApiKey: ANTHROPIC_KEY,
  });

  it("is booleans, a selection, a model string and the stored mode", () => {
    expect(inferenceStatus(full)).toEqual({
      provider: "plow",
      available: { plow: true, anthropic: true },
      info: reviewerInfo("plow"),
      approvalMode: full.approvalMode,
    });
  });

  it("contains neither credential, nor any prefix of one", () => {
    const serialized = JSON.stringify(inferenceStatus(full));
    expect(serialized).not.toContain(PLOW_CREDENTIAL);
    expect(serialized).not.toContain(ANTHROPIC_KEY);
    expect(serialized).not.toContain(PLOW_CREDENTIAL.slice(0, 8));
    expect(serialized).not.toContain(ANTHROPIC_KEY.slice(0, 8));
  });

  it("reports the active provider's model, not a fixed one", () => {
    expect(inferenceStatus(settings({ inferenceProvider: "plow" })).info).toContain("anthropic/claude-sonnet-4-6");
    expect(inferenceStatus(settings({ inferenceProvider: "anthropic" })).info).toContain("claude-haiku-4-5");
  });
});

// What used to sit here: `modeAfterAvailabilityChange`, which retired
// Adversarial to Ask whenever the active provider lost its credential. The
// function is gone with the gate. Losing a credential no longer rewrites the
// user's mode behind them — the mode stays, and every operation it decides is
// denied with `no_reviewer` until the credential comes back. That contract is
// pinned by the adversarial-mode describe above and by settingsActions.test.

describe("settings defaults", () => {
  let loadSettings: typeof import("../src/settings.js").loadSettings;
  beforeEach(async () => {
    ({ loadSettings } = await import("../src/settings.js"));
  });

  it("a settings.json with no inferenceProvider reads as plow", () => {
    // Existing installs upgrade onto Plow without a migration.
    const s = loadSettings("/nonexistent-domo-home");
    expect(s.inferenceProvider).toBe("plow");
    expect(activeProvider(s)).toBe("plow");
  });
});

describe("the audit tells one coherent story about who decided", () => {
  /**
   * The timeline a human actually reads: the recorded events run through the
   * same view model the activity pane renders from.
   */
  const narrative = (
    records: { event: string; fields: Record<string, JSONValue> }[],
    decision: { decision: string; source: string },
    intentId: string,
  ) => {
    const ts = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    const events: JSONValue[] = [
      { ts: ts(0), event: "intent_received", intentId, agent: "agent-1", agent_name: "Agent One",
        request: "run: ls", goal: "", capabilities: ["Run: ls"] },
      ...records.map((r, i) => ({ ts: ts(i + 1), event: r.event, ...r.fields })),
      { ts: ts(records.length + 1), event: "intent_decision", intentId,
        decision: decision.decision, source: decision.source },
    ];
    return auditActivities(events).flatMap((a) => a.timeline.map((s) => s.text));
  };

  it("out of credits reads as 'could not run', never 'defer to you'", async () => {
    // The incoherence this pins: an `ask` verdict recorded, then an automatic
    // deny with no dialog in between. Read back, that said the agent handed the
    // decision to the owner and then something else silently denied it.
    const h = harness(
      settings({
        approvalMode: "adversarial",
        relayCredential: PLOW_CREDENTIAL,
        inferenceProvider: "plow",
      }),
      { verdict: "ask", cause: "no_credits", reason: "insufficient Plow balance" },
    );
    const decision = await h.run();
    const lines = narrative(h.records, decision, intent().intentId);

    expect(lines.some((l) => l.includes("could not run"))).toBe(true);
    expect(lines.some((l) => l.includes("defer to you"))).toBe(false);
    // …and the decision that follows names the same thing, in human words.
    expect(decidedByLabel(decision.source)).toBe("AI Reviewer (out of credits)");
    expect(decidedByLabel(decision.source)).not.toContain("no_credits");
  });

  it("a genuine abstention still reads as deferring, because it is one", async () => {
    const h = harness(settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL }), {
      verdict: "ask",
      reason: "genuinely ambiguous",
    });
    const decision = await h.run();
    const lines = narrative(h.records, decision, intent().intentId);
    expect(lines.some((l) => l.includes("defer to you"))).toBe(true);
    expect(lines.some((l) => l.includes("could not run"))).toBe(false);
  });
});

/**
 * The purpose statement reaches the reviewer from SETTINGS, never from the
 * intent. That is the property the TRUSTED label in the prompt rests on, and it
 * lives here — this is the only place the two sources meet.
 */
describe("what the reviewer is told about the owner's purpose", () => {
  const PURPOSE = "Groceries and calendar only. Never touch ~/Developer.";

  it("hands the reviewer the stored purpose, alongside the intent it did not come from", async () => {
    const h = harness(
      settings({
        approvalMode: "adversarial",
        relayCredential: PLOW_CREDENTIAL,
        agentPurpose: PURPOSE,
      }),
      { verdict: "allow" },
    );

    await h.run();

    expect(h.reviewCalls).toHaveLength(1);
    expect(h.reviewCalls[0].agentPurpose).toBe(PURPOSE);
    // And it is not, and never was, on the intent.
    expect(JSON.stringify(h.reviewCalls[0].intent)).not.toContain("Groceries");
  });

  it("passes an empty string when the owner has said nothing", async () => {
    const h = harness(
      settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL }),
      { verdict: "allow" },
    );
    await h.run();
    expect(h.reviewCalls[0].agentPurpose).toBe("");
  });

  /**
   * The reviewer's own words are persisted to audit.ndjson and drawn in the
   * activity view. The purpose is not: the audit log records what was decided
   * and why the reviewer said so, not the standing instruction it was read
   * against.
   */
  it("keeps the purpose out of the audit record the review writes", async () => {
    const h = harness(
      settings({
        approvalMode: "adversarial",
        relayCredential: PLOW_CREDENTIAL,
        agentPurpose: PURPOSE,
      }),
      { verdict: "allow", reason: "fits routine shopping" },
    );

    await h.run();

    expect(JSON.stringify(h.records)).not.toContain("Groceries");
    expect(JSON.stringify(h.records)).not.toContain("~/Developer");
  });
});
