/**
 * Auto-update controller — the state machine between electron-updater and the
 * app's update UI, pure over injected seams so it is unit-testable without
 * Electron (updates.test.ts). main.ts feeds it the real autoUpdater and
 * settings; the renderer's banner, the Software Updates settings section, the
 * tray, and the app menu all render from `state()` and call the actions here.
 *
 * The feed URL is not here: electron-builder bakes it into the packaged app
 * (app-update.yml, from the `publish` block in electron-builder.yml), and only
 * a packaged app updates at all — main.ts never constructs this controller in
 * a from-source run, so worktree instances cannot poll or overwrite anything.
 * DOMO_UPDATE_FEED_URL (read in main.ts) points a packaged build elsewhere for
 * local testing.
 *
 * Notification policy: NOTHING here is modal. A background-discovered update
 * downloads silently and surfaces as a passive banner + tray/menu item; the
 * human restarts when they choose. Declining costs nothing — with the
 * "automatically install" preference on (the default), electron-updater's
 * autoInstallOnAppQuit applies the staged update on the next natural quit,
 * the same pattern VS Code and Slack use.
 */

export type UpdatePhase = "idle" | "checking" | "downloading" | "ready" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  /** The version being downloaded / staged, while downloading or ready. */
  availableVersion: string | null;
  /** ISO-8601 time the last check COMPLETED (found, up-to-date, or failed). */
  lastCheckAt: string | null;
  /** Why the last check failed, when phase is "error". */
  error: string | null;
  /** True when the human dismissed the ready banner for availableVersion. */
  dismissed: boolean;
  /**
   * True only after a check THIS SESSION came back empty-handed — the one
   * case where "You're up to date" is a claim and not a guess. A persisted
   * lastCheckAt alone never sets this.
   */
  upToDate: boolean;
}

/** The slice of electron-updater's AutoUpdater this controller drives. */
export interface UpdaterLike {
  /** Poll the feed; outcomes arrive via the events below. */
  checkForUpdates(): Promise<unknown>;
  /** Quit and apply the downloaded update now. */
  quitAndInstall(): void;
  on(event: "update-available", listener: (info: { version: string }) => void): void;
  on(event: "update-not-available", listener: () => void): void;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface UpdateControllerOpts {
  updater: UpdaterLike;
  /**
   * The "automatically check for updates" preference, read at every scheduled
   * tick so a toggle takes effect live — no restart, no timer juggling.
   * Manual checks (checkNow) ignore it.
   */
  autoCheckEnabled: () => boolean;
  /** Fires after every state transition with the new whole state. */
  onChange?: (state: UpdateState) => void;
  log?: (message: string) => void;
  /** Default 4 hours. */
  checkIntervalMs?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Seed lastCheckAt from persisted settings so relaunches keep the history. */
  initialLastCheckAt?: string | null;
}

export const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export type SimulatedScenario = "available" | "none" | "error";

/**
 * A scripted stand-in for electron-updater, so the update UI can be exercised
 * in a from-source run without packaging or a feed: launch with
 * DOMO_SIMULATE_UPDATE=available|none|error (main.ts wires it in). Every
 * check replays the scenario on a compressed timeline — found → downloading →
 * ready in ~2s — through the REAL controller, IPC, banner, tray, and
 * settings section; only the updater itself is fake.
 */
export class SimulatedUpdater implements UpdaterLike {
  private listeners = new Map<string, ((payload?: unknown) => void)[]>();

  constructor(
    private readonly opts: {
      scenario: SimulatedScenario;
      /** The version the fake update pretends to be. */
      version: string;
      /** Called for quitAndInstall — main.ts relaunches the app. */
      onInstall: () => void;
    },
  ) {}

  // `any` (not unknown): the payload must be assignable to every listener
  // shape in UpdaterLike's overloads, which contravariance forbids for unknown.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (payload?: any) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  async checkForUpdates(): Promise<unknown> {
    const { scenario, version } = this.opts;
    setTimeout(() => {
      if (scenario === "error") this.emit("error", new Error("simulated check failure (DOMO_SIMULATE_UPDATE=error)"));
      else if (scenario === "none") this.emit("update-not-available");
      else {
        this.emit("update-available", { version });
        setTimeout(() => this.emit("update-downloaded", { version }), 1500);
      }
    }, 400);
    return null;
  }

  quitAndInstall(): void {
    this.opts.onInstall();
  }

  private emit(event: string, payload?: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(payload);
  }
}

export class UpdateController {
  private readonly opts: UpdateControllerOpts;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The version whose ready banner was dismissed; a newer one shows again. */
  private dismissedVersion: string | null = null;
  private current: UpdateState;

  constructor(opts: UpdateControllerOpts) {
    this.opts = opts;
    this.intervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.current = {
      phase: "idle",
      availableVersion: null,
      lastCheckAt: opts.initialLastCheckAt ?? null,
      error: null,
      dismissed: false,
      upToDate: false,
    };

    opts.updater.on("update-available", (info) => {
      this.log(`update available: ${info.version}; downloading`);
      this.transition({
        phase: "downloading",
        availableVersion: info.version,
        lastCheckAt: this.timestamp(),
        error: null,
      });
    });
    opts.updater.on("update-not-available", () => {
      this.transition({
        phase: "idle",
        availableVersion: null,
        lastCheckAt: this.timestamp(),
        error: null,
        upToDate: true,
      });
    });
    opts.updater.on("update-downloaded", (info) => {
      this.log(`update downloaded: ${info.version}; staged for install`);
      this.transition({
        phase: "ready",
        availableVersion: info.version,
        error: null,
        dismissed: info.version === this.dismissedVersion,
      });
    });
    opts.updater.on("error", (error) => {
      // Routine when offline; the state carries the reason for anyone who
      // looks (the Software Updates section), and nothing pops.
      this.log(`update check failed: ${error.message}`);
      this.transition({
        phase: "error",
        availableVersion: null,
        lastCheckAt: this.timestamp(),
        error: error.message,
      });
    });
  }

  state(): UpdateState {
    return { ...this.current };
  }

  /** Begin the background cadence: one check now, then every interval. */
  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Never keep the process alive just to poll for updates.
    this.timer.unref?.();
  }

  /** A human asked — runs even with auto-check off. */
  checkNow(): void {
    // "ready" is busy too: a check that fails (e.g. offline) would transition
    // to error and throw away the staged update's restart controls, even
    // though the download is still on disk. Restart first, then check.
    if (this.current.phase === "checking" || this.current.phase === "downloading" || this.current.phase === "ready")
      return;
    this.check();
  }

  /** Hide the ready banner for this version; a newer version shows it again. */
  dismiss(): void {
    if (this.current.phase !== "ready") return;
    this.dismissedVersion = this.current.availableVersion;
    this.transition({ dismissed: true });
  }

  /** Apply the staged update now. No-op unless one is ready. */
  restartAndInstall(): void {
    if (this.current.phase !== "ready") return;
    this.log(`restarting to install ${this.current.availableVersion}`);
    this.opts.updater.quitAndInstall();
  }

  private tick(): void {
    if (!this.opts.autoCheckEnabled()) return;
    // A staged or in-flight download keeps quietly waiting; don't churn the
    // feed under it. A stale "checking" does NOT block the tick: if a check's
    // outcome event were ever lost, refusing to re-check would kill the
    // cadence forever, and re-checking is harmless.
    if (this.current.phase === "downloading" || this.current.phase === "ready") return;
    this.check();
  }

  private check(): void {
    this.transition({ phase: "checking", error: null });
    // Outcomes arrive via the events wired in the constructor; the rejection
    // duplicates the "error" event, so it is only swallowed, never reported.
    this.opts.updater.checkForUpdates().catch(() => {});
  }

  private transition(patch: Partial<UpdateState>): void {
    // dismissed and upToDate are claims about a moment, not carried state:
    // each transition re-earns them or loses them.
    this.current = { ...this.current, dismissed: false, upToDate: false, ...patch };
    this.opts.onChange?.(this.state());
  }

  private timestamp(): string {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }
}
