/**
 * At-most-once execution for a caller that retries (design §6).
 *
 * A response can be lost without the work being lost with it: the socket dies
 * after this Mac ran the command, or the relay gives up on an exchange whose
 * side effect already happened. The honest agent's move is to retry — and
 * without this, the retry asks the human again and does the thing again.
 *
 * The contract is small and deliberately not distributed:
 *
 *  - **The caller names the operation.** An `operation_id` it chooses, so the
 *    retry can say "this is the same request", which is knowledge only the
 *    caller has. This Mac cannot infer it: two identical `write_file` calls
 *    might be one retry or two intended writes.
 *  - **Scoped to `(agent_id, operation_id)`.** An id is a name inside one
 *    agent's namespace and nothing more. Another agent using the same string
 *    gets its own record, and can never learn that anyone else used it.
 *  - **The arguments are fingerprinted.** Reusing an id for a different request
 *    is a caller bug, and answering the old result would hide it. That is a
 *    conflict, said out loud.
 *  - **Process-lifetime, not exactly-once.** These records live in memory. A
 *    restart forgets them, and the design says so: what is on offer is
 *    at-most-once for a cooperating caller inside one run of this app.
 */
import { canonicalJSON, JSONValue } from "@domo/protocol";
import { DeniedError } from "./deferred.js";

/**
 * URL-safe, 1–128 characters.
 *
 * Narrow on purpose: the id travels in JSON today, but it names something a
 * human may have to read in a log or a support thread, and a value that needs
 * escaping to be written down is a value that will be written down wrong.
 */
export const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** How long a terminal result stays retrievable by its operation id. */
export const OPERATION_TTL_MS = 15 * 60_000;

/**
 * How long the id stays reserved after that.
 *
 * A tombstone is the difference between "your result is gone" and "I have never
 * heard of this", and a retry arriving in that window must not be treated as a
 * fresh operation — running the side effect a second time is exactly what this
 * module exists to prevent.
 */
export const OPERATION_TOMBSTONE_MS = 15 * 60_000;

/** The argument key that names the operation, excluded from its fingerprint. */
export const OPERATION_ID_KEY = "operation_id";

export class OperationError extends Error {}

/** Thrown when an id is reused for a different request. */
export class OperationConflictError extends OperationError {
  constructor(public readonly operationId: string) {
    super(
      `operation_id '${operationId}' was already used for a different request. ` +
        `Use a new operation_id for new work, or repeat the original arguments exactly.`,
    );
    this.name = "OperationConflictError";
  }
}

/** Validate a caller-supplied id, or say precisely what is wrong with it. */
export function checkOperationId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OperationError("missing 'operation_id' (1-128 URL-safe characters)");
  }
  if (!OPERATION_ID_PATTERN.test(value)) {
    throw new OperationError(
      "'operation_id' must be 1-128 characters of A-Z a-z 0-9 - _ (URL-safe)",
    );
  }
  return value;
}

/**
 * A canonical fingerprint of what was asked, minus the id that names it.
 *
 * The id is excluded because it is the *name* of the request, not part of it —
 * and canonical JSON is what makes two spellings of the same arguments compare
 * equal, so a retry that reorders its keys is still a retry.
 */
export function operationFingerprint(tool: string, args: JSONValue): string {
  let rest: { [k: string]: JSONValue } = { value: args };
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    rest = {};
    for (const [key, value] of Object.entries(args)) {
      if (key === OPERATION_ID_KEY || value === undefined) continue;
      rest[key] = value;
    }
  }
  return canonicalJSON({ tool, args: rest } as JSONValue);
}

type Record_ = {
  fingerprint: string;
  /** What the first call answered with — awaited by a retry that races it. */
  envelope: Promise<JSONValue>;
  /** The deferred handle, once the envelope turns out to be a pending one. */
  handle: string | null;
  /**
   * What a call that answered INLINE returned, kept for a lookup by id.
   *
   * A deferred operation is found through its handle; one that finished inside
   * its budget has no handle at all, and without this its result could only be
   * reached by repeating the call — which is exactly what a caller who lost the
   * response cannot safely do.
   */
  value: JSONValue | null;
  /** Why it failed, for the same lookup. A failure is an answer too. */
  failure: string | null;
  /**
   * Whether that failure was a refusal rather than a fault.
   *
   * "The owner said no" and "it broke" are different answers, and §4.3 keeps
   * them apart everywhere else; a lookup that flattened a denial into a failure
   * would be the one place an agent could not tell.
   */
  denied: boolean;
  /** When the work settled, or null while it is still running. */
  settledAt: number | null;
};

/** What a lookup by operation id found. */
export type OperationLookup =
  | { kind: "none"; fingerprint?: undefined }
  | { kind: "live"; record: Record_; fingerprint: string }
  | { kind: "tombstone"; fingerprint: string };

export class OperationRecords {
  /** `agentId` → `operationId` → record. One namespace per agent, by shape. */
  private readonly byAgent = new Map<string, Map<string, Record_>>();

  constructor(
    private readonly ttlMs = OPERATION_TTL_MS,
    private readonly tombstoneMs = OPERATION_TOMBSTONE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Run `work` for this operation, or answer with what the first attempt did.
   *
   * `readState` is how a repeat of an operation that deferred gets the CURRENT
   * state rather than the stale pending envelope: the handle is looked up
   * afresh, so a retry after the human answered receives the result.
   */
  async run(
    agentId: string,
    operationId: string,
    fingerprint: string,
    work: () => Promise<JSONValue>,
    readState: (handle: string) => JSONValue,
    /** Resolves when a DEFERRED attempt's work finally lands. */
    settledSignal: (handle: string) => Promise<void> = () => new Promise<void>(() => {}),
  ): Promise<JSONValue> {
    this.sweep();
    const found = this.lookup(agentId, operationId);

    // The fingerprint is checked FIRST, tombstone or not. An id reused for
    // different work is a caller bug whether or not the original result is
    // still around, and answering "expired" would let that bug look like an
    // ordinary retry that arrived late.
    if (found.kind !== "none" && found.fingerprint !== fingerprint) {
      throw new OperationConflictError(operationId);
    }

    if (found.kind === "tombstone") {
      // The id is still reserved: its result is gone, but re-running the work
      // would be the duplicate side effect this exists to prevent.
      return { status: "expired", operation_id: operationId };
    }

    if (found.kind === "live") {
      return this.replay(found.record, readState);
    }

    // Registered BEFORE the work starts, so a retry arriving while the first
    // attempt is still running finds it rather than starting a second one.
    const record: Record_ = {
      fingerprint,
      envelope: Promise.resolve(null as JSONValue),
      handle: null,
      value: null,
      failure: null,
      denied: false,
      settledAt: null,
    };
    this.namespace(agentId).set(operationId, record);
    record.envelope = work().then(
      (value) => {
        record.handle = handleOf(value);
        // A pending envelope is not the end of the work — the deferred store
        // owns that clock. Anything else is terminal here and now.
        if (record.handle === null) {
          record.value = value;
          record.settledAt = this.now();
        } else {
          // Deferred: retention starts when the WORK lands, not when the
          // envelope went out. Without this the record never settles, so it
          // never reaches its tombstone and the id is reserved for ever.
          const handle = record.handle;
          void settledSignal(handle).then(() => {
            if (record.settledAt === null) record.settledAt = this.now();
          });
        }
        return value;
      },
      (error: unknown) => {
        // A failure is an outcome too: the caller's retry gets the same answer
        // rather than a second attempt at something that did not work.
        record.failure = error instanceof Error ? error.message : String(error);
        record.denied = error instanceof DeniedError;
        record.settledAt = this.now();
        throw error;
      },
    );
    return record.envelope;
  }

  /**
   * The current answer for an operation, for `get_result`.
   *
   * An unknown id — never used, or used by somebody else — is `null` here and
   * `unknown` to the caller: an id is not an oracle for what other agents do.
   */
  lookupState(
    agentId: string,
    operationId: string,
    readState: (handle: string) => JSONValue,
  ): JSONValue | null {
    this.sweep();
    const found = this.lookup(agentId, operationId);
    if (found.kind === "none") return null;
    if (found.kind === "tombstone") return { status: "expired", operation_id: operationId };
    const record = found.record;
    if (record.handle !== null) return readState(record.handle);
    if (record.settledAt === null) return { status: "pending", operation_id: operationId };
    if (record.failure !== null) {
      // A refusal keeps its own name. Denied is a decision; failed is a fault.
      return record.denied
        ? { status: "denied", operation_id: operationId, reason: record.failure }
        : { status: "failed", operation_id: operationId, error: record.failure };
    }
    // Answered inside its budget: the result the lost response carried.
    return { status: "ready", operation_id: operationId, result: record.value };
  }

  /** The terminal envelope of a settled operation, if it has one. */
  async settledEnvelope(agentId: string, operationId: string): Promise<JSONValue | null> {
    const found = this.lookup(agentId, operationId);
    if (found.kind !== "live" || found.record.handle !== null) return null;
    return found.record.envelope;
  }

  /** How many operations are held, across every agent. For tests. */
  get size(): number {
    let total = 0;
    for (const ops of this.byAgent.values()) total += ops.size;
    return total;
  }

  private async replay(
    record: Record_,
    readState: (handle: string) => JSONValue,
  ): Promise<JSONValue> {
    const envelope = await record.envelope;
    // Answered inline, or still running: the first attempt's answer stands.
    if (record.handle === null) return envelope;
    // Deferred: the handle is re-read, so a retry arriving after the human
    // answered receives the RESULT rather than the pending envelope it already
    // has. "The existing state or result", not a recording of the first reply.
    return readState(record.handle);
  }

  private lookup(agentId: string, operationId: string): OperationLookup {
    const record = this.namespace(agentId).get(operationId);
    if (!record) return { kind: "none" };
    if (record.settledAt !== null && this.now() - record.settledAt > this.ttlMs) {
      return { kind: "tombstone", fingerprint: record.fingerprint };
    }
    return { kind: "live", record, fingerprint: record.fingerprint };
  }

  private namespace(agentId: string): Map<string, Record_> {
    let ops = this.byAgent.get(agentId);
    if (!ops) {
      ops = new Map();
      this.byAgent.set(agentId, ops);
    }
    return ops;
  }

  /** Drop ids whose tombstone has also elapsed: from here they are free again. */
  private sweep(): void {
    const now = this.now();
    for (const [agentId, ops] of this.byAgent) {
      for (const [id, record] of ops) {
        if (record.settledAt === null) continue;
        if (now - record.settledAt > this.ttlMs + this.tombstoneMs) ops.delete(id);
      }
      if (ops.size === 0) this.byAgent.delete(agentId);
    }
  }
}

/** The deferred handle out of a pending envelope, or null for anything else. */
function handleOf(value: JSONValue): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { status?: unknown; handle?: unknown };
  if (record.status !== "pending" || typeof record.handle !== "string") return null;
  return record.handle;
}
