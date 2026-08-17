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
}
