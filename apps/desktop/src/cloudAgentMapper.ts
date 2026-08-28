import { CloudAgentResource, CloudAgentStatus } from "./cloudAgents.js";
import type { ChatRecipients } from "./activation.js";

const FAILURE_LABELS: Record<string, string> = {
  provider_unreachable: "Provider unreachable",
  image_pull_timeout: "Image pull timed out",
  setup_failed: "Setup failed",
  validation_failed: "Validation failed — retrying will not help; ask a human",
  unknown: "Unknown failure",
  provision_timeout: "Provision timed out",
};

/** The complete cloud-agent shape allowed to cross into the renderer. */
export interface CloudAgentDisplayRow {
  agentId: string;
  name: string;
  /**
   * Every chat this agent serves, in the server's order. `chatUids[0]` is
   * home — where the agent's unprompted output lands — and the screen shows it
   * first for that reason, not because it happens to be first.
   */
  chatUids: string[];
  /**
   * A label per entry of `chatUids`, index for index.
   *
   * Two parallel arrays rather than a list of pairs because the uid is the join
   * key and the label is a lookup that can fail: an unresolved label falls back
   * to its own uid, so the arrays are always the same length and a row can
   * never name fewer chats than it serves.
   */
  chatLabels: string[];
  provider: string;
  status: CloudAgentStatus;
  failureReason: string | null;
  createdAt: string;
  /**
   * The numbers a message to this agent's HOME chat goes to, or `null` when
   * they are not known. Home is the one the Message button targets; the other
   * chats are served, not addressed from here.
   *
   * Carried rather than derived: the label is prose and was being scraped for
   * digits, which produced an empty recipient list for a label with none and
   * an incomplete one for a label that showed a display name. `null` means the
   * screen must not offer to message the chat at all.
   */
  recipients: ChatRecipients | null;
}

export interface CloudAgentDisplayContext {
  /**
   * Labels resolved from the separately fetched chat list, keyed by uid. A uid
   * the list does not know is simply absent, and the row shows the uid.
   */
  chatLabels?: Readonly<Record<string, string>>;
  /** The home chat's recipients, from the same place and absent for the same
   * reasons. */
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
  const failureReason = agent.failureCode && Object.hasOwn(FAILURE_LABELS, agent.failureCode)
    ? FAILURE_LABELS[agent.failureCode]
    : agent.failureReason;
  return {
    agentId: scrub(agent.agentId),
    name: scrub(agent.name ?? context.fallbackName ?? "cloud agent"),
    chatUids: agent.chatUids.map(scrub),
    chatLabels: agent.chatUids.map((uid) => scrub(context.chatLabels?.[uid] || uid)),
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
