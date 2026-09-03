/**
 * The Capabilities tab's view model — pure, like viewModel.ts, so the tab's
 * whole logic is unit-testable without Electron.
 *
 * The tab answers one question: what does this Mac let agents do right now,
 * and what has that stopped? Every row is a switch (a macOS permission, or
 * Automation consent for one app) from the standing inventory; the counts
 * beside a row come from the audit log's `host_permission_blocked` rows,
 * grouped by the permission they name and joined to their `intent_received`
 * for the agent and the goal. A row exists because a switch exists; it
 * NEEDS ATTENTION — and counts toward the tab's badge — only while the
 * switch is off and something has hit it, and the owner has not said "not
 * now" since the last hit. Status comes from the live inventory, so a row
 * stops needing attention the moment the switch is flipped, with nobody
 * marking anything done.
 */
import { JSONValue, jv } from "@domo/protocol";
import type { AutomationStatus, HostInventory, HostPermission, PermissionStatus } from "@domo/device-core";
import { automationApp, AutomationApp } from "./automation.js";

/** One blocked request, as the row lists it. */
export interface BlockedRequest {
  at: string;
  agent: string | null;
  goal: string | null;
  request: string | null;
  confidence: string | null;
  ownerAction: string | null;
}

/** Everything the audit log says about one switch. */
export interface BlockedGroup {
  /** The row key: a permission id, or `automation:<bundle id>`. */
  key: string;
  count: number;
  last: string;
  agents: string[];
  requests: BlockedRequest[];
}

/**
 * The audit log's blocks, grouped by the switch they name — newest first.
 * An Automation block names its target app; one that is not in the offered
 * table keeps the bare `automation` key and lands in the "yourself" section.
 */
export function blockedGroups(events: readonly JSONValue[]): BlockedGroup[] {
  const intents = new Map<string, JSONValue>();
  for (const e of events) {
    const ev = jv(e);
    const id = ev.get("intentId").str;
    if (ev.get("event").str === "intent_received" && id !== null) intents.set(id, e);
  }
  const groups = new Map<string, BlockedGroup>();
  for (const e of events) {
    const ev = jv(e);
    if (ev.get("event").str !== "host_permission_blocked") continue;
    const key = blockKey(ev);
    if (key === null) continue;
    const intentId = ev.get("intentId").str;
    const intent = intentId === null ? null : jv(intents.get(intentId) ?? null);
    const at = ev.get("ts").str ?? "";
    const request: BlockedRequest = {
      at,
      agent: intent?.get("agent_name").str ?? intent?.get("agent").str ?? null,
      goal: intent?.get("goal").str || null,
      request: intent?.get("request").str ?? null,
      confidence: ev.get("confidence").str,
      ownerAction: ev.get("owner_action").str,
    };
    const group = groups.get(key) ?? { key, count: 0, last: at, agents: [], requests: [] };
    group.count += 1;
    if (at > group.last) group.last = at;
    if (request.agent !== null && !group.agents.includes(request.agent)) group.agents.push(request.agent);
    group.requests.push(request);
    groups.set(key, group);
  }
  for (const g of groups.values()) g.requests.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return [...groups.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}

function blockKey(ev: ReturnType<typeof jv>): string | null {
  const permission = ev.get("permission").str;
  if (permission === null) return null;
  if (permission !== "automation") return permission;
  const target = ev.get("probes").get("automation_target").str;
  const app = target === null ? null : automationApp(target);
  return app === null ? "automation" : `automation:${app.bundleId}`;
}

/** System Settings' own words for a switch. */
export const PERMISSION_TITLES: Record<string, string> = {
  full_disk_access: "Full Disk Access",
  files_desktop: "Desktop folder",
  files_documents: "Documents folder",
  files_downloads: "Downloads folder",
  files_icloud_drive: "iCloud Drive",
  files_volumes: "Removable and network volumes",
  contacts: "Contacts",
  calendars: "Calendars",
  reminders: "Reminders",
  photos: "Photos",
  automation: "Automation",
  accessibility: "Accessibility",
  screen_recording: "Screen & System Audio Recording",
};

/**
 * Where each switch lives, as the deep link System Settings answers. The
 * panel flow opens the pane and floats beside it; whether the pane also
 * ACCEPTS A DROPPED APP (Full Disk Access and Accessibility do; the rest
 * list only apps that have asked) decides whether the panel shows the drag
 * tile or just points at the switch.
 */
export const SETTINGS_PANES: Record<string, { url: string; acceptsDrop: boolean }> = {
  full_disk_access: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles", acceptsDrop: true },
  accessibility: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", acceptsDrop: true },
  automation: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation", acceptsDrop: false },
  contacts: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts", acceptsDrop: false },
  calendars: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars", acceptsDrop: false },
  reminders: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders", acceptsDrop: false },
  photos: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos", acceptsDrop: false },
  screen_recording: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture", acceptsDrop: false },
  files_desktop: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders", acceptsDrop: false },
  files_documents: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders", acceptsDrop: false },
  files_downloads: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders", acceptsDrop: false },
  files_icloud_drive: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders", acceptsDrop: false },
  files_volumes: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders", acceptsDrop: false },
};

/** The pane a row key opens: an Automation row opens the Automation pane. */
export function paneFor(key: string): { url: string; acceptsDrop: boolean } | null {
  return SETTINGS_PANES[key.startsWith("automation:") ? "automation" : key] ?? null;
}

/** A row's state, folded from the several status vocabularies. */
export type RowStatus = "granted" | "denied" | "not_asked" | "unknown" | "target_not_running";

/**
 * What the row's button does. `grant`: the panel flow with the drag tile.
 * `open`: the panel flow pointing at the switch. `request`: raise macOS's own
 * dialog now (a queryable service, or an Automation pair). `ask`: touch a
 * folder so macOS asks. `none`: nothing to do.
 */
export type RowAction = "grant" | "open" | "request" | "ask" | "none";

export interface CapabilityRow {
  key: string;
  title: string;
  status: RowStatus;
  /** Where the row stands, in words — for a tooltip; the dot and the button
   *  carry it on screen. */
  statusText: string;
  /** What the switch is for. Empty where the section's line says it all. */
  detail: string;
  action: RowAction;
  actionLabel: string | null;
  count: number;
  last: string | null;
  agents: string[];
  requests: BlockedRequest[];
  /** Counts toward the badge. */
  needsAttention: boolean;
  /** Hidden from the badge by the owner, until a newer block arrives. */
  dismissed: boolean;
}

export interface CapabilitySection {
  key: "files" | "apps" | "yourself";
  title: string;
  description: string;
  rows: CapabilityRow[];
}

export interface CapabilitiesBanner {
  count: number;
  /** Per switch, most recent first: title and count. */
  summary: { title: string; count: number }[];
  last: string;
}

export interface CapabilitiesView {
  badge: number;
  banner: CapabilitiesBanner | null;
  sections: CapabilitySection[];
}

export interface CapabilitiesInput {
  inventory: HostInventory | null;
  /** The offered apps with their reconciled consent. */
  automation: { app: AutomationApp; status: AutomationStatus }[];
  events: readonly JSONValue[];
  /** Per row key, when the owner last said "not now". */
  dismissals: Record<string, string>;
  /** When the owner last dismissed the banner; blocks before it stay quiet. */
  bannerSeenAt: string | null;
  /** The three folders, as this Mac last learned them (setup's touch, or
   *  a block); absent means macOS has never been asked. */
  folders?: Partial<Record<"files_desktop" | "files_documents" | "files_downloads", PermissionStatus>>;
}

const FOLDERS: readonly ("files_desktop" | "files_documents" | "files_downloads")[] = [
  "files_desktop",
  "files_documents",
  "files_downloads",
];

const QUERYABLE: readonly ("contacts" | "calendars" | "accessibility")[] = ["contacts", "calendars", "accessibility"];

/** Build the tab. */
export function capabilitiesView(input: CapabilitiesInput): CapabilitiesView {
  const groups = new Map(blockedGroups(input.events).map((g) => [g.key, g]));
  const inv = input.inventory;
  const fda = inv?.full_disk_access.granted ?? null;

  const row = (
    key: string,
    title: string,
    status: RowStatus,
    detail: string,
    action: RowAction,
    actionLabel: string | null,
  ): CapabilityRow => {
    const g = groups.get(key);
    const dismissedAt = input.dismissals[key] ?? null;
    const dismissed = g !== undefined && dismissedAt !== null && dismissedAt >= g.last;
    const off = status !== "granted";
    return {
      key,
      title,
      status,
      statusText: statusWords(status),
      detail,
      action: off ? action : "none",
      actionLabel: off ? actionLabel : null,
      count: g?.count ?? 0,
      last: g?.last ?? null,
      agents: g?.agents ?? [],
      requests: g?.requests ?? [],
      needsAttention: off && (g?.count ?? 0) > 0 && !dismissed,
      dismissed,
    };
  };

  // Files and data. Full Disk Access first; the folders only while it is off,
  // since it covers them. Contacts, Calendars and Accessibility each have a
  // switch and a query API of their own.
  const files: CapabilityRow[] = [];
  files.push(
    row(
      "full_disk_access",
      PERMISSION_TITLES.full_disk_access!,
      fda === null ? "unknown" : fda ? "granted" : "denied",
      "Needed for Messages, Mail, and Safari data. Covers Desktop, Documents, and Downloads if granted",
      "grant",
      "Grant…",
    ),
  );
  if (fda !== true) {
    for (const folder of FOLDERS) {
      const learned = input.folders?.[folder] ?? null;
      const g = groups.get(folder);
      const status: RowStatus =
        learned === "granted"
          ? "granted"
          : learned === "denied" || (g !== undefined && g.requests[0]?.confidence === "confirmed" && learned !== "not_asked")
            ? "denied"
            : "not_asked";
      // Always the touch, even for a folder this Mac believes refused: what
      // it believes is history (a block, a past touch), macOS is the one
      // that knows, and a touch that comes back refused falls through to the
      // pane (main's act handler) — so asking never costs the owner a step.
      files.push(row(folder, PERMISSION_TITLES[folder]!, status, "Only needed if Full Disk Access is not granted", "ask", "Ask macOS now"));
    }
  }
  const queryable = new Map(inv?.permissions.map((p) => [p.permission, p.status]) ?? []);
  for (const permission of QUERYABLE) {
    const status = (queryable.get(permission) ?? "unknown") as RowStatus;
    const detail =
      permission === "contacts"
        ? "Reading and updating your address book, and associating contact names with Messages"
        : permission === "calendars"
          ? "Reading and scheduling events"
          : "Driving the screen and other apps' windows";
    // Accessibility's dialog only offers to open System Settings, and its
    // pane accepts a dropped app: the panel flow is the whole grant. The
    // other two have a real in-app dialog while they are not yet asked; once
    // refused, only the pane can undo it.
    const action: RowAction =
      permission === "accessibility" ? "grant" : status === "not_asked" || status === "unknown" ? "request" : "open";
    files.push(
      row(
        permission,
        PERMISSION_TITLES[permission]!,
        status,
        detail,
        action,
        action === "grant" ? "Grant…" : action === "request" ? "Ask macOS now" : "Open System Settings…",
      ),
    );
  }

  // Control other apps.
  // No detail per app: the section's own line says what these are, and
  // the dot and the button say where each stands.
  const apps: CapabilityRow[] = input.automation.map(({ app, status }) => {
    return row(
      `automation:${app.bundleId}`,
      app.name,
      status,
      "",
      status === "denied" ? "open" : "request",
      status === "denied" ? "Open System Settings…" : "Grant…",
    );
  });

  // Switches this app has no button for: anything a block named that is not
  // a row above. The owner flips these in System Settings themselves; the
  // section exists only while something asked.
  const known = new Set([...files, ...apps].map((r) => r.key));
  const yourself: CapabilityRow[] = [];
  for (const g of groups.values()) {
    if (known.has(g.key)) continue;
    if (g.key === "automation" && fda !== null) {
      // An Automation block for an app the tab does not list.
      yourself.push(row(g.key, "Automation for another app", "denied", "An app the list above does not offer", "open", "Open System Settings…"));
      continue;
    }
    const title = PERMISSION_TITLES[g.key] ?? g.key;
    yourself.push(
      row(g.key, title, "denied", "Plow Latch can't ask for this one; turn it on yourself if you want agents to have it", "open", "Open System Settings…"),
    );
  }

  const sections: CapabilitySection[] = [
    {
      key: "files",
      title: "Files and data",
      description:
        "What macOS lets Plow Latch reach on your behalf. Grant these ahead of time: otherwise an agent's first " +
        "request waits on a macOS dialog, which only someone at this Mac can answer.",
      rows: files,
    },
    {
      key: "apps",
      title: "Control other apps",
      description:
        "Which apps agents may drive with Apple events — sending a message, saving a contact. Grant ahead of time; " +
        "macOS otherwise asks the first time an agent scripts each app.",
      rows: apps,
    },
  ];
  if (yourself.length > 0) {
    sections.push({
      key: "yourself",
      title: "Grant in System Settings yourself",
      description: "Things agents asked for that this app has no button for.",
      rows: yourself,
    });
  }

  const badge = sections.reduce((n, s) => n + s.rows.filter((r) => r.needsAttention).length, 0);
  return { badge, banner: banner(groups, input.bannerSeenAt, sections), sections };
}

function banner(
  groups: Map<string, BlockedGroup>,
  seenAt: string | null,
  sections: CapabilitySection[],
): CapabilitiesBanner | null {
  const titles = new Map(sections.flatMap((s) => s.rows.map((r) => [r.key, r.title] as const)));
  const summary: { title: string; count: number; last: string }[] = [];
  let count = 0;
  let last = "";
  for (const g of groups.values()) {
    const fresh = g.requests.filter((r) => seenAt === null || r.at > seenAt);
    if (fresh.length === 0) continue;
    count += fresh.length;
    const newest = fresh[0]!.at;
    if (newest > last) last = newest;
    summary.push({ title: titles.get(g.key) ?? PERMISSION_TITLES[g.key] ?? g.key, count: fresh.length, last: newest });
  }
  if (count === 0) return null;
  summary.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
  return { count, summary: summary.map(({ title, count }) => ({ title, count })), last };
}

function statusWords(status: RowStatus): string {
  switch (status) {
    case "granted": return "Granted";
    case "denied": return "Not granted";
    case "not_asked": return "Not asked yet";
    case "target_not_running": return "Unknown until the app is open";
    default: return "Unknown";
  }
}
