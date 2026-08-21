/**
 * The decision path: approval mode × credential
 * availability. This is the gate the whole app exists to be, and until the
 * branching moved out of `main.ts` none of it was reachable by a test.
 *
 * What must hold, whatever the settings say:
 *   - a review that cannot run never becomes an approval — in adversarial mode
 *     it denies, in Ask mode the dialog was always the decider;
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
  decideIntent,
  inferenceStatus,
  reviewerAvailable,
} from "../src/reviewPolicy.js";
import { REVIEWER_MODEL } from "../src/adversarialAgent.js";

const PLOW_CREDENTIAL = "plow_sk_do_not_leak_me";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    relayCredential: "",
    accountUid: "",
    mcpUrl: "",
    selectedTab: "audit",
    approvalMode: "ask",
    showAgentSuggestions: true,
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

/**
 * What is actually PASSED, not what the prompt says.
 *
 * The ratchet was never a wording problem, so this asserts on the argument
 * `decideIntent` builds: a denial-soaked audit log and an empty one produce the
 * identical review call, because the history handed over is empty either way.
 */
describe("nothing about the past reaches the reviewer", () => {
  it("passes an empty history however full the audit log is", async () => {
    const reviewCalls: ReviewArgs[] = [];
    const review = vi.fn(async (args: ReviewArgs) => {
      reviewCalls.push(args);
      return { verdict: "allow" as const, reason: "fine" };
    });
    const soaked: JSONValue[] = [
      { event: "intent_received", intentId: "old", agent: "agent-1", request: "browse: doordash.com" },
      { event: "intent_decision", intentId: "old", decision: "deny", source: "adversarial" },
      {
        event: "adversarial_review_result",
        intentId: "old",
        verdict: "deny",
        reason: "compromised or misaligned agent",
      },
      { event: "file_read", intentId: "old", path: "/tmp/earlier.txt" },
    ];
    await decideIntent(intent(), {
      settings: settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL }),
      apiBaseUrl: "https://api.plow.co",
      auditEntries: () => soaked,
      record: () => {},
      review,
      openApproval: async () => "deny" as const,
    });

    expect(reviewCalls).toHaveLength(1);
    expect(reviewCalls[0].history).toEqual([]);
    const serialized = JSON.stringify(reviewCalls[0]);
    expect(serialized).not.toContain("compromised");
    expect(serialized).not.toContain("earlier.txt");
  });
});

describe("availability is credential presence", () => {
  it("signed in, or not", () => {
    expect(reviewerAvailable(settings())).toBe(false);
    expect(reviewerAvailable(settings({ relayCredential: PLOW_CREDENTIAL }))).toBe(true);
  });

  it("whitespace is not a credential", () => {
    expect(reviewerAvailable(settings({ relayCredential: "   " }))).toBe(false);
  });
});

describe("the model reported is the model that runs", () => {
  it("the wire id, provider prefix and all", () => {
    // A bare id is rejected by Plow's allowlist, and this is the value the
    // audit log records.
    expect(REVIEWER_MODEL).toBe("anthropic/claude-sonnet-4-6");
  });

  it("the audit record names the model that ran", async () => {
    // The audit log is the test oracle (CLAUDE.md). A review recorded under a
    // model that never saw the intent makes it lie.
    const h = harness(
      settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL }),
      { verdict: "allow" },
    );
    await h.run();
    const started = h.records.find((r) => r.event === "adversarial_review_started");
    expect(started?.fields).toMatchObject({ model: "anthropic/claude-sonnet-4-6" });
    // The provider field went with the choice it recorded.
    expect(started?.fields).not.toHaveProperty("provider");
  });
});

/**
 * Which mode is running is something the app KNOWS, so the reviewer is told
 * rather than left to infer it from the owner's optional purpose text. It
 * decides whether `ask` is even in the schema the model answers into.
 */
describe("the reviewer is told whether anyone is behind it", () => {
  it("adversarial mode: nobody is", async () => {
    const h = harness(
      settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL }),
      { verdict: "allow" },
    );
    await h.run();
    expect(h.reviewCalls[0].humanAvailable).toBe(false);
  });

  it("ask mode's hint: somebody is — the dialog is coming either way", async () => {
    const h = harness(
      settings({
        approvalMode: "ask",
        relayCredential: PLOW_CREDENTIAL,
        showAgentSuggestions: true,
      }),
      { verdict: "ask" },
    );
    await h.run();
    await h.dialogs[0];
    expect(h.reviewCalls[0].humanAvailable).toBe(true);
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

  // One review, two verdicts, two outcomes — and no dialog in either. The owner
  // chose "the reviewer decides", so a modal in this mode contradicts the
  // setting; there is no third verdict to hand over, because `ask` is not in
  // the schema the reviewer answers into when nobody is behind it.
  const decisionCases = [
    { verdict: "allow" as const, decision: "allow_once", source: "adversarial" },
    { verdict: "deny" as const, decision: "deny", source: "adversarial" },
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
   * A review that reached no verdict — timed out, errored, rate-limited, refused,
   * answered unparseably — arrives here as one shape: `ask` with `cause: "unavailable"`
   * (adversarialAgent.test.ts pins each real failure onto that cause). It used
   * to open the dialog, so it needs its own proof that it no longer does; and
   * Ask mode's dialog has to still be there afterwards.
   */
  describe("no route reaches a modal", () => {
    it("a review with no usable verdict → deny, sourced reviewer_unavailable", async () => {
      // `decision` is what the dialog WOULD have answered. Nothing may turn
      // it into execution, because nothing may open it.
      const h = harness(adversarial(), {
        verdict: "ask",
        reason: "reviewer timed out",
        cause: "unavailable",
        decision: "allow_once",
      });
      expect(await h.run()).toEqual({ decision: "deny", source: "reviewer_unavailable" });
      expect(h.openApproval).not.toHaveBeenCalled();
      // The Activity pane shows this source, and it says only what is known.
      // "Could not run" would be a false account of a reviewer that ran and
      // refused, which lands on this same cause.
      expect(decidedByLabel("reviewer_unavailable")).toBe("AI Reviewer (no usable verdict)");
      // The reason the reviewer gave is still recorded, so the source is a
      // summary of the timeline rather than a replacement for it.
      // The cause rides the record too: the verdict alone says "ask", which
      // reads as a reviewer deferring rather than one that never answered.
      expect(h.records[1].fields).toMatchObject({
        verdict: "ask",
        reason: "reviewer timed out",
        cause: "unavailable",
      });
    });

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

  // The security property, per shape of "the reviewer cannot run": an
  // unusable reviewer DENIES, never approves — and a credential belonging to
  //
  // This used to fall to the dialog, because Adversarial without a credential
  // was refused and the mode was retired to Ask behind the user. The
  // gate is gone: the state is reachable, so it has to answer for itself. Deny
  // is the fail-closed answer, and `no_reviewer` is what makes it legible
  // instead of looking like a decision somebody made.
  //
  // Nothing is CALLED to find this out. The reviewer's absence is on disk, so
  // asking it would only buy an audit pair naming a model that never saw the
  // intent — which is why `reviewerAvailable` decides before `review()` runs.
  const unusableReviewers = [
    { name: "the reviewer has no credential at all", over: { relayCredential: "" } },
    { name: "the credential is whitespace", over: { relayCredential: "   " } },
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
  it("suggests when the toggle is on and there is a credential", async () => {
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

  it("skips the review when there is no credential", async () => {
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
  it("passes the Plow credential and base URL", async () => {
    const h = harness(
      settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL }),
      { verdict: "allow" },
    );
    await h.run();
    expect(h.reviewCalls[0]).toMatchObject({
      plowCredential: PLOW_CREDENTIAL,
      apiBaseUrl: "https://api.plow.co",
    });
  });

  it("puts the credential into the audit log nowhere", async () => {
    // CLAUDE.md's highest-severity rule for this change. The reviewer gets the
    // credential; the audit trail must not.
    const h = harness(
      settings({
        approvalMode: "adversarial",
        relayCredential: PLOW_CREDENTIAL,
      }),
      { verdict: "deny", reason: "nope" },
    );
    await h.run();
    const serialized = JSON.stringify(h.records);
    expect(serialized).not.toContain(PLOW_CREDENTIAL);
    expect(serialized).not.toContain(PLOW_CREDENTIAL.slice(0, 8));
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
  const full = settings({ relayCredential: PLOW_CREDENTIAL });

  it("is a boolean and the stored mode, and nothing else", () => {
    expect(inferenceStatus(full)).toEqual({
      available: true,
      approvalMode: full.approvalMode,
    });
  });

  it("contains no credential, nor any prefix of one", () => {
    const serialized = JSON.stringify(inferenceStatus(full));
    expect(serialized).not.toContain(PLOW_CREDENTIAL);
    expect(serialized).not.toContain(PLOW_CREDENTIAL.slice(0, 8));
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

  it("a settings.json that was never written reads as an unusable reviewer", () => {
    const s = loadSettings("/nonexistent-domo-home");
    expect(reviewerAvailable(s)).toBe(false);
    expect(s.approvalMode).toBe("ask");
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

  it("a genuine abstention reads as 'would not decide'", async () => {
    // Ask mode, because that is where a genuine abstention still exists: the
    // hint may decline, and the human it defers to is actually there. In
    // adversarial mode `ask` is not in the schema at all, so there is nothing
    // left to render for it.
    const h = harness(
      settings({ relayCredential: PLOW_CREDENTIAL, showAgentSuggestions: true }),
      { verdict: "ask", reason: "genuinely ambiguous", decision: "allow_once" },
    );
    const decision = await h.run();
    await h.dialogs[0];
    const lines = narrative(h.records, decision, intent().intentId);
    const reviewLine = lines.find((l) => l.startsWith("AI Reviewer:")) ?? "";
    expect(reviewLine).toContain("would not decide");
    // Not "could not run" — that is the other failure, and this one ran.
    expect(reviewLine).not.toContain("could not run");
  });

  it("a review that reached no verdict does not claim the reviewer never ran", async () => {
    // `unavailable` is a bag: an outage, a rate limit, a refusal, an answer
    // that did not parse. Only the first two mean the reviewer never ran, and
    // nothing here knows which one happened — so the timeline says only that
    // no verdict came back. "Could not run" belongs to `no_credits`, which
    // does know.
    const h = harness(settings({ approvalMode: "adversarial", relayCredential: PLOW_CREDENTIAL }), {
      verdict: "ask",
      reason: "reviewer declined to assess",
      cause: "unavailable",
    });
    const decision = await h.run();
    const reviewLine =
      narrative(h.records, decision, intent().intentId).find((l) => l.startsWith("AI Reviewer:")) ?? "";
    expect(reviewLine).toContain("no usable verdict");
    expect(reviewLine).not.toContain("could not run");
    expect(decidedByLabel(decision.source)).toBe("AI Reviewer (no usable verdict)");
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
