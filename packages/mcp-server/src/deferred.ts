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
 *  - **Fifteen minutes.** A pending handle outlives a human walking away, and a
 *    terminal result stays retrievable for fifteen minutes after it lands.
 *
 * There are no timers here: entries are swept lazily on access, so this holds
 * nothing open and cannot keep a process alive.
 */
import crypto from "node:crypto";
import { JSONValue } from "@domo/protocol";

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
}

type Entry = {
  agentId: string;
  reason: PendingReason;
  /** Set once the work settles; until then the entry is pending. */
  terminal: JSONValue | null;
  /** When this handle stops answering: creation + TTL, then re-stamped on landing. */
  expiresAt: number;
};

export class DeferredResults {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private budgetMs = CALL_BUDGET_MS,
    private readonly ttlMs = HANDLE_TTL_MS,
    /** Injectable for tests; the real one is Date.now. */
    private readonly now: () => number = () => Date.now(),
  ) {}

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
    let reason: PendingReason = "awaiting_approval";
    const progress: Progress = {
      decided: () => {
        reason = "running";
        const entry = this.entries.get(handle);
        if (entry) entry.reason = "running";
      },
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
    const record = (value: JSONValue) => {
      settled = true;
      const entry = this.entries.get(handle);
      if (entry) {
        entry.terminal = value;
        entry.expiresAt = this.now() + this.ttlMs;
      }
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
      if (raced.ok) return raced.result;
      throw raced.error;
    }
    // The budget expired first. Register the handle so the outcome has
    // somewhere to land — unless it landed in the same tick as the timeout.
    if (settled) {
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
      expiresAt: this.now() + this.ttlMs,
    });
    return { status: "pending", handle, reason, retry_after_ms: RETRY_AFTER_MS };
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
    if (this.now() > entry.expiresAt) return { status: "expired", handle };
    if (entry.terminal !== null) return entry.terminal;
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
    const cutoff = this.now() - this.ttlMs;
    for (const [handle, entry] of this.entries) {
      if (entry.expiresAt < cutoff) this.entries.delete(handle);
    }
  }
}
