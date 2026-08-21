/**
 * Where Plow Latch keeps its own state, and how both enforcement paths
 * recognise it.
 *
 * `settings.json` under a Plow Latch home holds the relay credential and
 * `agentPurpose` — the text the reviewer is handed as the owner's own words
 * about what agents are for. That is a floor under every capability rather than
 * one of them, and it has to be recognised identically by the seatbelt profile
 * (`executor.ts`) and by the in-process file operations (`fileOps.ts`), so the
 * shape of the thing lives here once.
 *
 * The FAMILY, not just this instance. One Mac runs several checkouts side by
 * side, each with its own home `Plow-Latch-<branch>` beside the packaged
 * install's plain `Plow-Latch`, and each signed in for its OWN relay
 * credential. A branch's run reading its neighbour's `settings.json` takes a
 * credential just as surely as reading its own — the folder having a different
 * suffix is not a boundary.
 */
import path from "node:path";

/**
 * The home folder-name prefix. `apps/desktop/src/paths.ts` builds the home from
 * this and `migrateHome.ts` matches on it — one definition, so the thing that
 * NAMES a home and the thing that DEFENDS one cannot drift apart.
 */
export const HOME_PREFIX = "Plow-Latch";

/** Characters that would otherwise mean something inside an SBPL regex. */
function regexEscape(text: string): string {
  return text.replace(/[\\^$.|?*+()[\]{}]/g, (c) => "\\" + c);
}

/**
 * An SBPL regex matching every Plow Latch home beside `deviceHome` — the
 * unsuffixed packaged home and every `Plow-Latch-<branch>` — anchored to the
 * directory that holds this one.
 *
 * A regex rather than a list of subpaths because the list is not knowable when
 * the profile is generated: a sibling checkout can be created, or first sign
 * in, while a command is already running. The name pattern is what is fixed.
 */
export function homeFamilyRegex(deviceHome: string): string {
  const parent = regexEscape(path.dirname(deviceHome));
  return `^${parent}/${regexEscape(HOME_PREFIX)}(-[^/]*)?(/|$)`;
}

/**
 * Is this ALREADY-CANONICAL path inside a Plow Latch home — this one, or a
 * sibling of it?
 *
 * The caller canonicalizes: this is a pure name test, and handing it an
 * unresolved path would let a symlink spell around the answer.
 */
export function isInsidePlowHome(canonicalPath: string, canonicalDeviceHome: string): boolean {
  const within = (root: string): boolean =>
    canonicalPath === root || canonicalPath.startsWith(root.endsWith("/") ? root : root + "/");
  if (within(canonicalDeviceHome)) return true;
  const parent = path.dirname(canonicalDeviceHome);
  const rest = canonicalPath.startsWith(parent + "/") ? canonicalPath.slice(parent.length + 1) : null;
  if (rest === null) return false;
  const folder = rest.split("/")[0];
  return folder === HOME_PREFIX || folder.startsWith(HOME_PREFIX + "-");
}
