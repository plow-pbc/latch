/**
 * One folder per instance. resolveInstancePaths decides where an instance
 * keeps ALL of its state — the home and, inside it, Chromium's
 * userData/sessionData — and what it calls itself on screen. These are the
 * contracts that keep the packaged install, per-branch dev runs, and
 * throwaway test homes from ever sharing a folder.
 *
 * Note the split these assertions pin down: the app is called **Plow Latch**
 * on
 * screen, and its home on disk is still **Domo**. Renaming the folder would
 * strand the relay credential, the device keypair — which invalidates every
 * always-allow rule, since rule keys are derived from it — the audit log and
 * the vault. That is a migration, not a rename.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInstancePaths } from "../src/paths.js";

const appData = "/Users/x/Library/Application Support";

describe("resolveInstancePaths", () => {
  it("packaged install (no env): the plain Domo home, unbranded, named Plow Latch", () => {
    const p = resolveInstancePaths({ env: {}, appData });
    expect(p.home).toBe(path.join(appData, "Domo"));
    expect(p.electronData).toBe(path.join(appData, "Domo", "electron"));
    expect(p.appName).toBe("Plow Latch");
    expect(p.trayTooltip).toBe("Plow Latch");
  });

  it("a from-source run: per-branch Domo-<branch> home, branded", () => {
    const p = resolveInstancePaths({ env: { DOMO_BRANCH: "feature-test" }, appData });
    expect(p.home).toBe(path.join(appData, "Domo-feature-test"));
    expect(p.electronData).toBe(path.join(appData, "Domo-feature-test", "electron"));
    expect(p.appName).toBe("Plow Latch (feature-test)");
    expect(p.trayTooltip).toBe("Plow Latch (feature-test)");
  });

  it("DOMO_HOME wins, and Chromium state follows it into the same folder", () => {
    const p = resolveInstancePaths({
      env: { DOMO_HOME: "/tmp/throwaway", DOMO_BRANCH: "feature-test" },
      appData,
    });
    expect(p.home).toBe("/tmp/throwaway");
    expect(p.electronData).toBe(path.join("/tmp/throwaway", "electron"));
    // Branding still shows the branch — the window a human sees should say
    // which checkout it came from even when the state was redirected.
    expect(p.appName).toBe("Plow Latch (feature-test)");
  });

  /** The vault key's identity is not the app's name, and must never become it. */
  it("carries a vault identity that no rename can move", () => {
    expect(resolveInstancePaths({ env: {}, appData }).vaultIdentity).toBe("Domo Desktop");
    expect(resolveInstancePaths({ env: { DOMO_BRANCH: "feature-test" }, appData }).vaultIdentity).toBe(
      "Domo Desktop (feature-test)",
    );
    // The display name moved on again, to "Plow Latch"; the vault's key identity
    // did not, and
    // that is what keeps existing ciphertext readable.
    expect(resolveInstancePaths({ env: {}, appData }).vaultIdentity).not.toContain("Plow");
    expect(resolveInstancePaths({ env: {}, appData }).appName).toBe("Plow Latch");
  });

  it("a blank or whitespace DOMO_BRANCH means unbranded, like the packaged run", () => {
    const p = resolveInstancePaths({ env: { DOMO_BRANCH: "  " }, appData });
    expect(p.home).toBe(path.join(appData, "Domo"));
    expect(p.appName).toBe("Plow Latch");
  });
});
