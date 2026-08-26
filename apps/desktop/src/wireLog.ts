/**
 * A `fetch` that writes down what went over the wire.
 *
 * Kept from the throwaway card it was built for, because it is how we found two
 * things nothing else would have shown: prod serving the older tier-1 resource
 * shape, and a sandbox failure that surfaced only as a generic error. There is
 * no server-side request log we can read, so during the rollout this file is
 * the only account of what Plow was actually asked and what it actually said.
 *
 * It wraps the `FetchLike` the clients already take, so it adds nothing to
 * their code and can be unwired by deleting one argument at each construction.
 *
 * **It records no bodies.** Method, URL, status, elapsed ms, and an
 * unauthenticated failure's own `detail` sentence — that is the whole of it.
 * Riding the shared `PlowApi` means every authenticated chat and agent response
 * passes through here, and those carry participants' names and phone numbers
 * and session identities.
 * This file is meant to be pasted into a bug report, which is the worst
 * possible destination for someone else's phone number.
 *
 * **The credential never reaches it either.** The `Authorization` value is
 * recorded as its presence and nothing more. When it is present, response and
 * transport text are dropped outright rather than inspected for secret-shaped
 * substrings.
 */
import fs from "node:fs";
import path from "node:path";
import { FetchLike } from "./plowApi.js";

/** Past this, the log starts over. It is a rolling account, not an archive. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Where the raw wire log lands. */
export function wireLogPath(home: string): string {
  return path.join(home, "plow-wire.log");
}

export function loggingFetch(home: string, inner: FetchLike = fetch): FetchLike {
  return async (url, init) => {
    const started = Date.now();
    const authenticated = hasBearer(init?.headers);
    const entry: Record<string, unknown> = {
      at: new Date(started).toISOString(),
      method: init?.method ?? "GET",
      url,
      // Presence, never the value.
      authorization: authenticated ? "bearer present" : "none",
    };
    try {
      const response = await inner(url, init);
      append(home, {
        ...entry,
        status: response.status,
        detail: await errorDetail(response, authenticated),
        elapsedMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      append(home, {
        ...entry,
        status: null,
        error: authenticated ? null : String((error as { message?: unknown })?.message ?? error),
        elapsedMs: Date.now() - started,
      });
      throw error;
    }
  };
}

function append(home: string, entry: Record<string, unknown>): void {
  try {
    const file = wireLogPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Unbounded growth on someone's Mac is a defect, not a feature. Starting
    // over beats rotation here: what matters is the recent exchanges.
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) {
      fs.writeFileSync(file, "", { mode: 0o600 });
    }
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    // A log that cannot be written must not take the request down with it.
  }
}

/** Whether the request carries a bearer credential. Its value is never read. */
function hasBearer(headers: HeadersInit | undefined): boolean {
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has("authorization");
  if (Array.isArray(headers)) {
    return headers.some(([name]) => name.toLowerCase() === "authorization");
  }
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

/**
 * An unauthenticated server's sentence about a failure, and nothing else from
 * the body. Authenticated response text is never recorded.
 *
 * This is the one thing worth keeping out of a response: every shape mismatch
 * and server failure we chased today showed up in `detail`, and it is written
 * by the API team for a human to read. A 404 uses a different envelope from
 * every other error, so both are read.
 *
 * Successful bodies are never touched. That is where the chat records live —
 * participants' names and phone numbers, session identities — and this file is
 * meant to be pasted into a bug report.
 */
async function errorDetail(response: Response, authenticated: boolean): Promise<string | null> {
  if (response.ok || authenticated) return null;
  try {
    // `clone()` so the client still gets an unread body.
    const decoded: unknown = await response.clone().json();
    if (!decoded || typeof decoded !== "object") return null;
    const record = decoded as Record<string, unknown>;
    if (typeof record.detail === "string") return record.detail;
    const wrapped = record.error;
    if (wrapped && typeof wrapped === "object") {
      const message = (wrapped as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    return null;
  } catch {
    return null;
  }
}
