/**
 * FdaGrantFlow.start() resolves when the flow ENDS — granted, dismissed, timed
 * out, or replaced by a different switch — not when the panel merely opens.
 * Electron is mocked with a minimal fake window; the panel's own
 * geometry/parsing (permissionFlow.ts) is exercised elsewhere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeWindow {
  static instances: FakeWindow[] = [];
  // Lets a test simulate a window that fails partway through setup, after
  // the panel already exists (setAlwaysOnTop is the first call pursue()
  // makes on a freshly constructed panel).
  static throwOnSetAlwaysOnTop: Error | null = null;
  readonly title: string | undefined;
  private destroyed = false;
  private listeners = new Map<string, Array<() => void>>();

  constructor(options: { title?: string }) {
    this.title = options.title;
    FakeWindow.instances.push(this);
  }

  on(event: string, cb: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }

  once(event: string, cb: () => void): void {
    this.on(event, cb);
  }

  loadFile(): Promise<void> {
    return Promise.resolve();
  }

  setAlwaysOnTop(): void {
    if (FakeWindow.throwOnSetAlwaysOnTop) throw FakeWindow.throwOnSetAlwaysOnTop;
  }
  setVisibleOnAllWorkspaces(): void {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  // `closed` arrives after destroy() has returned, as a real window's can —
  // by then a replacing flow may own the panel slot.
  destroy(): void {
    this.destroyed = true;
    setTimeout(() => this.listeners.get("closed")?.forEach((cb) => cb()), 0);
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
type Flow = InstanceType<typeof FdaGrantFlow>;

function makeTarget(key: string, granted: () => boolean): GrantTarget {
  return {
    key,
    label: key,
    pane: `x-apple.systempreferences:com.apple.preference.security?${key}`,
    acceptsDrop: true,
    probe: async () => granted(),
  };
}

function makeFlow(): Flow {
  return new FdaGrantFlow({
    rendererDir: "/nonexistent/renderer",
    preloadPath: "/nonexistent/preload.cjs",
    // Doesn't exist on this host, so startTracker's fs.existsSync check
    // skips spawning the helper — no child process, no real tracker.
    helperPath: "/nonexistent/settings-window-frame",
    fullDisk: makeTarget("fullDiskAccess", () => false),
    openSettings: async () => {},
  });
}

/** A flow's promise, and whether it has ended yet — read after an await. */
function track(p: Promise<void>): { ended: boolean } {
  const t = { ended: false };
  void p.then(() => {
    t.ended = true;
  });
  return t;
}

const live = (): FakeWindow[] => FakeWindow.instances.filter((w) => !w.isDestroyed());

beforeEach(() => {
  FakeWindow.instances = [];
  FakeWindow.throwOnSetAlwaysOnTop = null;
  vi.useFakeTimers();
});

describe("FdaGrantFlow.start", () => {
  it("ends at once, and opens no panel, when the switch is already on", async () => {
    await makeFlow().start(makeTarget("fullDiskAccess", () => true));

    expect(FakeWindow.instances).toHaveLength(0);
  });

  it.each<[string, (flow: Flow, grant: () => void) => unknown]>([
    [
      "the grant lands",
      async (_flow, grant) => {
        grant();
        await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(GRANTED_LINGER_MS);
      },
    ],
    ["the owner dismisses it", (flow) => flow.stop()],
    ["the panel is closed from outside", () => FakeWindow.instances[0].destroy()],
    ["it times out", () => vi.advanceTimersByTimeAsync(FLOW_TIMEOUT_MS)],
  ])("ends, destroying the panel, when %s", async (_name, end) => {
    let granted = false;
    const flow = makeFlow();
    const f = track(flow.start(makeTarget("fullDiskAccess", () => granted)));
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWindow.instances).toHaveLength(1);
    expect(f.ended).toBe(false);

    await end(flow, () => {
      granted = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(f.ended).toBe(true);
    expect(live()).toHaveLength(0);
  });

  it("ends the replaced flow when a different switch takes over, and leaves the new panel up until it ends", async () => {
    const flow = makeFlow();
    const a = track(flow.start(makeTarget("a", () => false)));
    await vi.advanceTimersByTimeAsync(0);

    const b = track(flow.start(makeTarget("b", () => false)));
    // Also delivers A's late `closed`, which must leave B's flow alone.
    await vi.advanceTimersByTimeAsync(0);

    expect(a.ended).toBe(true);
    expect(b.ended).toBe(false);
    expect(live().map((w) => w.title)).toEqual(["Grant b"]);

    flow.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.ended).toBe(true);
    expect(live()).toHaveLength(0);
  });

  it("ends the pre-empted call, and builds only the newer switch's panel, when two different switches start before either probe resolves", async () => {
    const flow = makeFlow();
    // No await between these two calls — both probes race.
    const a = track(flow.start(makeTarget("a", () => false)));
    const b = track(flow.start(makeTarget("b", () => false)));
    await vi.advanceTimersByTimeAsync(0);

    expect(a.ended).toBe(true);
    expect(b.ended).toBe(false);
    expect(live().map((w) => w.title)).toEqual(["Grant b"]);
    expect(FakeWindow.instances).toHaveLength(1);
  });

  it("cancels a finished flow's linger timer so it cannot end the flow that replaced it", async () => {
    let grantedA = false;
    const flow = makeFlow();
    const a = track(flow.start(makeTarget("a", () => grantedA)));
    await vi.advanceTimersByTimeAsync(0);

    grantedA = true;
    // checkGranted's first tick sees the grant and arms the 2.5s linger —
    // it does not end the flow yet.
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
    expect(a.ended).toBe(false);

    // A different switch while A lingers: ends A now and starts B.
    const b = track(flow.start(makeTarget("b", () => false)));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.ended).toBe(true);

    // Past where A's linger would have fired.
    await vi.advanceTimersByTimeAsync(GRANTED_LINGER_MS);
    expect(b.ended).toBe(false);
    expect(live().map((w) => w.title)).toEqual(["Grant b"]);
  });

  it("ignores a replaced flow's probe that says granted after a different switch took over", async () => {
    let answerStale!: (granted: boolean) => void;
    let probes = 0;
    const targetA: GrantTarget = {
      ...makeTarget("a", () => false),
      // The first call is start()'s own already-granted check; the second,
      // checkGranted's first tick, is held open under this test's control.
      probe: async () => (++probes === 1 ? false : new Promise<boolean>((r) => (answerStale = r))),
    };
    const flow = makeFlow();
    void flow.start(targetA);
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);

    const b = track(flow.start(makeTarget("b", () => false)));
    await vi.advanceTimersByTimeAsync(0);
    answerStale(true);
    await vi.advanceTimersByTimeAsync(GRANTED_LINGER_MS);

    expect(b.ended).toBe(false);
    expect(live().map((w) => w.title)).toEqual(["Grant b"]);
  });

  it("shares one flow and builds one panel for a same-switch double call before the probe resolves", async () => {
    const flow = makeFlow();
    const target = makeTarget("fullDiskAccess", () => false);

    // No await between these two calls: both hit start() while the first
    // one's probe is still in flight and no panel exists yet.
    const p1 = flow.start(target);
    expect(flow.start(target)).toBe(p1);
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeWindow.instances).toHaveLength(1);
  });

  it("builds no panel when stopped while the initial probe is still in flight", async () => {
    let resolveProbe!: (granted: boolean) => void;
    const target: GrantTarget = {
      ...makeTarget("fullDiskAccess", () => false),
      probe: () => new Promise<boolean>((resolve) => (resolveProbe = resolve)),
    };
    const flow = makeFlow();

    const f = flow.start(target);
    flow.stop();
    await f;

    // The probe finally resolves, long after the flow was dismissed.
    resolveProbe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWindow.instances).toHaveLength(0);

    // The flow is left clean: starting the same switch again works normally.
    void flow.start(makeTarget("fullDiskAccess", () => false));
    await vi.advanceTimersByTimeAsync(0);
    expect(live()).toHaveLength(1);
  });

  it.each<[string, () => GrantTarget, number]>([
    [
      "the probe rejects",
      () => ({
        ...makeTarget("fullDiskAccess", () => false),
        probe: async () => {
          throw new Error("probe boom");
        },
      }),
      0,
    ],
    [
      "the panel fails partway through setup",
      () => {
        FakeWindow.throwOnSetAlwaysOnTop = new Error("setAlwaysOnTop boom");
        return makeTarget("fullDiskAccess", () => false);
      },
      1,
    ],
  ])("ends, tearing down what it built, when %s — and the next start() works", async (_name, failing, built) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const flow = makeFlow();

    await flow.start(failing());
    expect(FakeWindow.instances).toHaveLength(built);
    expect(live()).toHaveLength(0);

    // The flow is left clean: the next start() builds exactly one live
    // panel, not a second one beside an orphan.
    FakeWindow.throwOnSetAlwaysOnTop = null;
    void flow.start(makeTarget("fullDiskAccess", () => false));
    await vi.advanceTimersByTimeAsync(0);
    expect(live()).toHaveLength(1);
    consoleError.mockRestore();
  });
});
