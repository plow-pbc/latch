/**
 * The HTTPS seam to Plow's connector API.
 *
 * Slack's own OAuth token never reaches this Mac. Plow holds it server-side and
 * this client calls the connector route with the *device's* Plow credential, so
 * a compromised Mac yields a revocable Plow credential rather than the owner's
 * Slack workspace.
 *
 * Two guarantees hold **by construction** here, because neither survived being
 * left to a call site's memory:
 *
 *  - **A route is never composed from caller text.** `SLACK_ACTIONS` is the
 *    entire set of routes this Mac can reach, and a request is built from that
 *    table's own literals or not at all. An action is a key lookup, so "../",
 *    "?" and "#" are not traversal, query and fragment — they are simply not
 *    keys. This matters because the device credential carries `relay:device`
 *    and `llm:chat`: which route it reaches is a privilege boundary, not a
 *    formatting detail.
 *  - **No foreign text reaches a message.** `ConnectorError`'s constructor is
 *    private and every message is composed by one of its factories from a fixed
 *    vocabulary — a status number, an action out of the table, a
 *    timeout/unreachable classification. A call site *cannot* interpolate the
 *    credential, a response body, a parser's error text or an injected fetch's
 *    error text, because it cannot build the error at all. Same rule, and same
 *    reason, as `apps/desktop/src/plowApi.ts`: these messages are read by
 *    humans in the approval dialog and written to the append-only audit log.
 */
import { JSONValue } from "@domo/protocol";

/** Where every connector route hangs. A literal, joined to a literal. */
const SLACK_ROUTE_PREFIX = "/v1/connectors/slack/";

/**
 * Every Slack action this Mac can perform, with the path segment and method
 * each one takes. THIS TABLE IS THE CLOSED SET — the security bound of the
 * `tool` capability kind, and the only source of a URL below.
 *
 * The method belongs in it too: `status` is the one route that takes no body,
 * and that is this table's knowledge rather than a branch at each call site.
 */
export const SLACK_ACTIONS = {
  status: { method: "GET", segment: "status" },
  "channels.list": { method: "POST", segment: "channels.list" },
  "users.list": { method: "POST", segment: "users.list" },
  "messages.list": { method: "POST", segment: "messages.list" },
  "messages.search": { method: "POST", segment: "messages.search" },
  "messages.send": { method: "POST", segment: "messages.send" },
} as const;

export type SlackAction = keyof typeof SLACK_ACTIONS;

/** The prefix a `tool` capability's name carries. */
const SLACK_TOOL_PREFIX = "slack.";

/**
 * The action a `tool` capability names, or null when it names none.
 *
 * The single place free text becomes an action, so also the single place that
 * could be wrong. A `startsWith` test was not one: it admitted every suffix,
 * and the suffix went on to become a URL.
 */
export function slackAction(tool: string): SlackAction | null {
  if (!tool.startsWith(SLACK_TOOL_PREFIX)) return null;
  const action = tool.slice(SLACK_TOOL_PREFIX.length);
  return Object.hasOwn(SLACK_ACTIONS, action) ? (action as SlackAction) : null;
}

/**
 * A connector call failed. Every message is safe to display and to log because
 * every message is built here — see the file header.
 */
export class ConnectorError extends Error {
  private constructor(message: string) {
    super(message);
    this.name = "ConnectorError";
  }

  /** No credential to call with: never paired, or signed out since. */
  static unpaired(): ConnectorError {
    return new ConnectorError("this Mac is not paired with Plow");
  }

  /** A `tool` capability naming something outside `SLACK_ACTIONS`. The name is
   * deliberately NOT echoed: it is the caller's text, and this sentence is read
   * by the owner. */
  static unknownAction(): ConnectorError {
    return new ConnectorError("not a Slack action this Mac can perform");
  }

  /** Plow took the request and went quiet. Told apart from `unreachable`
   * because the two send someone to fix different things. */
  static timedOut(action: SlackAction): ConnectorError {
    return new ConnectorError(`Plow did not answer in time for ${action}`);
  }

  static unreachable(action: SlackAction): ConnectorError {
    return new ConnectorError(`could not reach Plow for ${action}`);
  }

  static httpStatus(action: SlackAction, status: number): ConnectorError {
    return new ConnectorError(`Plow returned ${status} for ${action}`);
  }

  static unreadable(action: SlackAction): ConnectorError {
    return new ConnectorError(`Plow returned an unreadable response for ${action}`);
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ConnectorClient {
  /** Run one action from the closed set. `body` is ignored by a GET route. */
  call(action: SlackAction, body: JSONValue): Promise<JSONValue>;
}

/** How long any one connector call may take before it is a failure. */
export const CONNECTOR_TIMEOUT_MS = 15_000;

/**
 * `AbortSignal.timeout` aborts with a `TimeoutError`; some runtimes surface it
 * as a plain `AbortError`, so both count. Twin of the predicate in
 * `apps/desktop/src/plowApi.ts` — two packages, three lines, and no shared home
 * worth inventing for it.
 */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  return name === "TimeoutError" || name === "AbortError";
}

export function makeConnectorClient(opts: {
  apiBaseUrl: string;
  credential: () => string;
  fetchImpl?: FetchLike;
}): ConnectorClient {
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const base = opts.apiBaseUrl.replace(/\/+$/, "");

  return {
    async call(action: SlackAction, body: JSONValue): Promise<JSONValue> {
      // A caller that got here with something that is not an action came from
      // outside the type system (untyped JS, a wire value). There is no route
      // to build, so there is no request.
      const route = SLACK_ACTIONS[action];
      if (route === undefined) throw ConnectorError.unknownAction();
      const credential = opts.credential().trim();
      if (!credential) throw ConnectorError.unpaired();

      const headers: Record<string, string> = { Authorization: `Bearer ${credential}` };
      if (route.method !== "GET") headers["Content-Type"] = "application/json";
      let response: Response;
      try {
        response = await doFetch(`${base}${SLACK_ROUTE_PREFIX}${route.segment}`, {
          method: route.method,
          headers,
          body: route.method === "GET" ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(CONNECTOR_TIMEOUT_MS),
        });
      } catch (e) {
        throw isTimeout(e) ? ConnectorError.timedOut(action) : ConnectorError.unreachable(action);
      }
      // Status only. A body can echo request content, and the request carried
      // the header we must never surface.
      if (!response.ok) throw ConnectorError.httpStatus(action, response.status);
      try {
        return (await response.json()) as JSONValue;
      } catch {
        // The parser's own message is foreign text too — V8 embeds a snippet of
        // the body in it.
        throw ConnectorError.unreadable(action);
      }
    },
  };
}
