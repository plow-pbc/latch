/**
 * Resolve the app an AppleScript targets to its bundle id, on this Mac,
 * before the human sees the capability — the same rule as paths.
 *
 * Deliberately not `id of application "X"` via osascript: for a name macOS
 * can't place, that pops a modal "Where is X?" chooser on the desktop and
 * blocks until someone answers it. A filesystem lookup over the standard
 * application folders can't block and can't prompt. Faceless scripting
 * targets live in CoreServices ("System Events", "Image Events").
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const APP_FOLDERS = [
  "/Applications",
  "/Applications/Utilities",
  "/System/Applications",
  "/System/Applications/Utilities",
  "/System/Library/CoreServices",
  "/System/Library/CoreServices/Applications",
  path.join(os.homedir(), "Applications"),
];

export class AppNotFoundError extends Error {
  constructor(public readonly app: string) {
    super(`no application named "${app}" in the standard application folders`);
  }
}

/** The bundle id of `<folder>/<name>.app` for the first folder that has one. */
export async function resolveAppBundleId(
  name: string,
  folders: string[] = APP_FOLDERS,
): Promise<string> {
  if (name === "" || name.includes("/") || name.includes("\0")) throw new AppNotFoundError(name);
  for (const folder of folders) {
    const plist = path.join(folder, `${name}.app`, "Contents", "Info.plist");
    let exists = false;
    try {
      await fs.access(plist);
      exists = true;
    } catch {
      // try the next folder
    }
    if (!exists) continue;
    const id = await bundleIdentifier(plist);
    if (id !== null) return id;
  }
  throw new AppNotFoundError(name);
}

function bundleIdentifier(plist: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist],
      { timeout: 5000 },
      (error, stdout) => {
        const id = stdout.trim();
        resolve(error || id === "" ? null : id);
      },
    );
  });
}
