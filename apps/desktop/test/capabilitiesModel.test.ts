/**
 * The Capabilities tab's view model: audit rows and the inventory in, rows
 * with counts, a banner and a badge out. Pure, so every rule the tab shows
 * is pinned here — above all what earns the badge and what clears it.
 */
import { describe, expect, it } from "vitest";
import { JSONValue } from "@domo/protocol";
import type { HostInventory } from "@domo/device-core";
import { AUTOMATION_APPS, automationApp } from "../src/automation.js";
import {
  actionLabel,
  blockedGroups,
  capabilitiesView,
  CapabilitiesInput,
  CapabilityGroup,
  CapabilityRow,
  isGroup,
  LABEL_IN_SETTINGS,
  LABEL_VIA_PROMPT,
  paneFor,
  SETTINGS_PANES,
} from "../src/capabilitiesModel.js";

/** The section's rows in display order, groups flattened, for the tests
 *  that care about order; `section.rows` is the same list. */
const groupOf = (section: { items: unknown[] }, key: string): CapabilityGroup =>
  section.items.find((i) => isGroup(i as never) && (i as CapabilityGroup).key === key) as CapabilityGroup;

function inventory(overrides: Partial<HostInventory> = {}): HostInventory {
  return {
    checked_at: "2026-09-02T08:00:00Z",
    full_disk_access: { granted: false, probes: [] },
    automation: [],
    automation_queryable: true,
    permissions: [
      { permission: "accessibility", status: "denied" },
      { permission: "contacts", status: "not_asked" },
      { permission: "calendars", status: "granted" },
    ],
    sandbox: { status: "ok", detail: null },
    child_attribution: { status: "not_applicable", detail: null },
    vault_key: { status: "ok", reason: null },
    ...overrides,
  };
}

function block(
  intentId: string,
  ts: string,
  permission: string,
  extra: { agent?: string; goal?: string; confidence?: string; target?: string } = {},
): JSONValue[] {
  return [
    {
      event: "intent_received",
      intentId,
      agent: "agent-1",
      agent_name: extra.agent ?? "Family Coordinator",
      request: `read file: /x/${intentId}`,
      goal: extra.goal ?? "read the code Chase texted",
      ts,
    },
    {
      event: "host_permission_blocked",
      intentId,
      permission,
      cause: "macos_permission",
      confidence: extra.confidence ?? "confirmed",
      owner_action: `Turn on ${permission}.`,
      probes: { automation_target: extra.target ?? null },
      ts,
    },
  ];
}

const messages = automationApp("Messages")!;
function input(overrides: Partial<CapabilitiesInput> = {}): CapabilitiesInput {
  return {
    inventory: inventory(),
    automation: AUTOMATION_APPS.map((app) => ({ app, status: app === messages ? "denied" : "not_asked" })),
    events: [],
    dismissals: {},
    bannerSeenAt: null,
    ...overrides,
  };
}

describe("blockedGroups", () => {
  it("groups blocks by switch, newest first, joined to the agent and goal", () => {
    const groups = blockedGroups([
      ...block("i1", "2026-09-02T02:00:00Z", "full_disk_access", { agent: "Inbox Triage", goal: "find the receipt" }),
      ...block("i2", "2026-09-02T06:12:00Z", "full_disk_access"),
      ...block("i3", "2026-09-02T04:00:00Z", "automation", { target: "Messages" }),
      ...block("i4", "2026-09-01T23:40:00Z", "files_downloads"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["full_disk_access", "automation:com.apple.MobileSMS", "files_downloads"]);
    const fda = groups[0]!;
    expect(fda.count).toBe(2);
    expect(fda.last).toBe("2026-09-02T06:12:00Z");
    expect(fda.agents).toEqual(["Inbox Triage", "Family Coordinator"]);
    expect(fda.requests.map((r) => r.at)).toEqual(["2026-09-02T06:12:00Z", "2026-09-02T02:00:00Z"]);
    expect(fda.requests[1]).toMatchObject({ agent: "Inbox Triage", goal: "find the receipt", ownerAction: "Turn on full_disk_access." });
  });

  it("an Automation block for an app the tab does not offer keeps the bare key", () => {
    const groups = blockedGroups(block("i1", "2026-09-02T02:00:00Z", "automation", { target: "Xcode" }));
    expect(groups[0]!.key).toBe("automation");
  });

  it("a block with no permission named is not a row", () => {
    const groups = blockedGroups([
      { event: "host_permission_blocked", intentId: "i9", cause: "outside_approved_bound", permission: null, ts: "2026-09-02T02:00:00Z" },
    ]);
    expect(groups).toEqual([]);
  });
});

describe("capabilitiesView", () => {
  it("shows the folders only while Full Disk Access is off, and the queryable services always", () => {
    const off = capabilitiesView(input());
    const files = off.sections.find((s) => s.key === "mac")!;
    expect(files.title).toBe("This Mac");
    expect(files.rows.map((r) => r.key)).toEqual([
      "full_disk_access", "files_desktop", "files_documents", "files_downloads", "contacts", "calendars", "accessibility",
      ...AUTOMATION_APPS.map((a) => `automation:${a.bundleId}`),
    ]);
    // The folders are a group; Automation is the other.
    expect(files.items.filter((i) => isGroup(i)).map((i) => (i as CapabilityGroup).key)).toEqual(["folders", "automation"]);
    const on = capabilitiesView(input({ inventory: inventory({ full_disk_access: { granted: true, probes: [] } }) }));
    expect(on.sections.find((s) => s.key === "mac")!.rows.filter((r) => !r.key.startsWith("automation:")).map((r) => r.key)).toEqual([
      "full_disk_access", "contacts", "calendars", "accessibility",
    ]);
    expect(on.sections[0]!.items.filter((i) => isGroup(i)).map((i) => (i as CapabilityGroup).key)).toEqual(["automation"]);
    expect(on.sections[0]!.rows[0]).toMatchObject({ status: "granted", action: "none", actionLabel: null });
  });

  it("the badge counts rows that are off AND were hit; a switch nobody hit does not badge", () => {
    const view = capabilitiesView(
      input({
        events: [
          ...block("i1", "2026-09-02T06:12:00Z", "full_disk_access"),
          ...block("i2", "2026-09-02T06:11:00Z", "full_disk_access"),
          ...block("i3", "2026-09-02T04:00:00Z", "automation", { target: "Messages" }),
          ...block("i4", "2026-09-02T03:00:00Z", "calendars"),
        ],
      }),
    );
    // Calendars is granted, so its hit is history, not attention.
    expect(view.badge).toBe(2);
    const rows = view.sections.flatMap((s) => s.rows);
    expect(rows.find((r) => r.key === "full_disk_access")).toMatchObject({ count: 2, needsAttention: true, action: "grant", actionLabel: LABEL_IN_SETTINGS });
    expect(rows.find((r) => r.key === "automation:com.apple.MobileSMS")).toMatchObject({ count: 1, needsAttention: true, status: "denied", action: "open" });
    expect(rows.find((r) => r.key === "calendars")).toMatchObject({ count: 1, needsAttention: false, status: "granted" });
    expect(rows.find((r) => r.key === "accessibility")).toMatchObject({ count: 0, needsAttention: false, action: "grant" });
    // The banner leads with the badge's number and counts only what those
    // switches blocked: Calendars' hit is not in it either.
    expect(view.banner).toEqual({
      switches: 2,
      count: 3,
      summary: [{ title: "Full Disk Access", count: 2 }, { title: "Messages", count: 1 }],
      last: "2026-09-02T06:12:00Z",
      since: null,
    });
  });

  it("the banner goes quiet with the badge: refusals of a switch granted since are history", () => {
    const events = block("i1", "2026-09-02T06:12:00Z", "calendars");
    expect(capabilitiesView(input({ events })).badge).toBe(0);
    expect(capabilitiesView(input({ events })).banner).toBeNull();
  });

  it("a row's own dismissal clears that row's requests — line, badge and banner — until a newer block lands", () => {
    const events = [
      ...block("i1", "2026-09-02T06:12:00Z", "full_disk_access"),
      ...block("i2", "2026-09-02T06:20:00Z", "contacts"),
    ];
    const dismissed = capabilitiesView(input({ events, dismissals: { full_disk_access: "2026-09-02T07:00:00Z" } }));
    expect(dismissed.sections[0]!.rows[0]).toMatchObject({ key: "full_disk_access", count: 0, needsAttention: false });
    // The other switch's request is untouched, so the badge and banner keep it.
    expect(dismissed.badge).toBe(1);
    expect(dismissed.banner).toEqual({ switches: 1, count: 1, summary: [{ title: "Contacts", count: 1 }], last: "2026-09-02T06:20:00Z", since: null });
    // The row's own cutoff, for its "Show in Audit": the row's dismissal.
    expect(dismissed.sections[0]!.rows[0]!.since).toBe("2026-09-02T07:00:00Z");
    const newer = capabilitiesView(
      input({
        events: [...events, ...block("i3", "2026-09-02T08:00:00Z", "full_disk_access")],
        dismissals: { full_disk_access: "2026-09-02T07:00:00Z" },
      }),
    );
    expect(newer.sections[0]!.rows[0]).toMatchObject({ count: 1, needsAttention: true });
    expect(newer.badge).toBe(2);
  });

  it("the banner counts blocks since it was last dismissed, summarised per switch, newest first", () => {
    const events = [
      ...block("i1", "2026-09-02T02:00:00Z", "full_disk_access"),
      ...block("i2", "2026-09-02T06:12:00Z", "full_disk_access"),
      ...block("i3", "2026-09-02T04:00:00Z", "automation", { target: "Messages" }),
    ];
    const fresh = capabilitiesView(input({ events }));
    expect(fresh.banner).toEqual({
      switches: 2,
      count: 3,
      summary: [{ title: "Full Disk Access", count: 2 }, { title: "Messages", count: 1 }],
      last: "2026-09-02T06:12:00Z",
      since: null,
    });
    const seen = capabilitiesView(input({ events, bannerSeenAt: "2026-09-02T05:00:00Z" }));
    // `since` is the dismissal the count starts from, so "Show in Audit"
    // can show exactly the requests the banner counted.
    expect(seen.banner).toEqual({ switches: 1, count: 1, summary: [{ title: "Full Disk Access", count: 1 }], last: "2026-09-02T06:12:00Z", since: "2026-09-02T05:00:00Z" });
    expect(seen.sections[0]!.rows[0]!.since).toBe("2026-09-02T05:00:00Z");
    expect(capabilitiesView(input({ events, bannerSeenAt: "2026-09-02T07:00:00Z" })).banner).toBeNull();
  });

  it("a block from the same second as the dismissal is dismissed", () => {
    // The audit log writes whole seconds; the dismissal keeps milliseconds.
    // As strings "…:00Z" sorts after "…:00.800Z" and the block survived.
    const events = block("i1", "2026-09-02T06:12:00Z", "full_disk_access");
    const seen = capabilitiesView(input({ events, bannerSeenAt: "2026-09-02T06:12:00.800Z" }));
    expect(seen.banner).toBeNull();
    expect(seen.badge).toBe(0);
    const row = capabilitiesView(input({ events, dismissals: { full_disk_access: "2026-09-02T06:12:00.800Z" } }));
    expect(row.sections[0]!.rows[0]).toMatchObject({ key: "full_disk_access", count: 0 });
  });

  it("a switch with no row of its own joins the end of This Mac only once something asked, in System Settings' words", () => {
    const quiet = capabilitiesView(input()).sections[0]!;
    expect(quiet.items.at(-1)).toMatchObject({ kind: "group", key: "automation" });
    const view = capabilitiesView(
      input({
        events: [
          ...block("i1", "2026-09-02T02:00:00Z", "screen_recording"),
          ...block("i2", "2026-09-02T03:00:00Z", "automation", { target: "Xcode" }),
        ],
      }),
    );
    expect(view.sections.map((s) => s.key)).toEqual(["mac"]);
    const tail = view.sections[0]!.items.slice(-2) as CapabilityRow[];
    expect(tail.map((r) => [r.key, r.title, r.action])).toEqual([
      ["automation", "Automation for another app", "open"],
      ["screen_recording", "Screen & System Audio Recording", "open"],
    ]);
    expect(view.badge).toBe(2);
  });

  it("a folder refused before Full Disk Access was granted is covered now, and shows nowhere", () => {
    const events = [
      ...block("i1", "2026-09-02T02:00:00Z", "files_downloads"),
      ...block("i2", "2026-09-02T03:00:00Z", "files_desktop"),
      ...block("i3", "2026-09-02T04:00:00Z", "screen_recording"),
    ];
    const granted = capabilitiesView(input({ events, inventory: inventory({ full_disk_access: { granted: true, probes: [] } }) }));
    const keys = granted.sections.flatMap((s) => s.rows.map((r) => r.key));
    expect(keys).not.toContain("files_downloads");
    expect(keys).not.toContain("files_desktop");
    // Screen Recording is not under the umbrella, so it still asks for the owner.
    expect(granted.sections[0]!.rows.at(-1)!.key).toBe("screen_recording");
    expect(granted.badge).toBe(1);
    // Without Full Disk Access the same refusals are rows in Files and data.
    const off = capabilitiesView(input({ events }));
    expect(off.sections[0]!.rows.filter((r) => r.count > 0).map((r) => r.key)).toEqual(["files_desktop", "files_downloads", "screen_recording"]);
  });

  it("a folder is denied once a confirmed block names it, and its button then points at the pane — macOS will not re-ask", () => {
    const never = capabilitiesView(input()).sections[0]!.rows.find((r) => r.key === "files_downloads")!;
    expect(never).toMatchObject({ status: "not_asked", action: "ask", actionLabel: LABEL_VIA_PROMPT });
    const refused = capabilitiesView(input({ events: block("i1", "2026-09-02T02:00:00Z", "files_downloads") }))
      .sections[0]!.rows.find((r) => r.key === "files_downloads")!;
    expect(refused).toMatchObject({ status: "denied", action: "open", actionLabel: LABEL_IN_SETTINGS, needsAttention: true });
    // What the touch learned wins over history.
    const granted = capabilitiesView(
      input({ events: block("i1", "2026-09-02T02:00:00Z", "files_downloads"), folders: { files_downloads: "granted" } }),
    ).sections[0]!.rows.find((r) => r.key === "files_downloads")!;
    expect(granted).toMatchObject({ status: "granted", needsAttention: false });
  });

  it("the queryable services ask macOS while unasked and open the pane once refused", () => {
    const rows = capabilitiesView(input()).sections[0]!.rows;
    expect(rows.find((r) => r.key === "contacts")).toMatchObject({ status: "not_asked", action: "request", actionLabel: LABEL_VIA_PROMPT });
    const refused = capabilitiesView(
      input({ inventory: inventory({ permissions: [{ permission: "contacts", status: "denied" }] }) }),
    ).sections[0]!.rows.find((r) => r.key === "contacts")!;
    expect(refused).toMatchObject({ status: "denied", action: "open" });
  });

  it("without the in-process addon, Contacts and Calendars point at the pane rather than promise a prompt", () => {
    const rows = capabilitiesView(input({ canRequestInProcess: false })).sections[0]!.rows;
    expect(rows.find((r) => r.key === "contacts")).toMatchObject({ action: "open", actionLabel: LABEL_IN_SETTINGS });
    expect(rows.find((r) => r.key === "accessibility")).toMatchObject({ action: "grant" });
  });

  it("Automation rows: the prompt until macOS has answered, the pane once it refused", () => {
    const apps = groupOf(capabilitiesView(input()).sections[0]!, "automation").rows;
    expect(apps.map((r) => r.title)).toEqual(AUTOMATION_APPS.map((a) => a.name));
    expect(apps.find((r) => r.title === "Messages")).toMatchObject({ status: "denied", action: "open" });
    expect(apps.find((r) => r.title === "Mail")).toMatchObject({ status: "not_asked", action: "request", actionLabel: LABEL_VIA_PROMPT });
  });

  it("without an inventory (no device yet) every row is unknown and nothing badges", () => {
    const view = capabilitiesView(input({ inventory: null }));
    expect(view.badge).toBe(0);
    expect(view.sections[0]!.rows[0]!.status).toBe("unknown");
  });
});

describe("panes", () => {
  it("every switch a row can name has a pane, and only the two drop targets accept a drag", () => {
    for (const key of Object.keys(SETTINGS_PANES)) {
      expect(SETTINGS_PANES[key]!.url).toMatch(/^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_/);
    }
    expect(Object.entries(SETTINGS_PANES).filter(([, p]) => p.acceptsDrop).map(([k]) => k).sort()).toEqual([
      "accessibility",
      "full_disk_access",
    ]);
    expect(paneFor("automation:com.apple.mail")).toEqual(SETTINGS_PANES.automation);
    expect(paneFor("nothing")).toBeNull();
    // Screen Recording's pane gets no panel at all.
    expect(paneFor("screen_recording")?.panel).toBe(false);
    expect(Object.entries(SETTINGS_PANES).filter(([, p]) => p.panel === false).map(([k]) => k)).toEqual(["screen_recording"]);
  });
});

describe("the words on the rows", () => {
  it("each Files row says what it is for, once, with no status in it; Automation rows say nothing", () => {
    const view = capabilitiesView(input());
    const detail = (key: string) => view.sections.flatMap((s) => s.rows).find((r) => r.key === key)!.detail;
    expect(detail("full_disk_access")).toBe("Needed for Messages, Mail, and Safari data. Covers Desktop, Documents, and Downloads if granted.");
    expect(detail("files_desktop")).toBe("Only needed if Full Disk Access is not granted.");
    expect(detail("contacts")).toMatch(/address book.*Messages/);
    expect(detail("calendars")).toBe("Reading and scheduling events.");
    expect(detail("accessibility")).toBe("Driving the screen and other apps' windows.");
    for (const r of groupOf(view.sections[0]!, "automation").rows) expect(r.detail).toBe("");
    // The status lives on the dot and the button, never as the line's opener
    // (the user's own wording may mention a grant mid-sentence).
    for (const r of view.sections.flatMap((s) => s.rows)) expect(r.detail).not.toMatch(/^(granted|allowed|not (granted|allowed|asked)|unknown)/i);
    // Granting ahead of time is the section's point, said there and not per row.
    expect(view.sections[0]!.description).toMatch(/ahead of time/);
  });
});

describe("the two button labels", () => {
  it("say what the owner will see next: a prompt here, or the pane with the panel", () => {
    expect(actionLabel("request")).toBe(LABEL_VIA_PROMPT);
    expect(actionLabel("ask")).toBe(LABEL_VIA_PROMPT);
    expect(actionLabel("grant")).toBe(LABEL_IN_SETTINGS);
    expect(actionLabel("open")).toBe(LABEL_IN_SETTINGS);
    expect(actionLabel("none")).toBeNull();
    // Every off row wears one of the two, never a third.
    const labels = new Set(
      capabilitiesView(input({ events: block("i1", "2026-09-02T02:00:00Z", "screen_recording") }))
        .sections.flatMap((s) => s.rows).map((r) => r.actionLabel).filter((l) => l !== null),
    );
    expect([...labels].sort()).toEqual([LABEL_IN_SETTINGS, LABEL_VIA_PROMPT].sort());
  });
});

describe("groups", () => {
  it("Folders and Automation open themselves only when a switch inside has blocked requests", () => {
    const quiet = capabilitiesView(input()).sections[0]!;
    expect(groupOf(quiet, "folders")).toMatchObject({ title: "Folders", total: 3, granted: 0, expandedByDefault: false });
    expect(groupOf(quiet, "automation")).toMatchObject({ title: "Automation", total: AUTOMATION_APPS.length, expandedByDefault: false });
    const hit = capabilitiesView(input({ events: block("i1", "2026-09-02T02:00:00Z", "files_downloads") })).sections[0]!;
    expect(groupOf(hit, "folders").expandedByDefault).toBe(true);
    // A hit inside Automation opens it the same way, and Folders stays shut.
    const auto = capabilitiesView(input({ events: block("i2", "2026-09-02T02:00:00Z", "automation", { target: "Messages" }) })).sections[0]!;
    expect(groupOf(auto, "automation").expandedByDefault).toBe(true);
    expect(groupOf(auto, "folders").expandedByDefault).toBe(false);
  });

  it("counts how many of a group are granted", () => {
    const view = capabilitiesView(
      input({
        folders: { files_desktop: "granted", files_documents: "granted" },
        automation: AUTOMATION_APPS.map((app, i) => ({ app, status: i < 2 ? "granted" : "not_asked" })),
      }),
    ).sections[0]!;
    expect(groupOf(view, "folders")).toMatchObject({ granted: 2, total: 3 });
    expect(groupOf(view, "automation")).toMatchObject({ granted: 2, total: AUTOMATION_APPS.length });
  });
});

describe("dismissing the banner", () => {
  it("clears the whole tab: no row lines, no badge, no leftover rows — until a newer block", () => {
    const events = [
      ...block("i1", "2026-09-02T02:00:00Z", "full_disk_access"),
      ...block("i2", "2026-09-02T03:00:00Z", "screen_recording"),
      ...block("i3", "2026-09-02T04:00:00Z", "files_downloads"),
    ];
    const seen = capabilitiesView(input({ events, bannerSeenAt: "2026-09-02T05:00:00Z" }));
    expect(seen.banner).toBeNull();
    expect(seen.badge).toBe(0);
    expect(seen.sections[0]!.rows.every((r) => r.count === 0)).toBe(true);
    expect(seen.sections[0]!.rows.map((r) => r.key)).not.toContain("screen_recording");
    expect(groupOf(seen.sections[0]!, "folders").expandedByDefault).toBe(false);
    // A block after the dismissal brings back exactly that one.
    const again = capabilitiesView(
      input({ events: [...events, ...block("i4", "2026-09-02T06:00:00Z", "full_disk_access")], bannerSeenAt: "2026-09-02T05:00:00Z" }),
    );
    expect(again.banner).toEqual({ switches: 1, count: 1, summary: [{ title: "Full Disk Access", count: 1 }], last: "2026-09-02T06:00:00Z", since: "2026-09-02T05:00:00Z" });
    expect(again.badge).toBe(1);
    expect(again.sections[0]!.rows.find((r) => r.key === "full_disk_access")).toMatchObject({ count: 1, needsAttention: true });
  });
});
