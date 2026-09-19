/**
 * The Agent Index's public catalog, read to describe the agents Plow can deploy.
 *
 * Plow's `/v1/signup` decides WHAT the owner can deploy; the Index only
 * describes it, and only for entries it marks deployable (its own `hermes` is
 * someone else's agent). The endpoint is public, so nothing credential-shaped
 * is sent, and every string in it is third-party text the renderer inserts as
 * textContent.
 *
 * Logos are builder-uploaded images. The renderer loads no remote content, so
 * this Mac fetches each one from the Index's own host, checks it is a PNG under
 * a size cap, and hands it over as a data URL — never decoding it here, in the
 * unsandboxed process: the sandboxed renderer does that.
 */
import { REQUEST_TIMEOUT_MS } from "./plowApi.js";

export const AGENT_INDEX_URL = "https://agent-index-server.vercel.app/v1/agents";
/** Plow builds its provider id from the Index's bare `agent_id`: `life` is `exe:life`. */
const PLOW_PROVIDER_PREFIX = "exe:";
const INDEX_ORIGIN = new URL(AGENT_INDEX_URL).origin;
/** The Index serves 256px logos of 8–132 KB; this bounds what one can add to the tab's state. */
const LOGO_MAX_BYTES = 512 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface AgentIndexEntry {
  blurb: string | null;
  builder: string | null;
  users: number;
  successRate: number | null;
  /** Verified by AI Worth Using: the Index's blessing. */
  verified: boolean;
  /** Its place in the Index's list, which is the Index's ranking — the order aiworthusing.com shows. */
  rank: number;
  /** A PNG data URL. Every logo rides in the Agents tab's state, so the catalog's size is its cost. */
  logo: string | null;
}

/** Keyed on Plow's provider id, so a `/v1/signup` provider looks itself up. */
export type AgentIndex = Record<string, AgentIndexEntry>;

/** An entry as the Index lists it: its logo still a URL on the Index's host. */
export type ListedAgent = Omit<AgentIndexEntry, "logo"> & { logoUrl: string | null };

export async function fetchAgentIndex(fetchImpl: typeof fetch = fetch): Promise<AgentIndex> {
  const response = await fetchImpl(AGENT_INDEX_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Agent Index returned ${response.status}`);
  const listed = Object.entries(parseAgentIndex(await response.json()));
  return Object.fromEntries(await Promise.all(listed.map(async ([id, { logoUrl, ...entry }]) =>
    [id, { ...entry, logo: logoUrl ? await fetchLogo(logoUrl, fetchImpl) : null }] as const)));
}

/** A logo's URL never changes what it serves, so one fetch a run; a failure is retried on the next read. */
const logos = new Map<string, string>();

/** Null for anything but a PNG under the cap: the card keeps its initial. */
async function fetchLogo(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  const cached = logos.get(url);
  if (cached) return cached;
  try {
    // A redirect would leave the Index's host.
    const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > LOGO_MAX_BYTES || !PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return null;
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    logos.set(url, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

/** A malformed entry is dropped on its own: one bad row must not blank every card. */
export function parseAgentIndex(json: unknown): Record<string, ListedAgent> {
  const agents = json && typeof json === "object" ? (json as { agents?: unknown }).agents : undefined;
  if (!Array.isArray(agents)) throw new Error("Agent Index returned no agent list");
  const entries: [string, ListedAgent][] = [];
  for (const [rank, raw] of agents.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.agent_id !== "string" || !row.agent_id || !text(row.deployable_at)) continue;
    const builder = row.builder && typeof row.builder === "object" ? (row.builder as Record<string, unknown>).name : null;
    entries.push([`${PLOW_PROVIDER_PREFIX}${row.agent_id}`, {
      blurb: text(row.blurb),
      builder: text(builder),
      users: Number.isInteger(row.users) && (row.users as number) >= 0 ? row.users as number : 0,
      successRate: Number.isInteger(row.install_success) ? row.install_success as number : null,
      verified: text(row.blessed_at) !== null,
      rank,
      logoUrl: onIndexHost(text(row.logo)),
    }]);
  }
  return Object.fromEntries(entries);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The Index names a logo's URL; this Mac fetches only from the Index's own host. */
function onIndexHost(url: string | null): string | null {
  return url && URL.canParse(url) && new URL(url).origin === INDEX_ORIGIN ? url : null;
}
