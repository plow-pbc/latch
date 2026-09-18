/** Pure cloud-agent presentation decisions, shared with the sandboxed renderer. */

import type { CloudAgentProvider } from "./plowApi.js";
import type { AgentIndex, AgentIndexEntry } from "./agentIndex.js";

const CLOUD_HTTP_REASONS = new Set([
  "bad request",
  "unauthorized",
  "forbidden",
  "not found",
  "method not allowed",
  "not acceptable",
  "request timeout",
  "conflict",
  "gone",
  "unprocessable entity",
  "too many requests",
  "internal server error",
  "not implemented",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
]);

/** Replace bare HTTP failures with useful copy while retaining specific errors. */
export function cloudErrorCopy(message: string): string {
  const reason = String(message ?? "").trim().replace(/[.!]$/, "").toLowerCase();
  if (
    CLOUD_HTTP_REASONS.has(reason) ||
    /^(?:plow returned|http(?: error)?) \d{3}$/.test(reason)
  ) {
    return "Plow couldn't complete that request. Try again.";
  }
  return message;
}

export interface CloudProviderPickerViewModel {
  mode: "ready" | "blocked";
  heading: string | null;
  message: string | null;
}

/** Decide whether the provider picker renders normally, blocks, or warns. */
export function cloudProviderPickerViewModel(
  cloudProviders: CloudAgentProvider[] | null,
  cloudProvidersError: string | null,
): CloudProviderPickerViewModel {
  const error = cloudProvidersError ? cloudErrorCopy(cloudProvidersError) : null;
  if (cloudProviders === null) {
    return {
      mode: "blocked",
      heading: "Agent types could not be loaded",
      message: error ?? "Agent types couldn't be loaded yet. Try again.",
    };
  }
  if (cloudProviders.length === 0) {
    return {
      mode: "blocked",
      heading: "No agent types are available",
      message: error ?? "Plow has no cloud agent types available right now.",
    };
  }
  return { mode: "ready", heading: null, message: null };
}

/** One card in the deploy modal. Strings are third-party; render as text. */
export interface DeployCard {
  id: string;
  name: string;
  initial: string;
  logo: string | null;
  blurb: string | null;
  byline: string;
}

/** Below this many people a success rate is noise: 1 of 1 reads 100%. */
export const SUCCESS_RATE_MIN_USERS = 5;

/** The deploy modal's cards: most-used first, undescribed agents last. */
export function deployCards(providers: CloudAgentProvider[], index: AgentIndex): DeployCard[] {
  const described = (id: string): AgentIndexEntry | null => (Object.hasOwn(index, id) ? index[id]! : null);
  return providers
    .map((provider) => ({ provider, entry: described(provider.id) }))
    .sort((a, b) => (b.entry?.users ?? -1) - (a.entry?.users ?? -1) || a.provider.name.localeCompare(b.provider.name))
    .map(({ provider, entry }) => ({
      id: provider.id,
      name: provider.name,
      initial: ([...provider.name.trim()][0] ?? "?").toUpperCase(),
      logo: entry?.logo ?? null,
      blurb: entry?.blurb ?? null,
      byline: entry ? byline(entry) : "No description yet",
    }));
}

function byline({ builder, users, successRate }: AgentIndexEntry): string {
  return [
    builder ? `by ${builder}` : null,
    users > 0 ? `${users} ${users === 1 ? "person" : "people"}` : null,
    users >= SUCCESS_RATE_MIN_USERS && successRate !== null ? `${successRate}% set up` : null,
  ].filter(Boolean).join(" · ");
}
