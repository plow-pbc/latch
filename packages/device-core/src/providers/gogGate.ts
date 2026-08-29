/**
 * The argv gate for the vendored gog, whichever spelling reaches it —
 * `plow-gog`, or the bare `gog` that resolves to the same provider. `refuse`'s
 * doc in `registry.ts` owns WHY each shape is refused; the sentences live here,
 * beside the planner that also reads them, so one spelling of each exists.
 *
 * Every string returned reaches the approval dialog and the append-only audit
 * log, so the rule `gogFlags` follows applies throughout: a reason may name a
 * rule or a registry literal, never the caller's text.
 */
import { reservedFlagIn } from "./gogFlags.js";
import { GOG_GROUPS } from "./gogGroups.js";

/**
 * `... --help`, which names no group and reaches nothing.
 *
 * A `--` terminator disqualifies it: after one, `-h` is the query itself, and
 * treating `gmail search -- -h` as help would run a real search with no minted
 * token. Fail-safe — it would simply fail — but wrong, and one condition
 * cheaper to prevent than to explain.
 */
export function isHelpInvocation(rest: readonly string[]): boolean {
  if (rest.includes("--")) return false;
  const last = rest[rest.length - 1];
  return last === "--help" || last === "-h";
}

/** The reserved-flag sentence, or null when no argument would disarm the
 * belt. `reservedFlagIn`'s return is safe to display by construction. */
export function reservedRefusal(rest: readonly string[]): string | null {
  const reserved = reservedFlagIn(rest);
  if (reserved === null) return null;
  return `${reserved} may not be supplied: it would override this Mac's safety flags`;
}

/**
 * The four wrong-command sentences. ONE check refuses all four shapes — a
 * group that is not gmail or calendar; the other three branches only choose a
 * better sentence. `command` is the provider's own registry literal, never
 * caller text.
 */
export function shapeRefusal(rest: readonly string[], command: string): string | null {
  const group = rest[0];
  if (group === undefined) {
    return `the command is missing: try ["${command}", "gmail", "search", ...]`;
  }
  if (group.startsWith("-")) return "the command must come first, before any flags";
  // Its own sentence because the group check below already refuses it, and
  // says the wrong thing when it does.
  if (group.includes(".")) {
    return 'the command must be separate words: ["gmail", "search"], not ["gmail.search"]';
  }
  if (!GOG_GROUPS.has(group)) return `this Mac reaches only Gmail and Calendar through ${command}`;
  return null;
}
