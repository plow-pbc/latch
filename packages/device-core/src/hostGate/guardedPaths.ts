/**
 * Which macOS privacy gate governs a path — the map behind a diagnosis.
 *
 * TCC (Transparency, Consent and Control) guards a fixed set of locations
 * under the owner's home, each behind its own switch in System Settings >
 * Privacy & Security. The kernel's answer for all of them is the same
 * `EPERM`, which is also what our own seatbelt profile, SIP and an immutable
 * flag return — so the errno alone never says WHICH gate refused, and this
 * table is how a refusal on a path gets a name a person can act on.
 *
 * Pure: a path and the owner's home in, a permission out. Nothing here touches
 * the disk, so every row is testable against a fixture home.
 *
 * The rows are what Apple documents plus what this app has actually hit. Full
 * Disk Access is the umbrella: it covers every folder gate below as well as
 * the `~/Library` stores, which is why the Settings pane and onboarding push
 * for that one grant rather than three.
 */
import { isLexicallyWithin } from "@domo/protocol";

/** A macOS permission this app can be missing. Stable names: they reach the
 *  agent in a tool result and the owner in the audit log. */
export type HostPermission =
  | "full_disk_access"
  | "files_desktop"
  | "files_documents"
  | "files_downloads"
  | "files_icloud_drive"
  | "files_volumes"
  | "contacts"
  | "calendars"
  | "reminders"
  | "photos"
  | "automation"
  | "accessibility"
  | "screen_recording";

/** Where the owner flips the switch, in the words System Settings uses. */
export const PERMISSION_LABELS: Record<HostPermission, string> = {
  full_disk_access: "Full Disk Access",
  files_desktop: "Files and Folders > Desktop Folder",
  files_documents: "Files and Folders > Documents Folder",
  files_downloads: "Files and Folders > Downloads Folder",
  files_icloud_drive: "Files and Folders > iCloud Drive",
  files_volumes: "Files and Folders > Removable Volumes / Network Volumes",
  contacts: "Contacts",
  calendars: "Calendars",
  reminders: "Reminders",
  photos: "Photos",
  automation: "Automation",
  accessibility: "Accessibility",
  screen_recording: "Screen & System Audio Recording",
};

/**
 * Gates that Full Disk Access subsumes. A Mac with FDA granted cannot be
 * refused on any of these by TCC, which is what lets the diagnosis rule TCC
 * out when the FDA probe says granted and the path is still refused.
 */
export const COVERED_BY_FULL_DISK_ACCESS: ReadonlySet<HostPermission> = new Set<HostPermission>([
  "full_disk_access",
  "files_desktop",
  "files_documents",
  "files_downloads",
  "files_icloud_drive",
  "files_volumes",
  "contacts",
  "calendars",
  "reminders",
  "photos",
]);

/**
 * Paths TCC guards, relative to the owner's home, longest prefix wins.
 *
 * `~/Library` entries name the app-data stores this Mac's skills actually
 * read: Messages (`chat.db`), Safari, Mail, the TCC database itself, and the
 * container trees where most modern apps keep their data. Contacts, Calendars
 * and Photos have switches of their own but FDA covers them too, so they are
 * named for the owner's benefit and still resolve through FDA when granted.
 */
const HOME_RELATIVE: readonly [string, HostPermission][] = [
  ["Desktop", "files_desktop"],
  ["Documents", "files_documents"],
  ["Downloads", "files_downloads"],
  ["Library/Mobile Documents", "files_icloud_drive"],
  ["Library/Application Support/AddressBook", "contacts"],
  ["Library/Calendars", "calendars"],
  ["Library/Reminders", "reminders"],
  ["Pictures/Photos Library.photoslibrary", "photos"],
  ["Library/Messages", "full_disk_access"],
  ["Library/Safari", "full_disk_access"],
  ["Library/Mail", "full_disk_access"],
  ["Library/Cookies", "full_disk_access"],
  ["Library/Suggestions", "full_disk_access"],
  ["Library/HomeKit", "full_disk_access"],
  ["Library/IdentityServices", "full_disk_access"],
  ["Library/Metadata/CoreSpotlight", "full_disk_access"],
  ["Library/Application Support/com.apple.TCC", "full_disk_access"],
  ["Library/Application Support/CallHistoryDB", "full_disk_access"],
  ["Library/Application Support/Knowledge", "full_disk_access"],
  ["Library/Containers", "full_disk_access"],
  ["Library/Group Containers", "full_disk_access"],
  ["Library/Daemon Containers", "full_disk_access"],
];

/** Absolute prefixes outside any home. */
const ABSOLUTE: readonly [string, HostPermission][] = [
  ["/Library/Application Support/com.apple.TCC", "full_disk_access"],
  ["/Volumes", "files_volumes"],
];

/**
 * Prefixes System Integrity Protection makes read-only for every process,
 * root included. A refusal here is not a permission the owner can grant.
 * `/usr/local` is the one carve-out under `/usr`; `/private/etc` and
 * `/private/var` are real filesystem paths under `/private` but are NOT
 * sealed as a whole, so only the sealed roots are listed.
 */
const SIP_PREFIXES = ["/System", "/usr", "/bin", "/sbin", "/private/var/db/ConfigurationProfiles"];
const SIP_EXEMPT = ["/usr/local", "/System/Volumes/Data"];

const under = isLexicallyWithin;

/**
 * The TCC gate that governs `path`, or null when none does. Both arguments
 * are expected canonical (a physical path, `~` expanded); the caller has
 * already resolved the path it is asking about, because a symlink's target
 * is what the kernel judged, not its name.
 *
 * `/Volumes` does not distinguish a removable disk from a network share —
 * they are two switches in System Settings, and telling them apart needs a
 * `statfs` this table deliberately does not make. One label names both.
 */
export function guardedPrefix(path: string, ownerHome: string): HostPermission | null {
  const home = ownerHome.endsWith("/") ? ownerHome.slice(0, -1) : ownerHome;
  let best: { length: number; permission: HostPermission } | null = null;
  const consider = (prefix: string, permission: HostPermission) => {
    if (under(path, prefix) && (best === null || prefix.length > best.length)) {
      best = { length: prefix.length, permission };
    }
  };
  if (home.length > 0) {
    for (const [rel, permission] of HOME_RELATIVE) consider(`${home}/${rel}`, permission);
  }
  for (const [abs, permission] of ABSOLUTE) consider(abs, permission);
  return best === null ? null : (best as { permission: HostPermission }).permission;
}

/** Whether SIP seals `path` against every process. Canonical path in. */
export function sipProtected(path: string): boolean {
  if (SIP_EXEMPT.some((p) => under(path, p))) return false;
  return SIP_PREFIXES.some((p) => under(path, p));
}

/**
 * A path with the owner's home folded back to `~`, for text that leaves this
 * Mac. The agent already knows the paths it asked about, but a diagnosis
 * also names paths it did not supply (a probe target, a candidate pulled out
 * of stderr), and a resolved `/Users/<name>` in a tool result is the owner's
 * account name in an approval-free response — the same leak the skill files
 * avoid (`imessageSkill.ts`).
 */
export function tildeRelative(path: string, ownerHome: string): string {
  const home = ownerHome.endsWith("/") ? ownerHome.slice(0, -1) : ownerHome;
  if (home.length === 0) return path;
  if (path === home) return "~";
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}
