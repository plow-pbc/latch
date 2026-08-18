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
import {
  VAULT_STORE_IDENTITY,
  bindVaultKeychainIdentity,
  vaultStoreIdentity,
} from "../src/browser/vaultKeychain.js";

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

describe("binding safeStorage to it", () => {
  it("latches under the frozen identity and puts the display name back", () => {
    const seen: string[] = [];
    let latchedUnder = "";
    let name = "Plow (main)";
    bindVaultKeychainIdentity(
      {
        get name() { return name; },
        setName: (n) => { name = n; seen.push(n); },
        latch: () => { latchedUnder = name; },
      },
      vaultStoreIdentity("main"),
    );
    // The key comes from the frozen identity...
    expect(latchedUnder).toBe("Domo Desktop (main)");
    // ...and the menu bar, dock and window titles never see the swap.
    expect(name).toBe("Plow (main)");
    expect(seen).toEqual(["Domo Desktop (main)", "Plow (main)"]);
  });

  it("restores the display name even if latching throws", () => {
    let name = "Plow";
    expect(() =>
      bindVaultKeychainIdentity(
        {
          get name() { return name; },
          setName: (n) => { name = n; },
          latch: () => { throw new Error("no secure storage here"); },
        },
        "Domo Desktop",
      ),
    ).toThrow();
    expect(name).toBe("Plow");
  });
});
