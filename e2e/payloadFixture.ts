/**
 * What a built runtime payload looks like on disk, for the suites that
 * fabricate donor checkouts.
 *
 * Shared because both of them need the same fact and it is not obvious: a
 * payload directory exists from the moment its fetch starts extracting, so the
 * marker its build writes at the end is the only thing separating a finished
 * payload from one still being written. Getting these wrong is what let a
 * donor mid-Rust-build read as ready — vault-server takes two, because the web
 * interface is fetched before the vaultwarden compile it sits beside.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The arch whose trees this machine can actually run — see browserRuntime.ts. */
export const ARCH = os.arch() === "arm64" ? "arm64" : "x86_64";

/** Every file that must exist before a payload counts as built, under its dir. */
export const MARKERS: Record<string, string[]> = {
  "python-runtime": [".stamp"],
  "camoufox-browser": [`${ARCH}/.sha256`],
  "vault-server": [".web-vault.sha256", `${ARCH}/.commit`],
  "vault-cli": [`${ARCH}/.sha256`],
};

/** Write one marker path under a checkout's vendor dir, parents and all. */
export function writeMarker(checkout: string, relative: string): void {
  const at = path.join(checkout, "vendor", relative);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, "built\n");
}

/** Mark a payload finished. Nothing happens for one that carries no marker. */
export function markBuilt(checkout: string, payload: string): void {
  for (const marker of MARKERS[payload] ?? []) writeMarker(checkout, path.join(payload, marker));
}
