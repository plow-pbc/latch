/**
 * Minting a vendored provider's short-lived token from Plow.
 *
 * One authenticated call, to one route out of a closed table. It is
 * deliberately not a general connector client: the CLI talks to the provider
 * directly, so the only thing this Mac asks Plow for is the token.
 *
 * **Nothing that comes back is ever quoted.** The response carries a live
 * credential, so a failure names the provider and the status and nothing else
 * — no body, no parser message (V8 embeds a snippet of the input in those),
 * no header. That is a property of this module, not a promise its callers
 * keep: every message here is built from a fixed vocabulary.
 */
import { JSONValue, jv } from "@domo/protocol";
import type { VendoredProvider } from "./registry.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** How long the mint may take before it is a failure. */
export const MINT_TIMEOUT_MS = 15_000;

/** A mint failed. Every message is safe to display, log and audit. */
export class MintError extends Error {
  private constructor(message: string) {
    super(message);
    this.name = "MintError";
  }

  static unpaired(): MintError {
    return new MintError("this Mac is not paired with Plow");
  }
  static unreachable(provider: string): MintError {
    return new MintError(`could not reach Plow to authorise ${provider}`);
  }
  static timedOut(provider: string): MintError {
    return new MintError(`Plow did not answer in time to authorise ${provider}`);
  }
  static httpStatus(provider: string, status: number): MintError {
    return new MintError(`Plow returned ${status} authorising ${provider}`);
  }
  /** Covers absent AND unusable — "did not return" would be false for the latter. */
  static noToken(provider: string): MintError {
    return new MintError(`Plow did not return a usable token for ${provider}`);
  }

  /**
   * A 2xx whose body would not parse. Its own sentence because reusing
   * `httpStatus` here reports "Plow returned 200 authorising gog" — naming the
   * success as the failure, and hiding that the body was the fault. The
   * parser's own message is never quoted: V8 embeds a snippet of the input,
   * and the input is a response that carries a credential.
   */
  static unreadable(provider: string): MintError {
    return new MintError(`Plow's answer authorising ${provider} could not be read`);
  }
}

/**
 * `AbortSignal.timeout` aborts with a `TimeoutError`; some runtimes surface it
 * as a plain `AbortError`, so both count.
 */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  return name === "TimeoutError" || name === "AbortError";
}

export interface Minter {
  /**
   * The provider's short-lived token for the owner's connected account.
   *
   * Which account that is stays Plow's answer: it resolves the default
   * connected one server-side, so this Mac holds no second copy of a fact the
   * server owns and the two cannot disagree.
   */
  mint(provider: VendoredProvider): Promise<string>;
}

export function makeMinter(opts: {
  apiBaseUrl: string;
  /**
   * Read on EVERY call rather than captured: re-pairing has to take effect on
   * the next command, not the next launch. A captured string keeps sending a
   * stale credential until the app relaunches, which reads as a server problem
   * rather than a not-yet-re-paired Mac.
   */
  credential: () => string;
  fetchImpl?: FetchLike;
}): Minter {
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const base = opts.apiBaseUrl.replace(/\/+$/, "");

  return {
    async mint(provider) {
      const credential = opts.credential().trim();
      if (!credential) throw MintError.unpaired();

      let response: Response;
      try {
        // Both halves of the URL are literals off the provider's own row —
        // never composed from anything a caller supplied.
        response = await doFetch(`${base}${provider.mintPrefix}${provider.mintAction}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
          // No account: Plow resolves the owner's default connected one.
          body: "{}",
          signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
        });
      } catch (e) {
        throw isTimeout(e)
          ? MintError.timedOut(provider.command)
          : MintError.unreachable(provider.command);
      }
      if (!response.ok) throw MintError.httpStatus(provider.command, response.status);

      let decoded: JSONValue;
      try {
        decoded = (await response.json()) as JSONValue;
      } catch {
        throw MintError.unreadable(provider.command);
      }
      const token = jv(decoded).get("data").get("access_token").str;
      if (token === null || token.trim() === "") throw MintError.noToken(provider.command);
      return token;
    },
  };
}
