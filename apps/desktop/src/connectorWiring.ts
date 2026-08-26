/**
 * How `DeviceAgent` reaches Plow's connector API for `tool` capabilities.
 *
 * Lives outside `main.ts` for the same reason `reviewPolicy.ts` does: it is a
 * security-relevant decision path (which credential leaves this Mac, and
 * when it is read), so it has to be reachable by `npx vitest run` with no
 * display and no device.
 */
import { makeConnectorClient, type ConnectorClient, type FetchLike } from "@domo/device-core";

/**
 * Build the connector client `DeviceAgent` executes `tool` capabilities
 * through.
 *
 * `credential` is a callback rather than a captured string: `main.ts:806`
 * reads `hasCredential` the same way, and for the same reason — re-pairing
 * has to take effect on the next call, not the next launch. A captured
 * string would keep sending a stale credential until the app quit and
 * relaunched, which would look like a server problem rather than a
 * not-yet-re-paired Mac.
 */
export function buildConnectorClient(opts: {
  apiBaseUrl: string;
  credential: () => string;
  fetchImpl?: FetchLike;
}): ConnectorClient {
  return makeConnectorClient(opts);
}
