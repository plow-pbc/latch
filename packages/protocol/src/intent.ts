/**
 * Intent / Decision / Grant / AlwaysAllowRule — twin of DomoProtocol/Intent.swift.
 * Dates are ISO-8601 strings (seconds precision) at rest and on the wire, so
 * canonical encoding never touches floating point.
 *
 * An Intent is built on this Mac from an authenticated agent's tool call and is
 * never RECEIVED over the wire, so it carries no agent public key and no agent
 * signature. That is provenance, not confinement — DESIGN.md §4 *The intent
 * object* owns where an intent's contents go. The DEVICE signature over a Grant stays: that one is the Mac
 * attesting to its own decision.
 */
import crypto from "node:crypto";
import { capabilityDisplay } from "./capability.js";
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

/**
 * What of an intent's free text may become durable.
 *
 * `request` and `goal` are display copy for the approver and both may carry
 * the operation's content — for a `tool` capability that content is the
 * owner's message text, and `goal` is the agent's own prose about the errand,
 * which describes it just as readily. Anything persisted takes the
 * capability's description instead: the action and the target, which is what
 * was authorised.
 *
 * Every other kind passes through. An exec's argv and a file op's path ARE the
 * operation rather than data inside it, and an audit that omitted them would
 * say nothing.
 *
 * One helper, every persisting site — `intent_received` here and the approval
 * store's record — because sanitising them one at a time is how the second one
 * gets missed. The live approval dialog reads `intent` directly and is
 * unaffected: the approver still sees the excerpt.
 *
 * KNOWN GAP, deliberately not closed here: when adversarial review is on, the
 * reviewer is shown the un-redacted request (it has to be) and its free-text
 * `reason` is persisted as `adversarial_review_result`. A verdict that quotes
 * what it judged puts that text back in the log. Screening model prose against
 * an excerpt is not something a helper can do honestly, so it is named rather
 * than half-solved.
 */
export function durableIntentText(intent: Intent): { request: string } {
  const tool = intent.capabilities.find((c) => c.kind === "tool");
  // `goal` goes unconditionally. Why it is unsafe does not depend on the kind:
  // it is agent-authored prose and `GOAL` is in `plow_write_file`'s and
  // `plow_run_command`'s schemas too, so an agent can put a file's bytes in
  // the goal of a write and land them in both durable records — the same split
  // (record the path, never the bytes) that keying this on `tool` was meant to
  // preserve. The live dialog reads the intent directly, so the approver still
  // sees it.
  // The key is OMITTED, not blanked. `""` is non-null, so it would win a `??`
  // chain over a real fallback — the Activity view resolves a goal from
  // `intent_received` then `access_request` then `agent_spawned`.
  return { request: tool ? capabilityDisplay(tool) : intent.request };
}
