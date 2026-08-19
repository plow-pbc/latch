/**
 * What the approval window says about an approval that may outlive its call.
 *
 * Pure, like `viewModel.ts`, and for the same reason: the window's honesty is
 * the product here, so what it claims has to be checkable without a display.
 *
 * Three rules shape the copy:
 *
 *  - **The countdown is a prediction; everything else is a record.** Time
 *    running out does not mean the agent stopped waiting, and the window never
 *    says it did. `backgrounded` appears only when the relay has acknowledged
 *    the handoff, which arrives as a state change, never as a timer here.
 *  - **The remainder is measured, not promised.** The window is handed the
 *    absolute deadline of the call, not a fresh budget: validation, path
 *    resolution and writing the approval down have already spent part of it,
 *    and a countdown that rounds in the user's favour is worse than none.
 *  - **The copy action exists only while it would help.** It is the sentence
 *    that gets a hosted agent to come back for a result that is sitting ready.
 *    Once collected, or once retention has taken it, there is nothing to
 *    resume and offering the phrase would be an instruction to waste a turn.
 */

/** The lifecycle states the window renders — mirrors `ContinuationState`. */
export type ContinuationPhase =
  | "waiting_inline"
  | "backgrounded"
  | "approved_uncollected"
  | "collected"
  | "expired"
  | "denied"
  | "failed";

/** The sentence a user reads to their agent to have it come back for a result. */
export const CONTINUE_PHRASE = "Continue the pending Plow request.";

/** How long a backgrounded confirmation lingers before closing itself (§4). */
export const CONFIRMATION_LINGER_MS = 30_000;

export interface ContinuationInput {
  /** The recorded state, or null when nothing is tracking this approval. */
  state: ContinuationPhase | null;
  /** Absolute deadline of the originating call, or null when unknown. */
  deadlineAt: number | null;
  now: number;
  /** Whether the human has already answered this prompt. */
  decided: boolean;
}

export interface ContinuationView {
  /** Rendered above the capability card, or absent when there is nothing to say. */
  headline: string | null;
  detail: string | null;
  /** Measured milliseconds left of the call, or null when there is no countdown. */
  remainingMs: number | null;
  /** The window has become a confirmation: the decision is in, the agent is not. */
  confirmation: boolean;
  /** Offer to copy `CONTINUE_PHRASE` — only while a ready result is uncollected. */
  showCopy: boolean;
  /** Nothing is left to watch: the window should close itself. */
  closed: boolean;
}

const EMPTY: ContinuationView = {
  headline: null,
  detail: null,
  remainingMs: null,
  confirmation: false,
  showCopy: false,
  closed: false,
};

/** Whole seconds left, rounded up so "1s" never means "already gone". */
export function secondsLeft(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

export function continuationView(input: ContinuationInput): ContinuationView {
  const { state, deadlineAt, now, decided } = input;
  if (state === null) return EMPTY;

  switch (state) {
    case "waiting_inline": {
      if (decided) {
        // Answered while the call was still open: the result goes back on that
        // call, and there is nothing for the user to do next.
        return { ...EMPTY, closed: true };
      }
      const remainingMs = deadlineAt === null ? null : Math.max(0, deadlineAt - now);
      return {
        ...EMPTY,
        // The clock lives in ONE place — the countdown line. Spelling the
        // seconds into the headline as well gave the window two of them,
        // ticking a beat apart as they re-rendered.
        headline: "The agent is still waiting on this call.",
        // Deliberately not "hurry up": running out costs the user nothing, it
        // just changes how the answer gets back to the agent.
        detail: "Answer now and the agent gets the result on the call it is holding.",
        remainingMs,
      };
    }

    case "backgrounded":
      return {
        ...EMPTY,
        headline: "The agent stopped waiting on this call.",
        detail: `Your answer still counts. After approving, return to your agent and say: “${CONTINUE_PHRASE}”`,
        confirmation: decided,
      };

    case "approved_uncollected":
      return {
        ...EMPTY,
        headline: "Approved — the result is ready and waiting.",
        detail: `The agent has not asked for it yet. Return to it and say: “${CONTINUE_PHRASE}”`,
        confirmation: decided,
        showCopy: true,
      };

    case "collected":
      // The agent came back and took it. Nothing left to watch.
      return { ...EMPTY, closed: true };

    case "expired":
      return {
        ...EMPTY,
        headline: "The result is no longer available.",
        detail: "The agent did not come back in time. Ask it to make the request again.",
        confirmation: decided,
      };

    case "denied":
    case "failed":
      return { ...EMPTY, closed: true };
  }
}
