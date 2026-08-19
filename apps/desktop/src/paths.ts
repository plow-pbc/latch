/**
 * Where one instance of the app keeps ALL of its state, and what it calls
 * itself on screen. Pure so it is unit-testable without Electron
 * (paths.test.ts); main.ts feeds it process.env and app.getPath("appData").
 *
 * One folder per instance: everything — settings, device identity, audit log,
 * AND Electron/Chromium's own state (userData/sessionData) — lives under a
 * single home in Application Support. Chromium state goes in `<home>/electron`
 * instead of the separate name-keyed "Plow Latch*" folder Electron would
 * pick on its own.
 *
 * DOMO_BRANCH (set by `just app` to this checkout's normalized branch name,
 * never set in a packaged run) picks the per-branch home "Plow-Latch-<branch>"
 * and brands the instance so from-source runs never collide with each other or
 * with the packaged install, which runs unbranded from the plain "Plow-Latch"
 * home. An explicit DOMO_HOME wins over both, and Chromium state follows it,
 * so a throwaway home really is the instance's ONLY folder.
 *
 * The home was called "Domo" (and "Domo-<branch>") before the product became
 * Plow Latch. `legacyHome` is where that older install would be — the same folder
 * name with "Domo" in place of "Plow-Latch" — so startup can move it to the new
 * name before anything opens it (migrateHome.ts). A home whose folder name
 * isn't "Plow-Latch"-prefixed (an explicit throwaway DOMO_HOME) has no legacy
 * twin and is never migrated.
 */
import path from "node:path";
import { vaultStoreIdentity } from "@domo/device-core";

const HOME_PREFIX = "Plow-Latch";
const LEGACY_HOME_PREFIX = "Domo";

export interface InstancePaths {
  /** macOS app menu / dock title (set before ready via app.setName). */
  appName: string;
  /** Menu-bar (tray) tooltip. */
  trayTooltip: string;
  /** DOMO_HOME — settings, device identity, audit log. */
  home: string;
  /** The pre-rename "Domo…" twin of `home`, if `home` has one, to migrate from. */
  legacyHome: string | undefined;
  /** Electron userData AND sessionData — Chromium's state, inside the home. */
  electronData: string;
  /**
   * The Keychain identity the vault account's encryption is bound to. NOT the
   * app name: `safeStorage` keys on `app.name`, and binding a secret to a
   * display string is what made an app rename unreadable. See vaultKeychain.ts.
   */
  vaultIdentity: string;
}

/** The "Domo…" sibling this home would have been called before the rename. */
function legacyHomeFor(home: string): string | undefined {
  const base = path.basename(home);
  if (base !== HOME_PREFIX && !base.startsWith(`${HOME_PREFIX}-`)) return undefined;
  return path.join(path.dirname(home), LEGACY_HOME_PREFIX + base.slice(HOME_PREFIX.length));
}

export function resolveInstancePaths(opts: {
  env: Record<string, string | undefined>;
  appData: string;
}): InstancePaths {
  const branch = (opts.env.DOMO_BRANCH ?? "").trim();
  const home =
    opts.env.DOMO_HOME ??
    path.join(opts.appData, branch ? `${HOME_PREFIX}-${branch}` : HOME_PREFIX);
  return {
    appName: branch ? `Plow Latch (${branch})` : "Plow Latch",
    trayTooltip: branch ? `Plow Latch (${branch})` : "Plow Latch",
    home,
    legacyHome: legacyHomeFor(home),
    electronData: path.join(home, "electron"),
    vaultIdentity: vaultStoreIdentity(branch),
  };
}
