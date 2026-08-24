import { CloudAgentResource, CloudAgentStatus } from "./cloudAgents.js";

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
}

export interface CloudAgentDisplayContext {
  /** Resolved from the separately fetched chat list. */
  chatLabel?: string;
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
  return {
    agentId: agent.agentId,
    name: agent.name ?? context.fallbackName ?? "cloud agent",
    chatUid: agent.chatUid,
    chatLabel: context.chatLabel ?? agent.chatUid,
    provider: agent.provider ?? "",
    status: agent.status,
    failureReason: agent.failureReason,
    createdAt: agent.createdAt,
  };
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
