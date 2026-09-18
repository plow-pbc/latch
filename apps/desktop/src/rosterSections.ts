/** Independent MCP clients; agents have their own resource roster. */
import { parseApiTimestamp, type KeyDevice, type KeyInfo } from "./plowApi.js";

/**
 * What a client may do beyond reaching this Mac, which every listed one can.
 *
 * Derived here from its real scopes: a permission line that does not read the
 * permissions is a claim, not a description.
 *
 * Booleans and never the scopes themselves: the renderer has no business
 * knowing plow's scope grammar, and a projection cannot leak what it does not
 * carry.
 */
export interface RosterPermissions {
  /** `chats:use` — reads and replies in the chats it is scoped to. */
  canReadAndReply: boolean;
  /** `llm:chat` — may spend inference on the account. */
  canSpendInference: boolean;
}

/**
 * Which chats a credential is scoped to.
 *
 * `[]` and `["*"]` are opposites and were being read as the same thing: plow
 * treats an empty list as covering NO chats (`auth.py:120`), so a credential
 * granted nothing was reading as granted everything. Projected as a word so
 * the screen cannot make that mistake again by counting.
 */
export type ChatAccess = "all" | "none" | "listed";

/** One MCP client: relay-capable, not an agent. Removal is a key revoke. */
export interface RosterRow {
  id: number;
  name: string | null;
  createdAt: string | null;
  lastSeenAt: string | null;
  chatUids: string[];
  /** How many of `chatUids` to name is the screen's business; whether it is
   * "all", "none" or a list is not. */
  chatAccess: ChatAccess;
  permissions: RosterPermissions;
  /**
   * The Mac this credential may be used from, ready to read.
   *
   * A LABEL and never a uid: a device uid identifies a device on the account
   * and a resource uid identifies what a credential was bound through, and
   * both stay in the main process, the same rule `key_prefix` and `scopes`
   * follow. `null` means the credential is bound to nothing and works from any
   * Mac — which is a different thing from being bound somewhere this screen
   * cannot name, and reads differently.
   */
  deviceLabel: string | null;
}

/**
 * Most recently used first, then the never-used by when they were made.
 *
 * A credential that has never been seen is not "oldest" — it is unknown, and
 * sorting it in among real timestamps would put a client made this morning
 * above one used a minute ago.
 */
function byLastUsed(a: RosterRow, b: RosterRow): number {
  // Newest first, and EQUAL means equal — a comparator that answers -1 for two
  // identical timestamps is inconsistent, and sorts differently depending on
  // where a row started.
  const seen = newestFirst(a.lastSeenAt, b.lastSeenAt);
  if (seen !== 0) return seen;
  const made = newestFirst(a.createdAt, b.createdAt);
  if (made !== 0) return made;
  return a.id - b.id;
}

/** Newer first; a missing timestamp sorts after every real one. */
function newestFirst(a: string | null, b: string | null): number {
  if (a && b) return a === b ? 0 : a < b ? 1 : -1;
  if (a) return -1;
  if (b) return 1;
  return 0;
}

function normalizeRosterTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const timestamp = parseApiTimestamp(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

/**
 * Does this credential's scope set cover the one asked about?
 *
 * plow's matcher recognises three forms and this must recognise the same
 * three, or the line understates what a wildcard token can do: the exact
 * grant, a resource wildcard (`relay:*`), and the global one (`*:*`).
 */
function scopeCovers(granted: readonly string[], required: string): boolean {
  const resource = required.split(":")[0];
  return granted.some(
    (scope) => scope === required || scope === `${resource}:*` || scope === "*:*",
  );
}

function rosterPermissions(scopes: readonly string[]): RosterPermissions {
  return {
    canReadAndReply: scopeCovers(scopes, "chats:use"),
    canSpendInference: scopeCovers(scopes, "llm:chat"),
  };
}

/**
 * What to call the Mac a credential is bound to.
 *
 * Four answers and no fifth: this Mac, the name Plow gave another one,
 * "another Mac" for a device row with no usable name, and "primary Mac" for one
 * bound to a resource Plow resolved no device row for. Never the uid, and never
 * nothing for a bound credential: one that rendered blank reads exactly like an
 * unbound one, and those differ in whether the thing holding it can reach this
 * screen's Mac at all.
 *
 * That last answer is the ACCOUNT alias, and PRESENCE is the whole signal: a
 * resource naming a device arrives as `device`, so a row bound to something
 * with no device row is bound to the account — which Plow accepts only through
 * the primary Mac, so the primary Mac is where it lands. Deliberately not a
 * comparison against the account uid: this app is never told what that is, and
 * a label that guessed would be wrong about a resource kind added later.
 */
function deviceLabelOf(
  device: KeyDevice | null,
  relayResourceUid: string | null,
  ourDeviceUid: string,
): string | null {
  if (!device) return relayResourceUid ? "primary Mac" : null;
  if (ourDeviceUid && device.uid === ourDeviceUid) return "this Mac";
  return device.name ?? "another Mac";
}

/** `["*"]` is every chat; `[]` is none of them; anything else is the list. */
function chatAccessOf(chatUids: readonly string[]): ChatAccess {
  if (chatUids.includes("*")) return "all";
  return chatUids.length === 0 ? "none" : "listed";
}

/**
 * The account's MCP clients: active credentials holding `relay:call` that no
 * agent owns. Agent credentials appear only in the agents resource roster, and
 * web logins, this Mac's own session and other account credentials are not
 * listed at all.
 */
export function mcpClientRoster(
  keys: readonly KeyInfo[],
  options: { deviceUid?: string | null } = {},
): RosterRow[] {
  const ourDeviceUid = (options.deviceUid ?? "").trim();
  return keys
    .filter((key) => key.is_active && key.agent_uid == null && key.scopes.includes("relay:call"))
    .map((key) => ({
      id: key.id,
      name: key.name,
      createdAt: normalizeRosterTimestamp(key.created_at),
      lastSeenAt: normalizeRosterTimestamp(key.last_seen_at),
      chatUids: key.chat_uids,
      chatAccess: chatAccessOf(key.chat_uids),
      permissions: rosterPermissions(key.scopes),
      deviceLabel: deviceLabelOf(key.device, key.relay_resource_uid, ourDeviceUid),
    }))
    .sort(byLastUsed);
}
