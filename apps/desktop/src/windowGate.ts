/**
 * The login gate: which window this Mac is allowed to have open.
 *
 * The rule is a product decision, not a UI detail — **a Mac that is not signed
 * in to the Plow relay is not usable.** Before this existed, login gated
 * nothing: the main window opened regardless and a setup window floated beside
 * it, so the app looked functional while no agent could reach it and nothing in
 * it could be done.
 *
 * It lives here, outside `main.ts`, for the same reason `viewModel.ts` and
 * `onboarding.ts` do: window orchestration is the one part of this that has
 * real states and transitions, and a rule that can only be exercised by
 * launching Electron is a rule nobody can test. `GateHost` is the whole
 * Electron surface it needs — four verbs and three questions.
 */

/** Which window belongs on screen. Exactly one, always. */
export type GateWindow = "main" | "setup";

/** The only thing the decision depends on. */
export function gateTarget(hasCredential: boolean): GateWindow {
  return hasCredential ? "main" : "setup";
}

export interface GateHost {
  /** Read from settings every time — sign-in and sign-out both change it. */
  hasCredential(): boolean;
  isMainOpen(): boolean;
  isSetupOpen(): boolean;
  /** Both open verbs must be safe to call on an already-open window (they
   * show/focus it), because `sync` is called on every transition. */
  openMain(): void;
  openSetup(): void;
  closeMain(): void;
  closeSetup(): void;
  /** Quit the whole app. Only ever called for a gate closed with no credential. */
  quit(): void;
}

export class WindowGate {
  constructor(private readonly host: GateHost) {}

  /**
   * Put the right window on screen and take the other one off.
   *
   * Called at launch, when login completes, and on sign-out. Idempotent: a
   * second call with nothing changed opens nothing and closes nothing, so it is
   * safe on `activate` and from the tray.
   *
   * The window that should be open is opened *first*. Closing first would leave
   * a beat with no window at all, and on macOS that is the moment the app looks
   * quit — and, for the setup window, the moment the gate's own
   * close-means-quit rule would fire.
   */
  sync(): GateWindow {
    const target = gateTarget(this.host.hasCredential());
    if (target === "main") {
      this.host.openMain();
      if (this.host.isSetupOpen()) this.host.closeSetup();
    } else {
      this.host.openSetup();
      if (this.host.isMainOpen()) this.host.closeMain();
    }
    return target;
  }

  /**
   * The setup window closed. What that means depends on which side of the gate
   * the Mac is on, and getting it wrong strands the user either way.
   *
   * **No credential — closing the gate is quitting.** There is no window behind
   * it and no way to get one without signing in, so staying resident would
   * leave a tray icon attached to an app that can do nothing.
   *
   * **Signed in — hand over to the app**, exactly as the Continue button does.
   * The window that just closed was the "This Mac is connected" confirmation:
   * the credential is already saved and the socket is already up, so the user
   * is past the gate and the main window is what they should be looking at.
   *
   * The third possibility — do nothing — is what shipped in the first cut, and
   * it leaves a Mac that has just been set up showing no window at all. Quitting
   * instead would be worse than either: Domo is a menu-bar agent, closing a
   * window is not quitting it, and an exit here would take the relay socket down
   * with it and quietly make the Mac the user just connected unreachable.
   */
  setupClosed(): "quit" | GateWindow {
    if (!this.host.hasCredential()) {
      this.host.quit();
      return "quit";
    }
    return this.sync();
  }
}
