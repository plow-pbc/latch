import { CloudAgentResource, CloudAgentStatus } from "./cloudAgents.js";
import { BUILTIN_TARGET_ID } from "./plowApi.js";

const FAILURE_LABELS: Record<string, string> = {
  provider_unreachable: "Provider unreachable",
  image_pull_timeout: "Image pull timed out",
  setup_failed: "Setup failed",
  validation_failed: "Validation failed — retrying will not help; ask a human",
  unknown: "Unknown failure",
  provision_timeout: "Provision timed out",
};

/** The complete cloud-agent shape allowed to cross into the renderer. */
export interface CloudAgentThread {
  uid: string;
  label: string;
}

export interface CloudAgentLine {
  uid: string;
  label: string;
}

export interface CloudAgentDisplayRow {
  agentId: string;
  /**
   * Which host this agent lives on — `BUILTIN_TARGET_ID` for Plow itself.
   *
   * The row carries it because every later call about this agent (delete,
   * change line, poll) has to reach the SAME host, and the agent id alone
   * cannot say which one that is.
   */
  targetId: string;
  name: string;
  line: CloudAgentLine | null;
  /** Whether the resolved line has an E.164 destination for Messages. */
  canMessage: boolean;
  /** Whether main retains enough create data to retry a failed agent. */
  canRetry: boolean;
  /** Read-only threads on the line. */
  threads: CloudAgentThread[];
  status: CloudAgentStatus;
  failureReason: string | null;
  createdAt: string;
}

export interface CloudAgentDisplayContext {
  /** The host this agent was listed from. Defaults to the built-in Plow. */
  targetId?: string;
  /** The agent's line resolved through its home chat. */
  line?: CloudAgentLine | null;
  /** Whether the resolved line has an E.164 destination for Messages. */
  canMessage?: boolean;
  /** Whether main retains enough create data to retry a failed agent. */
  canRetry?: boolean;
  /** Threads resolved from the separately fetched chat list. */
  threads?: readonly CloudAgentThread[];
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
  // ALLOWLIST ONLY. `failure_reason` is prose written by the host, and a
  // self-hosted one is an origin its owner typed in — it can put anything
  // there, including its own bearer in an encoding no echo check can see
  // through. Forwarding it is the same seam the 400-detail passthrough was
  // deleted for, so the same answer applies here: a known code becomes a
  // label WE wrote, and anything else says nothing rather than repeating the
  // server.
  const failureReason = agent.failureCode && Object.hasOwn(FAILURE_LABELS, agent.failureCode)
    ? FAILURE_LABELS[agent.failureCode]
    : agent.failureReason
      ? "Reason unavailable"
      : null;
  const line = context.line ?? null;
  return {
    agentId: scrub(agent.agentId),
    // Never scrubbed: a target id is this app's own, not server-authored.
    targetId: context.targetId ?? BUILTIN_TARGET_ID,
    name: scrub(agent.name ?? "cloud agent"),
    line: line === null ? null : { uid: scrub(line.uid), label: scrub(line.label) },
    canMessage: context.canMessage === true,
    canRetry: context.canRetry === true,
    threads: (context.threads ?? [])
      .map((thread) => ({ uid: scrub(thread.uid), label: scrub(thread.label) })),
    status: agent.status,
    failureReason: failureReason === null ? null : scrub(failureReason),
    createdAt: agent.createdAt === null ? "" : scrub(agent.createdAt),
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
