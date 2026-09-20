/**
 * Policy — twin of DomoDeviceCore/PolicyEngine.swift. Applies stored
 * always-allow rules before ever consulting the delegate. Rules match on
 * (agent, device, exact normalized capability set) — never on goal text.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { writeFileDurable } from "./durableFile.js";
import {
  AlwaysAllowRule,
  Decision,
  Grant,
  Intent,
  intentRuleKey,
  makeAlwaysAllowRule,
  makeGrant,
} from "@domo/protocol";

/**
 * A delegate's intent decision. It may return a bare Decision (source defaults
 * to "prompt") or annotate HOW it decided — so the audit log can distinguish
 * e.g. an auto-approve from a human answer from a policy deny. Known sources:
 * "prompt" (generic), "ask" (human dialog), "approve" (auto-approve),
 * "adversarial" (adversarial-agent review), "policy" (auto-deny). Rule matches
 * are labeled "rule" by the engine itself.
 */
export type IntentDecision =
  | Decision
  | {
      decision: Decision;
      source?: string;
      /**
       * This intent's always-allow rule is already in place — the delegate
       * stored it (`storeRule`), or answered from it — so the engine must not
       * store it again: the rule may have been revoked on the answer's way
       * back, and a second store would put it back. Travels with the
       * decision, so it cannot outlive it.
       */
      ruleStored?: true;
      /** Safe, human-readable context for a decision lifecycle event. It is
       * not part of the grant and cannot affect authorization. */
      reason?: string;
    };

export interface DeniedIntent {
  intent: Intent;
  reason: string | null;
}

/** Whoever answers approval questions: app UI, headless script… */
export interface PolicyDelegate {
  decideIntent(intent: Intent): Promise<IntentDecision>;
  /**
   * May a stored always-allow rule answer this intent on its own?
   *
   * A rule is a decision the human made once and cached, and the engine
   * short-circuits to it before this delegate is ever asked. A delegate may
   * veto that replay when the current global policy must decide every request.
   *
   * Optional: a delegate that does not implement it keeps the plain behaviour.
   * Answering false does not deny — it sends the intent down the normal path,
   * where the delegate decides as it would have the first time.
   */
  mayGrantFromStoredRule?(intent: Intent): boolean | Promise<boolean>;
  /**
   * The decision for this intent is now in the audit log. A delegate that
   * kept its own record of the question while it was open may let go of it
   * here, and not before: between an answer and its audit line the record is
   * the only durable account of what the human said.
   *
   * Optional. Called once per decided intent, after the audit append, and
   * awaited so a delegate's cleanup finishes before the intent runs.
   */
  decisionRecorded?(intentId: string): void | Promise<void>;
}

export class PolicyEngine {
  private rules = new Map<string, AlwaysAllowRule>();
  /** Reviewer denials are recovery UI state, not durable policy. */
  private readonly deniedIntents = new Map<string, DeniedIntent>();
  /**
   * Emits `changed` once per write to the rule set — a rule stored by an
   * always-allow answer, or one removed. The main window's Rules pane draws
   * from `allRules()` and has no other way to learn that an approval dialog
   * just added one while it was on screen.
   *
   * Alongside it, the write itself: `stored` with `{ rule, intentId }` (the
   * intent whose answer made the rule) and `revoked` with `{ rule }`. The
   * device agent turns these into audit lines, so the log accounts for every
   * rule that exists — including one made by an answer the request itself
   * did not get (see `storeRule`). These two are the write's RECORD, and a
   * listener that throws fails the write: the rule set goes back to what it
   * was and the error is rethrown, because an authorization the log cannot
   * account for must not exist. A write that then fails to reach disk is
   * announced as `write_failed` with `{ op, rule, intentId? }`, so the log
   * can say the recorded change did not stand. Only `changed` is best-effort.
   */
  readonly events = new EventEmitter();

  constructor(
    private readonly rulesFile: string,
    /**
     * The intent a RULE is keyed on and stored as — by default the intent
     * itself. A plugin read (`plugins/argvRules.ts`) is viewed with its argv cut
     * to `<command> <prefix>`, so the query TEXT may vary freely under one
     * "always allow" — but the rest of the normalized capability set (paths,
     * network, …) still participates in the key, so a call carrying different
     * ones is a different request and prompts again. Only the rule sees the
     * view: the approval card, the sandbox profile and the audit log all get
     * the real argv. The view MUST
     * return a new Intent and must never mutate the intent it is handed — the
     * same object is reused afterwards for the grant, the approval card, the
     * sandbox profile and the audit log.
     */
    private readonly ruleView: (intent: Intent) => Intent = (i) => i,
  ) {
    try {
      const stored = JSON.parse(fs.readFileSync(rulesFile, "utf8")) as AlwaysAllowRule[];
      for (const rule of stored) this.rules.set(rule.ruleKey, rule);
    } catch {
      /* no rules yet */
    }
  }

  allRules(): AlwaysAllowRule[] {
    return [...this.rules.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  deniedIntent(intentId: string): DeniedIntent | null {
    return this.deniedIntents.get(intentId) ?? null;
  }

  removeRule(key: string): void {
    const rule = this.rules.get(key);
    if (!rule) return;
    this.write(
      () => this.rules.delete(key),
      () => this.rules.set(key, rule),
      () => this.events.emit("revoked", { rule }),
      () => this.events.emit("write_failed", { op: "revoked", rule }),
    );
  }

  removeAllRules(): void {
    const before = new Map(this.rules);
    this.write(
      () => this.rules.clear(),
      () => { this.rules = new Map(before); },
      () => { for (const rule of before.values()) this.events.emit("revoked", { rule }); },
      () => { for (const rule of before.values()) this.events.emit("write_failed", { op: "revoked", rule }); },
    );
  }

  /**
   * One change to the rule set: apply it, record it, put it on disk, tell
   * the renderer — in that order, and the order is the guarantee.
   *
   * The record (`stored`/`revoked`) comes BEFORE the disk write. Either can
   * fail, and each failure is fail-closed: the change is undone in memory
   * (memory is what answers the next request, so it is undone first and
   * without fail) and the error rethrown. What differs is what disk and the
   * log are left saying, and this order makes the only possible
   * disagreement the safe one:
   *
   * - The record fails: nothing has touched disk, so nothing is there to
   *   undo, and no second write can fail. A rule the log cannot account for
   *   never exists on disk — not even for a moment, not even if the process
   *   dies right here.
   * - The write fails (or the process dies between the record and the
   *   write): the log says a rule was saved that the file does not hold —
   *   over-reporting, never a silent authorization — and the log is told so
   *   with `write_failed`, best-effort, since the disk may be the problem.
   *
   * The other order — write, then record — could leave a rule on disk with
   * no line to account for it, if the record failed and the undo-write
   * failed after it (disk full does both), and the next launch would load
   * it and grant on it. In the dialog path a failure here turns the owner's
   * click into an error the request is denied on, which is the same answer
   * any other un-auditable operation gets.
   *
   * The notification (`changed`) is best-effort, and only sent for a change
   * that stood: the renderer's listener can throw while a window is being
   * torn down, and that must take nothing down with it.
   */
  private write(apply: () => void, undo: () => void, record: () => void, recordFailure: () => void): void {
    apply();
    try {
      record();
    } catch (error) {
      undo();
      throw error;
    }
    try {
      this.persist();
    } catch (error) {
      undo();
      try {
        recordFailure();
      } catch (also) {
        console.error("[rules] could not record a failed rules.json write:", also);
      }
      throw error;
    }
    try {
      this.events.emit("changed");
    } catch (error) {
      console.error("[rules] changed listener failed after a recorded change:", error);
    }
  }

  /**
   * Whole or not at all, and on disk before it counts: a write that dies
   * part-way must not leave a truncated file the next launch reads as "no
   * rules", and a revoke the owner saw complete must not come back after a
   * power cut because the rename reached the platter and the data did not.
   */
  private persist(): void {
    fs.mkdirSync(path.dirname(this.rulesFile), { recursive: true });
    writeFileDurable(this.rulesFile, JSON.stringify([...this.rules.values()], null, 2) + "\n");
  }

  /**
   * Would a stored rule answer this intent right now?
   *
   * `decide` asks this first. A delegate that queues the human's dialogs may
   * ask it again when an intent's turn comes: an "always allow" answered
   * ahead of it in the queue stores a rule that this intent may match, and
   * the human should not be shown a request they have already decided.
   */
  async ruleAnswers(intent: Intent, delegate: PolicyDelegate): Promise<boolean> {
    return (
      ruleEligible(intent) &&
      this.rules.has(intentRuleKey(this.ruleView(intent))) &&
      (await mayGrantFromStoredRule(intent, delegate))
    );
  }

  /**
   * Store the always-allow rule for this intent now, ahead of its decision
   * completing. `decide` stores on an `always_allow` answer; a delegate that
   * queues dialogs calls this the moment the human answers, BEFORE the answer
   * travels back — the dialogs waiting behind it ask `ruleAnswers` right
   * then, and a store that waited for `decide` comes too late for them. The
   * delegate then says so on its decision (`ruleStored`), and `decide` does
   * not store again: the answer's way back can cross disk I/O (the approval
   * store's write), the owner may revoke the rule in that interval — it is
   * already on screen — and a second store would put it back. An existing
   * rule is left alone either way, so its creation time and the events stay
   * honest.
   */
  storeRule(intent: Intent): void {
    const viewed = this.ruleView(intent);
    const key = intentRuleKey(viewed);
    if (!ruleEligible(intent) || this.rules.has(key)) return;
    const rule = makeAlwaysAllowRule(viewed);
    this.write(
      () => this.rules.set(key, rule),
      () => this.rules.delete(key),
      () => this.events.emit("stored", { rule, intentId: intent.intentId }),
      () => this.events.emit("write_failed", { op: "stored", rule, intentId: intent.intentId }),
    );
  }

  async decide(intent: Intent, delegate: PolicyDelegate): Promise<Grant> {
    if (await this.ruleAnswers(intent, delegate)) {
      return makeGrant(intent, "always_allow", "rule");
    }
    const result = await delegate.decideIntent(intent);
    const decision = typeof result === "string" ? result : result.decision;
    const source = typeof result === "string" ? "prompt" : (result.source ?? "prompt");
    const reason = typeof result === "string" ? null : (result.reason ?? null);
    const ruleStored = typeof result !== "string" && result.ruleStored === true;
    if (decision === "always_allow" && !ruleStored) this.storeRule(intent);
    if (decision === "deny" && source === "adversarial") {
      this.deniedIntents.clear();
      this.deniedIntents.set(intent.intentId, { intent, reason });
      this.events.emit("reviewer_denied", { intentId: intent.intentId, intent, reason });
    }
    return makeGrant(intent, decision, source);
  }
}

/**
 * An Apple-event intent is a mutation with no idempotence guarantee — a
 * byte-identical `make new address` repeated duplicates owner data. So it is
 * never answered by a stored rule and never stored as one: an `always_allow`
 * answer still grants THIS run, it just isn't cached. Checked on both sides
 * so a rule persisted by an older build cannot replay either.
 *
 * An AppleScript intent is the same mutation by another road (and runs
 * outside the sandbox besides), so the exact same script against the exact
 * same app is decided fresh every time too.
 */
function ruleEligible(intent: Intent): boolean {
  return !intent.capabilities.some(
    (c) => (c.kind === "apple_events" && c.allowed === true) || c.kind === "applescript",
  );
}

/**
 * Ask the delegate whether a cached rule may still answer for itself.
 *
 * FAILS CLOSED on a throwing guard: a veto that errors must not read as
 * permission, or the bypass this exists to close comes back the moment the
 * guard is the thing that broke. Closed here means "ask properly", not "deny" —
 * the intent goes down the normal decision path.
 */
async function mayGrantFromStoredRule(intent: Intent, delegate: PolicyDelegate): Promise<boolean> {
  if (!delegate.mayGrantFromStoredRule) return true;
  try {
    return await delegate.mayGrantFromStoredRule(intent);
  } catch {
    return false;
  }
}

/** Scripted decisions — what makes automated testing possible without a UI. */
export interface HeadlessPolicyConfig {
  intent: "allow_once" | "always_allow" | "deny";
  denyKinds?: string[];
}

export class HeadlessPolicy implements PolicyDelegate {
  constructor(public readonly config: HeadlessPolicyConfig) {}

  async decideIntent(intent: Intent): Promise<Decision> {
    if (this.config.denyKinds?.some((kind) => intent.capabilities.some((c) => c.kind === kind))) {
      return "deny";
    }
    const d = this.config.intent;
    return d === "allow_once" || d === "always_allow" || d === "deny" ? d : "deny";
  }
}
