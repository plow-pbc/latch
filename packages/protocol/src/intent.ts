/**
 * Intent / Decision / Grant / AlwaysAllowRule — twin of DomoProtocol/Intent.swift.
 * Dates are ISO-8601 strings (seconds precision) at rest and on the wire, so
 * canonical encoding never touches floating point.
 *
 * An Intent is built on this Mac from an authenticated agent's tool call and is
 * never RECEIVED over the wire, so it carries no agent public key and no agent
 * signature — there is no third party's signature to verify. That is about
 * provenance, not confinement: whenever a reviewer runs — adversarial mode
 * always, and the default `ask` mode with suggestions on — an intent's contents
 * are formatted into a prompt and sent outbound
 * (apps/desktop/src/adversarialAgent.ts).
 * The DEVICE signature over a Grant stays: that one is the Mac attesting to its
 * own decision.
 */
import crypto from "node:crypto";
import { Capability, normalizedCapability, RuleKey } from "./capability.js";
import { canonicalBytes, isoNow, JSONValue } from "./json.js";
import { KeyPair } from "./identity.js";

export interface Intent {
  intentId: string;
  agentId: string;
  agentDisplay: string;
  deviceId: string;
  goal?: string;
  planContext?: string;
  request: string;
  capabilities: Capability[];
  createdAt: string;
  expiresAt: string;
  sessionId: string;
  nonce: string;
}

export function makeIntent(args: {
  agentId: string;
  agentDisplay: string;
  deviceId: string;
  goal?: string;
  planContext?: string;
  request: string;
  capabilities: Capability[];
  sessionId: string;
  ttlSeconds?: number;
}): Intent {
  return {
    intentId: crypto.randomUUID().toUpperCase(),
    agentId: args.agentId,
    agentDisplay: args.agentDisplay,
    deviceId: args.deviceId,
    goal: args.goal,
    planContext: args.planContext,
    request: args.request,
    capabilities: args.capabilities,
    createdAt: isoNow(),
    expiresAt: isoNow(args.ttlSeconds ?? 120),
    sessionId: args.sessionId,
    nonce: crypto.randomUUID().toUpperCase(),
  };
}

export function intentIsExpired(intent: Intent, now = new Date()): boolean {
  return now.getTime() > new Date(intent.expiresAt).getTime();
}

export function intentRuleKey(intent: Intent): string {
  return RuleKey.compute(intent.agentId, intent.deviceId, intent.capabilities);
}

export type Decision = "allow_once" | "always_allow" | "deny";

export function decisionIsAllowed(decision: Decision): boolean {
  return decision !== "deny";
}

/** The signed record of an approval decision. */
export interface Grant {
  intentId: string;
  agentId: string;
  deviceId: string;
  decision: Decision;
  capabilities: Capability[];
  ruleKey: string;
  /** "prompt" (human/policy delegate decided) or "rule" (stored always-allow rule). */
  source: string;
  issuedAt: string;
  deviceSignature?: string;
}

export function makeGrant(intent: Intent, decision: Decision, source: string): Grant {
  return {
    intentId: intent.intentId,
    agentId: intent.agentId,
    deviceId: intent.deviceId,
    decision,
    capabilities: intent.capabilities,
    ruleKey: intentRuleKey(intent),
    source,
    issuedAt: isoNow(),
  };
}

export function grantSigningData(grant: Grant): Buffer {
  const unsigned = { ...grant };
  delete unsigned.deviceSignature;
  return canonicalBytes(unsigned as unknown as JSONValue);
}

export function signGrant(grant: Grant, keyPair: KeyPair): void {
  grant.deviceSignature = keyPair.sign(grantSigningData(grant)).toString("base64");
}

/** A stored always-allow rule (exact capability match). */
export interface AlwaysAllowRule {
  ruleKey: string;
  agentId: string;
  agentDisplay: string;
  deviceId: string;
  capabilities: Capability[];
  createdAt: string;
}

export function makeAlwaysAllowRule(intent: Intent): AlwaysAllowRule {
  return {
    ruleKey: intentRuleKey(intent),
    agentId: intent.agentId,
    agentDisplay: intent.agentDisplay,
    deviceId: intent.deviceId,
    capabilities: intent.capabilities.map(normalizedCapability),
    createdAt: isoNow(),
  };
}
