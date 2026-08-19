/**
 * The continuation lifecycle: what happened to an approval after the call that
 * asked for it stopped waiting.
 *
 * An approval can outlive its tool call. The call hands back a handle at the
 * budget, the human answers later, and the result sits until the agent comes
 * back for it — or never does. Nothing recorded which of those happened, so a
 * user watching the approval window could only guess whether the agent was
 * still coming.
 *
 * Two rules shape everything here:
 *
 *  - **Nothing is inferred from elapsed time.** `backgrounded` means the relay
 *    said it matched our response to the exchange waiting on it, and nothing
 *    else. A countdown running out is a prediction; an acknowledgement is an
 *    observation, and only observations move this machine.
 *  - **`collected` is a local boundary.** It means an authorized `get_result`
 *    reached this Mac and a payload was generated — never that a model read it.
 *    The audit copy says the agent requested the result, for that reason.
 *
 * The deferred handle is deliberately absent from every audit record. Records
 * carry the intent id, which is what groups them into one operation in the
 * activity view, and which the human has already seen.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { JSONValue } from "@domo/protocol";

/** §4's user-visible states. */
export type ContinuationState =
  /** The original call is still open; the window shows the measured remainder. */
  | "waiting_inline"
  /** The relay acknowledged matching our response to the waiting exchange. */
  | "backgrounded"
  /** Approved, result ready, and no authorized lookup has reached this Mac. */
  | "approved_uncollected"
  /** An authorized lookup reached this Mac and the payload was generated. */
  | "collected"
  /** Retention elapsed before any authorized lookup. */
  | "expired"
  | "denied"
  | "failed";

/**
 * The audit events this module adds.
 *
 * "Permission requested" and "decision made" are NOT here: `intent_received`
 * and `intent_decision` already record them against the same intent id, and a
 * second line saying the same thing would split one operation's timeline in
 * two rather than complete it.
 */
export const CONTINUATION_EVENTS = {
  backgrounded: "continuation_backgrounded",
  deliveryUnknown: "continuation_delivery_unknown",
  ready: "continuation_result_ready",
  collected: "continuation_result_requested",
  expired: "continuation_result_expired",
} as const;

/** What the machine accepts, and from where. Everything else is refused. */
const LEGAL: Record<ContinuationState, ContinuationState[]> = {
  waiting_inline: ["backgrounded", "approved_uncollected", "denied", "failed", "expired"],
  backgrounded: ["approved_uncollected", "denied", "failed", "expired"],
  approved_uncollected: ["collected", "expired"],
  collected: [],
  expired: [],
  denied: [],
  failed: [],
};

/** Just enough of `AuditLog` to record against, so tests need no filesystem. */
export interface ContinuationAudit {
  record(event: string, fields?: { [k: string]: JSONValue | undefined }): void;
}

/**
 * The relay exchange a tool call is being served on.
 *
 * Async-local because one process serves several agents at once: a module-level
 * "current rid" would attach one agent's deferred handle to another's exchange,
 * and the acknowledgement would then move the wrong operation to backgrounded.
 */
export const exchangeContext = new AsyncLocalStorage<{ rid: string }>();

interface Record_ {
  agentId: string;
  intentId: string | null;
  state: ContinuationState;
  /** The exchange the pending envelope went out on, once it has gone out. */
  rid: string | null;
}

export class Continuations {
  private readonly byHandle = new Map<string, Record_>();
  private readonly byRid = new Map<string, Set<string>>();

  constructor(private readonly audit: ContinuationAudit) {}

  /** A deferrable call has started. Nothing is audited yet — the intent it is
   * about does not exist until the tool builds one. */
  open(handle: string, agentId: string): void {
    this.byHandle.set(handle, { agentId, intentId: null, state: "waiting_inline", rid: null });
  }

  /** The tool built its intent: from here every record can name the operation. */
  linkIntent(handle: string, intentId: string): void {
    const rec = this.byHandle.get(handle);
    if (rec) rec.intentId = intentId;
  }

  /**
   * The call answered inside its budget, so nothing outlived it. The record is
   * dropped rather than driven to a terminal state: the states here describe an
   * operation the agent has to come back for, and this one it never left.
   */
  closeInline(handle: string): void {
    this.forget(handle);
  }

  /**
   * A pending envelope went back to the agent. Remembers which exchange carried
   * it, because that is the only thing an acknowledgement names.
   */
  deferred(handle: string): void {
    const rec = this.byHandle.get(handle);
    if (!rec) return;
    const rid = exchangeContext.getStore()?.rid ?? null;
    rec.rid = rid;
    if (rid === null) return;
    let handles = this.byRid.get(rid);
    if (!handles) {
      handles = new Set();
      this.byRid.set(rid, handles);
    }
    handles.add(handle);
  }

  /** The relay matched the response for `rid` to the exchange waiting on it. */
  acknowledgeExchange(rid: string): void {
    for (const handle of this.byRid.get(rid) ?? []) {
      this.transition(handle, "backgrounded", CONTINUATION_EVENTS.backgrounded);
    }
    this.byRid.delete(rid);
  }

  /**
   * The response for `rid` went out and was never acknowledged — the socket
   * died, or the exchange could no longer be open.
   *
   * Records the uncertainty and moves nothing: a lost acknowledgement is not
   * evidence of failure any more than of success, and claiming backgrounding
   * here is exactly the lie this module exists to prevent.
   */
  exchangeDeliveryUnknown(rid: string): void {
    for (const handle of this.byRid.get(rid) ?? []) {
      const rec = this.byHandle.get(handle);
      if (rec?.intentId) {
        this.audit.record(CONTINUATION_EVENTS.deliveryUnknown, { intentId: rec.intentId });
      }
    }
    this.byRid.delete(rid);
  }

  /** The work landed and a payload is waiting for whoever asks. */
  ready(handle: string): void {
    this.transition(handle, "approved_uncollected", CONTINUATION_EVENTS.ready);
  }

  /** The owner said no. Already audited as a decision; this is the state only. */
  denied(handle: string): void {
    this.transition(handle, "denied", null);
  }

  /** The work failed. Already audited by whatever failed; state only. */
  failed(handle: string): void {
    this.transition(handle, "failed", null);
  }

  /**
   * An authorized lookup reached this Mac and generated the payload.
   *
   * Non-consuming, and audited exactly once: repeated reads answer the same
   * payload, and a timeline claiming the agent asked four times because it
   * polled four times would be describing the poller, not the operation.
   */
  collected(handle: string): void {
    this.transition(handle, "collected", CONTINUATION_EVENTS.collected);
  }

  /** Retention elapsed with the result never looked up. */
  expired(handle: string): void {
    this.transition(handle, "expired", CONTINUATION_EVENTS.expired);
  }

  /** The state of one operation, for tests and for the window to render. */
  state(handle: string): ContinuationState | null {
    return this.byHandle.get(handle)?.state ?? null;
  }

  /** The operation this handle belongs to, or null before the tool built one. */
  intentOf(handle: string): string | null {
    return this.byHandle.get(handle)?.intentId ?? null;
  }

  /** How many operations are tracked. Lets a test see records being dropped. */
  get size(): number {
    return this.byHandle.size;
  }

  /**
   * Move one record, recording the event if the move was legal.
   *
   * An illegal move is dropped, silently and deliberately: the caller is the
   * deferred store reporting something it observed twice — a second poll on a
   * collected result, an expiry sweep over a denied one — and neither is worth
   * an exception. What matters is that no event is recorded for it, so the
   * timeline never says a thing happened twice.
   */
  private transition(handle: string, to: ContinuationState, event: string | null): void {
    const rec = this.byHandle.get(handle);
    if (!rec) return;
    if (!LEGAL[rec.state].includes(to)) return;
    rec.state = to;
    if (event !== null && rec.intentId !== null) {
      this.audit.record(event, { intentId: rec.intentId });
    }
  }

  private forget(handle: string): void {
    const rec = this.byHandle.get(handle);
    if (rec?.rid) {
      const handles = this.byRid.get(rec.rid);
      handles?.delete(handle);
      if (handles && handles.size === 0) this.byRid.delete(rec.rid);
    }
    this.byHandle.delete(handle);
  }
}
