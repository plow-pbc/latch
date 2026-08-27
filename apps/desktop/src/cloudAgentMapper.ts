import { CloudAgentResource, CloudAgentStatus } from "./cloudAgents.js";
import type { ChatRecipients } from "./onboarding.js";

const KNOWN_FAILURE_CODES = new Set([
  "provider_unreachable", "image_pull_timeout", "setup_failed",
  "validation_failed", "unknown", "provision_timeout",
]);

/** The complete cloud-agent shape allowed to cross into the renderer. */
export interface CloudAgentDisplayRow {
  agentId: string;
  name: string;
  chatUid: string;
  chatLabel: string;
  provider: string;
  status: CloudAgentStatus;
  failureReason: string | null;
  createdAt: string;
  /**
   * The numbers a message to this agent's chat goes to, or `null` when they
   * are not known.
   *
   * Carried rather than derived: the label is prose and was being scraped for
   * digits, which produced an empty recipient list for a label with none and
   * an incomplete one for a label that showed a display name. `null` means the
   * screen must not offer to message the chat at all.
   */
  recipients: ChatRecipients | null;
}

export interface CloudAgentDisplayContext {
  /** Resolved from the separately fetched chat list. */
  chatLabel?: string;
  /** Resolved from the same place, and absent for the same reasons. */
  recipients?: ChatRecipients | null;
  /** The submitted name fills the gap in the initial create receipt. */
  fallbackName?: string;
}

/**
 * Reduce a main-process resource to the renderer's display contract. In
 * particular, credential identity (`sessionId`) and the provider URL have no
 * representation in the returned object.
 */
export function toCloudAgentDisplayRow(
  agent: CloudAgentResource,
  context: CloudAgentDisplayContext = {},
): CloudAgentDisplayRow {
  const scrub = (value: string): string => scrubSessionId(value, agent.sessionId);
  const failureReason = agent.failureCode && KNOWN_FAILURE_CODES.has(agent.failureCode)
    ? agent.failureCode
    : agent.failureReason ?? agent.failureCode ?? null;
  return {
    agentId: scrub(agent.agentId),
    name: scrub(agent.name ?? context.fallbackName ?? "cloud agent"),
    chatUid: scrub(agent.chatUid),
    chatLabel: scrub(context.chatLabel ?? agent.chatUid),
    provider: scrub(agent.provider ?? ""),
    status: agent.status,
    failureReason: failureReason === null ? null : scrub(failureReason),
    createdAt: agent.createdAt === null ? "" : scrub(agent.createdAt),
    // Addresses, not prose: nothing to scrub a session id out of, and nothing
    // to invent when the chat list could not say.
    recipients: context.recipients ?? null,
  };
}

function scrubSessionId(value: string, sessionId: string | null): string {
  if (!sessionId) return value;
  return value.split(sessionId).join("[credential]");
}

/** The only KeyInfo field needed to associate a credential with its agent. */
export interface CloudAgentKeyInfo {
  agent_id: string | null;
}

export interface CloudAgentKeyJoin<Key extends CloudAgentKeyInfo> {
  agent: CloudAgentResource;
  key: Key | null;
}

/** Join on the stable agent id. Session ids deliberately do not participate. */
export function joinCloudAgentsWithKeys<Key extends CloudAgentKeyInfo>(
  agents: readonly CloudAgentResource[],
  keys: readonly Key[],
): CloudAgentKeyJoin<Key>[] {
  const byAgentId = new Map(
    keys.filter((key) => key.agent_id !== null).map((key) => [key.agent_id, key] as const),
  );
  return agents.map((agent) => ({ agent, key: byAgentId.get(agent.agentId) ?? null }));
}
