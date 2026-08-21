/**
 * Policy — twin of DomoDeviceCore/PolicyEngine.swift. Applies stored
 * always-allow rules before ever consulting the delegate. Rules match on
 * (agent, device, exact normalized capability set) — never on goal text.
 */
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
 *
 * `reason` is one sentence for the CALLING AGENT, and only some deciders have
 * one to give: it exists so a machine's refusal can say what was wrong with the
 * request. A human's Deny does not fill it in — see `decideIntent` in the app.
 */
export type IntentDecision =
  | Decision
  | { decision: Decision; source?: string; reason?: string };

/** Whoever answers approval questions: app UI, headless script… */
export interface PolicyDelegate {
  decideIntent(intent: Intent): Promise<IntentDecision>;
}

export class PolicyEngine {
  private rules = new Map<string, AlwaysAllowRule>();

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
    this.rules.delete(key);
    this.persist();
  }

  removeAllRules(): void {
    this.rules.clear();
    this.persist();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.rulesFile), { recursive: true });
    fs.writeFileSync(this.rulesFile, JSON.stringify([...this.rules.values()], null, 2) + "\n");
  }

  /**
   * The grant, plus the decider's sentence for the calling agent when there is
   * one.
   *
   * Two values rather than a wider `Grant`: `Grant` is the frozen protocol
   * object whose canonical bytes are what gets signed, so a field added to it
   * to carry display text would be a protocol break for no protocol reason.
   */
  async decide(
    intent: Intent,
    delegate: PolicyDelegate,
  ): Promise<{ grant: Grant; reason?: string }> {
    const key = intentRuleKey(intent);
    if (this.rules.has(key)) {
      return { grant: makeGrant(intent, "always_allow", "rule") };
    }
    const result = await delegate.decideIntent(intent);
    const decision = typeof result === "string" ? result : result.decision;
    const source = typeof result === "string" ? "prompt" : (result.source ?? "prompt");
    const reason = typeof result === "string" ? undefined : result.reason;
    if (decision === "always_allow") {
      this.rules.set(key, makeAlwaysAllowRule(intent));
      this.persist();
    }
    return { grant: makeGrant(intent, decision, source), ...(reason ? { reason } : {}) };
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
