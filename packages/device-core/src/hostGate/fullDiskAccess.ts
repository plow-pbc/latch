/**
 * Full Disk Access detection.
 *
 * macOS has no API to request Full Disk Access and none to query it — the only
 * honest check is to try to open something TCC protects and see whether the
 * system allows it. Granting is likewise out of the app's hands: the person
 * flips a switch in System Settings, so the Settings pane's "grant" button is
 * a deep link to that pane (the `fullDiskSettings` entry in the desktop
 * main's EXTERNAL_URLS table).
 *
 * Lives in device-core rather than the desktop app because the diagnosis
 * (`hostGate/diagnose.ts`) needs the same answer the Settings pane shows —
 * two probes with two opinions would be the drift this module exists to
 * prevent. Pure Node on purpose (no Electron import): the probe logic is
 * unit-testable against fixture paths.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Files only Full Disk Access lets this process read. Several, because none is
 * guaranteed to exist on every Mac — the per-user TCC database is created with
 * the account, the Messages store only once Messages has run, the Safari file
 * only once Safari has. The grant is one per-app switch covering all of them,
 * so one readable probe proves it as well as three would.
 */
export function fullDiskProbePaths(home: string = os.homedir()): string[] {
  return [
    path.join(home, "Library/Application Support/com.apple.TCC/TCC.db"),
    path.join(home, "Library/Messages/chat.db"),
    path.join(home, "Library/Safari/Bookmarks.plist"),
  ];
}

/** One probe path's outcome. `ENOENT` proves nothing; a refusal is TCC. */
export interface FullDiskProbeResult {
  path: string;
  outcome: "ok" | "ENOENT" | "EPERM" | "EACCES" | string;
}

/**
 * Whether this process can read TCC-protected files right now, with the
 * errno each probe returned — the errno is what a diagnosis reads.
 *
 * "Right now" is the honest scope: macOS can keep enforcing the old answer on
 * a running process after the switch flips (System Settings offers
 * "Quit & Reopen" for a reason), so a fresh probe after relaunch is the
 * authoritative one. Only a successful open proves the grant; a missing path
 * proves nothing and is skipped. Every probe missing or refused reads as not
 * granted — the safe answer on the hosts where it could be wrong (non-Mac test
 * machines, where nothing is TCC-protected at all).
 */
export async function probeFullDiskAccessDetail(
  paths: string[] = fullDiskProbePaths(),
): Promise<{ granted: boolean; results: FullDiskProbeResult[] }> {
  const results: FullDiskProbeResult[] = [];
  for (const p of paths) {
    try {
      const handle = await fs.open(p, "r");
      await handle.close();
      results.push({ path: p, outcome: "ok" });
      return { granted: true, results };
    } catch (error: unknown) {
      const code = (error as { code?: unknown })?.code;
      results.push({ path: p, outcome: typeof code === "string" ? code : "error" });
    }
  }
  return { granted: false, results };
}

/** The yes/no the Settings pane and the grant flow poll. */
export async function probeFullDiskAccess(paths: string[] = fullDiskProbePaths()): Promise<boolean> {
  return (await probeFullDiskAccessDetail(paths)).granted;
}
