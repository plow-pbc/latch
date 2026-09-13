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
  APPROVAL_SOURCE_PLOW_FOLDER,
  confinedToPlowFolder,
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
import { DEFAULT_APPROVAL_MODE, Settings } from "./settings.js";

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
    approvalMode: settings.approvalMode ?? DEFAULT_APPROVAL_MODE,
  };
}

/** Can the reviewer run at all right now? Exactly: is this Mac signed in. */
export function reviewerAvailable(settings: Settings): boolean {
  return !!(settings.relayCredential ?? "").trim();
}

/**
 * May a stored always-allow rule answer on its own?
 *
 * Only under the modes that would let a cached human decision stand. A rule is
 * one human decision replayed, and the policy engine replays it BEFORE any
 * delegate is consulted — so a mode that takes the decision away from the
 * human has to say so here or be bypassed by every operation they ever pressed
 * "always allow" on.
 *
 * Two modes take it away. `adversarial` gives it to the reviewer; `deny`
 * refuses everything, and a cached allow must not outrank it.
 *
 * Refusing here is not itself a denial. It routes the intent down the normal
 * path, where `decideIntent` runs the review or denies as the mode requires.
 */
export function storedRuleMayGrant(settings: Settings): boolean {
  const mode = settings.approvalMode ?? DEFAULT_APPROVAL_MODE;
  return mode !== "adversarial" && mode !== "deny";
}

/**
 * A decision and HOW it was reached, for the audit log — and, on an
 * `always_allow`, whether its rule is already in place (stored by the dialog
 * path, or the rule that answered), so the engine does not store it again
 * (PolicyEngine's `IntentDecision`).
 */
export type Decided = { decision: ApprovalDecision; source: string; ruleStored?: true };

/** A request waiting its turn for the human. */
export interface QueuedApproval {
  /**
   * Answer without a dialog, if something decided this request while it
   * waited — a rule stored by an "always allow" ahead of it. Null: wait.
   */
  preempt: () => Promise<Decided | null>;
  /** Show the dialog. Runs only when no other dialog is open. */
  show: () => Promise<Decided>;
}

/**
 * One dialog at a time. Two approval windows must never overlap, so every
 * request waits its turn here. A request is `preempt`ed rather than shown
 * whenever something has already decided it: `sweep` asks every waiting
 * request at once, the moment a rule is stored, so [A, B, A] answered
 * "always allow" on the first A leaves the human with [B] — the second A is
 * granted right then, not when its turn would have come. The head of the
 * line is asked once more before its dialog opens, for a rule that landed
 * between a sweep and its turn. A dialog that throws fails its own request
 * and nothing behind it.
 */
export class ApprovalQueue {
  private busy = false;
  private line: { entry: QueuedApproval; resolve: (d: Decided) => void; reject: (e: unknown) => void }[] = [];

  run(entry: QueuedApproval): Promise<Decided> {
    return new Promise<Decided>((resolve, reject) => {
      this.line.push({ entry, resolve, reject });
      void this.advance();
    });
  }

  /** Something may now answer waiting requests: settle every one it does, in place. */
  async sweep(): Promise<void> {
    for (const waiting of [...this.line]) {
      const answer = await waiting.entry.preempt().catch(() => null);
      if (answer === null) continue;
      const at = this.line.indexOf(waiting);
      if (at < 0) continue; // its turn came, and it answered for itself
      this.line.splice(at, 1);
      waiting.resolve(answer);
    }
  }

  private async advance(): Promise<void> {
    if (this.busy) return;
    const next = this.line.shift();
    if (!next) return;
    this.busy = true;
    try {
      next.resolve((await next.entry.preempt()) ?? (await next.entry.show()));
    } catch (e) {
      next.reject(e);
    } finally {
      this.busy = false;
      void this.advance();
    }
  }
}

/** Everything `decideIntent` needs from the outside world, injected for tests. */
export interface DecideDeps {
  settings: Settings;
  /** Plow API origin. Baked into the build, never a setting. */
  apiBaseUrl: string;
  /**
   * The owner's `~/Plow` folder — the playground. File operations confined to
   * it are granted without a reviewer or a dialog (see `confinedToPlowFolder`
   * for what "confined" refuses). Deny mode outranks it.
   */
  plowRoot: string;
  /**
   * The audit log's current entries. NOT review context any more — nothing
   * below reads this, and the reviewer is handed `history: []` (DESIGN.md
   * §4). It comes out with `ReviewArgs.history` (#140).
   */
  auditEntries: () => JSONValue[];
  record: (event: string, fields: Record<string, JSONValue>) => void;
  review: (
    args: ReviewArgs,
  ) => Promise<{
    verdict: Verdict;
    reason: string;
    cause?: ReviewFailureCause;
  }>;
  /**
   * Show the human the approval dialog, optionally with the reviewer's say.
   * Not serialized by the caller: `decideIntent` runs it through `queue`.
   */
  openApproval: (hint: Promise<ReviewHint> | null) => Promise<ApprovalDecision>;
  /** The one queue every dialog on this Mac goes through. */
  queue: ApprovalQueue;
  /**
   * Does a stored always-allow rule cover this intent NOW, under the current
   * mode? The policy engine asked once, before this delegate was consulted;
   * this asks again when the dialog's turn comes, because the answer can
   * have changed while it waited (the engine's `ruleAnswers`).
   */
  ruleAnswers: () => Promise<boolean>;
  /**
   * Store this intent's always-allow rule now (the engine's `storeRule`).
   * Called the moment the human answers "always allow", while the dialog
   * still holds the queue: the next dialog in line asks `ruleAnswers` as
   * soon as this one lets go, and the engine's own store, which waits for
   * the answer to travel back up through `decide`, comes a few microtasks
   * too late for it.
   */
  storeRule: () => void;
}

/**
 * Decide one intent. The returned `source` records HOW it was decided, for the
 * audit log.
 *
 * The adversarial-agent features need a Plow credential; without one,
 * adversarial mode denies (`DENIAL_SOURCE_NO_REVIEWER`) and Ask
 * mode's suggestions are skipped.
 */
export async function decideIntent(intent: Intent, deps: DecideDeps): Promise<Decided> {
  const { settings } = deps;
  const mode = settings.approvalMode ?? DEFAULT_APPROVAL_MODE;

  if (mode === "deny") return { decision: "deny", source: "policy" };

  // The playground: file operations confined to ~/Plow are granted here, in
  // every mode that grants anything — no review spent, no dialog raised. After
  // the deny return above ON PURPOSE: deny mode is the owner's kill switch,
  // and the carve-out must not outrank it.
  if (await confinedToPlowFolder(intent.capabilities, deps.plowRoot)) {
    return { decision: "allow_once", source: APPROVAL_SOURCE_PLOW_FOLDER };
  }

  /** Is the reviewer the decider for this intent? */
  // Approve: the whole point of the mode, for every intent — a script that
  // runs outside the sandbox included. Above the reviewer, because by here
  // `deny` has already returned and `ask` still wants the human.
  if (mode === "approve") return { decision: "allow_once", source: "approve" };

  const reviewDecides = mode === "adversarial";

  // Run one review, recording its start and outcome onto the intent's audit
  // timeline so the app shows "adversarial agent started" + its verdict between
  // the request and the final decision.
  // A review that decides has no human behind it, and the reviewer is told so
  // rather than left to infer it from the owner's freeform purpose text. Ask
  // mode is the other way round: the dialog is coming either way, so a reviewer
  // that wants to defer is saying something the human will actually see.
  const humanAvailable = !reviewDecides;

  const review = async () => {
    deps.record("adversarial_review_started", {
      intentId: intent.intentId,
      agent: intent.agentId,
      // The model that actually ran — the audit log is the test oracle, so it
      // must not name one that never saw this intent.
      model: REVIEWER_MODEL,
    });
    const r = await deps.review({
      intent,
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

  if (reviewDecides) {
    // No credential is no reviewer, and this intent has no other decider: the
    // mode that got here has no human in it. Auto-approving would hand the
    // agent exactly the access the mode exists to gate.
    //
    // Decide this BEFORE `review()`, which opens the timeline with "adversarial
    // agent started" and names the model it is about to use. With no credential
    // there is no call and no model, so recording one would put a reviewer that
    // never ran into the audit log — and the audit log is the oracle.
    if (!reviewerAvailable(settings)) {
      return { decision: "deny", source: DENIAL_SOURCE_NO_REVIEWER };
    }
    const { verdict, reason, cause } = await review();
    if (verdict === "allow")
      return { decision: "allow_once", source: "adversarial" };
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

  // Ask mode: show the dialog, with the reviewer's hint whenever a credential
  // is present. A 402 here costs only the hint — the human was always the
  // decider.
  //
  // A hint is a nicety, so it is skipped when there is no credential:
  // running a review that cannot run would buy an audit pair and a null
  // suggestion. Not a gate — nothing the human chose is refused by it.
  const hint =
    reviewerAvailable(settings)
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
  return deps.queue.run({
    // A dialog ahead of this one in the queue may have been answered "always
    // allow", storing a rule that covers this intent too. Then the human has
    // already decided it: it is granted the way the engine grants a matching
    // rule — as the rule's answer, not the dialog's — and no window opens.
    // `ruleStored`: this answer came FROM a rule, so the engine has nothing to
    // store — and must not, or a rule revoked while the answer travels back
    // through the approval store's write would come back.
    preempt: async () =>
      (await deps.ruleAnswers()) ? { decision: "always_allow", source: "rule", ruleStored: true } : null,
    show: async () => {
      const decision = await deps.openApproval(hint);
      if (decision === "always_allow") {
        // Stored, then every request still waiting is asked whether the new
        // rule covers it — before this dialog's own answer goes back, so
        // the ones it covers are granted now and never reach the human.
        //
        // DELIBERATELY ahead of the approval store's deadline check. That
        // deadline is the REQUEST's: an answer past it denies the request as
        // expired, because the agent's call is long stale. The rule is not
        // stale — it is the owner's standing choice about exactly the bound
        // they were shown, and would be asked for again on the next matching
        // request only to get the same click. So a late "always allow" keeps
        // its rule, and the audit log says so: `rule_stored` is written when
        // the rule is, and the decision line then says what the request got.
        deps.storeRule();
        await deps.queue.sweep();
        return { decision, source: "ask", ruleStored: true };
      }
      return { decision, source: "ask" };
    },
  });
}
