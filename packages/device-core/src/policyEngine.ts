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
export type IntentDecision =
  | Decision
  | {
      decision: Decision;
      source?: string;
      /**
       * The delegate already stored this intent's always-allow rule (via
       * `storeRule`), so the engine must not store it again: the rule may
       * have been revoked on the answer's way back, and a second store would
       * put it back. Travels with the decision, so it cannot outlive it.
       */
      ruleStored?: true;
    };

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
    this.announce("revoked", { rule });
  }

  removeAllRules(): void {
    const rules = [...this.rules.values()];
    this.rules.clear();
    this.persist();
    for (const rule of rules) this.announce("revoked", { rule });
  }

  /** The file, and nothing else: what listeners do is not this write's problem. */
  private persist(): void {
    fs.mkdirSync(path.dirname(this.rulesFile), { recursive: true });
    fs.writeFileSync(this.rulesFile, JSON.stringify([...this.rules.values()], null, 2) + "\n");
  }

  /**
   * The write's record first (`stored`/`revoked` — the audit line), then the
   * best-effort `changed` (the renderer). Each listener is isolated: the
   * renderer's can throw while a window is being torn down, and a throw here
   * would escape from the dialog path — the rule on disk, no audit line, and
   * the request denied as an error. Same shape as AuditLog's emits.
   */
  private announce(event: "stored" | "revoked", payload: object): void {
    for (const [name, arg] of [[event, payload], ["changed", undefined]] as const) {
      try {
        this.events.emit(name, arg);
      } catch (error) {
        console.error(`[rules] ${name} listener failed:`, error);
      }
    }
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
    const key = intentRuleKey(intent);
    if (!ruleEligible(intent) || this.rules.has(key)) return;
    const rule = makeAlwaysAllowRule(intent);
    this.rules.set(key, rule);
    this.persist();
    this.announce("stored", { rule, intentId: intent.intentId });
  }

  async decide(intent: Intent, delegate: PolicyDelegate): Promise<Grant> {
    if (await this.ruleAnswers(intent, delegate)) {
      return makeGrant(intent, "always_allow", "rule");
    }
    const result = await delegate.decideIntent(intent);
    const decision = typeof result === "string" ? result : result.decision;
    const source = typeof result === "string" ? "prompt" : (result.source ?? "prompt");
    const ruleStored = typeof result !== "string" && result.ruleStored === true;
    if (decision === "always_allow" && !ruleStored) this.storeRule(intent);
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
