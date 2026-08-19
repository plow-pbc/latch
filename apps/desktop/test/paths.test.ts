/**
 * One folder per instance. resolveInstancePaths decides where an instance
 * keeps ALL of its state — the home and, inside it, Chromium's
 * userData/sessionData — and what it calls itself on screen. These are the
 * contracts that keep the packaged install, per-branch dev runs, and
 * throwaway test homes from ever sharing a folder.
 *
 * The app is called **Plow Latch** on screen, and its home moved from "Domo"
 * to "Plow-Latch". `legacyHome` names the old folder so startup can move it
 * wholesale (migrateHome.test.ts covers the move itself); everything an
 * install is — relay credential, device keypair and the rule keys derived
 * from it, audit log, vault ciphertext — travels inside the folder or keys on
 * the frozen Keychain identity, never on the folder's name.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInstancePaths } from "../src/paths.js";

const appData = "/Users/x/Library/Application Support";

describe("resolveInstancePaths", () => {
  it("packaged install (no env): the plain Plow-Latch home, unbranded, named Plow Latch", () => {
    const p = resolveInstancePaths({ env: {}, appData });
    expect(p.home).toBe(path.join(appData, "Plow-Latch"));
    expect(p.legacyHome).toBe(path.join(appData, "Domo"));
    expect(p.electronData).toBe(path.join(appData, "Plow-Latch", "electron"));
    expect(p.appName).toBe("Plow Latch");
    expect(p.trayTooltip).toBe("Plow Latch");
  });

  it("a from-source run: per-branch Plow-Latch-<branch> home, branded", () => {
    const p = resolveInstancePaths({ env: { DOMO_BRANCH: "feature-test" }, appData });
    expect(p.home).toBe(path.join(appData, "Plow-Latch-feature-test"));
    expect(p.legacyHome).toBe(path.join(appData, "Domo-feature-test"));
    expect(p.electronData).toBe(path.join(appData, "Plow-Latch-feature-test", "electron"));
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
    // A home that isn't "Plow-Latch"-named never had a Domo twin: no migration.
    expect(p.legacyHome).toBeUndefined();
    // Branding still shows the branch — the window a human sees should say
    // which checkout it came from even when the state was redirected.
    expect(p.appName).toBe("Plow Latch (feature-test)");
  });

  it("an explicit Plow-Latch-named DOMO_HOME still gets its Domo twin", () => {
    // `just app` always passes DOMO_HOME explicitly — the per-branch and
    // "-local" homes must migrate too, so the twin derives from the folder
    // name, not from how the home was chosen.
    const p = resolveInstancePaths({
      env: { DOMO_HOME: path.join(appData, "Plow-Latch-feature-test-local") },
      appData,
    });
    expect(p.legacyHome).toBe(path.join(appData, "Domo-feature-test-local"));
    // The prefix has to match as a whole word, not as a substring.
    const q = resolveInstancePaths({
      env: { DOMO_HOME: path.join(appData, "Plow-Latchery") },
      appData,
    });
    expect(q.legacyHome).toBeUndefined();
  });

  /** The vault key's identity is not the app's name, and must never become it. */
  it("carries a vault identity that no rename can move", () => {
    expect(resolveInstancePaths({ env: {}, appData }).vaultIdentity).toBe("Domo Desktop");
    expect(resolveInstancePaths({ env: { DOMO_BRANCH: "feature-test" }, appData }).vaultIdentity).toBe(
      "Domo Desktop (feature-test)",
    );
    // The display name moved on again, to "Plow Latch", and the home to
    // "Plow-Latch"; the vault's key identity did not, and that is what keeps
    // existing ciphertext readable. Whatever the app is called this month,
    // the identity must never drift toward the name or the home.
    const p = resolveInstancePaths({ env: {}, appData });
    expect(p.appName).toBe("Plow Latch");
    expect(p.vaultIdentity).not.toContain(p.appName);
    expect(p.vaultIdentity).not.toContain("Plow");
    expect(p.vaultIdentity).not.toContain(path.basename(p.home));
  });

  it("a blank or whitespace DOMO_BRANCH means unbranded, like the packaged run", () => {
    const p = resolveInstancePaths({ env: { DOMO_BRANCH: "  " }, appData });
    expect(p.home).toBe(path.join(appData, "Plow-Latch"));
    expect(p.appName).toBe("Plow Latch");
  });
});
