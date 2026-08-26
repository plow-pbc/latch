/**
 * The renderer-safe roster derived from Plow's account credential metadata.
 *
 * Plow's scope matcher recognizes exact, resource-wildcard and global-wildcard
 * grants. More-specific relay grants win when a legacy row carries more than
 * one form; credentials without a relay grant are ordinary sessions.
 */
import type { KeyInfo } from "./plowApi.js";

export type AgentRosterKind =
  | "Agent"
  | "Plow web login"
  | "Legacy — full access"
  | "Session";

export interface AgentRosterRow {
  id: number;
  name: string | null;
  kind: AgentRosterKind;
  createdAt: string | null;
  lastSeenAt: string | null;
  agentId: string | null;
  chatUids: string[];
  isActive: boolean;
}

function rosterKind(scopes: readonly string[]): AgentRosterKind {
  if (scopes.includes("relay:call")) return "Agent";
  if (scopes.includes("relay:*")) return "Plow web login";
  if (scopes.includes("*:*")) return "Legacy — full access";
  return "Session";
}

/** Remove every field the renderer has no reason to know: token prefix, raw
 * scopes, and usage accounting. */
export function agentRosterRows(keys: readonly KeyInfo[]): AgentRosterRow[] {
  const rows: AgentRosterRow[] = [];
  for (const key of keys) {
    const kind = rosterKind(key.scopes);
    rows.push({
      id: key.id,
      name: key.name,
      kind,
      createdAt: key.created_at,
      lastSeenAt: key.last_seen_at,
      agentId: key.agent_id,
      chatUids: key.chat_uids,
      isActive: key.is_active,
    });
  }
  return rows;
}
