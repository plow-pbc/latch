import { AgentSettings, CloudAgentResource, CloudAgentStatus } from "./cloudAgents.js";

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
  name: string;
  line: CloudAgentLine | null;
  /** Whether the resolved line has an E.164 destination for Messages. */
  canMessage: boolean;
  /** Whether main retains enough create data to retry a failed agent. */
  canRetry: boolean;
  /** Read-only threads on the line. */
  threads: CloudAgentThread[];
  status: CloudAgentStatus | null;
  provider: string;
  settings: AgentSettings;
  connected: boolean;
  lastSeenAt: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface CloudAgentDisplayContext {
  /** The agent's own line. */
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
 * particular, credential identity and the provider URL have no
 * representation in the returned object.
 */
export function toCloudAgentDisplayRow(
  agent: CloudAgentResource,
  context: CloudAgentDisplayContext = {},
): CloudAgentDisplayRow {
  const failureReason = agent.failureCode
    ? Object.hasOwn(FAILURE_LABELS, agent.failureCode) ? FAILURE_LABELS[agent.failureCode] : "Agent operation failed"
    : null;
  const line = context.line ?? null;
  return {
    agentId: agent.agentId,
    name: agent.name,
    line: line === null ? null : { uid: line.uid, label: line.label },
    canMessage: context.canMessage === true,
    canRetry: context.canRetry === true,
    threads: (context.threads ?? [])
      .map((thread) => ({ uid: thread.uid, label: thread.label })),
    status: agent.status,
    provider: agent.provider,
    settings: agent.settings,
    connected: agent.credential?.connected ?? false,
    lastSeenAt: agent.credential?.last_seen_at ?? null,
    failureReason,
    createdAt: agent.createdAt,
  };
}
