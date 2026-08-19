/**
 * The approval window's lifecycle rules, driven through the production opener.
 *
 * These are the rules a user experiences as "where did my approval go": whether
 * the window closes when the answer has landed, whether it stays when they
 * still have something to do, and whether a state recorded while the renderer
 * was still building its DOM reaches it at all.
 *
 * Electron is injected rather than mocked away — `main.ts` calls this same
 * function with the real `BrowserWindow` and `ipcMain`, and a real Electron
 * driver runs it against both. What stands in here is the *host*, so the rules
 * can be exercised without a display; the logic under test is production code.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  ApprovalWindowDeps,
  ContinuationChange,
  ContinuationSnapshot,
  runApprovalWindow,
} from "../src/approvalWindow.js";
import { ContinuationPhase } from "../src/continuationView.js";

const INTENT = "INTENT-1";
const REQUEST = { kind: "intent" as const, view: { intentId: INTENT } };

/** A BrowserWindow's surface, recording what production asks of it. */
class FakeWindow {
  destroyed = false;
  sizes: { width: number; height: number }[] = [];
  sent: { channel: string; payload: unknown }[] = [];
  private readonly closeHandlers: (() => void)[] = [];
  readonly webContents = {
    send: (channel: string, payload: unknown) => {
      this.sent.push({ channel, payload });
    },
  };
  isDestroyed(): boolean {
    return this.destroyed;
  }
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const h of this.closeHandlers) h();
  }
  setContentSize(width: number, height: number): void {
    this.sizes.push({ width, height });
  }
  on(event: string, handler: () => void): void {
    if (event === "closed") this.closeHandlers.push(handler);
  }
  /** Channels the renderer was told about, in order. */
  channels(): string[] {
    return this.sent.map((s) => s.channel);
  }
  lastOn(channel: string): unknown {
    return [...this.sent].reverse().find((s) => s.channel === channel)?.payload;
  }
}

/** ipcMain's surface: handlers a renderer invokes, listeners it sends to. */
class FakeIpc {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn);
  }
  handleOnce(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  on(channel: string, fn: (...args: unknown[]) => void): void {
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), fn]);
  }
  removeListener(channel: string, fn: (...args: unknown[]) => void): void {
    this.listeners.set(channel, (this.listeners.get(channel) ?? []).filter((f) => f !== fn));
  }
  /** The renderer's `invoke`. */
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn({}, ...args);
  }
  /** The renderer's `send`. */
  emit(channel: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(channel) ?? []) fn({}, ...args);
  }
  has(channel: string): boolean {
    return this.handlers.has(channel);
  }
}

/** A stand-in for the continuation registry, driven the way the relay drives it. */
class FakeContinuations {
  readonly events = new EventEmitter();
  private snap: ContinuationSnapshot;
  constructor(deadlineAt: number | null) {
    this.snap = { state: "waiting_inline", deadlineAt, deliveryUnknown: false };
  }
  snapshot(): ContinuationSnapshot {
    return this.snap;
  }
  subscribe(listener: (change: ContinuationChange) => void): () => void {
    this.events.on("change", listener);
    return () => this.events.removeListener("change", listener);
  }
  /** Record a change, exactly as `Continuations.announce` does. */
  record(state: ContinuationPhase, deliveryUnknown = this.snap.deliveryUnknown): void {
    this.snap = { ...this.snap, state, deliveryUnknown };
    this.events.emit("change", { intentId: INTENT, state, deliveryUnknown });
  }
}

interface Harness {
  win: FakeWindow;
  ipc: FakeIpc;
  cont: FakeContinuations;
  decision: Promise<string>;
  /** Drive the renderer's own startup: pull the model, then announce ready. */
  rendererStarts(): Promise<unknown>;
}

function open(
  overrides: Partial<ApprovalWindowDeps> = {},
  deadlineAt: number | null = Date.now() + 9_000,
): Harness {
  const win = new FakeWindow();
  const ipc = new FakeIpc();
  const cont = new FakeContinuations(deadlineAt);
  const decision = runApprovalWindow(REQUEST, {
    ipc: ipc as unknown as ApprovalWindowDeps["ipc"],
    createWindow: () => win as unknown as ReturnType<ApprovalWindowDeps["createWindow"]>,
    loadFile: async () => {},
    continuation: cont,
    lingerMs: 10_000,
    ...overrides,
  });
  return {
    win,
    ipc,
    cont,
    decision,
    rendererStarts: async () => {
      const model = await ipc.invoke("approval:get");
      await ipc.invoke("approval:ready");
      return model;
    },
  };
}

describe("a terminal state destroys the window", () => {
  it("closes when the agent collects the result", async () => {
    const h = open();
    await h.rendererStarts();
    h.cont.record("backgrounded");
    h.ipc.emit("approval:decide", INTENT, "allow_once");
    expect(await h.decision).toBe("allow_once");

    h.cont.record("approved_uncollected");
    expect(h.win.destroyed).toBe(false);

    // The agent came back for it. There is nothing left to show, and the
    // renderer knowing that is not enough — something has to act on it.
    h.cont.record("collected");
    expect(h.win.destroyed).toBe(true);
  });

  it("closes on a failure that lands after the window became a confirmation", async () => {
    const h = open();
    await h.rendererStarts();
    h.cont.record("backgrounded");
    h.ipc.emit("approval:decide", INTENT, "allow_once");
    await h.decision;
    expect(h.win.destroyed).toBe(false);

    h.cont.record("failed");
    expect(h.win.destroyed).toBe(true);
  });

  it("closes on a denial recorded for the operation", async () => {
    const h = open();
    await h.rendererStarts();
    h.cont.record("backgrounded");
    h.ipc.emit("approval:decide", INTENT, "allow_once");
    await h.decision;

    h.cont.record("denied");
    expect(h.win.destroyed).toBe(true);
  });

  it("leaves an expired result on screen — that one the user has to read", async () => {
    // Expiry is the ending a user needs told, not one to tidy away: their
    // approval was granted and the agent never came back for it.
    const h = open();
    await h.rendererStarts();
    h.cont.record("backgrounded");
    h.ipc.emit("approval:decide", INTENT, "allow_once");
    await h.decision;

    h.cont.record("approved_uncollected");
    h.cont.record("expired");
    expect(h.win.destroyed).toBe(false);
    expect(h.win.lastOn("approval:continuation")).toMatchObject({ state: "expired" });
  });
});

describe("no snapshot/subscription race", () => {
  it("replays the state recorded while the renderer was still building its DOM", async () => {
    const h = open();
    // The renderer has pulled its model but has not announced its listeners.
    const model = (await h.ipc.invoke("approval:get")) as { continuation: ContinuationSnapshot };
    expect(model.continuation.state).toBe("waiting_inline");

    // The relay acknowledges in that gap. Under the old shape this vanished:
    // the window went on counting down a call that had already been handed off.
    h.cont.record("backgrounded");
    expect(h.win.channels()).not.toContain("approval:continuation");

    await h.ipc.invoke("approval:ready");
    expect(h.win.lastOn("approval:continuation")).toMatchObject({ state: "backgrounded" });
  });

  it("replays only the latest, not a backlog the user would watch flicker past", async () => {
    const h = open();
    await h.ipc.invoke("approval:get");
    h.cont.record("backgrounded");
    h.cont.record("approved_uncollected");
    await h.ipc.invoke("approval:ready");

    const changes = h.win.sent.filter((s) => s.channel === "approval:continuation");
    expect(changes.length).toBe(1);
    expect(changes[0].payload).toMatchObject({ state: "approved_uncollected" });
  });

  it("acts on a terminal state that landed during the gap", async () => {
    // An always-allow rule answers the operation while this window is still
    // loading, and the agent collects the result — all before the renderer can
    // hear any of it. The window must not be left sitting there.
    const h = open();
    await h.ipc.invoke("approval:get");
    h.cont.record("backgrounded");
    h.cont.record("collected");
    // Not yet — nobody is listening, and closing before the renderer exists
    // would race its own load.
    expect(h.win.destroyed).toBe(false);

    await h.ipc.invoke("approval:ready");
    expect(h.win.destroyed).toBe(true);
    // Closing an unanswered window is a denial, which is the fail-safe.
    expect(await h.decision).toBe("deny");
  });
});

describe("the decision and the confirmation", () => {
  it("resolves inline and closes when the call is demonstrably still open", async () => {
    const h = open();
    await h.rendererStarts();
    h.ipc.emit("approval:decide", INTENT, "deny");
    expect(await h.decision).toBe("deny");
    expect(h.win.destroyed).toBe(true);
    expect(h.win.sizes).toEqual([]);
  });

  it("shrinks to a compact confirmation when the call is already gone", async () => {
    const h = open();
    await h.rendererStarts();
    h.cont.record("backgrounded");
    h.ipc.emit("approval:decide", INTENT, "allow_once");
    expect(await h.decision).toBe("allow_once");

    expect(h.win.destroyed).toBe(false);
    expect(h.win.sizes).toEqual([{ width: 460, height: 190 }]);
    expect(h.win.lastOn("approval:decided")).toEqual({ intentId: INTENT });
  });

  it("stays open on a decision made after delivery could not be confirmed", async () => {
    // Nobody knows whether the agent is still there, so the user is told what
    // to do about it rather than having the window vanish.
    const h = open({}, Date.now() - 1);
    await h.rendererStarts();
    h.ipc.emit("approval:decide", INTENT, "allow_once");
    await h.decision;
    expect(h.win.destroyed).toBe(false);
    expect(h.win.sizes).toEqual([{ width: 460, height: 190 }]);
  });

  it("ignores a decision for a different intent", async () => {
    const h = open();
    await h.rendererStarts();
    h.ipc.emit("approval:decide", "SOMEONE-ELSE", "allow_once");
    expect(h.win.destroyed).toBe(false);
    h.ipc.emit("approval:decide", INTENT, "deny");
    expect(await h.decision).toBe("deny");
  });

  it("dismisses only once the decision is in — never as a silent deny", async () => {
    const h = open();
    await h.rendererStarts();
    h.cont.record("backgrounded");

    // A dismiss before answering must do nothing at all.
    h.ipc.emit("approval:dismiss", INTENT);
    expect(h.win.destroyed).toBe(false);

    h.ipc.emit("approval:decide", INTENT, "always_allow");
    await h.decision;
    h.ipc.emit("approval:dismiss", INTENT);
    expect(h.win.destroyed).toBe(true);
  });

  it("closes itself after the linger, and denies if closed unanswered", async () => {
    const h = open({ lingerMs: 20 });
    await h.rendererStarts();
    h.cont.record("backgrounded");
    h.ipc.emit("approval:decide", INTENT, "allow_once");
    await h.decision;
    await new Promise((r) => setTimeout(r, 60));
    expect(h.win.destroyed).toBe(true);

    const unanswered = open();
    await unanswered.rendererStarts();
    unanswered.win.close();
    expect(await unanswered.decision).toBe("deny");
  });

  it("stops listening to the registry once the window is gone", async () => {
    const h = open();
    await h.rendererStarts();
    expect(h.cont.events.listenerCount("change")).toBe(1);
    h.ipc.emit("approval:decide", INTENT, "deny");
    await h.decision;
    expect(h.cont.events.listenerCount("change")).toBe(0);
    // And the IPC handlers are gone with it, so the next window owns them.
    expect(h.ipc.has("approval:get")).toBe(false);
    expect(h.ipc.has("approval:ready")).toBe(false);
  });
});
