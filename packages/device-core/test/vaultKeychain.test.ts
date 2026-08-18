/**
 * The vault's Keychain identity is frozen, and not the app's name.
 *
 * The regression: `safeStorage` keys on `app.name`, so renaming the app to
 * "Plow" pointed it at a Keychain item that had never existed and every vault
 * account on disk stopped decrypting. These tests fail the moment someone
 * "tidies" the constant to match whatever the product is called — which is the
 * exact change that caused the outage.
 */
import { describe, expect, it } from "vitest";
import { VAULT_STORE_IDENTITY, vaultStoreIdentity } from "../src/browser/vaultKeychain.js";

describe("the frozen vault storage identity", () => {
  it("is the OLD app name, on purpose — every existing vault is encrypted under it", () => {
    expect(VAULT_STORE_IDENTITY).toBe("Domo Desktop");
  });

  it("is not the product name, and must never be tidied into it", () => {
    expect(VAULT_STORE_IDENTITY).not.toMatch(/plow/i);
  });

  it("keeps per-worktree separation with a branch suffix", () => {
    expect(vaultStoreIdentity()).toBe("Domo Desktop");
    expect(vaultStoreIdentity("  ")).toBe("Domo Desktop");
    expect(vaultStoreIdentity("feature-test")).toBe("Domo Desktop (feature-test)");
  });
});
