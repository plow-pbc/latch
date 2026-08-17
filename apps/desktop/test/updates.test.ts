import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHECK_INTERVAL_MS,
  SimulatedUpdater,
  UpdateController,
  UpdaterLike,
  UpdateState,
} from "../src/updates.js";

/** In-memory stand-in for electron-updater's autoUpdater. */
class FakeUpdater implements UpdaterLike {
  checks = 0;
  installed = 0;
  private listeners = new Map<string, ((payload?: unknown) => void)[]>();

  checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    return Promise.resolve(null);
  }
  quitAndInstall(): void {
    this.installed += 1;
  }
  on(event: string, listener: (payload?: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: string, payload?: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(payload);
  }
}

const NOW = new Date("2026-08-13T10:00:00.000Z");

function make(overrides: Partial<{ autoCheck: boolean; initialLastCheckAt: string }> = {}) {
  const updater = new FakeUpdater();
  const changes: UpdateState[] = [];
  let autoCheck = overrides.autoCheck ?? true;
  const controller = new UpdateController({
    updater,
    autoCheckEnabled: () => autoCheck,
    onChange: (s) => changes.push(s),
    now: () => NOW,
    initialLastCheckAt: overrides.initialLastCheckAt ?? null,
  });
  return { updater, controller, changes, setAutoCheck: (on: boolean) => (autoCheck = on) };
}

describe("scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("checks immediately on start and again every interval", () => {
    const { updater, controller } = make();
    controller.start();
    expect(updater.checks).toBe(1);
    vi.advanceTimersByTime(DEFAULT_CHECK_INTERVAL_MS * 2);
    expect(updater.checks).toBe(3);
  });

  it("start is idempotent", () => {
    const { updater, controller } = make();
    controller.start();
    controller.start();
    vi.advanceTimersByTime(DEFAULT_CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(2);
  });

  it("the auto-check preference gates ticks live, in both directions", () => {
    const { updater, controller, setAutoCheck } = make({ autoCheck: false });
    controller.start();
    expect(updater.checks).toBe(0);
    setAutoCheck(true);
    vi.advanceTimersByTime(DEFAULT_CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(1);
    setAutoCheck(false);
    vi.advanceTimersByTime(DEFAULT_CHECK_INTERVAL_MS * 3);
    expect(updater.checks).toBe(1);
  });

  it("a staged update stops the background cadence; a failed check doesn't", () => {
    const { updater, controller } = make();
    controller.start();
    updater.emit("update-downloaded", { version: "0.2.0" });
    vi.advanceTimersByTime(DEFAULT_CHECK_INTERVAL_MS * 2);
    expect(updater.checks).toBe(1);

    const failing = make();
    failing.controller.start();
    failing.updater.emit("error", new Error("offline"));
    vi.advanceTimersByTime(DEFAULT_CHECK_INTERVAL_MS);
    expect(failing.updater.checks).toBe(2);
  });

  it("checkNow works with auto-check off, but not while already busy", () => {
    const { updater, controller } = make({ autoCheck: false });
    controller.checkNow();
    expect(updater.checks).toBe(1);
    expect(controller.state().phase).toBe("checking");
    controller.checkNow();
    expect(updater.checks).toBe(1);
    updater.emit("update-available", { version: "0.2.0" });
    controller.checkNow();
    expect(updater.checks).toBe(1);
  });
});

describe("state machine", () => {
  it("walks idle → checking → downloading → ready with timestamps", () => {
    const { updater, controller } = make();
    expect(controller.state()).toEqual({
      phase: "idle",
      availableVersion: null,
      lastCheckAt: null,
      error: null,
      dismissed: false,
      upToDate: false,
    });
    controller.checkNow();
    expect(controller.state().phase).toBe("checking");
    updater.emit("update-available", { version: "0.2.0" });
    expect(controller.state()).toMatchObject({
      phase: "downloading",
      availableVersion: "0.2.0",
      lastCheckAt: NOW.toISOString(),
    });
    updater.emit("update-downloaded", { version: "0.2.0" });
    expect(controller.state()).toMatchObject({ phase: "ready", availableVersion: "0.2.0", dismissed: false });
  });

  it("up-to-date and failure both stamp lastCheckAt; only up-to-date claims it", () => {
    const { updater, controller } = make();
    controller.checkNow();
    updater.emit("update-not-available");
    expect(controller.state()).toMatchObject({
      phase: "idle",
      lastCheckAt: NOW.toISOString(),
      upToDate: true,
    });
    controller.checkNow();
    updater.emit("error", new Error("feed unreachable"));
    expect(controller.state()).toMatchObject({
      phase: "error",
      error: "feed unreachable",
      lastCheckAt: NOW.toISOString(),
      upToDate: false,
    });
  });

  it("an up-to-date verdict does not survive the next check finding something", () => {
    const { updater, controller } = make();
    controller.checkNow();
    updater.emit("update-not-available");
    controller.checkNow();
    updater.emit("update-available", { version: "0.2.0" });
    expect(controller.state().upToDate).toBe(false);
  });

  it("seeds lastCheckAt from persisted settings without claiming up-to-date", () => {
    const seeded = "2026-08-12T09:00:00.000Z";
    const { controller } = make({ initialLastCheckAt: seeded });
    expect(controller.state()).toMatchObject({ lastCheckAt: seeded, upToDate: false });
  });

  it("notifies on every transition", () => {
    const { updater, controller, changes } = make();
    controller.checkNow();
    updater.emit("update-not-available");
    expect(changes.map((c) => c.phase)).toEqual(["checking", "idle"]);
  });
});

describe("dismissal and install", () => {
  it("dismiss hides the ready state for that version only", () => {
    const { updater, controller } = make();
    updater.emit("update-downloaded", { version: "0.2.0" });
    controller.dismiss();
    expect(controller.state().dismissed).toBe(true);
    // The same version re-staging stays dismissed; a newer one shows again.
    updater.emit("update-downloaded", { version: "0.2.0" });
    expect(controller.state().dismissed).toBe(true);
    updater.emit("update-downloaded", { version: "0.3.0" });
    expect(controller.state()).toMatchObject({ availableVersion: "0.3.0", dismissed: false });
  });

  it("dismiss is meaningless outside ready", () => {
    const { controller } = make();
    controller.dismiss();
    expect(controller.state().dismissed).toBe(false);
  });

  it("restartAndInstall installs only when an update is staged", () => {
    const { updater, controller } = make();
    controller.restartAndInstall();
    expect(updater.installed).toBe(0);
    updater.emit("update-downloaded", { version: "0.2.0" });
    controller.restartAndInstall();
    expect(updater.installed).toBe(1);
  });
});

describe("SimulatedUpdater (DOMO_SIMULATE_UPDATE)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function drive(scenario: "available" | "none" | "error") {
    let installed = 0;
    const sim = new SimulatedUpdater({ scenario, version: "0.1.1", onInstall: () => installed++ });
    const controller = new UpdateController({ updater: sim, autoCheckEnabled: () => true });
    return { controller, installedCount: () => installed };
  }

  it("plays check → downloading → ready → install through the real controller", () => {
    const { controller, installedCount } = drive("available");
    controller.checkNow();
    expect(controller.state().phase).toBe("checking");
    vi.advanceTimersByTime(400);
    expect(controller.state()).toMatchObject({ phase: "downloading", availableVersion: "0.1.1" });
    vi.advanceTimersByTime(1500);
    expect(controller.state().phase).toBe("ready");
    controller.restartAndInstall();
    expect(installedCount()).toBe(1);
  });

  it("plays the up-to-date and failure scenarios", () => {
    const none = drive("none");
    none.controller.checkNow();
    vi.advanceTimersByTime(400);
    expect(none.controller.state().phase).toBe("idle");

    const err = drive("error");
    err.controller.checkNow();
    vi.advanceTimersByTime(400);
    expect(err.controller.state()).toMatchObject({ phase: "error", error: expect.stringContaining("simulated") });
  });
});
