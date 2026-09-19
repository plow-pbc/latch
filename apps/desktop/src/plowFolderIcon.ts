/** Best-effort boundary to the macOS helper that decorates the shared workspace. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PlowFolderIconOptions {
  folderPath: string;
  helperPath: string;
  badgePath: string;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}

export async function applyPlowFolderIcon(options: PlowFolderIconOptions): Promise<void> {
  if ((options.platform ?? process.platform) !== "darwin") return;
  try {
    await execFileAsync(options.helperPath, [options.folderPath, options.badgePath]);
  } catch {
    (options.log ?? console.log)(
      "[plow-folder] could not apply the Finder icon; the workspace is still available",
    );
  }
}
