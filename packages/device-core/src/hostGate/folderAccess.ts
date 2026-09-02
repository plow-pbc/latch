/**
 * Raising the folder consent dialogs on purpose, while the owner is there.
 *
 * The Desktop, Documents and Downloads folders have no query API and no
 * "request" API: the first access is the request, and macOS answers it with
 * a dialog that PARKS the access until someone clicks. Every other part of
 * hostGate/ is built around never doing that unattended. This is the one
 * place it is done deliberately — in first-run setup, with the owner at the
 * Mac — so the dialogs are answered once, now, instead of parking an agent's
 * read on a Tuesday afternoon when nobody is home.
 *
 * Full Disk Access covers all three folders, which is why setup offers that
 * first; this is for the owner who declined it. The touch is the same
 * one-directory listing the diagnosis probe makes (`probes.ts`), through the
 * same child, with a long timeout: a person reading a dialog takes seconds,
 * not milliseconds.
 */
import path from "node:path";
import { HostPermission, PERMISSION_LABELS } from "./guardedPaths.js";
import { HostProbes, nodeProbes } from "./probes.js";

/** The folders with a switch of their own, in the order setup shows them. */
export const CONSENT_FOLDERS: readonly { folder: string; permission: HostPermission }[] = [
  { folder: "Desktop", permission: "files_desktop" },
  { folder: "Documents", permission: "files_documents" },
  { folder: "Downloads", permission: "files_downloads" },
];

/** How long one folder's dialog is given. The owner is expected to be
 *  present; two minutes is patience, not a poll. */
export const FOLDER_CONSENT_TIMEOUT_MS = 2 * 60_000;

export type FolderConsent = "granted" | "denied" | "unanswered" | "missing";

export interface FolderAccessResult {
  folder: string;
  permission: HostPermission;
  label: string;
  status: FolderConsent;
}

/**
 * Touch each folder, one after another — one dialog at a time is what the
 * owner can answer — and report what macOS decided. `unanswered` means the
 * dialog outlived the timeout: still open, or dismissed without a choice.
 */
export async function requestFolderAccess(
  ownerHome: string,
  options: { probes?: HostProbes; timeoutMs?: number; folders?: typeof CONSENT_FOLDERS } = {},
): Promise<FolderAccessResult[]> {
  const probes = options.probes ?? nodeProbes({ ownerHome, timeoutMs: options.timeoutMs ?? FOLDER_CONSENT_TIMEOUT_MS });
  const results: FolderAccessResult[] = [];
  for (const { folder, permission } of options.folders ?? CONSENT_FOLDERS) {
    const open = await probes.openAsApp(path.join(ownerHome, folder));
    const status: FolderConsent =
      open === "ok" ? "granted" : open === "hung" ? "unanswered" : open === "ENOENT" ? "missing" : "denied";
    results.push({ folder, permission, label: PERMISSION_LABELS[permission], status });
  }
  return results;
}
