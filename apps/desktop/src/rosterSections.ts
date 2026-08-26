/**
 * The Agents screen's three sections, derived from the account's credentials.
 *
 * `agentRoster.ts` says what a credential IS — its kind, from the scopes Plow
 * granted it. This says where it BELONGS on screen, which is a different
 * question and a newer one: `AgentRosterKind` predates cloud agents entirely,
 * so a row's kind alone can no longer place it.
 *
 * Kept out of the renderer deliberately. The classification decides which
 * removal call a row gets, and a row misplaced here is a live cloud agent
 * removed by the wrong endpoint — that is a decision for tested code, not for
 * a template.
 */
import { AgentRosterRow, agentRosterRows } from "./agentRoster.js";
import type { KeyInfo } from "./plowApi.js";

export interface RosterSectionRow extends AgentRosterRow {
  /**
   * This Mac's own device credential.
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
  const byId = new Map(keys.map((key) => [key.id, key] as const));
  const credential = (options.deviceCredential ?? "").trim();
  const sections: RosterSections = { cloud: [], mcp: [], other: [], revokedHidden: 0 };

  for (const key of keys) if (!key.is_active) sections.revokedHidden += 1;

  // Exactly one row is this Mac, or none is. Two rows matching means the match
  // is not identifying anything, and marking both would warn about revoking a
  // credential that is not ours — on the one row where the warning is the
  // difference between a revoke and signing this Mac out.
  const candidates = keys.filter(
    (key) => key.is_active && isDeviceCredential(key.key_prefix, credential),
  );
  const thisMacId = candidates.length === 1 ? candidates[0].id : null;

  for (const row of agentRosterRows(keys)) {
    // Revoked rows are counted, never listed — decided here rather than
    // assumed of `agentRosterRows`, whose job is what a credential IS, not what
    // this screen shows. It returns them now precisely so this layer can make
    // that call.
    if (!row.isActive) continue;
    const placed: RosterSectionRow = { ...row, isThisMac: row.id === thisMacId };
    if (placed.agentId !== null) sections.cloud.push(placed);
    else if (placed.kind === "Agent") sections.mcp.push(placed);
    else sections.other.push(placed);
  }

  sections.cloud.sort(byLastUsed);
  sections.mcp.sort(byLastUsed);
  sections.other.sort(byLastUsed);
  return sections;
}

/** A prefix long enough to mean something, and a credential that starts with
 * it. An empty or absent prefix matches nothing rather than everything. */
function isDeviceCredential(prefix: string | null, credential: string): boolean {
  if (!prefix || !credential) return false;
  return prefix.length >= 6 && credential.startsWith(prefix);
}
