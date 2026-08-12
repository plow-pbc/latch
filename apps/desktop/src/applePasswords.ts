/**
 * Apple Passwords orchestration for the desktop app: owns the apw daemon +
 * pairing state, and points the device's credential switch at Apple Passwords
 * while the feature is enabled.
 *
 * Lifecycle (DESIGN.md §11a): pairing happens once per app launch — enable (or
 * launch with the setting on) starts the bundled apw daemon, asks macOS for
 * the pairing PIN dialog, and the user types that PIN into Settings. The
 * pairing lives exactly as long as the daemon, which lives exactly as long as
 * the app (or until the setting is turned off) — quitting unpairs.
 *
 * The credential switch flips to Apple Passwords as soon as the feature is
 * enabled, not when pairing completes: an unpaired daemon yields honest typed
 * errors ("pair it in Domo Settings"), never a silent fallback to 1Password
 * the user opted out of.
 *
 * Kept free of Electron imports so it is unit-testable headlessly.
 */
import {
  ApwCredentialBroker,
  ApwDaemon,
  ApwPairingState,
  CredentialError,
  CredentialSourceSwitch,
} from "@domo/device-core";
import { JSONValue } from "@domo/protocol";

export interface ApwWarmup {
  host: string;
  username: string;
}

export interface ApplePasswordsView {
  /** False when this build/install has no apw binary — the toggle is disabled. */
  available: boolean;
  enabled: boolean;
  state: ApwPairingState;
  detail: string;
}

export interface ApplePasswordsOptions {
  /** Argv for the bundled apw binary (ResolvedBrowserRuntime.apwCommand). */
  apwCommand: string[] | null;
  /** The device's credential switch (null when no browser runtime). */
  credentials: CredentialSourceSwitch | null;
  /** Read/write the persisted setting. */
  isEnabled: () => boolean;
  setEnabled: (on: boolean) => void;
  /** Read/write the remembered last release (host + username, never a secret)
   * used to front-load macOS's AutoFill consent right after pairing. */
  loadWarmup?: () => ApwWarmup | null;
  saveWarmup?: (warmup: ApwWarmup | null) => void;
  audit?: (event: string, fields: { [k: string]: JSONValue }) => void;
  /** Fired on every pairing-state change (push to the renderer). */
  onChange?: () => void;
  /** Test seams: apw daemon start timeout + pairing timing tuning. */
  startTimeoutMs?: number;
  startSettleMs?: number;
  pinRetryDelayMs?: number;
  pairProbeAttempts?: number;
  pairProbeIntervalMs?: number;
}

export class ApplePasswords {
  private daemon: ApwDaemon | null = null;
  private broker: ApwCredentialBroker | null = null;

  constructor(private readonly opts: ApplePasswordsOptions) {}

  view(): ApplePasswordsView {
    const status = this.daemon?.status() ?? { state: "stopped" as const, detail: "" };
    return {
      available: this.opts.apwCommand !== null && this.opts.credentials !== null,
      enabled: this.opts.isEnabled(),
      state: status.state,
      detail: status.detail,
    };
  }

  /** Launch path: start + pair if the persisted setting says so. Never throws
   * (a failed start lands in the error state for Settings to show). */
  async startIfEnabled(): Promise<void> {
    if (!this.opts.isEnabled() || !this.view().available) return;
    await this.enable(false);
  }

  /**
   * Turn the feature on (persisting the setting when `persist`): flip the
   * credential switch, start the daemon, and ask macOS for the PIN dialog.
   * Resolves when the flow reaches awaiting-pin (or error).
   */
  async enable(persist = true): Promise<void> {
    const { apwCommand, credentials } = this.opts;
    if (!apwCommand || !credentials) return;
    if (persist) this.opts.setEnabled(true);

    this.broker ??= new ApwCredentialBroker({
      command: apwCommand,
      // A fill found the daemon unpaired (helper session dropped, or pairing
      // never actually settled): re-enter the PIN flow instead of leaving
      // every later fill to die on the same error.
      onNotPaired: () => void this.daemon?.repair(),
      // Remember where a password was last released (metadata only) so the
      // next pairing can warm up macOS's AutoFill consent immediately.
      onRelease: (host, username) => this.opts.saveWarmup?.({ host, username }),
    });
    credentials.set(this.broker, "apple-passwords");

    if (!this.daemon) {
      this.daemon = new ApwDaemon({
        command: apwCommand,
        startTimeoutMs: this.opts.startTimeoutMs,
        startSettleMs: this.opts.startSettleMs,
        pinRetryDelayMs: this.opts.pinRetryDelayMs,
        pairProbeAttempts: this.opts.pairProbeAttempts,
        pairProbeIntervalMs: this.opts.pairProbeIntervalMs,
        audit: this.opts.audit,
        onChange: () => this.opts.onChange?.(),
      });
    }
    const state = this.daemon.status().state;
    if (state === "paired" || state === "awaiting-pin" || state === "starting") return;
    try {
      await this.daemon.start();
      await this.daemon.requestPin();
    } catch {
      /* state is "error" with detail; Settings renders it with a Retry */
    }
  }

  /** Re-trigger the macOS PIN dialog (the old PIN expired or was dismissed). */
  async requestPin(): Promise<void> {
    try {
      await this.daemon?.requestPin();
    } catch {
      /* state carries the failure detail */
    }
  }

  /** Complete pairing. Returns false when the PIN was rejected. */
  async submitPin(pin: string): Promise<boolean> {
    const paired = (await this.daemon?.submitPin(pin)) ?? false;
    // macOS asks for one user-presence approval ("AutoFill for …") per pairing
    // session, at the first password release. Trigger that release NOW — while
    // the user is standing at the PIN field — instead of mid-task later. The
    // value is dropped on the spot and never leaves this call.
    if (paired) void this.warmUp();
    return paired;
  }

  private async warmUp(): Promise<void> {
    const warmup = this.opts.loadWarmup?.();
    if (!warmup || !this.broker) return;
    try {
      await this.broker.getField(warmup.username, "password", warmup.host);
      this.opts.audit?.("apw_warmup", { host: warmup.host, ok: true });
    } catch (error) {
      this.opts.audit?.("apw_warmup", { host: warmup.host, ok: false });
      // The remembered entry no longer exists — forget it; a later real fill
      // will remember a fresh one. Transient errors keep the memory.
      if (
        error instanceof CredentialError &&
        (error.type === "ApwDenied" || error.type === "ApwNoResults")
      ) {
        this.opts.saveWarmup?.(null);
      }
    }
  }

  /** Turn the feature off: persist, kill the daemon (unpairs), restore the
   * default credential source (1Password). */
  async disable(): Promise<void> {
    this.opts.setEnabled(false);
    this.opts.credentials?.reset();
    const daemon = this.daemon;
    this.daemon = null;
    await daemon?.stop();
    this.opts.onChange?.();
  }

  /** App quit: kill the daemon so the pairing dies with the app. The setting
   * and credential switch are left alone — next launch pairs again. */
  async shutdown(): Promise<void> {
    const daemon = this.daemon;
    this.daemon = null;
    await daemon?.stop();
  }
}
