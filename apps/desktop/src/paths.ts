/**
 * Where one instance of the app keeps ALL of its state, and what it calls
 * itself on screen. Pure so it is unit-testable without Electron
 * (paths.test.ts); main.ts feeds it process.env and app.getPath("appData").
 *
 * One folder per instance: everything — settings, device identity, audit log,
 * AND Electron/Chromium's own state (userData/sessionData) — lives under a
 * single home in Application Support. Chromium state goes in `<home>/electron`
 * instead of the separate name-keyed "Domo Desktop*" folder Electron would
 * pick on its own.
 *
 * DOMO_BRANCH (set by `just app` to this checkout's normalized branch name,
 * never set in a packaged run) picks the per-branch home "Domo-<branch>" and
 * brands the instance so from-source runs never collide with each other or
 * with the packaged install, which runs unbranded from the plain "Domo" home.
 * An explicit DOMO_HOME wins over both, and Chromium state follows it, so a
 * throwaway home really is the instance's ONLY folder.
 */
import path from "node:path";

export interface InstancePaths {
  /** macOS app menu / dock title (set before ready via app.setName). */
  appName: string;
  /** Menu-bar (tray) tooltip. */
  trayTooltip: string;
  /** DOMO_HOME — settings, device identity, audit log. */
  home: string;
  /** Electron userData AND sessionData — Chromium's state, inside the home. */
  electronData: string;
}

export function resolveInstancePaths(opts: {
  env: Record<string, string | undefined>;
  appData: string;
}): InstancePaths {
  const branch = (opts.env.DOMO_BRANCH ?? "").trim();
  const home =
    opts.env.DOMO_HOME ?? path.join(opts.appData, branch ? `Domo-${branch}` : "Domo");
  return {
    appName: branch ? `Domo Desktop (${branch})` : "Domo Desktop",
    trayTooltip: branch ? `Domo (${branch})` : "Domo",
    home,
    electronData: path.join(home, "electron"),
  };
}
