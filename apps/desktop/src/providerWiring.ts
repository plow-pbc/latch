/**
 * How a vendored provider CLI is authorised, and where its binary lives.
 *
 * Outside `main.ts` for the reason the browser runtime's resolution is: these
 * decide which credential leaves this Mac and which binary a bare command name
 * reaches, so both have to be reachable by `npx vitest run` with no display.
 */
import { makeMinter, resolveVendoredBinary, type FetchLike, type Minter } from "@domo/device-core";
import path from "node:path";
import { loadSettings } from "./settings.js";

export function buildMinter(opts: {
  apiBaseUrl: string;
  home: string;
  fetchImpl?: FetchLike;
}): Minter {
  return makeMinter({
    apiBaseUrl: opts.apiBaseUrl,
    // Read per call, never captured: re-pairing takes effect on the next
    // command rather than the next launch.
    credential: () => loadSettings(opts.home).relayCredential,
    fetchImpl: opts.fetchImpl,
  });
}

/**
 * The directories holding vendored CLIs, for the child's PATH.
 *
 * Empty when nothing is staged, which is not an error: the exec path reports
 * a missing provider through the approval dialog rather than failing at
 * launch, and every non-provider command still runs.
 */
export function vendorDirs(opts: { resourcesDir?: string; repoRoot?: string }): string[] {
  const located = resolveVendoredBinary(opts);
  if (located.path !== null) return [path.dirname(located.path)];
  // The distinction `resolveVendoredBinary` draws is worth keeping: an
  // operator who NAMED a path gets told that path is wrong, rather than
  // "nothing is staged", which would send them to run a fetch they have
  // already run. Logged rather than thrown — this runs inside the launch
  // chain, and a stale env var must not be able to take the app down.
  if (located.problem === "override-missing") {
    console.error(`[providers] DOMO_GOG names no executable: ${process.env.DOMO_GOG}`);
  }
  return [];
}
