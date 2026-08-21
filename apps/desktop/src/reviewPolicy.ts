/**
 * How an operation intent gets decided — the branching between approval mode,
 * credential availability, and the human dialog.
 *
 * This lives outside the Electron entry on purpose (same reason as
 * `viewModel.ts` and `spawnAgent.ts`): it is the security-relevant decision
 * path, so it has to be reachable by `npx vitest run` with no display and no
 * device. `main.ts` keeps only the Electron-shaped adapter around it.
 */
import { Intent, JSONValue } from "@domo/protocol";
import {
  DENIAL_SOURCE_NO_CREDITS,
  DENIAL_SOURCE_NO_REVIEWER,
  DENIAL_SOURCE_REVIEWER_UNAVAILABLE,
} from "@domo/device-core";
import {
  REVIEWER_MODEL,
  ReviewArgs,
  ReviewFailureCause,
  Verdict,
} from "./adversarialAgent.js";
import { Settings } from "./settings.js";

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

/**
 * What the renderer is allowed to know about inference: whether the reviewer
 * can run. **No credentials** — not the relay credential, not a prefix of one.
 */
export interface InferenceStatus {
  /** Whether this Mac holds the credential the reviewer needs. */
  available: boolean;
  /**
   * The stored approval mode, in the SAME snapshot as availability. Reading the
   * two separately gave the renderer two async views of one settings file, and
   * a window where they disagreed.
   */
  approvalMode: Settings["approvalMode"];
}

/** The renderer-facing shape. Built here so there is one definition of "safe". */
export function inferenceStatus(settings: Settings): InferenceStatus {
  return {
    available: reviewerAvailable(settings),
    approvalMode: settings.approvalMode ?? "ask",
  };
}

/** Can the reviewer run at all right now? Exactly: is this Mac signed in. */
export function reviewerAvailable(settings: Settings): boolean {
  return !!(settings.relayCredential ?? "").trim();
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
  /**
   * What this Mac can establish about the operation on its own — the origins a
   * live browser session already holds, a vault item's category and whether it
   * belongs to the page in front of it.
   *
   * Injected rather than read here because it is device state (the vault
   * broker, the browser sessions) and this file must stay runnable with no
   * display and no device. Absent means "nothing to add", which is the honest
   * answer for every operation that is not a credential fill.
   */
  deviceFacts?: (intent: Intent) => Promise<string[]>;
  /** Show the human the approval dialog, optionally with the reviewer's say. */
  openApproval: (hint: Promise<ReviewHint> | null) => Promise<ApprovalDecision>;
}

/**
 * Decide one intent. The returned `source` records HOW it was decided, for the
 * audit log.
 *
 * The adversarial-agent features need a Plow credential; without one,
 * adversarial mode denies (`DENIAL_SOURCE_NO_REVIEWER`) and Ask
 * mode's suggestions are skipped.
 */
export async function decideIntent(
  intent: Intent,
  deps: DecideDeps,
): Promise<{ decision: ApprovalDecision; source: string }> {
  const { settings } = deps;
  const mode = settings.approvalMode ?? "ask";

  if (mode === "approve") return { decision: "allow_once", source: "approve" };
  if (mode === "deny") return { decision: "deny", source: "policy" };

  // Run one review, recording its start and outcome onto the intent's audit
  // timeline so the app shows "adversarial agent started" + its verdict between
  // the request and the final decision.
  // Adversarial mode has no human in it, and the reviewer is told so rather
  // than left to infer it from the owner's freeform purpose text. Ask mode is
  // the other way round: the dialog is coming either way, so a reviewer that
  // wants to defer is saying something the human will actually see.
  const humanAvailable = mode !== "adversarial";

  const review = async () => {
    deps.record("adversarial_review_started", {
      intentId: intent.intentId,
      agent: intent.agentId,
      // The model that actually ran — the audit log is the test oracle, so it
      // must not name one that never saw this intent.
      model: REVIEWER_MODEL,
    });
    const facts = deps.deviceFacts ? await deps.deviceFacts(intent) : [];
    const r = await deps.review({
      intent,
      // Established on this Mac at decision time. The prompt says so, and says
      // it in a line the agent cannot write into.
      deviceFacts: facts,
      // Nothing about the past. The reviewer reasoned from a growing pile of
      // earlier operations rather than from the request, and each denial fed
      // the next; it now sees this operation and nothing else.
      history: [],
      // A SECRET. It reaches the Authorization header of the Plow request and
      // nothing else — never the audit record below, never the renderer.
      plowCredential: (settings.relayCredential ?? "").trim(),
      // Device-side and human-authored: it comes from the settings file, so no
      // agent-reachable path can write what the prompt will label TRUSTED.
      agentPurpose: settings.agentPurpose ?? "",
      apiBaseUrl: deps.apiBaseUrl,
      humanAvailable,
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
    // The account cannot pay for inference, so the reviewer can never run.
    // Deny — and say why, in a form the calling agent can read.
    // Quietly reverting to prompting a human would change the mode the user
    // configured, and would hide a standing condition behind one more dialog.
    if (cause === "no_credits") {
      return { decision: "deny", source: DENIAL_SOURCE_NO_CREDITS };
    }
    // Any other "ask". This mode has no human in it — the owner chose "the
    // reviewer decides", and a modal here contradicts the setting: it appears
    // on a Mac whose owner has said they are not answering, waits out its
    // fifteen minutes, and holds every request behind it while it does, because
    // approvals are serialized. So the fallback is a verdict.
    //
    // Deny, because it is the fail-closed answer and because nothing that
    // arrives here is an argument for access: the reviewer never reached a
    // verdict.
    //
    // One source, not two. There used to be a second — a reviewer that ran and
    // declined to decide — but `ask` is no longer in the schema the model
    // answers into, and an `ask` that arrives anyway is refused at the parse
    // and comes back carrying `unavailable`. Nothing can reach this line
    // without that cause, so a branch on it would be picking between a live
    // source and a dead one.
    return { decision: "deny", source: DENIAL_SOURCE_REVIEWER_UNAVAILABLE };
  }

  // Ask mode: show the dialog, optionally with the reviewer's hint when both
  // the toggle and a credential are present. A 402 here costs only the hint —
  // the human was always the decider.
  //
  // A hint is a nicety, so it is skipped when there is no credential:
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
