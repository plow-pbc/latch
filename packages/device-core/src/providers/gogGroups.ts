/**
 * Which gog groups this Mac reaches, in the two shapes that are not the same
 * thing.
 *
 * Its own module because both `registry.ts` and the skill it publishes need
 * them, and importing the registry from the skill it carries is a cycle.
 */

/**
 * The canonical group names, and the ONE source of the belt's scope bound.
 *
 * Separate from the aliases because they are not the same thing: these are
 * what gog is TOLD to enable, and an alias sent to `--enable-commands` would
 * be asking gog to resolve its own alias twice.
 */
export const GOG_CANONICAL = ["gmail", "calendar"] as const;

/**
 * gog's own alias spellings for those two — `gog gmail (mail,email)`,
 * `gog calendar (cal)`.
 *
 * Accepted by the check, never sent to the belt: gog resolves them itself.
 * Without them this refused Gmail for being called `mail`.
 */
export const GOG_ALIASES = ["mail", "email", "cal"] as const;

/**
 * Every spelling this Mac accepts as a group.
 *
 * The check that decides whether a command is refused at all — every
 * wrong-command shape `refuse` enumerates fails it, and the other branches
 * only choose a better sentence. What each shape would otherwise cost is
 * written once, in `refuse`'s doc; the per-version verdicts behind the bound
 * are step 5 of the pin-bump checklist in `scripts/fetch-gog.mjs`.
 */
export const GOG_GROUPS: ReadonlySet<string> = new Set<string>([
  ...GOG_CANONICAL,
  ...GOG_ALIASES,
]);
