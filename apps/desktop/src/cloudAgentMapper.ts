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
 * ONE key, used INSIDE the main process. Comparing the pair at each seam was
 * tried and kept missing one; a single value has nothing to forget.
 *
 * It does NOT cross to the renderer. It embeds `agent_id`, which the host
 * writes — a self-hosted one could return `base64(bearer)` there, walk past
 * `echoesCredential`'s literal check, and land reversible credential material
 * in the DOM. The renderer gets a `RowHandle` instead, which this process
 * mints and which carries no host-authored bytes at all.
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

/**
 * What the renderer holds instead of a `RowKey`: a small minted token like
 * `r7`, with no host bytes in it.
 *
 * Deliberately meaningless. Nothing may parse it — main maps it back to the
 * real identity — so there is no encoding for a hostile host to hide inside.
 */
export type RowHandle = string & { readonly __rowHandle: unique symbol };

/**
 * Stable handles for row keys, for the life of the process.
 *
 * STABLE matters: the renderer stores a handle in open modal state, and a new
 * one on every refresh would unbind the modal mid-interaction. Unbounded in
 * principle, bounded in practice by the agents an account has ever listed in
 * one session.
 */
export class RowHandles {
  private readonly toHandle = new Map<RowKey, RowHandle>();
  private readonly toKey = new Map<RowHandle, RowKey>();
  private next = 1;

  handleFor(key: RowKey): RowHandle {
    const existing = this.toHandle.get(key);
    if (existing) return existing;
    const handle = `r${this.next++}` as RowHandle;
    this.toHandle.set(key, handle);
    this.toKey.set(handle, key);
    return handle;
  }

  /** `null` for anything this process did not mint — including a handle the
   * renderer invented, which is the case worth refusing. */
  keyFor(handle: string): RowKey | null {
    return this.toKey.get(handle as RowHandle) ?? null;
  }
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
   * The renderer's handle for this agent. Genuinely opaque — minted by main,
   * carrying nothing the host wrote — so the renderer can join, focus, store
   * and send it without ever holding a host-authored identifier.
   */
  rowKey: RowHandle;
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

/** Statuses the screen knows how to render. A self-host writes this field, so
 * anything else becomes `failed` rather than reaching the DOM verbatim. */
const KNOWN_STATUSES = new Set(["provisioning", "running", "failed", "teardown"]);

export interface CloudAgentDisplayContext {
  /** The name the OWNER typed when creating this agent, for a self-hosted row
   * whose host-echoed name is not trusted. */
  localName?: string;
  /** The host this agent was listed from. Defaults to the built-in Plow. */
  targetId?: string;
  /** The renderer-facing handle main minted for this row. */
  rowKey?: RowHandle;
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
  // A SELF-HOSTED row is projected from local facts only.
  //
  // Its host is an origin the owner typed in, and every string it returns is
  // therefore attacker-controllable in the case that matters: a host echoing
  // `base64(bearer)` as the agent's NAME walks past `echoesCredential`'s
  // literal/prefix check and lands a reversible credential in the DOM. The
  // handle already keeps host bytes out of the routing identity; this keeps
  // them out of the display too. Plow is not treated this way — it is the
  // build's own origin, not one someone typed.
  const selfHosted = targetId !== BUILTIN_TARGET_ID;
  if (selfHosted) {
    return {
      rowKey: context.rowKey ?? ("r0" as RowHandle),
      // The renderer addresses rows by handle, so it never needs the id.
      agentId: "",
      targetId,
      name: context.localName?.trim() || "Local agent",
      line: context.line === null || context.line === undefined
        ? null
        : { uid: context.line.uid, label: context.line.label },
      canMessage: context.canMessage === true,
      canRetry: context.canRetry === true,
      threads: (context.threads ?? []).map((thread) => ({ ...thread })),
      status: KNOWN_STATUSES.has(agent.status) ? agent.status : "failed",
      // A host-authored date string is prose; the row simply does not date it.
      failureReason: failureReason === null ? null : failureReason,
      createdAt: "",
    };
  }
  return {
    // Minted by main; contains nothing the host wrote, so nothing to scrub.
    rowKey: context.rowKey ?? ("r0" as RowHandle),
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
