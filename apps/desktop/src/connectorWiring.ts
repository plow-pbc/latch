/**
 * How `DeviceAgent` reaches Plow's connector API for `tool` capabilities.
 *
 * Lives outside `main.ts` for the same reason `reviewPolicy.ts` does: it is a
 * security-relevant decision path (which credential leaves this Mac, and
 * when it is read), so it has to be reachable by `npx vitest run` with no
 * display and no device.
 */
import { makeConnectorClient, type ConnectorClient, type FetchLike } from "@domo/device-core";
import { loadSettings } from "./settings.js";

/**
 * Build the connector client `DeviceAgent` executes `tool` capabilities
 * through.
 *
 * The credential is read out of `home` on every call rather than captured
 * here: `main.ts` reads `hasCredential` the same way, and for the same reason
 * — re-pairing has to take effect on the next call, not the next launch. A
 * captured string would keep sending a stale credential until the app quit and
 * relaunched, which would look like a server problem rather than a
 * not-yet-re-paired Mac. That read lives HERE rather than in a callback the
 * caller supplies, so the thing under test is the wiring the app ships;
 * `loadSettings` is pure `node:fs`, so it pulls no Electron into the suite.
 */
export function buildConnectorClient(opts: {
  apiBaseUrl: string;
  home: string;
  fetchImpl?: FetchLike;
}): ConnectorClient {
  return makeConnectorClient({
    apiBaseUrl: opts.apiBaseUrl,
    credential: () => loadSettings(opts.home).relayCredential,
    fetchImpl: opts.fetchImpl,
  });
}
