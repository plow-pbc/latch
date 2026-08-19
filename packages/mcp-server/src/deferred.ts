/**
 * The deferred-result contract (design §4.3).
 *
 * A tunnelled call has a hard ceiling: the relay abandons the exchange on a
 * deadline it advertises at the handshake, so nothing on this Mac may block
 * past its call budget — not a
 * human who has walked away from an approval, not a slow command. Any
 * tool that cannot finish inside the budget returns a handle instead, keeps the
 * work running, and the agent retrieves the outcome later with `get_result`.
 *
 * Two rules make this safe rather than merely convenient:
 *
 *  - **A handle belongs to the `agent_id` that created it.** Another agent
 *    presenting it gets `unknown` — indistinguishable from a handle that never
 *    existed, so a handle is not an oracle for what other agents are doing.
 *  - **Fifteen minutes, and only for a result.** A pending handle stays live
 *    however long the human takes — retention is for something retained, and a
 *    handle that answered `expired` mid-approval only to answer `ready`
 *    afterwards told the agent the operation was dead and then alive. A
 *    terminal payload stays retrievable for fifteen minutes after it lands,
 *    and expiry is the end of it.
 *
 * A landed result carries one timer, so retention runs out on a Mac that has
 * gone quiet rather than waiting for the next call to sweep. It is unref'd and
 * cannot keep the process alive; everything else here is swept lazily.
 */
import crypto from "node:crypto";
import { JSONValue } from "@domo/protocol";
import { Continuations } from "./continuation.js";

/**
 * How long a tool may block before it must hand back a handle, until a relay
 * says otherwise.
 *
 * This is the floor, not the contract: a relay that advertises its exchange
 * deadline raises the budget through `setBudgetMs` (see the relay client's
 * `deferrableBudgetMs`). Absent that advertisement the old 20-second deadline
 * is assumed, and this leaves room for the tunnel round-trip on top of itself
 * rather than merely being smaller than that deadline.
 */
export const CALL_BUDGET_MS = 8_000;

/**
 * How long a direct-bounded tool may block.
 *
 * A different question from the call budget, which is how long a human may
 * take: this one has no handle behind it, so overrunning is not "answer later"
 * but "answer into an exchange the relay has abandoned". It is its own knob for
 * that reason — nothing about a human's window should move it.
 *
 * The same fifteen seconds, and a flat constant: a direct tool is real work an
 * agent is waiting on, and cutting a browser action short to buy margin the
 * direct path does not spend is a worse trade than it looks. What the ten
 * seconds behind the *budget* buy is registering a deferred result and framing
 * it; a direct answer only has to be framed and sent, which is not seconds of
 * work. Against a relay that advertises nothing this leaves five seconds of a
 * twenty-second exchange for that — less headroom than the deferrable path
 * keeps, deliberately.
 */
export const DIRECT_CEILING_MS = 15_000;

/** Both halves of §4.3's fifteen minutes: pending lifetime, and result retention. */
export const HANDLE_TTL_MS = 15 * 60_000;

/** Advice to the caller, never a gate — polling early is answered honestly. */
export const RETRY_AFTER_MS = 1_000;

/** Why a call is still outstanding. */
export type PendingReason = "awaiting_approval" | "running";

/**
 * Thrown by a tool when a human or a policy rule refused the operation, as
 * opposed to it failing. The two are different answers and §4.3 keeps them
 * distinct (`denied` vs `failed`).
 */
export class DeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeniedError";
  }
}

/**
 * Handed to the work so it can say when it stops waiting on a human and starts
 * actually running. Without it every pending handle would claim
 * `awaiting_approval`, which would be a lie for the second half of a long job.
 */
export interface Progress {
  decided(): void;
  /**
   * The intent this call is about, as soon as the tool has built one.
   *
   * The continuation record is opened before the work runs — there is no other
   * moment at which the handle is known — but it cannot be audited until it can
   * name the operation a human was asked about.
   */
  intent(intentId: string): void;
}

type Entry = {
  agentId: string;
  reason: PendingReason;
  /** Set once the work settles; until then the entry is pending. */
  terminal: JSONValue | null;
  /**
   * When this handle stops answering — `null` while the work is still pending.
   *
   * Retention is for a RESULT, and pending work has none. Stamping it at
   * creation meant a handle whose human took longer than retention answered
   * `expired` while the approval was still on screen, and then answered `ready`
   * the moment they said yes: an agent told the operation was dead, and told
   * otherwise if it asked again. Expiry is terminal-only for that reason, and
   * `expired` is the end of this entry rather than a phase of it.
   */
  expiresAt: number | null;
  /**
   * Fires when retention runs out on a terminal payload nobody collected.
   *
   * Scheduled rather than swept, because a sweep only runs when something else
   * happens: a Mac that answers one approval and then goes quiet would leave
   * that result "ready, uncollected" in the timeline for ever, which is the
   * one ending a user cannot act on.
   */
  expiry: NodeJS.Timeout | null;
};

export class DeferredResults {
  private readonly entries = new Map<string, Entry>();
  /**
   * Who is waiting to hear that a handle's work has landed.
   *
   * The retry records need that moment: an operation whose call deferred has
   * not finished when the envelope goes out, and its retention cannot start
   * until it has — otherwise the id it reserved is reserved for ever.
   */
  private readonly settledWaiters = new Map<string, (() => void)[]>();

  constructor(
    private budgetMs = CALL_BUDGET_MS,
    private readonly ttlMs = HANDLE_TTL_MS,
    /** Injectable for tests; the real one is Date.now. */
    private readonly now: () => number = () => Date.now(),
    /** Where the continuation lifecycle is recorded, when there is one. */
    private readonly continuations: Continuations | null = null,
  ) {}

  /**
   * Resolves when this handle's work has landed, or at once if it already has.
   *
   * An unknown handle resolves immediately too: nothing is coming for it, and
   * a caller waiting for ever on a handle that does not exist is worse than one
   * told "there is nothing to wait for".
   */
  settled(handle: string): Promise<void> {
    const entry = this.entries.get(handle);
    if (!entry || entry.terminal !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.settledWaiters.set(handle, [...(this.settledWaiters.get(handle) ?? []), resolve]);
    });
  }

  /**
   * Re-point the budget at what the relay's advertised deadline allows.
   *
   * Calls already racing their budget keep the one they were armed with: a
   * timer that has been scheduled cannot honestly be moved, and the agent on
   * the other end is waiting against the deadline that was in force when its
   * exchange started.
   */
  setBudgetMs(ms: number): void {
    this.budgetMs = ms;
  }

  /** The budget the next call will be armed with. */
  get budget(): number {
    return this.budgetMs;
  }

  /**
   * Run one tool body against the call budget. If it finishes in time the
   * caller gets its result and no handle is ever minted — the common case
   * costs nothing. If it does not, the caller gets §4.3's pending envelope and
   * the work carries on.
   */
  async run(
    agentId: string,
    work: (progress: Progress) => Promise<JSONValue>,
  ): Promise<JSONValue> {
    const handle = crypto.randomUUID().toUpperCase();
    // The absolute moment this call stops waiting, fixed before any work runs.
    // The approval window shows the measured remainder of it.
    this.continuations?.open(handle, agentId, this.now() + this.budgetMs);
    let reason: PendingReason = "awaiting_approval";
    const progress: Progress = {
      decided: () => {
        reason = "running";
        const entry = this.entries.get(handle);
        if (entry) entry.reason = "running";
      },
      intent: (intentId: string) => this.continuations?.linkIntent(handle, intentId),
    };

    // Arm the budget BEFORE the work is invoked. Nothing here needs to know
    // anything about the work, so this is a pure reorder — and it removes the
    // window in which the work's synchronous prologue ran with no timer
    // scheduled at all.
    let fireBudget!: () => void;
    const budgetExpired = new Promise<"budget">((resolve) => {
      fireBudget = () => resolve("budget");
    });
    const timer = setTimeout(() => fireBudget(), this.budgetMs);
    timer.unref?.();

    const started = work(progress);
    // Attach the terminal recorders NOW, before any await: if the work rejects
    // after we have already returned a pending envelope, nothing else is
    // listening and Node would report an unhandled rejection.
    let settled = false;
    // The outcome, held back until we know the call actually deferred. A call
    // answered inside its budget has no continuation for anyone to come back
    // to, and recording "result ready" for one would put a lifecycle in the
    // timeline of an operation that never had one.
    let announce: (() => void) | null = null;
    const record = (value: JSONValue) => {
      settled = true;
      const status = (value as { status?: string }).status;
      // Land the payload, start retention on it, and say what became of the
      // work — in that order, and only once there is an entry to land it in.
      const apply = () => {
        const entry = this.entries.get(handle);
        if (entry) {
          entry.terminal = value;
          entry.expiresAt = this.now() + this.ttlMs;
          // Retention starts here, when there is finally something to retain.
          this.armExpiry(handle);
          // And anyone whose own clock starts with this one is told.
          for (const wake of this.settledWaiters.get(handle) ?? []) wake();
          this.settledWaiters.delete(handle);
        }
        if (status === "ready") this.continuations?.ready(handle);
        else if (status === "denied") this.continuations?.denied(handle);
        else this.continuations?.failed(handle);
      };
      if (this.entries.has(handle)) apply();
      else announce = apply;
    };
    const done = started.then(
      (result) => {
        record({ status: "ready", handle, result });
        return { ok: true as const, result };
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        record(
          error instanceof DeniedError
            ? { status: "denied", handle, reason: message }
            : { status: "failed", handle, error: message },
        );
        return { ok: false as const, error };
      },
    );

    // Stop the timer as soon as the work lands, so a fast call does not leave a
    // pending timer behind.
    void done.then(() => clearTimeout(timer));

    const raced = await Promise.race([done, budgetExpired]);

    if (raced !== "budget") {
      // Answered inside the budget: nothing outlived the call, so there is no
      // continuation for anyone to come back to.
      this.continuations?.closeInline(handle);
      if (raced.ok) return raced.result;
      throw raced.error;
    }
    // The budget expired first. Register the handle so the outcome has
    // somewhere to land — unless it landed in the same tick as the timeout.
    if (settled) {
      this.continuations?.closeInline(handle);
      const landed = await done;
      if (landed.ok) return landed.result;
      throw landed.error;
    }
    // Sweep on insert as well as on read. An agent that starts slow work and
    // then discards every handle never calls `get`, so without this the
    // terminal payloads would accumulate for the life of the process despite
    // the documented TTL.
    this.sweep();
    this.entries.set(handle, {
      agentId,
      reason,
      terminal: null,
      // Pending: live until the work lands. §6 — "records remain live while
      // work or approval is pending".
      expiresAt: null,
      expiry: null,
    });
    // The envelope is about to go back down one relay exchange; remember which,
    // because an acknowledgement names only the exchange.
    this.continuations?.deferred(handle);
    // An outcome that landed between the budget firing and this registration
    // has been waiting to be told.
    (announce as (() => void) | null)?.();
    return { status: "pending", handle, reason, retry_after_ms: RETRY_AFTER_MS };
  }

  /**
   * Start retention's clock on a terminal payload.
   *
   * Only a terminal result gets one: pending work has nothing to expire, and
   * `Continuations` refuses the transition anyway.
   */
  private armExpiry(handle: string): void {
    const entry = this.entries.get(handle);
    if (!entry || entry.expiry || entry.terminal === null) return;
    const timer = setTimeout(() => {
      entry.expiry = null;
      // Only the audit needs telling: `expiresAt` was stamped when the payload
      // landed, so by now the read path already answers `expired` on its own.
      this.continuations?.expired(handle);
    }, this.ttlMs);
    timer.unref?.();
    entry.expiry = timer;
  }

  /**
   * Retrieve a deferred result. Anything the calling agent does not own — a
   * handle another agent minted, or one that never existed — is `unknown`, and
   * deliberately indistinguishable.
   */
  get(agentId: string, handle: string): JSONValue {
    this.sweep();
    const entry = this.entries.get(handle);
    if (!entry || entry.agentId !== agentId) return { status: "unknown", handle };
    // Only a landed result can have run out of retention. Pending work is
    // answered as pending however long the human takes.
    if (entry.expiresAt !== null && this.now() > entry.expiresAt) {
      this.continuations?.expired(handle);
      return { status: "expired", handle };
    }
    if (entry.terminal !== null) {
      // Non-consuming: the payload stays, and only the FIRST reader is recorded.
      this.continuations?.collected(handle);
      return entry.terminal;
    }
    return {
      status: "pending",
      handle,
      reason: entry.reason,
      retry_after_ms: RETRY_AFTER_MS,
    };
  }

  /**
   * How many handles are held. Exists so a test can see that sweeping on
   * insert actually happens — reading through `get` would sweep too, and prove
   * nothing about the insert path.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Drop entries that have been expired for a further TTL. Until then an
   * expired handle keeps answering `expired` rather than lying with `unknown`.
   */
  private sweep(): void {
    const now = this.now();
    const cutoff = now - this.ttlMs;
    for (const [handle, entry] of this.entries) {
      // Pending work is never swept and never expired: it has no result to
      // retain, and the only honest answer to "is it done" is "not yet".
      if (entry.expiresAt === null) continue;
      // Retention elapsed. Recorded here as well as on the scheduled timer, so
      // a clock a test drives forward reaches the same ending.
      if (entry.expiresAt < now) this.continuations?.expired(handle);
      if (entry.expiresAt < cutoff) {
        if (entry.expiry) clearTimeout(entry.expiry);
        this.entries.delete(handle);
      }
    }
  }
}
