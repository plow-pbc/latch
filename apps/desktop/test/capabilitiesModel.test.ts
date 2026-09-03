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
  blockedGroups,
  capabilitiesView,
  CapabilitiesInput,
  paneFor,
  SETTINGS_PANES,
} from "../src/capabilitiesModel.js";

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
    const files = off.sections.find((s) => s.key === "files")!;
    expect(files.rows.map((r) => r.key)).toEqual([
      "full_disk_access", "files_desktop", "files_documents", "files_downloads", "contacts", "calendars", "accessibility",
    ]);
    const on = capabilitiesView(input({ inventory: inventory({ full_disk_access: { granted: true, probes: [] } }) }));
    expect(on.sections.find((s) => s.key === "files")!.rows.map((r) => r.key)).toEqual([
      "full_disk_access", "contacts", "calendars", "accessibility",
    ]);
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
    expect(rows.find((r) => r.key === "full_disk_access")).toMatchObject({ count: 2, needsAttention: true, action: "grant", actionLabel: "Grant…" });
    expect(rows.find((r) => r.key === "automation:com.apple.MobileSMS")).toMatchObject({ count: 1, needsAttention: true, status: "denied", action: "open" });
    expect(rows.find((r) => r.key === "calendars")).toMatchObject({ count: 1, needsAttention: false, status: "granted" });
    expect(rows.find((r) => r.key === "accessibility")).toMatchObject({ count: 0, needsAttention: false, action: "grant" });
  });

  it("a dismissal hides a row from the badge until a newer block lands", () => {
    const events = block("i1", "2026-09-02T06:12:00Z", "full_disk_access");
    const dismissed = capabilitiesView(input({ events, dismissals: { full_disk_access: "2026-09-02T07:00:00Z" } }));
    expect(dismissed.badge).toBe(0);
    expect(dismissed.sections[0]!.rows[0]).toMatchObject({ dismissed: true, count: 1 });
    const newer = capabilitiesView(
      input({
        events: [...events, ...block("i2", "2026-09-02T08:00:00Z", "full_disk_access")],
        dismissals: { full_disk_access: "2026-09-02T07:00:00Z" },
      }),
    );
    expect(newer.badge).toBe(1);
    expect(newer.sections[0]!.rows[0]!.dismissed).toBe(false);
  });

  it("the banner counts blocks since it was last dismissed, summarised per switch, newest first", () => {
    const events = [
      ...block("i1", "2026-09-02T02:00:00Z", "full_disk_access"),
      ...block("i2", "2026-09-02T06:12:00Z", "full_disk_access"),
      ...block("i3", "2026-09-02T04:00:00Z", "automation", { target: "Messages" }),
    ];
    const fresh = capabilitiesView(input({ events }));
    expect(fresh.banner).toEqual({
      count: 3,
      summary: [{ title: "Full Disk Access", count: 2 }, { title: "Messages", count: 1 }],
      last: "2026-09-02T06:12:00Z",
    });
    const seen = capabilitiesView(input({ events, bannerSeenAt: "2026-09-02T05:00:00Z" }));
    expect(seen.banner).toEqual({ count: 1, summary: [{ title: "Full Disk Access", count: 1 }], last: "2026-09-02T06:12:00Z" });
    expect(capabilitiesView(input({ events, bannerSeenAt: "2026-09-02T07:00:00Z" })).banner).toBeNull();
  });

  it("the yourself section appears only for switches with no row, and names them in System Settings' words", () => {
    expect(capabilitiesView(input()).sections.map((s) => s.key)).toEqual(["files", "apps"]);
    const view = capabilitiesView(
      input({
        events: [
          ...block("i1", "2026-09-02T02:00:00Z", "screen_recording"),
          ...block("i2", "2026-09-02T03:00:00Z", "automation", { target: "Xcode" }),
        ],
      }),
    );
    const yourself = view.sections.find((s) => s.key === "yourself")!;
    expect(yourself.rows.map((r) => [r.key, r.title, r.action])).toEqual([
      ["automation", "Automation for another app", "open"],
      ["screen_recording", "Screen & System Audio Recording", "open"],
    ]);
    expect(view.badge).toBe(2);
  });

  it("a folder is denied once a confirmed block names it, and its button changes accordingly", () => {
    const never = capabilitiesView(input()).sections[0]!.rows.find((r) => r.key === "files_downloads")!;
    expect(never).toMatchObject({ status: "not_asked", action: "ask", actionLabel: "Ask macOS now" });
    const refused = capabilitiesView(input({ events: block("i1", "2026-09-02T02:00:00Z", "files_downloads") }))
      .sections[0]!.rows.find((r) => r.key === "files_downloads")!;
    expect(refused).toMatchObject({ status: "denied", action: "open", needsAttention: true });
    // What the touch learned wins over history.
    const granted = capabilitiesView(
      input({ events: block("i1", "2026-09-02T02:00:00Z", "files_downloads"), folders: { files_downloads: "granted" } }),
    ).sections[0]!.rows.find((r) => r.key === "files_downloads")!;
    expect(granted).toMatchObject({ status: "granted", needsAttention: false });
  });

  it("the queryable services ask macOS while unasked and open the pane once refused", () => {
    const rows = capabilitiesView(input()).sections[0]!.rows;
    expect(rows.find((r) => r.key === "contacts")).toMatchObject({ status: "not_asked", action: "request", actionLabel: "Ask macOS now" });
    const refused = capabilitiesView(
      input({ inventory: inventory({ permissions: [{ permission: "contacts", status: "denied" }] }) }),
    ).sections[0]!.rows.find((r) => r.key === "contacts")!;
    expect(refused).toMatchObject({ status: "denied", action: "open" });
  });

  it("Automation rows: Grant… until macOS has answered, the pane once it refused", () => {
    const apps = capabilitiesView(input()).sections.find((s) => s.key === "apps")!.rows;
    expect(apps.map((r) => r.title)).toEqual(AUTOMATION_APPS.map((a) => a.name));
    expect(apps.find((r) => r.title === "Messages")).toMatchObject({ status: "denied", action: "open" });
    expect(apps.find((r) => r.title === "Mail")).toMatchObject({ status: "not_asked", action: "request", actionLabel: "Grant…" });
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
  });
});

describe("the words on the rows", () => {
  it("each Files row says what it is for, once, with no status in it; Automation rows say nothing", () => {
    const view = capabilitiesView(input());
    const detail = (key: string) => view.sections.flatMap((s) => s.rows).find((r) => r.key === key)!.detail;
    expect(detail("full_disk_access")).toBe("Needed for Messages, Mail, and Safari data. Covers Desktop, Documents, and Downloads if granted");
    expect(detail("files_desktop")).toBe("Only needed if Full Disk Access is not granted");
    expect(detail("contacts")).toMatch(/address book.*Messages/);
    expect(detail("calendars")).toBe("Reading and scheduling events");
    expect(detail("accessibility")).toBe("Driving the screen and other apps' windows");
    for (const r of view.sections.find((s) => s.key === "apps")!.rows) expect(r.detail).toBe("");
    // The status lives on the dot and the button, never as the line's opener
    // (the user's own wording may mention a grant mid-sentence).
    for (const r of view.sections.flatMap((s) => s.rows)) expect(r.detail).not.toMatch(/^(granted|allowed|not (granted|allowed|asked)|unknown)/i);
    // Granting ahead of time is the sections' point, said there and not per row.
    for (const s of view.sections) expect(s.description).toMatch(/ahead of time/);
  });
});
