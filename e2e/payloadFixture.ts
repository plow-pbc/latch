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

/**
 * Files a payload's build writes BEFORE its marker — the ones that make a tree
 * look inhabited while it is still being filled in. fetchBrowser() writes
 * camoufox's config.json after the extraction and before the addon it fetches
 * over the network, so a tree holding one is past the slow half and still
 * unfinished.
 */
export const CONTENTS: Record<string, string[]> = {
  // In the order fetchBrowser() writes them: something inside the extracted
  // tree first (its real shape is browsers/<repo>/<version>-<sha>/…, which
  // nothing here needs to match), then config.json once the extraction
  // finishes, and .sha256 — a MARKER, not listed here — last of all, after an
  // addon pulled over the network. A row drops one to sit at a chosen point.
  "camoufox-browser": [`${ARCH}/browsers/extracted-file`, `${ARCH}/config.json`],
};

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

/** The files a build leaves behind before its marker — an in-flight payload. */
export function markStarted(checkout: string, payload: string): void {
  for (const f of CONTENTS[payload] ?? []) writeMarker(checkout, path.join(payload, f));
}

/** Mark a payload finished: what a started one has, plus its markers. */
export function markBuilt(checkout: string, payload: string): void {
  markStarted(checkout, payload);
  for (const marker of MARKERS[payload] ?? []) writeMarker(checkout, path.join(payload, marker));
}
