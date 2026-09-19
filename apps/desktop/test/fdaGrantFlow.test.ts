/**
 * FdaGrantFlow.start() resolution: the promise settles when the flow ENDS —
 * granted, dismissed, timed out, or replaced by a different switch — not when
 * the panel merely opens. Electron is mocked with a minimal fake window; the
 * panel's own geometry/parsing (permissionFlow.ts) is exercised elsewhere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeWindow {
  static instances: FakeWindow[] = [];
  private destroyed = false;
  private visible = false;
  private bounds: { x: number; y: number; width: number; height: number };
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(options: { x: number; y: number; width: number; height: number }) {
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    FakeWindow.instances.push(this);
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  once(event: string, cb: (...args: unknown[]) => void): void {
    this.on(event, cb);
  }

  loadFile(): Promise<void> {
    return Promise.resolve();
  }

  setAlwaysOnTop(): void {}
  setVisibleOnAllWorkspaces(): void {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
  }

  isVisible(): boolean {
    return this.visible;
  }

  showInactive(): void {
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  setBounds(b: { x: number; y: number; width: number; height: number }): void {
    this.bounds = b;
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return this.bounds;
  }
}

vi.mock("electron", () => ({
  BrowserWindow: FakeWindow,
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  },
}));

const { FdaGrantFlow } = await import("../src/fdaGrantFlow.js");
type GrantTarget = import("../src/fdaGrantFlow.js").GrantTarget;

const PROBE_INTERVAL_MS = 2000;
const GRANTED_LINGER_MS = 2500;

function makeTarget(key: string, granted: () => boolean): GrantTarget {
  return {
    key,
    label: `Grant ${key}`,
    pane: `x-apple.systempreferences:com.apple.preference.security?${key}`,
    acceptsDrop: true,
    probe: async () => granted(),
  };
}

function makeDeps() {
  return {
    rendererDir: "/nonexistent/renderer",
    preloadPath: "/nonexistent/preload.cjs",
    // Doesn't exist on this host, so startTracker's fs.existsSync check
    // skips spawning the helper — no child process, no real tracker.
    helperPath: "/nonexistent/settings-window-frame",
    fullDisk: makeTarget("fullDiskAccess", () => false),
    openSettings: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  FakeWindow.instances = [];
  vi.useFakeTimers();
});

describe("FdaGrantFlow.start", () => {
  it("resolves true and opens no panel when already granted", async () => {
    const deps = makeDeps();
    const target = makeTarget("fullDiskAccess", () => true);
    const flow = new FdaGrantFlow(deps);

    const result = await flow.start(target);

    expect(result).toBe(true);
    expect(FakeWindow.instances).toHaveLength(0);
  });

  it("resolves true and destroys the panel once the grant lands mid-flow", async () => {
    const deps = makeDeps();
    let granted = false;
    const target = makeTarget("fullDiskAccess", () => granted);
    const flow = new FdaGrantFlow(deps);

    const startPromise = flow.start(target);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWindow.instances).toHaveLength(1);

    granted = true;
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(GRANTED_LINGER_MS);

    await expect(startPromise).resolves.toBe(true);
    expect(FakeWindow.instances[0].isDestroyed()).toBe(true);
  });

  it("resolves false when dismissed before a grant", async () => {
    const deps = makeDeps();
    const target = makeTarget("fullDiskAccess", () => false);
    const flow = new FdaGrantFlow(deps);

    const startPromise = flow.start(target);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWindow.instances).toHaveLength(1);

    flow.stop();

    await expect(startPromise).resolves.toBe(false);
    expect(FakeWindow.instances[0].isDestroyed()).toBe(true);
  });

  it("resolves the replaced flow false when a different switch takes over", async () => {
    const deps = makeDeps();
    const targetA = makeTarget("a", () => false);
    const targetB = makeTarget("b", () => false);
    const flow = new FdaGrantFlow(deps);

    const pA = flow.start(targetA);
    await vi.advanceTimersByTimeAsync(0);

    // Same key while A's panel is up: returns A's same pending outcome.
    const pA2 = flow.start(targetA);
    await vi.advanceTimersByTimeAsync(0);

    // Different key: ends A's flow and starts B's.
    const pB = flow.start(targetB);
    await vi.advanceTimersByTimeAsync(0);

    await expect(pA).resolves.toBe(false);
    await expect(pA2).resolves.toBe(false);
    expect(FakeWindow.instances).toHaveLength(2);
    expect(FakeWindow.instances[0].isDestroyed()).toBe(true);

    flow.stop();
    await expect(pB).resolves.toBe(false);
  });
});
