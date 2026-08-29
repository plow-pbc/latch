/**
 * The `~/Plow` folder — the agent's playground on this Mac.
 *
 * The Plow desktop app (plow-pbc/plow-mac) established `~/Plow` as the shared
 * workspace agents reach; Latch keeps the same folder so the migration to
 * hosted agents changes the transport, not where the owner's files live. Latch
 * ensures it exists at startup and publishes a skill teaching agents to do
 * their file work there. File operations confined to it skip approval — the
 * decision path (`reviewPolicy.ts` in the desktop app) grants them with source
 * `APPROVAL_SOURCE_PLOW_FOLDER`, except in deny mode, which refuses everything
 * and is the owner's kill switch for the carve-out too.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Capability, isWithinAsync } from "@domo/protocol";
import { Skill, SkillRegistry } from "./skills.js";

/** Audit `source` for a grant the carve-out answered — no reviewer, no dialog. */
export const APPROVAL_SOURCE_PLOW_FOLDER = "plow_folder";

/** Where the playground lives, given the owner's real home. */
export function plowFolderPath(ownerHome: string): string {
  return path.join(ownerHome, "Plow");
}

/** Create `~/Plow` if missing. Idempotent; returns the path. */
export function ensurePlowFolder(ownerHome: string): string {
  const dir = plowFolderPath(ownerHome);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * May this capability set be granted without asking anyone?
 *
 * True only when the root itself is a real directory — not a symlink — and
 * there is at least one capability and EVERY one is a file read or write
 * whose every path canonicalizes to inside `~/Plow`. Anything else — exec (a
 * command run "in" the folder can touch the whole disk), browser, credential,
 * network, an empty path list, an empty set — keeps the normal decision path.
 * Canonicalization (realpath) is what defeats a symlink planted inside the
 * folder pointing out of it: the capability paths are resolved before
 * comparison, so `~/Plow/escape -> ~/.ssh` reads as `~/.ssh` and fails the
 * prefix test. The root lstat closes the inverse: a `~/Plow -> ~` symlink
 * would canonicalize the ROOT to the whole home and confine everything, so a
 * link root refuses at decision time — no startup-check TOCTOU window.
 *
 * Async on purpose: this runs under the call budget, and path resolution is
 * filesystem I/O — the sync variants block the event loop and stop the budget
 * timer from firing (see `canonicalizeAsync`).
 */
export async function confinedToPlowFolder(
  capabilities: Capability[],
  plowRoot: string,
): Promise<boolean> {
  if (capabilities.length === 0) return false;
  try {
    if (!(await fsp.lstat(plowRoot)).isDirectory()) return false;
  } catch {
    return false;
  }
  for (const c of capabilities) {
    if (c.kind !== "fs.read" && c.kind !== "fs.write") return false;
    if ((c.paths?.length ?? 0) === 0) return false;
    for (const p of c.paths!) if (!(await isWithinAsync(p, plowRoot))) return false;
  }
  return true;
}

/** The skill body names the real path, like the WhatsApp skill does. */
function plowFolderSkill(ownerHome: string): Skill {
  const dir = plowFolderPath(ownerHome);
  return {
    name: "plow-folder",
    description:
      "Where to do file work on this Mac: the shared Plow folder. Reads and writes " +
      "inside it are approved automatically — start here.",
    body: `# The Plow folder — your workspace on this Mac

\`${dir}\` is the shared workspace between the owner and their agents. Use it as
your default place for file work: notes, working files, downloads, anything you
produce for the owner to keep.

Why start here: \`plow_read_file\` and \`plow_write_file\` operations whose paths
are all inside \`${dir}\` are approved automatically — no human dialog, no wait.
Any path outside it goes through the normal approval flow, which can take as
long as a human takes.

Ground rules:
- Prefer a subfolder per task or project over loose files at the top level.
- The folder may already contain files the owner or the Plow desktop app put
  there (for example \`brain/\` or \`skills/\`); read them if relevant, do not
  reorganize or delete what you did not create.
- The auto-approval covers file reads and writes only. Running commands,
  browsing, and credentials follow this Mac's configured approval flow, even
  when they mention this folder.
- If the owner has set this Mac to deny everything, that includes this folder.`,
  };
}

/** Register the built-in skill. The folder always exists (ensured at startup). */
export function registerPlowFolderSkill(skills: SkillRegistry, ownerHome: string): void {
  skills.register(plowFolderSkill(ownerHome));
}
