/**
 * The renderer-safe roster derived from Plow's account credential metadata.
 *
 * Plow's scope matcher recognizes exact, resource-wildcard and global-wildcard
 * grants. The relay needs `relay:call`, so those same three forms are the whole
 * predicate here. More-specific grants win when a legacy row carries more than
 * one form.
 */
import type { KeyInfo } from "./plowApi.js";

export type AgentRosterKind = "Agent" | "Plow web login" | "Legacy — full access";

export interface AgentRosterRow {
  id: number;
  name: string | null;
  kind: AgentRosterKind;
  createdAt: string | null;
  lastSeenAt: string | null;
}

function relayKind(scopes: readonly string[]): AgentRosterKind | null {
  if (scopes.includes("relay:call")) return "Agent";
  if (scopes.includes("relay:*")) return "Plow web login";
  if (scopes.includes("*:*")) return "Legacy — full access";
  return null;
}

/** Drop revoked and non-relay rows, then remove every field the renderer has
 * no reason to know: token prefix, raw scopes, and usage accounting. */
export function agentRosterRows(keys: readonly KeyInfo[]): AgentRosterRow[] {
  const rows: AgentRosterRow[] = [];
  for (const key of keys) {
    if (!key.is_active) continue;
    const kind = relayKind(key.scopes);
    if (!kind) continue;
    rows.push({
      id: key.id,
      name: key.name,
      kind,
      createdAt: key.created_at,
      lastSeenAt: key.last_seen_at,
    });
  }
  return rows;
}
