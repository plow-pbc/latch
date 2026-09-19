/**
 * FdaGrantFlow.start() resolution: the promise settles when the flow ENDS —
 * granted, dismissed, timed out, or replaced by a different switch — not when
 * the panel merely opens. Electron is mocked with a minimal fake window; the
 * panel's own geometry/parsing (permissionFlow.ts) is exercised elsewhere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeWindow {
  static instances: FakeWindow[] = [];
  readonly title: string | undefined;
  private destroyed = false;
  private visible = false;
  private bounds: { x: number; y: number; width: number; height: number };
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(options: { x: number; y: number; width: number; height: number; title?: string }) {
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.title = options.title;
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

const { FdaGrantFlow, PROBE_INTERVAL_MS, GRANTED_LINGER_MS, FLOW_TIMEOUT_MS } =
  await import("../src/fdaGrantFlow.js");
type GrantTarget = import("../src/fdaGrantFlow.js").GrantTarget;

function makeTarget(key: string, granted: () => boolean): GrantTarget {
  return {
    key,
    label: key,
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

    // Same key while A's panel is up: returns A's exact same pending
    // outcome, not merely an equal one — the contract setup relies on to
    // await one handle per switch.
    const pA2 = flow.start(targetA);
    expect(pA2).toBe(pA);
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

  it("resolves false when the flow times out with no grant", async () => {
    const deps = makeDeps();
    const target = makeTarget("fullDiskAccess", () => false);
    const flow = new FdaGrantFlow(deps);

    const startPromise = flow.start(target);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWindow.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(FLOW_TIMEOUT_MS);

    await expect(startPromise).resolves.toBe(false);
    expect(FakeWindow.instances[0].isDestroyed()).toBe(true);
  });

  it("resolves the pre-empted call false, and builds only the newer switch's panel, when two different switches start before either probe resolves", async () => {
    const deps = makeDeps();
    const targetA = makeTarget("a", () => false);
    const targetB = makeTarget("b", () => false);
    const flow = new FdaGrantFlow(deps);

    // No await between these two calls — both probes race.
    const pA = flow.start(targetA);
    const pB = flow.start(targetB);

    // A's call resolves false on its own, from the mismatch alone, without
    // any stop() ending the flow.
    await expect(pA).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeWindow.instances).toHaveLength(1);
    expect(FakeWindow.instances[0].title).toBe("Grant b");
    expect(FakeWindow.instances[0].isDestroyed()).toBe(false);

    flow.stop();
    await expect(pB).resolves.toBe(false);
  });

  it("cancels a finished flow's linger timer so it cannot stop the flow that replaced it", async () => {
    const deps = makeDeps();
    let grantedA = false;
    const targetA = makeTarget("a", () => grantedA);
    const targetB = makeTarget("b", () => false);
    const flow = new FdaGrantFlow(deps);

    const pA = flow.start(targetA);
    await vi.advanceTimersByTimeAsync(0);

    grantedA = true;
    // checkGranted's first tick sees the grant and arms the 2.5s linger —
    // it does not stop the flow yet.
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
    expect(FakeWindow.instances[0].isDestroyed()).toBe(false);

    // A different switch while A is lingering: ends A now (resolving it
    // true, since the grant had landed) and starts B.
    const pB = flow.start(targetB);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pA).resolves.toBe(true);
    expect(FakeWindow.instances).toHaveLength(2);

    let bSettled = false;
    void pB.then(() => {
      bSettled = true;
    });

    // Advance exactly past where A's original (now-cancelled) linger timer
    // would have fired. Without clearing it in stop(), it would stop B too.
    await vi.advanceTimersByTimeAsync(GRANTED_LINGER_MS);

    expect(FakeWindow.instances[1].isDestroyed()).toBe(false);
    expect(bSettled).toBe(false);

    flow.stop();
    await expect(pB).resolves.toBe(false);
  });

  it("ignores a stale checkGranted probe that resolves after a different switch has taken over", async () => {
    const deps = makeDeps();
    let resolveStaleProbe!: (granted: boolean) => void;
    const staleProbe = new Promise<boolean>((resolve) => {
      resolveStaleProbe = resolve;
    });
    let probeACalls = 0;
    const targetA: GrantTarget = {
      key: "a",
      label: "Grant a",
      pane: "pane-a",
      acceptsDrop: true,
      probe: async () => {
        probeACalls += 1;
        // The first call is start()'s own already-granted check, resolved
        // immediately so the panel gets built; the second is checkGranted's
        // periodic probe, held open under this test's control.
        return probeACalls === 1 ? false : staleProbe;
      },
    };
    const targetB = makeTarget("b", () => false);
    const flow = new FdaGrantFlow(deps);

    const pA = flow.start(targetA);
    await vi.advanceTimersByTimeAsync(0);
    // Fires checkGranted's first tick; its probe() call is now in flight,
    // held open on staleProbe.
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);

    const pB = flow.start(targetB);
    await expect(pA).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWindow.instances).toHaveLength(2);

    // A's stale probe finally resolves true, long after being superseded.
    resolveStaleProbe(true);
    await vi.advanceTimersByTimeAsync(0);

    flow.stop();
    await expect(pB).resolves.toBe(false);
  });
});
