/**
 * Launch at Login — the decision layer between Electron's login-item API and
 * the Settings toggle, pure over an injected seam (like updates.ts) so its
 * rules are unit-testable without Electron.
 *
 * There is deliberately NO settings.json field behind this. macOS owns the
 * bit: System Settings → General → Login Items can flip it while the app
 * isn't even running, and no event tells the app when that happens — a stored
 * mirror could only drift. So every read asks the OS fresh (the same reason
 * `capabilities:get` re-probes Full Disk Access) and a write reports back
 * what the OS then holds, not what was asked for.
 * (`Settings.launchAtLoginDefaulted` is not that field: it records that the
 * one-time first-run default — onboarding.ts's `applyAvailabilityDefault` —
 * has run, never what the bit is.)
 *
 * Only the packaged install is supported. A from-source run is the stock
 * Electron.app bundle, so registering it would enroll the development binary
 * as a login item — one per worktree, each pointing at a checkout that may
 * not build tomorrow. The renderer fades the toggle, but the refusal lives
 * HERE, where a replayed IPC call hits it and a test can prove it.
 */

/** The slice of Electron's `app` this module drives. */
export interface LoginItemApi {
  /** `app.getLoginItemSettings()` — what the OS holds right now. */
  get(): { openAtLogin: boolean };
  /** `app.setLoginItemSettings(...)` — ask the OS to register/deregister. */
  set(settings: { openAtLogin: boolean }): void;
}

/** The whole state the Settings pane renders from, one shape per read. */
export interface LaunchAtLoginState {
  /** False in a from-source run; the toggle explains itself instead. */
  supported: boolean;
  openAtLogin: boolean;
}

export function launchAtLoginState(supported: boolean, api: LoginItemApi): LaunchAtLoginState {
  // Unsupported short-circuits the read too: what the OS would report for the
  // dev binary is about the dev binary, and showing it here would be a lie
  // about the app.
  return { supported, openAtLogin: supported && api.get().openAtLogin };
}

/**
 * Set the toggle. Refused (not merely hidden) when unsupported, and the
 * answer is always a fresh read — if the OS declined, the pane shows that.
 */
export function setLaunchAtLogin(
  supported: boolean,
  api: LoginItemApi,
  on: unknown,
): LaunchAtLoginState {
  if (supported) api.set({ openAtLogin: !!on });
  return launchAtLoginState(supported, api);
}
