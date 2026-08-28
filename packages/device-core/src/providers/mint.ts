/**
 * What a vendored provider CLI needs in order to be authorised.
 *
 * The INTERFACE only. The transport is `PlowApi`'s — bearer auth in a header
 * and nowhere else, a bounded request, and a response that repeats its own
 * credential never reaching the screen. A second HTTP client would be a second
 * copy of exactly the three properties that must not drift.
 */
import type { VendoredProvider } from "./registry.js";

/** A mint failed. Every message is safe to display, log and audit. */
export class MintError extends Error {
  private constructor(message: string) {
    super(message);
    this.name = "MintError";
  }

  static unpaired(): MintError {
    return new MintError("this Mac is not paired with Plow");
  }

  /** The mint did not yield a usable token. `detail` comes from `PlowApi`,
   * which composes its own messages under the same no-foreign-text rule — a
   * raw response body never reaches here. */
  static failed(provider: string, detail: string): MintError {
    return new MintError(`could not authorise ${provider}: ${detail}`);
  }
}

/**
 * Every connected account's short-lived token, from one batch mint.
 *
 * `degraded` is the accounts Plow could not mint for (revoked refresh token,
 * connector error) — listed so a fan-out can report partial coverage instead
 * of a false absence. `reason` is server-composed under the same
 * no-foreign-text rule as everything else that reaches a screen.
 */
export interface MintedAccounts {
  accounts: { account: string; token: string; isDefault: boolean }[];
  degraded: { account: string; reason: string }[];
}

export interface Minter {
  /**
   * The provider's short-lived token for the owner's connected account.
   *
   * Which account stays Plow's answer: it resolves the default connected one
   * server-side, so this Mac holds no second copy of a fact the server owns.
   */
  mint(provider: VendoredProvider): Promise<string>;
  /**
   * One token per connected account, for a multi-account provider's fan-out.
   * Same scope, same route as `mint` — the request just says `all`.
   */
  mintAll(provider: VendoredProvider): Promise<MintedAccounts>;
}
