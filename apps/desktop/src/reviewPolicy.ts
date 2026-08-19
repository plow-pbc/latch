/**
 * How an operation intent gets decided — the branching between approval mode,
 * inference provider, credential availability, and the human dialog.
 *
 * This lives outside the Electron entry on purpose (same reason as
 * `viewModel.ts` and `spawnAgent.ts`): it is the security-relevant decision
 * path, so it has to be reachable by `npx vitest run` with no display and no
 * device. `main.ts` keeps only the Electron-shaped adapter around it.
 */
import { Intent, JSONValue } from "@domo/protocol";
import { DENIAL_SOURCE_NO_CREDITS, DENIAL_SOURCE_NO_REVIEWER } from "@domo/device-core";
import {
  agentHistory,
  PLOW_REVIEWER_INFO,
  PLOW_REVIEWER_MODEL,
  REVIEWER_INFO,
  REVIEWER_MODEL,
  ReviewArgs,
  ReviewFailureCause,
  Verdict,
} from "./adversarialAgent.js";
import { INFERENCE_PROVIDERS, InferenceProvider, Settings } from "./settings.js";

export type ApprovalDecision = "allow_once" | "always_allow" | "deny";

/**
 * What the reviewer has to say to the human, when a human is being asked.
 *
 * **Display-only, both halves.** `decision` highlights a button and `reason`
 * is text to read; neither touches the capability set, which is what the
 * sandbox is built from and the only thing the dialog presents as enforceable.
 */
export interface ReviewHint {
  /** The button to highlight, or null when the reviewer reached no verdict. */
  decision: ApprovalDecision | null;
  /** Why — in the reviewer's words, or ours when it could not answer. */
  reason: string;
}

/** Which providers this Mac currently holds a credential for. */
export type ProviderAvailability = Record<InferenceProvider, boolean>;

/**
 * What the renderer is allowed to know about inference: the selection, which
 * providers are usable, and what the active one runs. **No credentials** — not
 * the relay credential, not the Anthropic key, not a prefix of either.
 */
export interface InferenceStatus {
  provider: InferenceProvider;
  /** Keyed by provider, so a caller never has to know their names to read it. */
  available: ProviderAvailability;
  /** Model + limits of the *active* provider, for display. */
  info: string;
  /**
   * The stored approval mode, in the SAME snapshot as availability. Reading the
   * two separately gave the renderer two async views of one settings file, and
   * a window where they disagreed.
   */
  approvalMode: Settings["approvalMode"];
}

/**
 * The stored selection, defaulting to Plow. An absent field reads as `plow`, and
 * so does anything unrecognised — a hand-edited settings.json must not be able
 * to put the reviewer into an undefined state.
 */
export function activeProvider(settings: Pick<Settings, "inferenceProvider">): InferenceProvider {
  const stored = settings.inferenceProvider;
  return INFERENCE_PROVIDERS.includes(stored as InferenceProvider)
    ? (stored as InferenceProvider)
    : "plow";
}

/** A provider is usable exactly when its credential is present. */
export function providerAvailability(
  settings: Pick<Settings, "relayCredential" | "anthropicApiKey">,
): ProviderAvailability {
  return {
    plow: !!(settings.relayCredential ?? "").trim(),
    anthropic: !!(settings.anthropicApiKey ?? "").trim(),
  };
}

/** The model the given provider actually runs. Audited, and shown in Settings. */
export function reviewerModel(provider: InferenceProvider): string {
  return provider === "plow" ? PLOW_REVIEWER_MODEL : REVIEWER_MODEL;
}

export function reviewerInfo(provider: InferenceProvider): string {
  return provider === "plow" ? PLOW_REVIEWER_INFO : REVIEWER_INFO;
}

/** The renderer-facing shape. Built here so there is one definition of "safe". */
export function inferenceStatus(settings: Settings): InferenceStatus {
  const provider = activeProvider(settings);
  return {
    provider,
    available: providerAvailability(settings),
    info: reviewerInfo(provider),
    approvalMode: settings.approvalMode ?? "ask",
  };
}

/** Can the reviewer run at all right now? */
export function reviewerAvailable(settings: Settings): boolean {
  return providerAvailability(settings)[activeProvider(settings)];
}

/** Everything `decideIntent` needs from the outside world, injected for tests. */
export interface DecideDeps {
  settings: Settings;
  /** Plow API origin. Baked into the build, never a setting. */
  apiBaseUrl: string;
  /** The audit log's current entries, for the reviewer's history context. */
  auditEntries: () => JSONValue[];
  record: (event: string, fields: Record<string, JSONValue>) => void;
  review: (
    args: ReviewArgs,
  ) => Promise<{ verdict: Verdict; reason: string; cause?: ReviewFailureCause }>;
  /** Show the human the approval dialog, optionally with the reviewer's say. */
  openApproval: (hint: Promise<ReviewHint> | null) => Promise<ApprovalDecision>;
}

/**
 * Decide one intent. The returned `source` records HOW it was decided, for the
 * audit log.
 *
 * The adversarial-agent features need a credential for the selected provider;
 * without one, adversarial mode falls back to Ask and suggestions are skipped.
 */
export async function decideIntent(
  intent: Intent,
  deps: DecideDeps,
): Promise<{ decision: ApprovalDecision; source: string }> {
  const { settings } = deps;
  const mode = settings.approvalMode ?? "ask";

  if (mode === "approve") return { decision: "allow_once", source: "approve" };
  if (mode === "deny") return { decision: "deny", source: "policy" };

  const provider = activeProvider(settings);

  // Run one review, recording its start and outcome onto the intent's audit
  // timeline so the app shows "adversarial agent started" + its verdict between
  // the request and the final decision.
  const review = async () => {
    const history = agentHistory(deps.auditEntries(), intent.agentId);
    deps.record("adversarial_review_started", {
      intentId: intent.intentId,
      agent: intent.agentId,
      // The provider that actually ran, and the model it actually used — the
      // audit log is the test oracle, so it must not name a model that never
      // saw this intent.
      provider,
      model: reviewerModel(provider),
    });
    const r = await deps.review({
      intent,
      history,
      provider,
      apiKey: (settings.anthropicApiKey ?? "").trim(),
      // A SECRET. It reaches the Authorization header of the Plow request and
      // nothing else — never the audit record below, never the renderer.
      plowCredential: (settings.relayCredential ?? "").trim(),
      // Device-side and human-authored: it comes from the settings file, so no
      // agent-reachable path can write what the prompt will label TRUSTED.
      agentPurpose: settings.agentPurpose ?? "",
      apiBaseUrl: deps.apiBaseUrl,
    });
    deps.record("adversarial_review_result", {
      intentId: intent.intentId,
      verdict: r.verdict,
      reason: r.reason,
      // The verdict alone says "ask", which reads as the agent deferring to the
      // human — untrue when it never ran. The cause is what tells the timeline
      // the difference between deferring and being unable to answer.
      ...(r.cause ? { cause: r.cause } : {}),
    });
    return r;
  };

  if (mode === "adversarial") {
    // Decide this BEFORE `review()`, which opens the timeline with "adversarial
    // agent started" and names the model it is about to use. With no credential
    // there is no call and no model, so recording one would put a reviewer that
    // never ran into the audit log — and the audit log is the oracle.
    if (!reviewerAvailable(settings)) {
      return { decision: "deny", source: DENIAL_SOURCE_NO_REVIEWER };
    }
    const { verdict, reason, cause } = await review();
    if (verdict === "allow") return { decision: "allow_once", source: "adversarial" };
    if (verdict === "deny") return { decision: "deny", source: "adversarial" };
    // The account cannot pay for inference, so the reviewer the user chose can
    // never run. Deny — and say why, in a form the calling agent can read.
    // Quietly reverting to prompting a human would change the mode the user
    // configured, and would hide a standing condition behind one more dialog.
    if (cause === "no_credits") {
      return { decision: "deny", source: DENIAL_SOURCE_NO_CREDITS };
    }
    // Any other "ask" — the reviewer could not decide; hand it to the human,
    // telling them what it said rather than prompting them out of nowhere.
    return {
      decision: await deps.openApproval(Promise.resolve({ decision: null, reason })),
      source: "ask",
    };
  }

  // Ask mode: show the dialog, optionally with the reviewer's hint when both
  // the toggle and a credential are present. A 402 here costs only the hint —
  // the human was always the decider.
  //
  // A hint is a nicety, so it is skipped when the provider has no credential:
  // running a review that cannot run would buy an audit pair and a null
  // suggestion. Not a gate — nothing the human chose is refused by it.
  const hint =
    settings.showAgentSuggestions && reviewerAvailable(settings)
      ? review().then((r) => ({
          decision:
            r.verdict === "allow"
              ? ("allow_once" as const)
              : r.verdict === "deny"
                ? ("deny" as const)
                : null,
          reason: r.reason,
        }))
      : null;
  return { decision: await deps.openApproval(hint), source: "ask" };
}
