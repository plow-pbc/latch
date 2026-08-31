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

/**
 * How an agent is identified everywhere: the HOST it lives on plus its id on
 * that host.
 *
 * `agent_id` alone is not an identity. Plow mints uuids, but `agent-mgr`
 * answers with the NAME its owner typed — so a local agent can be called
 * exactly what a Plow agent is called. Keyed on the raw id, one silently
 * replaced the other, a Plow removal followed the survivor to the wrong host,
 * and the roster pinned Plow's metadata onto the local twin.
 *
 * ONE key, and it crosses to the renderer. Comparing the pair at each seam was
 * tried and kept missing one; a single opaque value has nothing to forget.
 */
export type RowKey = string & { readonly __rowKey: unique symbol };

/** NUL joins the halves: it occurs in neither, so the pair round-trips. */
export function rowKey(targetId: string, agentId: string): RowKey {
  return `${targetId}\u0000${agentId}` as RowKey;
}

/** The host half, for callers that must address a request to it. */
export function targetIdOf(key: RowKey): string {
  return key.split("\u0000")[0];
}

/** The agent half, as the host itself knows it. */
export function agentIdOf(key: RowKey): string {
  return key.slice(key.indexOf("\u0000") + 1);
}

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
  /**
   * The renderer's handle for this agent. Opaque: the renderer joins, focuses,
   * stores and sends this, and never rebuilds it from parts.
   */
  rowKey: RowKey;
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
  /** The lifecycle key, when the caller already holds it. */
  rowKey?: RowKey;
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
  const targetId = context.targetId ?? BUILTIN_TARGET_ID;
  return {
    // Never scrubbed: both halves are this app's own or already scrubbed.
    rowKey: context.rowKey ?? rowKey(targetId, scrub(agent.agentId)),
    agentId: scrub(agent.agentId),
    targetId,
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
