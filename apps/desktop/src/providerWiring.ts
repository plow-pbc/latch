/**
 * How a provider CLI is authorised.
 *
 * Outside `main.ts` for the reason the browser runtime's resolution is: this
 * decides which credential leaves this Mac, so it has to be reachable by
 * `npx vitest run` with no display.
 */
import {
  MintError,
  type Minter,
  type Provider,
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
  const authorised = async <T>(
    provider: Provider,
    call: (credential: string) => Promise<T>,
  ): Promise<T> => {
    // Read per call, never captured: re-pairing takes effect on the next
    // command rather than the next launch.
    const credential = loadSettings(opts.home).relayCredential.trim();
    if (!credential) throw MintError.unpaired();
    try {
      return await call(credential);
    } catch (e) {
      // PlowApi composes its own messages under the same no-foreign-text
      // rule, so this one is safe to carry into the audit log.
      throw MintError.failed(provider.command, e instanceof Error ? e.message : "unknown error");
    }
  };
  return {
    mintAll: (provider) =>
      authorised(provider, (c) => opts.api.mintAccountTokens(c, provider.mintPrefix, provider.mintAction)),
  };
}
