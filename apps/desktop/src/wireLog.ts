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
 * **It records no bodies or server-authored text.** Method, URL, status, and
 * elapsed ms are the whole of it.
 * Riding the shared `PlowApi` means every authenticated chat and agent response
 * passes through here, and those carry participants' names and phone numbers
 * and session identities.
 * This file is meant to be pasted into a bug report, which is the worst
 * possible destination for someone else's phone number.
 *
 * **The credential never reaches it either.** `Authorization` is neither
 * inspected nor recorded.
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
    const entry: Record<string, unknown> = {
      at: new Date(started).toISOString(),
      method: init?.method ?? "GET",
      url,
    };
    try {
      const response = await inner(url, init);
      append(home, {
        ...entry,
        status: response.status,
        elapsedMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      append(home, {
        ...entry,
        status: null,
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
