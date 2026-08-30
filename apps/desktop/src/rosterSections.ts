/**
 * The Agents screen's three sections, derived from the account's credentials.
 *
 * Kept out of the renderer deliberately. The classification decides which
 * removal call a row gets, and a row misplaced here is a live cloud agent
 * removed by the wrong endpoint — that is a decision for tested code, not for
 * a template.
 */
import type { KeyInfo } from "./plowApi.js";

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
  agentId: string | null;
  chatUids: string[];
  /** How many of `chatUids` to name is the screen's business; whether it is
   * "all", "none" or a list is not. */
  chatAccess: ChatAccess;
  permissions: RosterPermissions;
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
  /** Provisioned cloud agents. Removal goes to the cloud-agent endpoint. */
  cloud: RosterSectionRow[];
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
  cloud: [],
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

/**
 * The active key this Mac is authenticated with, only when its public prefix
 * identifies exactly one row. An ambiguous match identifies nothing.
 */
export function thisMacKeyId(
  keys: readonly KeyInfo[],
  deviceCredential: string,
): number | null {
  const credential = deviceCredential.trim();
  const candidates = keys.filter(
    (key) => key.is_active && isDeviceCredential(key.key_prefix, credential),
  );
  return candidates.length === 1 ? candidates[0].id : null;
}

const ABANDONED_SESSION_AGE_MS = 10 * 60_000;

/**
 * Whether an active key has the exact shape left behind by an abandoned
 * activation: an unnamed, unused global session old enough not to be another
 * Mac's sign-in still settling. Agent-owned keys are not sessions; revoking
 * one here would leave its cloud agent running without a usable credential.
 */
export function shouldAutoRevokeSession(
  key: KeyInfo,
  options: { thisMacId: number; now: number },
): boolean {
  if (!key.is_active) return false;
  if (key.agent_id !== null) return false;
  if (!key.scopes.includes("*:*")) return false;
  if (key.name?.trim()) return false;
  if (key.last_seen_at !== null) return false;
  if (key.id === options.thisMacId) return false;
  if (key.created_at === null) return false;
  const createdAt = Date.parse(key.created_at);
  return Number.isFinite(createdAt) && createdAt < options.now - ABANDONED_SESSION_AGE_MS;
}

/**
 * Split the account's credentials into the three sections the screen shows.
 *
 * `agentId` decides first and decides alone. A credential that belongs to a
 * cloud agent is a cloud agent however its scopes read — and prod returns a
 * null `agent_id` while no agents are live, so the branch that matters is the
 * one everyday testing never enters.
 */
export function sectionRoster(
  keys: readonly KeyInfo[],
  options: { deviceCredential?: string } = {},
): RosterSections {
  const credential = (options.deviceCredential ?? "").trim();
  const sections: RosterSections = { cloud: [], mcp: [], other: [], revokedHidden: 0 };

  // Exactly one row is this Mac, or none is. Two rows matching means the match
  // is not identifying anything, and marking both would warn about revoking a
  // credential that is not ours — on the one row where the warning is the
  // difference between a revoke and signing this Mac out.
  const thisMacId = thisMacKeyId(keys, credential);

  for (const key of keys) {
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
      createdAt: key.created_at,
      lastSeenAt: key.last_seen_at,
      agentId: key.agent_id,
      chatUids: key.chat_uids,
      chatAccess: chatAccessOf(key.chat_uids),
      permissions: rosterPermissions(key.scopes),
      isThisMac: key.id === thisMacId,
    };
    if (placed.agentId !== null) sections.cloud.push(placed);
    else if (placed.kind === "Agent") sections.mcp.push(placed);
    else sections.other.push(placed);
  }

  sections.cloud.sort(byLastUsed);
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
