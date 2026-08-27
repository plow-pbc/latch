/**
 * How a vendored provider CLI is authorised, and where its binary lives.
 *
 * Outside `main.ts` for the reason the browser runtime's resolution is: these
 * decide which credential leaves this Mac and which binary a bare command name
 * reaches, so both have to be reachable by `npx vitest run` with no display.
 */
import path from "node:path";
import {
  MintError,
  overrideVar,
  PROVIDERS,
  resolveVendoredBinary,
  type Minter,
  type VendoredProvider,
} from "@domo/device-core";
import type { PlowApi } from "./plowApi.js";
import { loadSettings } from "./settings.js";

/**
 * Adapts `PlowApi` to the `Minter` the device expects.
 *
 * An adapter rather than a transport: everything about how the call is made —
 * the bearer header, the bound, the credential-echo rule — is already
 * `PlowApi`'s, and duplicating it would have put those three properties in two
 * places that can drift.
 */
export function buildMinter(opts: { api: PlowApi; home: string }): Minter {
  return {
    async mint(provider: VendoredProvider): Promise<string> {
      // Read per call, never captured: re-pairing takes effect on the next
      // command rather than the next launch.
      const credential = loadSettings(opts.home).relayCredential.trim();
      if (!credential) throw MintError.unpaired();
      try {
        return await opts.api.mintProviderToken(credential, provider.mintPrefix, provider.mintAction);
      } catch (e) {
        // PlowApi composes its own messages under the same no-foreign-text
        // rule, so this one is safe to carry into the audit log.
        throw MintError.failed(provider.command, e instanceof Error ? e.message : "unknown error");
      }
    },
  };
}

/**
 * The directories holding vendored CLIs, for the child's PATH.
 *
 * Empty when nothing is staged, which is not an error: the exec path reports
 * a missing provider through the approval dialog rather than failing at
 * launch, and every non-provider command still runs.
 */
export function vendorDirs(opts: { resourcesDir?: string; repoRoot?: string }): string[] {
  const dirs: string[] = [];
  for (const provider of PROVIDERS) {
    const located = resolveVendoredBinary(provider.command, opts);
    if (located.path !== null) {
      dirs.push(path.dirname(located.path));
      continue;
    }
    // The distinction `resolveVendoredBinary` draws is worth keeping: an
    // operator who NAMED a path gets told that path is wrong, rather than
    // "nothing is staged", which would send them to run a fetch they have
    // already run. Logged rather than thrown — this runs inside the launch
    // chain, and a stale env var must not be able to take the app down.
    if (located.problem === "override-missing") {
      const name = overrideVar(provider.command);
      console.error(`[providers] ${name} names no executable: ${process.env[name]}`);
    }
  }
  return dirs;
}
