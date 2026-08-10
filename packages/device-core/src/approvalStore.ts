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
 * outcome is written next to it. This is a decorator around whatever normally
 * answers — the Electron dialog, a scripted policy in tests — and it changes
 * neither the question asked nor the decision made. It adds three things:
 *
 *  - a durable record of what was asked, while it is still unanswered;
 *  - a way for an answer to arrive from somewhere other than the dialog;
 *  - a deadline, so an unanswered approval fails closed instead of pending
 *    forever.
 *
 * The window is fifteen minutes, matching the deferred handle's, so a decision
 * that lands at any point before the deadline still has a handle to land on.
 */
import fs from "node:fs";
import path from "node:path";
import { Decision, Intent, capabilityDisplay } from "@domo/protocol";
import { IntentDecision, PolicyDelegate } from "./policyEngine.js";

/** Same fifteen minutes as a deferred handle — §4.3 uses one window. */
export const APPROVAL_TTL_MS = 15 * 60_000;

export type ApprovalStatus = "pending" | "decided" | "expired" | "abandoned";

/** What is written to disk for one approval. */
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

  constructor(
    public readonly dir: string,
    private readonly inner: PolicyDelegate,
    private readonly ttlMs = APPROVAL_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.reapStale();
  }

  private file(intentId: string): string {
    // Intent ids are UUIDs we mint, but this string reaches a path, so refuse
    // anything that is not one rather than trusting the caller.
    if (!/^[A-Za-z0-9._-]+$/.test(intentId)) throw new Error("unusable intent id");
    return path.join(this.dir, `${intentId}.json`);
  }

  private write(record: ApprovalRecord): void {
    // The record carries the goal and the paths asked for, so it is as
    // sensitive as the request itself.
    fs.writeFileSync(this.file(record.intentId), JSON.stringify(record, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.chmodSync(this.file(record.intentId), 0o600);
  }

  private read(intentId: string): ApprovalRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(intentId), "utf8")) as ApprovalRecord;
    } catch {
      return null;
    }
  }

  /** Every approval on disk, newest last. */
  all(): ApprovalRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .map((n) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.dir, n), "utf8")) as ApprovalRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is ApprovalRecord => r !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Approvals still awaiting an answer in THIS process. */
  pending(): ApprovalRecord[] {
    return this.all().filter((r) => r.status === "pending" && this.waiting.has(r.intentId));
  }

  /**
   * A `pending` record from a previous run has nobody waiting on it — the call
   * it belonged to is long gone. Mark it so, rather than leaving the directory
   * claiming approvals are outstanding when nothing can answer them.
   */
  private reapStale(): void {
    for (const record of this.all()) {
      if (record.status !== "pending") continue;
      this.write({ ...record, status: "abandoned", decidedAt: iso(this.now()) });
    }
  }

  /**
   * Answer an approval from outside the dialog — a restored UI after a reload,
   * or an operator tool. Returns false if nothing is waiting on it.
   */
  resolve(intentId: string, decision: Decision, source = "external"): boolean {
    const waiter = this.waiting.get(intentId);
    if (!waiter) return false;
    waiter({ decision, source }, source);
    return true;
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
    // exists while the answer does not.
    this.write(record);

    let settle!: (d: IntentDecision, source: string) => void;
    const answered = new Promise<{ decision: IntentDecision; source: string }>((resolve) => {
      settle = (decision, source) => resolve({ decision, source });
    });
    this.waiting.set(intent.intentId, settle);

    const deadline = new Promise<{ decision: IntentDecision; source: string }>((resolve) => {
      const timer = setTimeout(
        // Fail closed. An approval nobody answered is not an approval.
        () => resolve({ decision: { decision: "deny", source: "expired" }, source: "expired" }),
        this.ttlMs,
      );
      timer.unref?.();
      void answered.finally(() => clearTimeout(timer));
    });

    // Ask whoever normally answers. Its result races the external path and the
    // deadline; whichever lands first is the decision.
    void this.inner
      .decideIntent(intent)
      .then((decision) => settle(decision, "dialog"))
      .catch(() => settle({ decision: "deny", source: "error" }, "error"));

    const { decision, source } = await Promise.race([answered, deadline]);
    this.waiting.delete(intent.intentId);

    const resolved: Decision = typeof decision === "string" ? decision : decision.decision;
    this.write({
      ...record,
      status: source === "expired" ? "expired" : "decided",
      decision: resolved,
      source,
      decidedAt: iso(this.now()),
    });
    return decision;
  }
}
