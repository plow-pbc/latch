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
import {
  agentHistory,
  PLOW_REVIEWER_INFO,
  PLOW_REVIEWER_MODEL,
  REVIEWER_INFO,
  REVIEWER_MODEL,
  ReviewArgs,
  Verdict,
} from "./adversarialAgent.js";
import { InferenceProvider, Settings } from "./settings.js";

export type ApprovalDecision = "allow_once" | "always_allow" | "deny";

/** Which providers this Mac currently holds a credential for. */
export interface ProviderAvailability {
  plow: boolean;
  anthropic: boolean;
}

/**
 * What the renderer is allowed to know about inference: the selection, which
 * providers are usable, and what the active one runs. **No credentials** — not
 * the relay credential, not the Anthropic key, not a prefix of either.
 */
export interface InferenceStatus {
  provider: InferenceProvider;
  plowAvailable: boolean;
  anthropicAvailable: boolean;
  /** Model + limits of the *active* provider, for display. */
  info: string;
}

const PROVIDERS: InferenceProvider[] = ["plow", "anthropic"];

/**
 * The stored selection, defaulting to Plow. An absent field reads as `plow`, and
 * so does anything unrecognised — a hand-edited settings.json must not be able
 * to put the reviewer into an undefined state.
 */
export function activeProvider(settings: Pick<Settings, "inferenceProvider">): InferenceProvider {
  const stored = settings.inferenceProvider;
  return PROVIDERS.includes(stored as InferenceProvider) ? (stored as InferenceProvider) : "plow";
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
  const availability = providerAvailability(settings);
  return {
    provider,
    plowAvailable: availability.plow,
    anthropicAvailable: availability.anthropic,
    info: reviewerInfo(provider),
  };
}

/** Can the reviewer run at all right now? */
export function reviewerAvailable(settings: Settings): boolean {
  return providerAvailability(settings)[activeProvider(settings)];
}

/**
 * Adversarial mode is only meaningful with a working reviewer. When the active
 * provider has no credential — the key was cleared, the Mac was signed out, the
 * provider was switched — the mode falls back to Ask, exactly as it always has
 * when the Anthropic key was cleared.
 *
 * Returns the mode to store, so the caller decides whether to persist.
 */
export function modeAfterAvailabilityChange(settings: Settings): Settings["approvalMode"] {
  const mode = settings.approvalMode ?? "ask";
  if (mode === "adversarial" && !reviewerAvailable(settings)) return "ask";
  return mode;
}

/** Everything `decideIntent` needs from the outside world, injected for tests. */
export interface DecideDeps {
  settings: Settings;
  /** Plow API origin. Baked into the build, never a setting. */
  apiBaseUrl: string;
  /** The audit log's current entries, for the reviewer's history context. */
  auditEntries: () => JSONValue[];
  record: (event: string, fields: Record<string, JSONValue>) => void;
  review: (args: ReviewArgs) => Promise<{ verdict: Verdict; reason: string }>;
  /** Show the human the approval dialog, optionally hinting a button. */
  openApproval: (
    suggestion: Promise<ApprovalDecision | null> | null,
  ) => Promise<ApprovalDecision>;
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
  const available = providerAvailability(settings)[provider];

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
      apiBaseUrl: deps.apiBaseUrl,
    });
    deps.record("adversarial_review_result", {
      intentId: intent.intentId,
      verdict: r.verdict,
      reason: r.reason,
    });
    return r;
  };

  if (mode === "adversarial" && available) {
    const { verdict } = await review();
    if (verdict === "allow") return { decision: "allow_once", source: "adversarial" };
    if (verdict === "deny") return { decision: "deny", source: "adversarial" };
    // "ask" — the agent couldn't decide; hand it to the human (no suggestion).
    return { decision: await deps.openApproval(null), source: "ask" };
  }

  // Ask mode (or adversarial with no credential): show the dialog, optionally
  // with a suggestion when both the toggle and a credential are present.
  const suggestion =
    settings.showAgentSuggestions && available
      ? review().then((r) =>
          r.verdict === "allow" ? "allow_once" : r.verdict === "deny" ? "deny" : null,
        )
      : null;
  return { decision: await deps.openApproval(suggestion), source: "ask" };
}
