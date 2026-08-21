/**
 * The deferred-result contract (design §4.3).
 *
 * A tunnelled call has a hard ceiling — `RELAY_TIMEOUT_MS` below — so nothing
 * on this Mac may block past `CALL_BUDGET_MS`: not a human who has walked away
 * from an approval, not a slow command. Any tool that cannot finish inside the
 * budget returns a handle instead, keeps the work running, and the agent
 * retrieves the outcome later with `plow_get_result`.
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
 * The relay's own ceiling: how long its pending future waits before it
 * abandons a tunnelled exchange. Not ours — it belongs to `plow-pbc/plow` — but
 * `CALL_BUDGET_MS` is chosen against it, so it is named here rather than
 * restated in prose wherever a timeout is sized against it. If the relay
 * changes this, this is the line to change, and the budget check in
 * `mcpServer.test.ts` fails until the arithmetic is redone. (The MCP client
 * abandons later still, around 30s.)
 *
 * Exported for that check, not as a value to build on: it belongs to another
 * system, and nothing here can verify it.
 */
export const RELAY_TIMEOUT_MS = 25_000;

/**
 * What delivery must fit in after the budget is spent: registering the handle,
 * framing the response, and the relay matching it to the exchange still
 * waiting. A floor, not slack.
 */
export const DELIVERY_MARGIN_MS = 10_000;

/**
 * How long a tool may block before it must hand back a handle.
 *
 * CHOSEN against the two above, not computed from them: a human gets the whole
 * fifteen seconds to answer inside the original call, which is the point of the
 * number and why it is a literal rather than `RELAY_TIMEOUT_MS -
 * DELIVERY_MARGIN_MS`. `mcpServer.test.ts` pins it and checks the margin still
 * clears, so the two only move together by a human editing both.
 */
export const CALL_BUDGET_MS = 15_000;

/** Both halves of §4.3's fifteen minutes: pending lifetime, and result retention. */
export const HANDLE_TTL_MS = 15 * 60_000;

/** Advice to the caller, never a gate — polling early is answered honestly. */
export const RETRY_AFTER_MS = 1_000;

/** Why a call is still outstanding. */
export type PendingReason = "awaiting_approval" | "running";

/**
 * What the agent should DO about a pending handle, in the envelope itself.
 *
 * The four machine fields say what is true; none of them say what to do, and
 * an agent cannot see the dialog that just appeared on a screen in another
 * room. So agents went quiet, and — worse — re-issued the original call, which
 * mints a fresh intent and asks the human all over again.
 *
 * This rides the response rather than only the server's `instructions` block
 * because a client may drop instructions, and because this is the moment the
 * advice is actually needed. `retry_after_ms` next to it is advice too, never
 * a gate: polling early is answered honestly.
 *
 * `awaiting_approval` must not claim a dialog is on screen, because often
 * there is not one. It means "no decision yet", and that covers the work
 * before anyone is asked (path resolution, writing the approval record), the
 * adversarial reviewer thinking — a 30s budget against this 15s one, so in
 * that mode deferring while nobody has been asked is still commonplace — and the
 * approve/deny modes, which never show a human anything at all.
 *
 * An earlier version of this note hedged on whether approval was *needed*,
 * which is not the uncertain part: it always is. What varies is whether it has
 * been ASKED yet.
 */
const PENDING_NOTES: Record<PendingReason, string> = {
  awaiting_approval:
    "not decided yet — it may be waiting on the user, on a policy check, or still being " +
    "prepared. Tell the user it is waiting, then poll plow_get_result with this handle. " +
    "Do not repeat the original call; that starts a second request.",
  running:
    "approved, and running now. Poll plow_get_result with this handle; do not repeat the " +
    "original call.",
};

/** §4.3's pending envelope, with the advice the caller needs to act on it. */
function pendingEnvelope(handle: string, reason: PendingReason): JSONValue {
  return {
    status: "pending",
    handle,
    reason,
    note: PENDING_NOTES[reason],
    retry_after_ms: RETRY_AFTER_MS,
  };
}

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
    return pendingEnvelope(handle, reason);
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
    return pendingEnvelope(handle, entry.reason);
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
