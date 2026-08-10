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

/** Whoever answers approval questions: app UI, headless script, iOS relay… */
export interface PolicyDelegate {
  decideAccess(agentId: string, agentDisplay: string, goals: string): Promise<boolean>;
  decideIntent(intent: Intent): Promise<Decision>;
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

  async decide(intent: Intent, delegate: PolicyDelegate): Promise<Grant> {
    const key = intentRuleKey(intent);
    if (this.rules.has(key)) {
      return makeGrant(intent, "always_allow", "rule");
    }
    const decision = await delegate.decideIntent(intent);
    if (decision === "always_allow") {
      this.rules.set(key, makeAlwaysAllowRule(intent));
      this.persist();
    }
    return makeGrant(intent, decision, "prompt");
  }
}

/** Scripted decisions for the headless runner — what makes full-stack
 * automated E2E testing possible without a UI (DESIGN.md §10). */
export interface HeadlessPolicyConfig {
  access: "allow" | "deny";
  intent: "allow_once" | "always_allow" | "deny";
  denyKinds?: string[];
}

export class HeadlessPolicy implements PolicyDelegate {
  constructor(public readonly config: HeadlessPolicyConfig) {}

  static fromFile(configPath: string): HeadlessPolicy {
    return new HeadlessPolicy(JSON.parse(fs.readFileSync(configPath, "utf8")));
  }

  async decideAccess(): Promise<boolean> {
    return this.config.access === "allow";
  }

  async decideIntent(intent: Intent): Promise<Decision> {
    if (this.config.denyKinds?.some((kind) => intent.capabilities.some((c) => c.kind === kind))) {
      return "deny";
    }
    const d = this.config.intent;
    return d === "allow_once" || d === "always_allow" || d === "deny" ? d : "deny";
  }
}
