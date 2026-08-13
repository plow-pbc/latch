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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Intent, JSONValue, makeIntent } from "@domo/protocol";
import type { ReviewArgs, Verdict } from "../src/adversarialAgent.js";
import { Settings } from "../src/settings.js";
import {
  activeProvider,
  decideIntent,
  inferenceStatus,
  modeAfterAvailabilityChange,
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
  opts: { verdict?: Verdict; reason?: string; decision?: "allow_once" | "always_allow" | "deny" } = {},
) {
  const records: { event: string; fields: Record<string, JSONValue> }[] = [];
  const reviewCalls: ReviewArgs[] = [];
  const dialogs: (Promise<string | null> | null)[] = [];
  const review = vi.fn(async (args: ReviewArgs) => {
    reviewCalls.push(args);
    return { verdict: opts.verdict ?? "ask", reason: opts.reason ?? "because" };
  });
  const openApproval = vi.fn(async (suggestion: Promise<"allow_once" | "always_allow" | "deny" | null> | null) => {
    dialogs.push(suggestion);
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
    expect(reviewerModel("plow")).toBe("claude-sonnet-4-6");
    expect(reviewerModel("anthropic")).toBe("claude-haiku-4-5");
    expect(reviewerInfo("plow")).toContain("claude-sonnet-4-6");
    expect(reviewerInfo("anthropic")).toContain("claude-haiku-4-5");
  });

  it("the audit record names the provider and its model, not a fixed one", async () => {
    // The audit log is the test oracle (CLAUDE.md). A review recorded under a
    // model that never saw the intent makes it lie.
    for (const [provider, model] of [
      ["plow", "claude-sonnet-4-6"],
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

  it("an allow verdict decides, and is sourced to the agent", async () => {
    const h = harness(adversarial(), { verdict: "allow" });
    expect(await h.run()).toEqual({ decision: "allow_once", source: "adversarial" });
    expect(h.openApproval).not.toHaveBeenCalled();
  });

  it("a deny verdict decides", async () => {
    const h = harness(adversarial(), { verdict: "deny" });
    expect(await h.run()).toEqual({ decision: "deny", source: "adversarial" });
    expect(h.openApproval).not.toHaveBeenCalled();
  });

  it("an ask verdict hands over to the human, with no suggestion", async () => {
    const h = harness(adversarial(), { verdict: "ask", decision: "allow_once" });
    expect(await h.run()).toEqual({ decision: "allow_once", source: "ask" });
    expect(h.dialogs).toEqual([null]);
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

  it("with no credential for the active provider it asks the human instead", async () => {
    // The security property: an unusable reviewer degrades to the dialog, never
    // to an approval.
    const h = harness(
      settings({ approvalMode: "adversarial", inferenceProvider: "plow", relayCredential: "" }),
      { decision: "deny" },
    );
    expect(await h.run()).toEqual({ decision: "deny", source: "ask" });
    expect(h.review).not.toHaveBeenCalled();
    expect(h.openApproval).toHaveBeenCalledOnce();
  });

  it("a pasted Anthropic key does not silently power the Plow reviewer", async () => {
    const h = harness(
      settings({
        approvalMode: "adversarial",
        inferenceProvider: "plow",
        relayCredential: "",
        anthropicApiKey: ANTHROPIC_KEY,
      }),
      { verdict: "allow" },
    );
    const result = await h.run();
    expect(h.review).not.toHaveBeenCalled();
    expect(result.source).toBe("ask");
    expect(result.decision).not.toBe("allow_once");
  });
});

describe("decideIntent — ask mode and suggestions", () => {
  it("suggests when the toggle is on and the active provider has a credential", async () => {
    const h = harness(
      settings({ approvalMode: "ask", relayCredential: PLOW_CREDENTIAL, showAgentSuggestions: true }),
      { verdict: "allow", decision: "always_allow" },
    );
    expect(await h.run()).toEqual({ decision: "always_allow", source: "ask" });
    expect(h.dialogs).toHaveLength(1);
    await expect(h.dialogs[0]).resolves.toBe("allow_once");
  });

  it("maps a deny verdict to the deny button, and ask to no hint", async () => {
    for (const [verdict, hint] of [
      ["deny", "deny"],
      ["ask", null],
    ] as const) {
      const h = harness(settings({ approvalMode: "ask", relayCredential: PLOW_CREDENTIAL }), { verdict });
      await h.run();
      await expect(h.dialogs[0]).resolves.toBe(hint);
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

describe("the renderer's view of inference carries no credentials", () => {
  const full = settings({
    inferenceProvider: "plow",
    relayCredential: PLOW_CREDENTIAL,
    anthropicApiKey: ANTHROPIC_KEY,
  });

  it("is booleans, a selection, and a model string", () => {
    expect(inferenceStatus(full)).toEqual({
      provider: "plow",
      plowAvailable: true,
      anthropicAvailable: true,
      info: reviewerInfo("plow"),
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
    expect(inferenceStatus(settings({ inferenceProvider: "plow" })).info).toContain("claude-sonnet-4-6");
    expect(inferenceStatus(settings({ inferenceProvider: "anthropic" })).info).toContain("claude-haiku-4-5");
  });
});

describe("losing the active credential retires Adversarial mode", () => {
  it("falls back to ask when the credential is gone", () => {
    const signedOut = settings({ approvalMode: "adversarial", inferenceProvider: "plow", relayCredential: "" });
    expect(modeAfterAvailabilityChange(signedOut)).toBe("ask");
  });

  it("leaves the mode alone while the credential is present", () => {
    const ok = settings({
      approvalMode: "adversarial",
      inferenceProvider: "plow",
      relayCredential: PLOW_CREDENTIAL,
    });
    expect(modeAfterAvailabilityChange(ok)).toBe("adversarial");
  });

  it("does not disturb the other modes", () => {
    for (const mode of ["approve", "ask", "deny"] as const) {
      expect(modeAfterAvailabilityChange(settings({ approvalMode: mode }))).toBe(mode);
    }
  });
});

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
