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
  "messages.update": { method: "POST", segment: "messages.update" },
  "conversations.open": { method: "POST", segment: "conversations.open" },
} as const;

export type SlackAction = keyof typeof SLACK_ACTIONS;

/**
 * The actions out of `SLACK_ACTIONS` that act in the owner's name rather than
 * only reading — send, edit, or open a DM. This is consumed off-Mac from
 * `apps/desktop/src/viewModel.ts` to decide whether the consent card's
 * connected-account warning fires: deriving it from here, rather than
 * restating the three strings in a second package, means the table that IS
 * the security bound and the card that describes it cannot drift. See
 * `connectors.test.ts` for the check that every key in `SLACK_ACTIONS` is
 * accounted for as a read or a write.
 */
export const SLACK_WRITE_ACTIONS: ReadonlySet<SlackAction> = new Set([
  "messages.send",
  "messages.update",
  "conversations.open",
]);

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
  * How much of a leading fragment still counts as an echo. A partial echo is
  * still an echo: ten characters is what V8 quotes when it reports offending
  * input, and a Plow credential is opaque from its first character.
  */
const SECRET_HEAD = 10;

/**
 * Every string form of `secret` a response could carry it in.
 *
 * The literal, plus Base64 at all three byte alignments. Alignment matters
 * because Base64 encodes three bytes to four characters: a server that
 * encodes the token *standing alone* emits one character stream, and one that
 * encodes an envelope containing it — a reflected `Authorization: Bearer
 * <cred>` dump, where the seven bytes of `"Bearer "` leave the token at offset
 * 1 (mod 3) — emits a completely different one. Checking only the aligned form
 * misses two alignments out of three, which is a decodable credential reaching
 * the agent through the screen meant to stop it.
 *
 * Each alignment drops the characters that encode the padding prefix and the
 * trailing partial group, leaving the run that is stable wherever the token
 * sits. `REVIEW.md` puts a credential reaching the renderer "in any encoding"
 * in the carve-out; this is what "any" costs.
 *
 * Derived once per credential rather than per node: `carriesCredential` walks
 * an arbitrary-size decoded response — a `messages.list` body runs to
 * thousands of nodes — and the forms depend only on the secret.
 */
export function secretForms(secret: string): string[] {
  const trimmed = secret.trim();
  if (trimmed.length < SECRET_HEAD) return [];
  const forms = [trimmed];
  const raw = Buffer.from(trimmed, "utf8");
  for (let r = 0; r < 3; r++) {
    const b64 = Buffer.concat([Buffer.alloc(r), raw]).toString("base64").replace(/=+$/, "");
    const core = b64.slice(Math.ceil((r * 4) / 3), b64.length - 4);
    if (core.length >= SECRET_HEAD) {
      forms.push(core, core.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return forms;
}

/** Whether `text` carries any of `forms`, whole or as a leading fragment. */
function textCarries(text: string, forms: string[]): boolean {
  for (const form of forms) {
    if (text.includes(form)) return true;
    if (form.length > SECRET_HEAD && text.includes(form.slice(0, SECRET_HEAD))) return true;
  }
  return false;
}

/**
 * Whether `text` discloses `secret`, in any form `secretForms` knows.
 *
 * One predicate, two sinks — the adversarial reviewer screens model output
 * with it, the connector screens decoded responses. Short secrets are ignored
 * because a handful of characters matches ordinary prose.
 */
export function echoesSecret(text: string, secret: string): boolean {
  return textCarries(text, secretForms(secret));
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

  /**
   * Names neither the credential nor the value that carried it — the whole
   * point is that this string is safe to log, display and audit.
   */
  static echoedCredential(action: SlackAction): ConnectorError {
    return new ConnectorError(
      `Plow's answer to ${action} contained this Mac's credential and was discarded`,
    );
  }
}

/**
 * Whether a decoded response carries the credential anywhere inside it.
 *
 * The request sends a bearer credential and the answer is arbitrary JSON that
 * a tool hands straight to a hosted agent, so a server that ever echoed the
 * header — in a debug field, a reflected request dump, an error envelope —
 * would disclose it. `REVIEW.md` puts "a secret or credential reaching a log
 * line, an error string, a URL, the audit log, or the renderer — in any
 * encoding" in the carve-out where a check like this is the product, not bloat.
 *
 * Walks leaves rather than testing `JSON.stringify`, so an escaped or
 * split-across-fields occurrence is caught the same way a plain one is.
 */
function carriesCredential(value: JSONValue, forms: string[]): boolean {
  if (typeof value === "string") return textCarries(value, forms);
  if (Array.isArray(value)) return value.some((v) => carriesCredential(v, forms));
  if (value !== null && typeof value === "object") {
    // KEYS as well as values. A reflected-request or debug envelope maps the
    // token TO metadata — `{"tokens":{"<credential>":{"remaining":5}}}` — so a
    // value-only walk skips half the string positions in the decoded body, and
    // this check's whole premise is that it is complete.
    return Object.entries(value).some(
      ([k, v]) => textCarries(k, forms) || carriesCredential(v as JSONValue, forms),
    );
  }
  return false;
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
      if (!Object.hasOwn(SLACK_ACTIONS, action)) throw ConnectorError.unknownAction();
      const route = SLACK_ACTIONS[action];
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
      let decoded: JSONValue;
      try {
        decoded = (await response.json()) as JSONValue;
      } catch {
        // The parser's own message is foreign text too — V8 embeds a snippet of
        // the body in it.
        throw ConnectorError.unreadable(action);
      }
      if (carriesCredential(decoded, secretForms(credential)))
        throw ConnectorError.echoedCredential(action);
      return decoded;
    },
  };
}
