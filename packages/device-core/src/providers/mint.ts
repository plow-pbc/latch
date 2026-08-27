/**
 * What a vendored provider CLI needs in order to be authorised.
 *
 * The INTERFACE only. The transport is `PlowApi`'s — bearer auth in a header
 * and nowhere else, a bounded request, and a response that repeats its own
 * credential never reaching the screen. A second HTTP client here would have
 * been a second copy of all three, and those are exactly the properties that
 * must not drift.
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

  /**
   * The mint did not yield a usable token. `detail` comes from `PlowApi`,
   * which composes its own messages under the same no-foreign-text rule — a
   * raw response body never reaches here.
   */
  static failed(provider: string, detail: string): MintError {
    return new MintError(`could not authorise ${provider}: ${detail}`);
  }
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
