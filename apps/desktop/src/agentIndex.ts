/**
 * The Agent Index's public catalog, read to describe the agents Plow can deploy.
 *
 * Plow's `/v1/signup` decides WHAT the owner can deploy; the Index only
 * describes it, and only for entries it marks deployable (its own `hermes` is
 * someone else's agent). The endpoint is public, so nothing credential-shaped
 * is sent, and every string in it is third-party text the renderer inserts as
 * textContent.
 */
import { REQUEST_TIMEOUT_MS } from "./plowApi.js";

export const AGENT_INDEX_URL = "https://agent-index-server.vercel.app/v1/agents";
/** Plow builds its provider id from the Index's bare `agent_id`: `life` is `exe:life`. */
const PLOW_PROVIDER_PREFIX = "exe:";

export interface AgentIndexEntry {
  blurb: string | null;
  builder: string | null;
  users: number;
  successRate: number | null;
}

/** Keyed on Plow's provider id, so a `/v1/signup` provider looks itself up. */
export type AgentIndex = Record<string, AgentIndexEntry>;

export async function fetchAgentIndex(fetchImpl: typeof fetch = fetch): Promise<AgentIndex> {
  const response = await fetchImpl(AGENT_INDEX_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Agent Index returned ${response.status}`);
  return parseAgentIndex(await response.json());
}

/** A malformed entry is dropped on its own: one bad row must not blank every card. */
export function parseAgentIndex(json: unknown): AgentIndex {
  const agents = json && typeof json === "object" ? (json as { agents?: unknown }).agents : undefined;
  if (!Array.isArray(agents)) throw new Error("Agent Index returned no agent list");
  const entries: [string, AgentIndexEntry][] = [];
  for (const raw of agents) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.agent_id !== "string" || !row.agent_id || !text(row.deployable_at)) continue;
    const builder = row.builder && typeof row.builder === "object" ? (row.builder as Record<string, unknown>).name : null;
    entries.push([`${PLOW_PROVIDER_PREFIX}${row.agent_id}`, {
      blurb: text(row.blurb),
      builder: text(builder),
      users: Number.isInteger(row.users) && (row.users as number) >= 0 ? row.users as number : 0,
      successRate: Number.isInteger(row.install_success) ? row.install_success as number : null,
    }]);
  }
  return Object.fromEntries(entries);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
