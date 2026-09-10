/** Independent MCP clients and sessions; agents have their own resource roster. */
import { parseApiTimestamp, type KeyDevice, type KeyInfo } from "./plowApi.js";

export type AgentRosterKind =
  | "Agent"
  | "Plow web login"
  | "Admin — full access"
  | "Session";

/**
 * What a credential may actually do, as three plain booleans.
 *
 * Derived here from its real scopes, because the row used to state all three
 * as literals — so an agent created over SMS straight from the API, which
 * carries no relay credential, still read "Will reach this Mac". A permission
 * line that does not read the permissions is a claim, not a description.
 *
 * Booleans and never the scopes themselves: the renderer has no business
 * knowing plow's scope grammar, and a projection cannot leak what it does not
 * carry.
 */
export interface RosterPermissions {
  /** `chats:use` — reads and replies in the chats it is scoped to. */
  canReadAndReply: boolean;
  /** `relay:call` — may ask to run things on this Mac. */
  canReachMac: boolean;
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

export interface RosterSectionRow {
  id: number;
  name: string | null;
  kind: AgentRosterKind;
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
  /**
   * This Mac's own stored credential.
   *
   * Revoking it signs this Mac out, so the screen has to say so before the
   * click. Matched on the key prefix, which is the only part of a credential
   * the server hands back — the credential itself never leaves the main
   * process, and this boolean is what crosses in its place.
   */
  isThisMac: boolean;
}

export interface RosterSections {
  /** MCP clients: relay-capable, not an agent. Removal is a key revoke. */
  mcp: RosterSectionRow[];
  /**
   * Everything else — web logins, other Macs, legacy tokens, and any
   * credential with no relay reach at all. Removal is a key revoke.
   *
   * Deliberately the default rather than a list of kinds: a kind this file has
   * never heard of belongs on screen, not silently dropped. An account with
   * ninety credentials should show ninety.
   */
  other: RosterSectionRow[];
  /** Revoked credentials, counted rather than listed. */
  revokedHidden: number;
}

export const EMPTY_ROSTER: RosterSections = Object.freeze({
  mcp: [],
  other: [],
  revokedHidden: 0,
});

/**
 * Most recently used first, then the never-used by when they were made.
 *
 * A credential that has never been seen is not "oldest" — it is unknown, and
 * sorting it in among real timestamps would put a client made this morning
 * above one used a minute ago.
 */
function byLastUsed(a: RosterSectionRow, b: RosterSectionRow): number {
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
    canReachMac: scopeCovers(scopes, "relay:call"),
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
 *
 * "This Mac" is decided by the DEVICE uid rather than by `isThisMac`, which
 * answers a different question — whether the row IS this Mac's own login
 * session. A credential minted here for someone's editor is bound to this Mac
 * and is not this Mac's session.
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

function rosterKind(scopes: readonly string[]): AgentRosterKind {
  if (scopes.includes("relay:call")) return "Agent";
  if (scopes.includes("relay:*")) return "Plow web login";
  if (scopes.includes("*:*")) return "Admin — full access";
  return "Session";
}

/** Agent-owned credentials appear only in the agents resource roster. */
export function sectionRoster(
  keys: readonly KeyInfo[],
  options: { deviceCredential?: string; deviceUid?: string | null } = {},
): RosterSections {
  const credential = (options.deviceCredential ?? "").trim();
  const ourDeviceUid = (options.deviceUid ?? "").trim();
  const sections: RosterSections = { mcp: [], other: [], revokedHidden: 0 };

  // Exactly one row is this Mac, or none is. Two rows matching means the match
  // is not identifying anything, and marking both would warn about revoking a
  // credential that is not ours — on the one row where the warning is the
  // difference between a revoke and signing this Mac out.
  const candidates = keys.filter(
    (key) => key.is_active && isDeviceCredential(key.key_prefix, credential),
  );
  const thisMacId = candidates.length === 1 ? candidates[0].id : null;

  for (const key of keys) {
    if (key.agent_uid != null) continue;
    if (!key.is_active) {
      sections.revokedHidden += 1;
      continue;
    }
    const placed: RosterSectionRow = {
      id: key.id,
      name: key.name,
      // This Mac's own row is a Session, whatever its scopes say. It holds the
      // login session now, which is `*:*` — the same shape `rosterKind` reads
      // as "Admin — full access", so without this override the screen would
      // label its own session as an admin credential.
      kind: key.id === thisMacId ? "Session" : rosterKind(key.scopes),
      createdAt: normalizeRosterTimestamp(key.created_at),
      lastSeenAt: normalizeRosterTimestamp(key.last_seen_at),
      chatUids: key.chat_uids,
      chatAccess: chatAccessOf(key.chat_uids),
      permissions: rosterPermissions(key.scopes),
      deviceLabel: deviceLabelOf(key.device, key.relay_resource_uid, ourDeviceUid),
      isThisMac: key.id === thisMacId,
    };
    if (placed.kind === "Agent") sections.mcp.push(placed);
    else sections.other.push(placed);
  }

  sections.mcp.sort(byLastUsed);
  sections.other.sort(byLastUsed);
  return sections;
}

/**
 * Is this row the credential this Mac holds?
 *
 * Plow stores `token[5:13]` as the public `key_prefix` — the eight characters
 * AFTER the `plow_` scheme, not including it (plow's `api/plow/auth.py`). So a
 * prefix never starts the token it came from, and comparing with `startsWith`
 * matched nothing in production while looking right against a hand-written
 * fixture.
 *
 * Equality against that same fixed-width slice is the whole check: a string of
 * any other length cannot equal it, so nothing here guesses at a partial
 * match, and an absent or malformed prefix matches nothing rather than
 * everything.
 */
function isDeviceCredential(prefix: string | null, credential: string): boolean {
  if (!prefix || !credential) return false;
  return credential.slice(5, 13) === prefix;
}
