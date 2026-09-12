/**
 * Policy — twin of DomoDeviceCore/PolicyEngine.swift. Applies stored
 * always-allow rules before ever consulting the delegate. Rules match on
 * (agent, device, exact normalized capability set) — never on goal text.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
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
export type IntentDecision = Decision | { decision: Decision; source?: string };

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
   * did not get (see `storeRule`).
   */
  readonly events = new EventEmitter();

  constructor(private readonly rulesFile: string) {
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

  removeRule(key: string): void {
    const rule = this.rules.get(key);
    if (!rule) return;
    this.rules.delete(key);
    this.persist();
    this.events.emit("revoked", { rule });
  }

  removeAllRules(): void {
    const rules = [...this.rules.values()];
    this.rules.clear();
    this.persist();
    for (const rule of rules) this.events.emit("revoked", { rule });
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.rulesFile), { recursive: true });
    fs.writeFileSync(this.rulesFile, JSON.stringify([...this.rules.values()], null, 2) + "\n");
    this.events.emit("changed");
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
      this.rules.has(intentRuleKey(intent)) &&
      (await mayGrantFromStoredRule(intent, delegate))
    );
  }

  /**
   * Intents whose rule was stored ahead of `decide`'s own turn to store it
   * (`storeRule`), so that turn is skipped. Cleared as each decision completes.
   */
  private readonly storedEarly = new Set<string>();

  /**
   * Store the always-allow rule for this intent now, ahead of its decision
   * completing. `decide` stores on an `always_allow` answer; a delegate that
   * queues dialogs calls this the moment the human answers, BEFORE the answer
   * travels back — the dialogs waiting behind it ask `ruleAnswers` right
   * then, and a store that waited for `decide` comes too late for them.
   *
   * A decision stores its rule ONCE. The answer's way back to `decide` can
   * cross disk I/O (the approval store's write), and the owner may revoke
   * the rule in that interval — it is already on screen. `decide` must not
   * put it back: that store is this one, already done, so `decide` skips it.
   * An existing rule is left alone either way, so its creation time and the
   * change event stay honest.
   */
  storeRule(intent: Intent): void {
    this.storedEarly.add(intent.intentId);
    const key = intentRuleKey(intent);
    if (!ruleEligible(intent) || this.rules.has(key)) return;
    const rule = makeAlwaysAllowRule(intent);
    this.rules.set(key, rule);
    this.persist();
    this.events.emit("stored", { rule, intentId: intent.intentId });
  }

  async decide(intent: Intent, delegate: PolicyDelegate): Promise<Grant> {
    if (await this.ruleAnswers(intent, delegate)) {
      return makeGrant(intent, "always_allow", "rule");
    }
    let result;
    try {
      result = await delegate.decideIntent(intent);
    } catch (e) {
      this.storedEarly.delete(intent.intentId);
      throw e;
    }
    const decision = typeof result === "string" ? result : result.decision;
    const source = typeof result === "string" ? "prompt" : (result.source ?? "prompt");
    // Consumed here whatever the decision: a delegate that stored early and
    // then answered otherwise must not leave a mark for a later intent.
    const alreadyStored = this.storedEarly.delete(intent.intentId);
    if (decision === "always_allow" && !alreadyStored) {
      this.storeRule(intent);
      this.storedEarly.delete(intent.intentId);
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
