/**
 * Per-agent ownership of running command jobs (design §4.4).
 *
 * `run_command` hands back a job handle and `get_output` reads more of it. The
 * executor that mints those handles knows nothing about agents — it is one
 * registry for the whole process — so without this, any agent holding or
 * guessing a handle could read another agent's command output, and two agents
 * would be reading one shared stream.
 *
 * Ownership lives here rather than in the executor because this is the only
 * layer that knows who is calling: `agent_id` arrives on the request frame and
 * goes no deeper than the MCP server.
 *
 * The refusal is deliberately **indistinguishable** from a handle that never
 * existed — same error text the executor itself raises — so a handle is not an
 * oracle for what other agents are doing, exactly as with deferred handles.
 */

/** Verbatim the executor's own wording for a handle it does not know. */
export function unknownHandleMessage(handle: string): string {
  return `unknown output handle: ${handle}`;
}

export class UnknownJobError extends Error {
  constructor(handle: string) {
    super(unknownHandleMessage(handle));
    this.name = "UnknownJobError";
  }
}

export class JobOwners {
  private readonly owners = new Map<string, string>();

  /** Record that `agentId` started the job behind `handle`. */
  claim(agentId: string, handle: string): void {
    // First claim wins. Handles are executor-minted UUIDs, so a collision is
    // not a real scenario — but silently reassigning an owner would be, so it
    // is refused rather than trusted.
    if (!this.owners.has(handle)) this.owners.set(handle, agentId);
  }

  /** Throw unless `agentId` is the agent that started this job. */
  assertOwner(agentId: string, handle: string): void {
    if (this.owners.get(handle) !== agentId) throw new UnknownJobError(handle);
  }

  /** How many jobs are tracked. For tests. */
  get size(): number {
    return this.owners.size;
  }
}
