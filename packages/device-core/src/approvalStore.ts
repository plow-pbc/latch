/**
 * Approvals that survive on disk (design §4.3, D3).
 *
 * A tunnelled call cannot wait for a human — it has a few seconds before the
 * relay gives up. So the call returns a handle and the human answers whenever
 * they get back to their desk. That gap is the problem this file exists for: in
 * between, the only record of what was asked lives in a promise in memory, and
 * a promise is not a record. If the app is force-quit while someone is at
 * lunch, nothing anywhere says an agent asked to read their SSH key.
 *
 * So every pending approval is written down before the human is asked, and the
 * record goes once the answer is in the audit log. This is a decorator around whatever
 * normally answers — the Electron dialog, a scripted policy in tests — and it
 * changes neither the question asked nor the decision made. It adds three
 * things:
 *
 *  - a durable record of what was asked, while it is still unanswered;
 *  - a way for an answer to arrive from somewhere other than the dialog;
 *  - a deadline, so an unanswered approval fails closed instead of pending
 *    forever.
 *
 * The directory holds what is in flight and nothing else. The outcome is not
 * kept here: the audit log records every intent and every decision, including
 * the deadline's and the startup sweep's, and it is the one history the owner
 * reads. Keeping a second copy beside it — one file per approval, each holding
 * the goal and the paths asked for, never read again and never removed — grew
 * without bound on a long-lived install. The hand-off is ordered: the record
 * stays until `decisionRecorded` says the audit line is down. Removing it at
 * settlement left a gap where a crash between the answer and its audit line
 * lost the human's decision from every durable place at once; now that crash
 * leaves a `pending` record the next start closes out as abandoned.
 *
 * The window is fifteen minutes, matching the deferred handle's, so a decision
 * that lands at any point before the deadline still has a handle to land on.
 *
 * Two properties this file has to get right, both learned the hard way:
 *
 *  - **Nothing here may be synchronous on the call path.** Writing the record
 *    happens while a tunnelled call is running against its budget, and a
 *    synchronous write on a slow or unresponsive volume blocks the event loop —
 *    which stops the budget timer from firing, so the call overruns the relay's
 *    timeout instead of returning a handle. Same class as a synchronous read.
 *  - **Failing closed cannot depend on a timer.** A deadline enforced only by
 *    `setTimeout` is not enforced at all if the loop was blocked past it: a
 *    late answer can win the race against an overdue timer callback and an
 *    expired approval executes. The deadline is therefore checked at
 *    settlement, by clock, whichever path settles.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Decision, Intent, capabilityDisplay } from "@domo/protocol";
import { IntentDecision, PolicyDelegate } from "./policyEngine.js";

/** Same fifteen minutes as a deferred handle — §4.3 uses one window. */
export const APPROVAL_TTL_MS = 15 * 60_000;

/**
 * The `source` on a decision the deadline made, rather than a person.
 *
 * Exported because the difference matters to the agent that asked: a human
 * saying no and nobody being at the desk are not the same answer, and until
 * this was a shared constant they were literally the same sentence. Defined
 * here, where the value is produced; `deviceAgent` imports it to decide what
 * the caller is told.
 */
export const APPROVAL_SOURCE_EXPIRED = "expired";

/**
 * Only `pending` is ever on disk. The others name how an approval settled, for
 * the hook that carries a startup abandonment to the audit log and for anyone
 * reading a record that reached them before it was removed.
 */
export type ApprovalStatus = "pending" | "decided" | "expired" | "abandoned";

/** What is written to disk for one approval, while it is unanswered. */
export interface ApprovalRecord {
  intentId: string;
  /** The isolation key. Never the name. */
  agentId: string;
  /** Display only — nullable and not unique. */
  agentName: string;
  request: string;
  goal: string;
  /** Rendered capability set: what was actually asked for. */
  capabilities: string[];
  createdAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  decision?: Decision;
  /** How it was answered: the dialog, an external writer, or the deadline. */
  source?: string;
  decidedAt?: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class ApprovalStore implements PolicyDelegate {
  private readonly waiting = new Map<string, (d: IntentDecision, source: string) => void>();

  /**
   * Called for each pending record the startup sweep marks abandoned, so the
   * abandonment can reach the audit log. Assign it in the same tick as
   * construction: the sweep performs I/O before it can fire, so a hook set
   * immediately never misses one.
   */
  onAbandoned?: (record: ApprovalRecord) => void;

  /**
   * Directory creation and the stale sweep, started at construction. Awaited by
   * the first approval rather than blocking a constructor, so no I/O is
   * synchronous anywhere.
   */
  readonly ready: Promise<void>;

  constructor(
    public readonly dir: string,
    private readonly inner: PolicyDelegate,
    private readonly ttlMs = APPROVAL_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.ready = this.init();
    // A store nobody awaits must not crash the process on a bad directory; the
    // failure surfaces when an approval is actually made.
    this.ready.catch(() => {});
  }

  private async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.reapStale();
  }

  private file(intentId: string): string {
    // Intent ids are UUIDs we mint, but this string reaches a path, so refuse
    // anything that is not one rather than trusting the caller.
    if (!/^[A-Za-z0-9._-]+$/.test(intentId)) throw new Error("unusable intent id");
    return path.join(this.dir, `${intentId}.json`);
  }

  private async write(record: ApprovalRecord): Promise<void> {
    // The record carries the goal and the paths asked for, so it is as
    // sensitive as the request itself.
    const file = this.file(record.intentId);
    await fs.writeFile(file, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    // mode applies only on creation, so re-apply for a record we are updating.
    // ENOENT here means the record was removed between the two calls — a
    // directory swept while a write was still in flight, which is what a test
    // teardown does and what a user emptying the approvals dir would do. The
    // file is already gone, so there is no mode left to enforce; anything else
    // is a real permissions problem and still throws.
    try {
      await fs.chmod(file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }

  /** Every approval on disk, newest last. */
  async all(): Promise<ApprovalRecord[]> {
    let names: string[];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const records = await Promise.all(
      names.map(async (n) => {
        try {
          return JSON.parse(
            await fs.readFile(path.join(this.dir, n), "utf8"),
          ) as ApprovalRecord;
        } catch {
          return null;
        }
      }),
    );
    return records
      .filter((r): r is ApprovalRecord => r !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Approvals still awaiting an answer in THIS process. */
  async pending(): Promise<ApprovalRecord[]> {
    const all = await this.all();
    return all.filter((r) => r.status === "pending" && this.waiting.has(r.intentId));
  }

  /** The record is done with: its answer is in the audit log, or nobody can
   * give one. ENOENT is fine — a swept directory already did this. */
  private async remove(intentId: string): Promise<void> {
    await fs.rm(this.file(intentId), { force: true });
  }

  /** The audit log has the decision, so the record has nothing left to say.
   * An intent a stored rule answered never had a record; removing nothing is
   * fine. Forwarded, like every other delegate method. */
  async decisionRecorded(intentId: string): Promise<void> {
    await this.remove(intentId);
    await this.inner.decisionRecorded?.(intentId);
  }

  /**
   * A `pending` record from a previous run has nobody waiting on it — the call
   * it belonged to is long gone. Report it abandoned and remove it, rather than
   * leaving the directory claiming approvals are outstanding when nothing can
   * answer them. Anything else found here was settled by an earlier build that
   * kept its outcomes on disk; the audit log has those, so they go too.
   */
  private async reapStale(): Promise<void> {
    for (const record of await this.all()) {
      if (record.status === "pending") {
        this.onAbandoned?.({ ...record, status: "abandoned", decidedAt: iso(this.now()) });
      }
      await this.remove(record.intentId);
    }
  }

  /**
   * Answer an approval from outside the dialog — a restored UI after a reload,
   * or an operator tool. Returns false if nothing is waiting on it.
   */
  resolve(intentId: string, decision: Decision, source = "external"): boolean {
    const waiter = this.waiting.get(intentId);
    if (!waiter) return false;
    // The waiter re-checks the deadline by clock before accepting this, so an
    // answer that arrives after expiry is denied even if the timer has not run.
    waiter({ decision, source }, source);
    return true;
  }

  /**
   * Forwarded, never answered here. This decorator adds durability and a
   * deadline; deciding whether a cached rule still applies belongs to whoever
   * it wraps, and a decorator that quietly answered `true` would restore the
   * bypass for every delegate it is put in front of.
   */
  mayGrantFromStoredRule(intent: Intent): boolean | Promise<boolean> {
    return this.inner.mayGrantFromStoredRule?.(intent) ?? true;
  }

  async decideIntent(intent: Intent): Promise<IntentDecision> {
    const started = this.now();
    const record: ApprovalRecord = {
      intentId: intent.intentId,
      agentId: intent.agentId,
      agentName: intent.agentDisplay,
      request: intent.request,
      goal: intent.goal ?? "",
      capabilities: intent.capabilities.map(capabilityDisplay),
      createdAt: iso(started),
      expiresAt: iso(started + this.ttlMs),
      status: "pending",
    };
    // Written BEFORE the human is asked: the whole point is that the record
    // exists while the answer does not. Awaited, and async, so a slow volume
    // delays this call rather than blocking the loop the budget timer lives on.
    await this.ready;
    await this.write(record);

    // The absolute deadline. EVERY settlement is checked against this by clock,
    // not merely raced against a timer: if the loop is blocked past the
    // deadline, an answer can otherwise beat the overdue timer callback and an
    // expired approval executes. The timer only wakes us up; this is what
    // decides.
    const deadlineAt = started + this.ttlMs;
    const expiredAnswer = {
      decision: { decision: "deny" as Decision, source: APPROVAL_SOURCE_EXPIRED },
      source: APPROVAL_SOURCE_EXPIRED,
    };

    let settle!: (d: IntentDecision, source: string) => void;
    const answered = new Promise<{ decision: IntentDecision; source: string }>((resolve) => {
      settle = (decision, source) => {
        if (this.now() > deadlineAt) resolve(expiredAnswer);
        else resolve({ decision, source });
      };
    });
    this.waiting.set(intent.intentId, settle);

    const timer = setTimeout(
      () => settle(expiredAnswer.decision, APPROVAL_SOURCE_EXPIRED),
      this.ttlMs,
    );
    timer.unref?.();
    void answered.finally(() => clearTimeout(timer));

    // Ask whoever normally answers. Its result goes through the same settlement
    // check as an external answer and as the timer.
    void this.inner
      .decideIntent(intent)
      .then((decision) => settle(decision, "dialog"))
      .catch(() => settle({ decision: "deny", source: "error" }, "error"));

    const { decision } = await answered;
    this.waiting.delete(intent.intentId);
    // Still on disk, on purpose: the caller writes the decision to the audit
    // log next and calls decisionRecorded() once it is there. Until then this
    // record is the only durable thing that knows an answer was given.
    return decision;
  }
}
