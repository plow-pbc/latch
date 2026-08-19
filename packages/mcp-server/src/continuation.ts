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
 * **One outcome, two independent observations.** The first shape here made
 * `backgrounded` and `collected` states in the same machine as `ready`,
 * `denied` and `failed`, so they overwrote each other: an acknowledgement
 * arriving after the result landed was dropped, and looking up a denial
 * rewrote the denial as a collection. They are not alternatives. The outcome
 * is what became of the work; whether the relay acknowledged the handle, and
 * whether an authorized lookup has reached this Mac, are two separate facts
 * about it, each observed at most once.
 *
 * The rest of the rules:
 *
 *  - **Nothing is inferred from elapsed time.** `backgrounded` means the relay
 *    said it matched our response to the exchange waiting on it, and nothing
 *    else. A countdown running out is a prediction; an acknowledgement is an
 *    observation, and only observations are recorded here.
 *  - **`collected` is a local boundary.** It means an authorized `get_result`
 *    reached this Mac and a payload was generated — never that a model read it.
 *    The audit copy says the agent requested the result, for that reason.
 *  - **Only a terminal, uncollected result expires.** Work still pending when
 *    retention elapses has not "expired" in any sense a user cares about, and
 *    letting it say so would have an operation reported dead and then, when the
 *    human finally answered, alive again.
 *
 * The deferred handle is deliberately absent from every audit record. Records
 * carry the intent id, which is what groups them into one operation in the
 * activity view, and which the human has already seen.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { JSONValue } from "@domo/protocol";

/** §4's user-visible states, derived from the outcome and the observations. */
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

/** What became of the work itself. */
export type ContinuationOutcome = "pending" | "ready" | "denied" | "failed" | "expired";

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

/** What the relay said about one exchange's delivery. One of, at most once. */
type Delivery = "ack" | "unknown";

interface Record_ {
  agentId: string;
  intentId: string | null;
  /**
   * When the call that opened this stops waiting, as an absolute time.
   *
   * The window shows the MEASURED remainder of it. Handing the window a
   * duration instead would promise a fresh budget after validation, path
   * resolution and persistence had already spent part of it — a countdown
   * that lies in the user's favour is worse than none.
   */
  deadlineAt: number | null;
  outcome: ContinuationOutcome;
  /** The relay acknowledged the exchange that carried this handle. */
  acknowledged: boolean;
  /** An authorized lookup reached this Mac. */
  collected: boolean;
  /** The exchange the pending envelope went out on, once it has gone out. */
  rid: string | null;
  /**
   * Events observed before the tool had built its intent, waiting for one.
   *
   * The budget can fire before an intent exists at all — a path resolution on a
   * slow volume is enough — so the acknowledgement for that envelope can land
   * while this record still has nothing to name. Dropping those observations
   * lost exactly the timeline the user is owed.
   */
  buffered: string[];
}

export class Continuations {
  /**
   * Emits "change" with `{ intentId, state }` on every recorded move.
   *
   * The approval window transitions on these and on nothing else: §4 is
   * explicit that the UI follows recorded state, not a renderer-side timer.
   * The countdown is the one prediction it is allowed to make.
   */
  readonly events = new EventEmitter();
  private readonly byHandle = new Map<string, Record_>();
  private readonly byIntent = new Map<string, string>();
  private readonly byRid = new Map<string, Set<string>>();
  /**
   * Deliveries observed for an exchange nothing was attached to yet.
   *
   * A socket that dies while the approval is still being decided settles its
   * exchange before any handle has been minted, let alone attached. Holding the
   * observation lets the handle pick it up when it arrives.
   */
  private readonly deliveryByRid = new Map<string, Delivery>();

  constructor(private readonly audit: ContinuationAudit) {}

  /** A deferrable call has started. Nothing is audited yet — the intent it is
   * about does not exist until the tool builds one. */
  open(handle: string, agentId: string, deadlineAt: number | null = null): void {
    this.byHandle.set(handle, {
      agentId,
      intentId: null,
      deadlineAt,
      outcome: "pending",
      acknowledged: false,
      collected: false,
      rid: null,
      buffered: [],
    });
  }

  /**
   * The tool built its intent: from here every record can name the operation,
   * including anything observed while it could not.
   */
  linkIntent(handle: string, intentId: string): void {
    const rec = this.byHandle.get(handle);
    if (!rec || rec.intentId !== null) return;
    rec.intentId = intentId;
    this.byIntent.set(intentId, handle);
    const held = rec.buffered.splice(0);
    for (const event of held) this.audit.record(event, { intentId });
    this.announce(rec);
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
   * it, because that is the only thing a delivery observation names — and picks
   * up an observation that already landed for it.
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
    const already = this.deliveryByRid.get(rid);
    if (already) this.observe(handle, already);
  }

  /** The relay matched the response for `rid` to the exchange waiting on it. */
  acknowledgeExchange(rid: string): void {
    this.settleExchange(rid, "ack");
  }

  /**
   * The response for `rid` will never be acknowledged — the socket died, or the
   * exchange could no longer be open.
   *
   * Records the uncertainty and changes no outcome: a lost acknowledgement is
   * not evidence of failure any more than of success, and claiming
   * backgrounding here is exactly the lie this module exists to prevent.
   */
  exchangeDeliveryUnknown(rid: string): void {
    this.settleExchange(rid, "unknown");
  }

  /** The work landed and a payload is waiting for whoever asks. */
  ready(handle: string): void {
    this.settleOutcome(handle, "ready", CONTINUATION_EVENTS.ready);
  }

  /** The owner said no. Already audited as a decision; this is the outcome. */
  denied(handle: string): void {
    this.settleOutcome(handle, "denied", null);
  }

  /** The work failed. Already audited by whatever failed; outcome only. */
  failed(handle: string): void {
    this.settleOutcome(handle, "failed", null);
  }

  /**
   * An authorized lookup reached this Mac and generated the payload.
   *
   * Non-consuming, and audited exactly once: repeated reads answer the same
   * payload, and a timeline claiming the agent asked four times because it
   * polled four times would be describing the poller, not the operation. It is
   * recorded whatever the outcome was — an agent collecting a denial asked for
   * its result just as much as one collecting a success, and the denial stands.
   */
  collected(handle: string): void {
    const rec = this.byHandle.get(handle);
    if (!rec || rec.collected) return;
    // Expired is the one outcome that cannot be collected: there is no payload
    // left to generate, so a lookup gets `expired` and the agent did not
    // receive a result to have asked for.
    if (rec.outcome === "expired") return;
    rec.collected = true;
    this.emit(rec, CONTINUATION_EVENTS.collected);
    this.announce(rec);
  }

  /**
   * Retention elapsed with the result never looked up.
   *
   * Refused for anything but a terminal, uncollected result. Pending work that
   * outlives retention has not expired in any sense the user cares about, and
   * saying so would have an operation reported dead and then — when the human
   * finally answers — alive again.
   */
  expired(handle: string): void {
    const rec = this.byHandle.get(handle);
    if (!rec || rec.collected) return;
    if (rec.outcome !== "ready") return;
    rec.outcome = "expired";
    this.emit(rec, CONTINUATION_EVENTS.expired);
    this.announce(rec);
  }

  /** The state of the operation this intent belongs to, for the window. */
  stateOfIntent(intentId: string): ContinuationState | null {
    const handle = this.byIntent.get(intentId);
    return handle === undefined ? null : this.state(handle);
  }

  /** When the call that asked for this approval stops waiting, absolute. */
  deadlineOfIntent(intentId: string): number | null {
    const handle = this.byIntent.get(intentId);
    return handle === undefined ? null : (this.byHandle.get(handle)?.deadlineAt ?? null);
  }

  /** The state §4 shows a user, derived from the outcome and observations. */
  state(handle: string): ContinuationState | null {
    const rec = this.byHandle.get(handle);
    if (!rec) return null;
    switch (rec.outcome) {
      case "pending":
        return rec.acknowledged ? "backgrounded" : "waiting_inline";
      case "ready":
        return rec.collected ? "collected" : "approved_uncollected";
      default:
        return rec.outcome;
    }
  }

  /** Whether the relay acknowledged this operation's envelope. */
  acknowledged(handle: string): boolean {
    return this.byHandle.get(handle)?.acknowledged ?? false;
  }

  /** Whether an authorized lookup has reached this Mac for it. */
  wasCollected(handle: string): boolean {
    return this.byHandle.get(handle)?.collected ?? false;
  }

  /** What became of the work, independent of who observed what. */
  outcome(handle: string): ContinuationOutcome | null {
    return this.byHandle.get(handle)?.outcome ?? null;
  }

  /** The operation this handle belongs to, or null before the tool built one. */
  intentOf(handle: string): string | null {
    return this.byHandle.get(handle)?.intentId ?? null;
  }

  /** How many operations are tracked. Lets a test see records being dropped. */
  get size(): number {
    return this.byHandle.size;
  }

  /** Apply one delivery observation to every handle on that exchange. */
  private settleExchange(rid: string, delivery: Delivery): void {
    if (this.deliveryByRid.has(rid)) return;
    this.deliveryByRid.set(rid, delivery);
    for (const handle of this.byRid.get(rid) ?? []) this.observe(handle, delivery);
  }

  private observe(handle: string, delivery: Delivery): void {
    const rec = this.byHandle.get(handle);
    if (!rec) return;
    if (delivery === "unknown") {
      this.emit(rec, CONTINUATION_EVENTS.deliveryUnknown);
      return;
    }
    if (rec.acknowledged) return;
    rec.acknowledged = true;
    this.emit(rec, CONTINUATION_EVENTS.backgrounded);
    this.announce(rec);
  }

  /**
   * Set what became of the work, once.
   *
   * The first answer wins: a result that landed is not un-landed by a later
   * sweep, and a denial is not overwritten by anything.
   */
  private settleOutcome(
    handle: string,
    outcome: ContinuationOutcome,
    event: string | null,
  ): void {
    const rec = this.byHandle.get(handle);
    if (!rec || rec.outcome !== "pending") return;
    rec.outcome = outcome;
    if (event !== null) this.emit(rec, event);
    this.announce(rec);
  }

  /** Record against the intent, or hold it until there is an intent to name. */
  private emit(rec: Record_, event: string): void {
    if (rec.intentId === null) {
      rec.buffered.push(event);
      return;
    }
    this.audit.record(event, { intentId: rec.intentId });
  }

  /** Tell whoever is rendering this operation where it now stands. */
  private announce(rec: Record_): void {
    if (rec.intentId === null) return;
    const handle = this.byIntent.get(rec.intentId);
    if (handle === undefined) return;
    this.events.emit("change", { intentId: rec.intentId, state: this.state(handle) });
  }

  private forget(handle: string): void {
    const rec = this.byHandle.get(handle);
    if (rec?.intentId) this.byIntent.delete(rec.intentId);
    if (rec?.rid) {
      const handles = this.byRid.get(rec.rid);
      handles?.delete(handle);
      if (handles && handles.size === 0) this.byRid.delete(rec.rid);
    }
    this.byHandle.delete(handle);
  }
}
