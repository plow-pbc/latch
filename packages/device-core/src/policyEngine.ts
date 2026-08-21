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
  JSONValue,
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
  /**
   * `payload` is the tool call's delivery detail — a browser session handle and
   * nothing an approval is granted over. It is here so a delegate can look up
   * what this Mac knows about the thing being acted on (which session, which
   * page) before deciding. Optional, so a delegate that does not care about it
   * simply does not take it; the enforceable bound is still the capability set.
   */
  decideIntent(intent: Intent, payload?: JSONValue): Promise<IntentDecision>;
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

  async decide(intent: Intent, delegate: PolicyDelegate, payload?: JSONValue): Promise<Grant> {
    const key = intentRuleKey(intent);
    if (this.rules.has(key)) {
      return makeGrant(intent, "always_allow", "rule");
    }
    const result = await delegate.decideIntent(intent, payload);
    const decision = typeof result === "string" ? result : result.decision;
    const source = typeof result === "string" ? "prompt" : (result.source ?? "prompt");
    if (decision === "always_allow") {
      this.rules.set(key, makeAlwaysAllowRule(intent));
      this.persist();
    }
    return makeGrant(intent, decision, source);
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
