import type { HostInventory } from "@domo/device-core";

/** A standing inventory for the view-model tests: Full Disk Access off and
 *  one permission in each of the three states a row can read.
 *
 *  `child_attribution` follows the grant the way the real inventory does —
 *  "not_applicable" while Full Disk Access is off, because there is nothing
 *  to inherit, and "ok" once it is on. A test that wants the granted-but-
 *  broken case overrides it; hardcoding "not_applicable" alongside a grant
 *  would be a state this Mac never reports. */
export function inventory(overrides: Partial<HostInventory> = {}): HostInventory {
  const granted = overrides.full_disk_access?.granted ?? false;
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
    child_attribution: { status: granted ? "ok" : "not_applicable", detail: null },
    vault_key: { status: "ok", reason: null },
    ...overrides,
  };
}
