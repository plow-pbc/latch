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
 * **The credential never reaches it.** The `Authorization` value is recorded as
 * its presence and nothing more, and it is scrubbed out of the URL and both
 * bodies before anything is written — this file is meant to be pasted into a
 * bug report, so it is the one place a leak would travel furthest.
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
    const secret = bearerOf(init?.headers);
    const entry: Record<string, unknown> = {
      at: new Date(started).toISOString(),
      method: init?.method ?? "GET",
      url: scrub(url, secret),
      // Presence, never the value.
      authorization: secret ? "bearer present" : "none",
      requestBody: decodeBody(typeof init?.body === "string" ? init.body : null, secret),
    };
    try {
      const response = await inner(url, init);
      // `clone()` so the client still gets an unread body.
      const text = await response
        .clone()
        .text()
        .catch(() => "");
      append(home, {
        ...entry,
        status: response.status,
        responseBody: decodeBody(text, secret),
        elapsedMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      append(home, {
        ...entry,
        status: null,
        error: scrub(String((error as { message?: unknown })?.message ?? error), secret),
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

/** The bearer token, read only so it can be kept out of everything below. */
function bearerOf(headers: HeadersInit | undefined): string {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "";
  const value = (headers as Record<string, string>).authorization ?? "";
  return value.replace(/^Bearer\s+/i, "").trim();
}

/** JSON where it parses, the raw text where it does not — scrubbed either way. */
function decodeBody(raw: string | null, secret: string): unknown {
  if (raw === null || raw === "") return null;
  const cleaned = scrub(raw, secret);
  try {
    return JSON.parse(cleaned);
  } catch {
    return cleaned;
  }
}

/**
 * Take the credential back out of anything a server said.
 *
 * A response that echoes the token is exactly the case this guards: the file is
 * meant to be shared, so a leak here leaves the Mac entirely. The prefix match
 * catches a truncated echo — a key shown as its first characters is still the
 * first characters of a key.
 */
function scrub(text: string, secret: string): string {
  if (!secret) return text;
  let out = text.split(secret).join("[redacted]");
  if (secret.length > 10) out = out.split(secret.slice(0, 10)).join("[redacted]");
  return out;
}
