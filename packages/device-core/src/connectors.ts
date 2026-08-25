/**
 * The HTTPS seam to Plow's connector API.
 *
 * Slack's own OAuth token never reaches this Mac. Plow holds it server-side and
 * this client calls the connector route with the *device's* Plow credential, so
 * a compromised Mac yields a revocable Plow credential rather than the owner's
 * Slack workspace.
 *
 * **The credential never appears in a thrown message** — same rule, and same
 * reason, as `apps/desktop/src/plowApi.ts`: these errors are read by humans in
 * the approval dialog and written to the audit log.
 */
import { JSONValue } from "@domo/protocol";

/** A connector call failed. Message is safe to display and to log. */
export class ConnectorError extends Error {}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ConnectorClient {
  /** POST one Slack action, e.g. `messages.send`. */
  call(action: string, body: JSONValue): Promise<JSONValue>;
  /** GET the connector's status — the only route that takes no body. */
  status(): Promise<JSONValue>;
}

/** How long any one connector call may take before it is a failure. */
export const CONNECTOR_TIMEOUT_MS = 15_000;

export function makeConnectorClient(opts: {
  apiBaseUrl: string;
  credential: () => string;
  fetchImpl?: FetchLike;
}): ConnectorClient {
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const base = opts.apiBaseUrl.replace(/\/+$/, "");

  const request = async (path: string, init: RequestInit): Promise<JSONValue> => {
    const credential = opts.credential().trim();
    if (!credential) throw new ConnectorError("this Mac is not paired with Plow");
    const url = `${base}${path}`;
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(CONNECTOR_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ConnectorError(`could not reach Plow: ${(e as Error).message}`);
    }
    if (!response.ok) {
      // Status only. A body can echo request content, and the request carried
      // the header we must never surface.
      throw new ConnectorError(`Plow returned ${response.status} for ${path}`);
    }
    try {
      return (await response.json()) as JSONValue;
    } catch {
      // Same rule as the !response.ok branch, and for the same reason: a
      // malformed body must not reach the message, and neither should the
      // parser's own error text — V8 embeds a snippet of the body in it.
      throw new ConnectorError(`Plow returned an unparsable response for ${path}`);
    }
  };

  return {
    call: (action, body) =>
      request(`/v1/connectors/slack/${action}`, { method: "POST", body: JSON.stringify(body) }),
    status: () => request("/v1/connectors/slack/status", { method: "GET" }),
  };
}
