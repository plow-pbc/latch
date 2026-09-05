/**
 * The standing inventory: what this Mac lets the app do right now, before
 * anything fails.
 *
 * The diagnosis (`diagnose.ts`) answers "why did that not happen"; this
 * answers "what would not happen if asked", so an agent can say "your Mac
 * has not given me Full Disk Access" before trying, and the Settings pane
 * can show the owner every switch on one card. Same probes, same answers —
 * the pane and the tool cannot disagree because they read one snapshot.
 *
 * Every row is a fresh read. macOS flips these behind the app's back
 * (System Settings) and there is no event to invalidate a cache on, so the
 * snapshot carries when it was taken and nothing here remembers a previous
 * one.
 */
import { isoNow } from "@domo/protocol";
import { fullDiskProbePaths, probeFullDiskAccessDetail, FullDiskProbeResult } from "./fullDiskAccess.js";
import { AutomationStatus, HostProbes, PermissionStatus, QueryablePermission } from "./probes.js";

/**
 * The apps this Mac's built-in skills send Apple events to. Named here, not
 * discovered, because the skills are what need them: the iMessage skill
 * sends through Messages.app and the Contacts skill edits through
 * Contacts.app. Adding a skill that drives another app means adding its
 * name here, so the inventory can say up front whether it is allowed.
 */
export const AUTOMATION_TARGETS: readonly string[] = ["Messages", "Contacts"];

/**
 * The services with a query API of their own that this Mac's tools can need:
 * Accessibility for anything that drives the screen, Contacts and Calendars
 * for the stores the skills read. Screen Recording is deliberately absent —
 * no tool takes a screenshot of the screen, and asking about a permission
 * nothing uses reads as an intent to use it.
 */
export const QUERYABLE_PERMISSIONS: readonly QueryablePermission[] = ["accessibility", "contacts", "calendars"];

/** A child run the inventory's self-checks need: argv in, exit and output out. */
export type ChildRunner = (argv: string[]) => Promise<{ exitCode: number | null; output: string }>;

export interface HostInventory {
  checked_at: string;
  full_disk_access: { granted: boolean; probes: FullDiskProbeResult[] };
  /** Consent per target app. `target_not_running` is macOS declining to say. */
  automation: { target: string; status: AutomationStatus }[];
  /** Whether Automation can be asked about at all (the helper is present). */
  automation_queryable: boolean;
  /** The services with their own switch and their own query API. */
  permissions: { permission: QueryablePermission; status: PermissionStatus }[];
  /** `sandbox-exec` spawns and runs a trivial command under a generated
   *  profile — every plow_run_command depends on this. */
  sandbox: { status: "ok" | "failed"; detail: string | null };
  /**
   * A child of this app inherits its Full Disk Access — TCC's "responsible
   * process" attribution, which every sandboxed run that reads another app's
   * data relies on. Checked by reading a protected file through a real
   * child; `not_applicable` when FDA is not granted, since there is then
   * nothing to inherit.
   */
  child_attribution: { status: "ok" | "broken" | "not_applicable"; detail: string | null };
  /** The vault's master key opens on this Mac. A code-signature change
   *  between builds makes it unreadable, which otherwise surfaces as a
   *  vault error at fill time. */
  vault_key: { status: "ok" | "locked" | "absent" | "unknown"; reason: string | null };
}

export interface InventoryDeps {
  probes: HostProbes;
  ownerHome: string;
  /** Runs argv through the real sandboxed executor. Null where there is
   *  none (a non-Mac test host): the sandbox rows say so. */
  runSandboxed: ChildRunner | null;
  /** The vault's key state, as the vault reports it. Null when this Mac has
   *  no vault (no browser runtime). */
  vaultKey: (() => { status: string; reason?: string }) | null;
  /** Which targets to ask about; the built-in list by default. */
  automationTargets?: readonly string[];
  /** Override for tests; the real list is `fullDiskProbePaths(ownerHome)`. */
  fullDiskPaths?: string[];
}

/** Take the snapshot. Every row is independent, so they run together. */
export async function hostInventory(deps: InventoryDeps): Promise<HostInventory> {
  const targets = deps.automationTargets ?? AUTOMATION_TARGETS;
  const fdaPaths = deps.fullDiskPaths ?? fullDiskProbePaths(deps.ownerHome);
  const [fda, automation, permissions, sandbox] = await Promise.all([
    probeFullDiskAccessDetail(fdaPaths),
    Promise.all(
      targets.map(async (target) => ({ target, status: await deps.probes.automationStatus(target) })),
    ),
    Promise.all(
      QUERYABLE_PERMISSIONS.map(async (permission) => ({
        permission,
        status: await deps.probes.permissionStatus(permission),
      })),
    ),
    sandboxCheck(deps.runSandboxed),
  ]);
  // Attribution is checked only once FDA is known granted, and against the
  // very file the app's own probe just opened: any other file could be
  // missing, and a missing file proves nothing about attribution.
  const opened = fda.results.find((r) => r.outcome === "ok")?.path ?? null;
  const attribution = await attributionCheck(deps.runSandboxed, fda.granted ? opened : null);
  return {
    checked_at: isoNow(),
    full_disk_access: { granted: fda.granted, probes: fda.results },
    automation,
    // The helper answers something other than unknown for a target it can
    // see; "every target unknown" is what its absence looks like.
    automation_queryable: automation.some((a) => a.status !== "unknown"),
    permissions,
    sandbox,
    child_attribution: attribution,
    vault_key: vaultKeyRow(deps.vaultKey),
  };
}

async function sandboxCheck(run: ChildRunner | null): Promise<HostInventory["sandbox"]> {
  if (run === null) return { status: "failed", detail: "no sandboxed executor on this host" };
  try {
    const result = await run(["/usr/bin/true"]);
    return result.exitCode === 0
      ? { status: "ok", detail: null }
      : { status: "failed", detail: `exit ${result.exitCode ?? -1}: ${result.output.trim()}`.trim() };
  } catch (error: unknown) {
    return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function attributionCheck(
  run: ChildRunner | null,
  protectedFile: string | null,
): Promise<HostInventory["child_attribution"]> {
  if (protectedFile === null) return { status: "not_applicable", detail: null };
  if (run === null) return { status: "not_applicable", detail: "no sandboxed executor on this host" };
  try {
    // `head -c 1`, the same one-byte read the app-process probe makes: a
    // child that inherits the grant reads it, one that does not gets EPERM.
    const result = await run(["/usr/bin/head", "-c", "1", "--", protectedFile]);
    return result.exitCode === 0
      ? { status: "ok", detail: null }
      : { status: "broken", detail: `a child of the app is refused a file the app itself can read (exit ${result.exitCode ?? -1})` };
  } catch (error: unknown) {
    return { status: "broken", detail: error instanceof Error ? error.message : String(error) };
  }
}

function vaultKeyRow(read: InventoryDeps["vaultKey"]): HostInventory["vault_key"] {
  if (read === null) return { status: "absent", reason: "this Mac has no vault" };
  try {
    const state = read();
    const status = state.status === "ok" || state.status === "locked" ? state.status : "unknown";
    return { status, reason: state.reason ?? null };
  } catch (error: unknown) {
    return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}
