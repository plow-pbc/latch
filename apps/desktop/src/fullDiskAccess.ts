/**
 * Full Disk Access detection.
 *
 * macOS has no API to request Full Disk Access and none to query it — the only
 * honest check is to try to open something TCC protects and see whether the
 * system allows it. Granting is likewise out of the app's hands: the person
 * flips a switch in System Settings, so the Settings pane's "grant" button is
 * a deep link to that pane (the `fullDiskSettings` entry in main's
 * EXTERNAL_URLS table).
 *
 * Pure Node on purpose (no Electron import), like viewModel.ts: the probe
 * logic is unit-testable against fixture paths.
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

/**
 * Whether this process can read TCC-protected files right now.
 *
 * "Right now" is the honest scope: macOS can keep enforcing the old answer on
 * a running process after the switch flips (System Settings offers
 * "Quit & Reopen" for a reason), so a fresh probe after relaunch is the
 * authoritative one. Only a successful open proves the grant; a missing path
 * proves nothing and is skipped. Every probe missing or refused reads as not
 * granted — the safe answer on the hosts where it could be wrong (non-Mac test
 * machines, where nothing is TCC-protected at all).
 */
export async function probeFullDiskAccess(
  paths: string[] = fullDiskProbePaths(),
): Promise<boolean> {
  for (const p of paths) {
    try {
      const handle = await fs.open(p, "r");
      await handle.close();
      return true;
    } catch {
      // ENOENT proves nothing; EPERM/EACCES is TCC saying no. Try the next.
    }
  }
  return false;
}
