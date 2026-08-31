/**
 * Keep Mac Awake — an opt-in sleep blocker held only while on AC power, so
 * agents can reach this Mac during plugged-in idle without draining a battery
 * the moment the owner unplugs.
 *
 * Ported from the Phoenix app's `KeepMacAwake` (plow repo, PLO-30), behavior
 * intact: AC↔battery transitions reconcile automatically — switching to
 * battery debounces ~750ms before releasing (absorbs charger flap), switching
 * back to AC reacquires immediately so reachability returns the moment the
 * user plugs in — and an acquire the OS refuses reverts the toggle rather
 * than showing a state that is not actually held. Clamshell sleep on a
 * MacBook without an external display is still enforced by the kernel and is
 * not reachable from any public API, here or there.
 *
 * This module is pure and lives outside `main.ts` for the usual reason: main
 * cannot be imported under vitest, and the debounce/revert behavior is only
 * provable while the blocker, power source, clock and persistence are all
 * injected. `main.ts` hands it a `caffeinate -dims` child process — the tool
 * that holds exactly the four assertions Phoenix held — plus Electron's
 * `powerMonitor` and the on-disk settings.
 */

/** AC vs battery. External power of any kind counts as AC — drain is not the
 * owner's concern while plugged in. */
export type PowerSource = "ac" | "battery";

/** Test seam for power-source observation. Production reads
 * `powerMonitor.isOnBatteryPower()` and subscribes to `on-ac`/`on-battery`. */
export interface PowerSourceObserver {
  /** Synchronous read used at construction, so the first reconcile sees the
   * true power state — a seeded-true launch on battery must not acquire. */
  current(): PowerSource;
  /** Subscribes for transitions; returns an unsubscribe handle. */
  subscribe(callback: (source: PowerSource) => void): () => void;
}

/** Test seam for the OS sleep blocker. `start` answers `null` when the OS
 * refused, which is what drives the toggle revert. Production spawns
 * `caffeinate -dims` and answers its pid; a hold that later dies out from
 * under us is reported through `blockerLost`, not through this interface. */
export interface SleepBlocker {
  start(): number | null;
  stop(id: number): void;
}

/** Schedules `work` after `delayMs`; returns a cancel handle. The production
 * default is setTimeout; tests inject a virtual scheduler with a manual
 * flush so the AC→battery debounce is testable without real time. */
export type DebounceScheduler = (delayMs: number, work: () => void) => () => void;

export interface KeepAwakeOptions {
  blocker: SleepBlocker;
  power: PowerSourceObserver;
  /** The persisted opt-in, read once at construction. */
  load(): boolean;
  /** Persists every toggle outcome — including a revert, so the file never
   * promises a hold the OS refused. */
  save(enabled: boolean): void;
  schedule?: DebounceScheduler;
  /** Clock for hold-age checks; the production default is Date.now. */
  now?: () => number;
}

/** AC→battery debounce window (ms). */
export const AC_TRANSITION_DEBOUNCE_MS = 750;

/** A lost hold younger than this is not reacquired: something on this Mac is
 * killing caffeinate on sight, and respawning per exit would be a spawn loop.
 * The opt-in stands; the next toggle or power transition retries. */
export const SHORT_LIVED_HOLD_MS = 5_000;

const defaultScheduler: DebounceScheduler = (delayMs, work) => {
  const timer = setTimeout(work, delayMs);
  return () => clearTimeout(timer);
};

export class KeepAwake {
  private readonly blocker: SleepBlocker;
  private readonly power: PowerSourceObserver;
  private readonly load: () => boolean;
  private readonly save: (enabled: boolean) => void;
  private readonly schedule: DebounceScheduler;
  private readonly now: () => number;

  private enabled: boolean;
  private powerSource: PowerSource;
  private blockId: number | null = null;
  /** When the current hold was acquired — the age check in blockerLost. */
  private acquiredAt = 0;
  /** Cancel handle for the in-flight AC→battery debounce, if any. Cleared
   * when it fires, when an AC transition supersedes it, or by teardown. */
  private pendingDebounceCancel: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Set by `teardown()` FIRST, then checked at every callback entry, so a
   * transition already dispatched when teardown ran cannot re-acquire or
   * re-schedule against a torn-down instance. */
  private tornDown = false;

  constructor(options: KeepAwakeOptions) {
    this.blocker = options.blocker;
    this.power = options.power;
    this.load = options.load;
    this.save = options.save;
    this.schedule = options.schedule ?? defaultScheduler;
    this.now = options.now ?? Date.now;
    // Power first, then the stored opt-in, then apply: the first reconcile
    // must see the real power state, or a seeded-true launch on battery would
    // briefly hold a blocker it has no business holding.
    this.powerSource = this.power.current();
    this.enabled = this.load();
    this.applyEnabled();
    // Subscribe AFTER the initial apply so no transition is processed for a
    // state already reflected.
    this.unsubscribe = this.power.subscribe((source) => this.handleTransition(source));
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * The toggle. Answers with what actually took: an acquire the OS refuses
   * reverts to false, and that is what is persisted and what the caller
   * shows — never the state that was merely asked for.
   *
   * The ask is persisted BEFORE anything is assigned or touched: a save that
   * throws then changes nothing — memory, disk, and the hold all keep the
   * last agreed state, instead of three different answers.
   */
  setEnabled(on: boolean): boolean {
    this.save(on);
    this.enabled = on;
    this.applyEnabled();
    return this.enabled;
  }

  /**
   * The hold vanished out from under us — a caffeinate child can be killed,
   * where Phoenix's in-process IOKit assertions could not. Forgets the dead
   * hold and re-acquires if one should stand. A stale report (an id no longer
   * held) is a no-op, so a deliberate stop racing its own exit event cannot
   * double-release or re-acquire. Failure follows the transition rule: the
   * opt-in stands and the next transition retries — only the explicit toggle
   * answers to its caller.
   */
  blockerLost(id: number): void {
    if (this.tornDown) return;
    if (this.blockId !== id) return;
    this.blockId = null;
    // A hold that died this young is being killed on sight, and reacquiring
    // per exit would be a spawn loop. Treated like a refused acquire: the
    // opt-in stands, and the next toggle or power transition retries.
    if (this.now() - this.acquiredAt < SHORT_LIVED_HOLD_MS) {
      console.log("[keep-awake] hold died young; not respawning until the next transition");
      return;
    }
    this.reconcile();
  }

  /**
   * Releases the blocker deterministically before quit, cancels any pending
   * debounce, and unsubscribes. The OS reclaims the blocker on process exit
   * either way; this is a courtesy, not a leak fix.
   */
  teardown(): void {
    this.tornDown = true;
    this.pendingDebounceCancel?.();
    this.pendingDebounceCancel = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.release();
  }

  /** Brings the held blocker in line with `enabled` + power source. An
   * acquire failure reverts `enabled` and writes the false down, so the file
   * never promises a hold the OS refused. */
  private applyEnabled(): void {
    if (!this.reconcile()) {
      this.enabled = false;
      this.save(false);
    }
  }

  /** Drives the blocker toward `enabled && powerSource === "ac"`. Answers
   * false iff an acquire attempt failed. */
  private reconcile(): boolean {
    const shouldHold = this.enabled && this.powerSource === "ac";
    if (shouldHold && this.blockId === null) {
      const id = this.blocker.start();
      if (id === null) {
        console.log("[keep-awake] OS refused the sleep blocker");
        return false;
      }
      this.blockId = id;
      this.acquiredAt = this.now();
    }
    if (!shouldHold && this.blockId !== null) this.release();
    return true;
  }

  private release(): void {
    if (this.blockId === null) return;
    this.blocker.stop(this.blockId);
    this.blockId = null;
  }

  private handleTransition(source: PowerSource): void {
    if (this.tornDown) return;
    // Idempotence: same-value rebroadcasts are no-ops — critically, a repeat
    // battery notification during an in-flight debounce must not reschedule
    // the timer indefinitely. `powerSource` is updated synchronously below on
    // a true transition, so the same-value check is sufficient.
    if (source === this.powerSource) return;
    // Update the truth-of-the-world synchronously; only the SIDE EFFECT is
    // debounced on the AC→battery edge. A toggle landing inside the debounce
    // window then reads live state and reconciles correctly.
    this.powerSource = source;
    if (source === "battery") {
      // Debounce the release so a quick replug doesn't churn the blocker.
      this.pendingDebounceCancel?.();
      this.pendingDebounceCancel = this.schedule(AC_TRANSITION_DEBOUNCE_MS, () => {
        if (this.tornDown) return;
        this.pendingDebounceCancel = null;
        this.reconcile();
      });
    } else {
      // battery→AC: cancel any pending debounce and reacquire immediately.
      // A failure here is not a revert — the opt-in stands, and the next
      // transition retries; only the explicit toggle answers to its caller.
      this.pendingDebounceCancel?.();
      this.pendingDebounceCancel = null;
      this.reconcile();
    }
  }
}
