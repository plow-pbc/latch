/**
 * The deferred-result contract (design §4.3).
 *
 * A tunnelled call has a hard ceiling: the relay's pending future times out
 * comfortably below 30s, so nothing on this Mac may block past its call budget
 * — not a human who has walked away from an approval, not a slow command. Any
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
 * How long a tool may block before it must hand back a handle.
 *
 * The relay's pending future sits comfortably below 30s and the MCP client
 * abandons at ~30s, so this has to leave room for both the tunnel round-trip
 * and the relay's own timeout — not merely be smaller than them.
 */
export const CALL_BUDGET_MS = 8_000;

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
    private readonly budgetMs = CALL_BUDGET_MS,
    private readonly ttlMs = HANDLE_TTL_MS,
    /** Injectable for tests; the real one is Date.now. */
    private readonly now: () => number = () => Date.now(),
  ) {}

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

    const raced = await Promise.race([
      done,
      new Promise<"budget">((resolve) => {
        const timer = setTimeout(() => resolve("budget"), this.budgetMs);
        timer.unref?.();
        // Stop the timer as soon as the work lands, so a fast call does not
        // leave a pending timer behind.
        void done.then(() => clearTimeout(timer));
      }),
    ]);

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
