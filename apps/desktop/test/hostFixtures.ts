import type { HostInventory } from "@domo/device-core";

/** A standing inventory for the view-model tests: Full Disk Access off and
 *  one permission in each of the three states a row can read. */
export function inventory(overrides: Partial<HostInventory> = {}): HostInventory {
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
