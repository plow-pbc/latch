import { describe, expect, it } from "vitest";
import { KeepAwake, KeepAwakeOptions, PowerSource, SHORT_LIVED_HOLD_MS } from "../src/keepAwake.js";

/**
 * Ported alongside keepAwake.ts from the Phoenix app's KeepMacAwakeTests: all
 * state checks go through the injected blocker/store counters — the class
 * exposes nothing test-only.
 */

class FakeBlocker {
  starts = 0;
  stops: number[] = [];
  refuse = false;
  private nextId = 1;
  start = (): number | null => {
    if (this.refuse) return null;
    this.starts += 1;
    return this.nextId++;
  };
  stop = (id: number): void => {
    this.stops.push(id);
  };
  get held(): number {
    return this.starts - this.stops.length;
  }
}

class FakePower {
  source: PowerSource;
  private listeners: ((s: PowerSource) => void)[] = [];
  constructor(source: PowerSource) {
    this.source = source;
  }
  current = (): PowerSource => this.source;
  subscribe = (cb: (s: PowerSource) => void): (() => void) => {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  };
  get subscribed(): boolean {
    return this.listeners.length > 0;
  }
  /** Deliver a notification as IOKit would — including same-value rebroadcasts. */
  fire(source: PowerSource): void {
    this.source = source;
    for (const cb of [...this.listeners]) cb(source);
  }
}

/** Virtual clock: pending debounce work with a manual flush. */
class FakeScheduler {
  pending: (() => void)[] = [];
  cancelled = 0;
  schedule = (_delayMs: number, work: () => void): (() => void) => {
    this.pending.push(work);
    return () => {
      this.cancelled += 1;
      this.pending = this.pending.filter((w) => w !== work);
    };
  };
  flush(): void {
    const work = [...this.pending];
    this.pending = [];
    for (const w of work) w();
  }
}

function harness(opts: { seeded?: boolean; power?: PowerSource; refuse?: boolean } = {}) {
  const blocker = new FakeBlocker();
  blocker.refuse = opts.refuse ?? false;
  const power = new FakePower(opts.power ?? "ac");
  const scheduler = new FakeScheduler();
  const clock = { t: 0 };
  let stored = opts.seeded ?? false;
  const saves: boolean[] = [];
  const options: KeepAwakeOptions = {
    blocker,
    power,
    load: () => stored,
    save: (on) => {
      stored = on;
      saves.push(on);
    },
    schedule: scheduler.schedule,
    now: () => clock.t,
  };
  const keepAwake = new KeepAwake(options);
  return { keepAwake, blocker, power, scheduler, clock, saves, stored: () => stored };
}

describe("KeepAwake", () => {
  it("is off by default and holds nothing", () => {
    const h = harness();
    expect(h.keepAwake.isEnabled).toBe(false);
    expect(h.blocker.starts).toBe(0);
  });

  it("acquires on enable while on AC, and persists the opt-in", () => {
    const h = harness();
    expect(h.keepAwake.setEnabled(true)).toBe(true);
    expect(h.blocker.held).toBe(1);
    expect(h.stored()).toBe(true);
  });

  it("enable on battery persists the opt-in but holds nothing", () => {
    const h = harness({ power: "battery" });
    expect(h.keepAwake.setEnabled(true)).toBe(true);
    expect(h.blocker.starts).toBe(0);
    expect(h.stored()).toBe(true);
  });

  it("disable releases the blocker", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.keepAwake.setEnabled(false);
    expect(h.blocker.held).toBe(0);
    expect(h.stored()).toBe(false);
  });

  it("a refused acquire reverts the toggle and persists false", () => {
    const h = harness({ refuse: true });
    expect(h.keepAwake.setEnabled(true)).toBe(false);
    expect(h.keepAwake.isEnabled).toBe(false);
    expect(h.stored()).toBe(false);
    expect(h.blocker.held).toBe(0);
  });

  it("a seeded-true launch on AC acquires at construction", () => {
    const h = harness({ seeded: true });
    expect(h.keepAwake.isEnabled).toBe(true);
    expect(h.blocker.held).toBe(1);
  });

  it("a seeded-true launch on battery holds nothing but keeps the opt-in", () => {
    const h = harness({ seeded: true, power: "battery" });
    expect(h.keepAwake.isEnabled).toBe(true);
    expect(h.blocker.starts).toBe(0);
    expect(h.stored()).toBe(true);
  });

  it("a seeded-true launch whose acquire is refused reverts and persists false", () => {
    const h = harness({ seeded: true, refuse: true });
    expect(h.keepAwake.isEnabled).toBe(false);
    expect(h.stored()).toBe(false);
  });

  it("AC→battery releases only after the debounce fires", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.power.fire("battery");
    expect(h.blocker.held).toBe(1); // still held inside the window
    h.scheduler.flush();
    expect(h.blocker.held).toBe(0);
  });

  it("a replug inside the debounce window cancels the release and never churns", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.power.fire("battery");
    h.power.fire("ac");
    expect(h.scheduler.pending.length).toBe(0);
    h.scheduler.flush(); // nothing pending; nothing changes
    expect(h.blocker.held).toBe(1);
    expect(h.blocker.starts).toBe(1); // the original hold, never re-acquired
  });

  it("repeat battery notifications do not reschedule the in-flight debounce", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.power.fire("battery");
    h.power.fire("battery"); // charging→charged style rebroadcast
    expect(h.scheduler.pending.length).toBe(1);
    expect(h.scheduler.cancelled).toBe(0);
  });

  it("battery→AC reacquires immediately", () => {
    const h = harness({ power: "battery" });
    h.keepAwake.setEnabled(true);
    expect(h.blocker.held).toBe(0);
    h.power.fire("ac");
    expect(h.blocker.held).toBe(1);
  });

  it("toggling off inside the debounce window releases and the late fire is a no-op", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.power.fire("battery");
    h.keepAwake.setEnabled(false);
    expect(h.blocker.held).toBe(0);
    h.scheduler.flush();
    expect(h.blocker.held).toBe(0);
    expect(h.blocker.starts).toBe(1);
  });

  it("toggling inside the debounce window reads the live power source, not the stale one", () => {
    const h = harness();
    h.power.fire("battery"); // truth updated synchronously, release debounced
    expect(h.keepAwake.setEnabled(true)).toBe(true);
    expect(h.blocker.starts).toBe(0); // no stale-AC acquire on actual battery
  });

  it("teardown releases, cancels the pending debounce, and unsubscribes", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.power.fire("battery");
    h.keepAwake.teardown();
    expect(h.blocker.held).toBe(0);
    expect(h.scheduler.pending.length).toBe(0);
    expect(h.power.subscribed).toBe(false);
  });

  it("a callback already in flight when teardown ran mutates nothing", () => {
    // A subscription whose unsubscribe does nothing stands in for the
    // dispatched-but-not-yet-run notification teardown's unsubscribe misses.
    const listeners: ((s: PowerSource) => void)[] = [];
    const blocker = new FakeBlocker();
    const scheduler = new FakeScheduler();
    let stored = false;
    const ka = new KeepAwake({
      blocker,
      power: {
        current: () => "ac",
        subscribe: (cb) => {
          listeners.push(cb);
          return () => {};
        },
      },
      load: () => stored,
      save: (on) => {
        stored = on;
      },
      schedule: scheduler.schedule,
    });
    ka.setEnabled(true);
    ka.teardown();
    listeners[0]("battery");
    listeners[0]("ac");
    expect(blocker.held).toBe(0);
    expect(scheduler.pending.length).toBe(0);
  });

  it("a debounce firing after teardown mutates nothing", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.power.fire("battery");
    const work = [...h.scheduler.pending];
    h.keepAwake.teardown();
    for (const w of work) w(); // the timer the cancel missed
    expect(h.blocker.held).toBe(0);
    expect(h.blocker.starts).toBe(1);
  });

  it("persists the ask before touching the blocker", () => {
    // A save that throws must leave the hold as it was — never a released
    // hold with a stale true on disk resurrecting the block next launch.
    const sequence: string[] = [];
    const blocker = new FakeBlocker();
    let stored = false;
    const ka = new KeepAwake({
      blocker: {
        start: () => {
          sequence.push("start");
          return blocker.start();
        },
        stop: (id) => {
          sequence.push("stop");
          blocker.stop(id);
        },
      },
      power: { current: () => "ac", subscribe: () => () => {} },
      load: () => stored,
      save: (on) => {
        sequence.push(`save:${on}`);
        stored = on;
      },
      schedule: new FakeScheduler().schedule,
    });
    ka.setEnabled(true);
    ka.setEnabled(false);
    expect(sequence).toEqual(["save:false", "save:true", "start", "save:false", "stop"]);
  });

  it("a save that throws while disabling leaves the hold in place", () => {
    const blocker = new FakeBlocker();
    let stored = false;
    let explode = false;
    const ka = new KeepAwake({
      blocker,
      power: { current: () => "ac", subscribe: () => () => {} },
      load: () => stored,
      save: (on) => {
        if (explode) throw new Error("disk full");
        stored = on;
      },
      schedule: new FakeScheduler().schedule,
    });
    ka.setEnabled(true);
    explode = true;
    expect(() => ka.setEnabled(false)).toThrow("disk full");
    // Disk still says true and the hold still stands — consistent across a
    // relaunch, instead of a released hold the file promises is held.
    expect(stored).toBe(true);
    expect(blocker.held).toBe(1);
  });

  it("a lost hold is reacquired while it should stand", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.clock.t += SHORT_LIVED_HOLD_MS; // an established hold, not a young one
    h.keepAwake.blockerLost(1); // the id FakeBlocker handed out
    expect(h.blocker.starts).toBe(2);
    // The dead hold is forgotten, not released — nothing stops a pid that
    // already exited.
    expect(h.blocker.stops).toEqual([]);
  });

  it("a stale loss report — an id no longer held — is a no-op", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.keepAwake.blockerLost(999);
    expect(h.blocker.starts).toBe(1);
    h.keepAwake.setEnabled(false);
    h.keepAwake.blockerLost(1); // its own release racing the exit event
    expect(h.blocker.starts).toBe(1);
    expect(h.blocker.held).toBe(0);
  });

  it("a hold lost on battery — inside the debounce window — is not reacquired", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.clock.t += SHORT_LIVED_HOLD_MS; // past the young-hold guard, so battery is the reason
    h.power.fire("battery");
    h.keepAwake.blockerLost(1);
    expect(h.blocker.starts).toBe(1);
    h.scheduler.flush(); // the debounced release finds nothing left to release
    expect(h.blocker.stops).toEqual([]);
  });

  it("a loss report after teardown mutates nothing", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.keepAwake.teardown();
    h.keepAwake.blockerLost(1);
    expect(h.blocker.starts).toBe(1);
    expect(h.blocker.held).toBe(0);
  });

  it("a hold that dies young is not respawned, and the next transition retries", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.clock.t += SHORT_LIVED_HOLD_MS - 1;
    h.keepAwake.blockerLost(1);
    // No respawn: something is killing caffeinate on sight, and a per-exit
    // reacquire would be a spawn loop.
    expect(h.blocker.starts).toBe(1);
    expect(h.keepAwake.isEnabled).toBe(true);
    expect(h.stored()).toBe(true);
    h.power.fire("battery");
    h.scheduler.flush();
    h.power.fire("ac");
    expect(h.blocker.starts).toBe(2);
  });

  it("a refused reacquire after a lost hold keeps the opt-in", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.clock.t += SHORT_LIVED_HOLD_MS;
    h.blocker.refuse = true;
    h.keepAwake.blockerLost(1);
    expect(h.keepAwake.isEnabled).toBe(true);
    expect(h.stored()).toBe(true);
  });

  it("a refused reacquire on replug keeps the opt-in and retries on the next transition", () => {
    const h = harness();
    h.keepAwake.setEnabled(true);
    h.power.fire("battery");
    h.scheduler.flush();
    h.blocker.refuse = true;
    h.power.fire("ac"); // refused — not a revert, only a toggle answers its caller
    expect(h.keepAwake.isEnabled).toBe(true);
    expect(h.stored()).toBe(true);
    h.blocker.refuse = false;
    h.power.fire("battery");
    h.scheduler.flush();
    h.power.fire("ac");
    expect(h.blocker.held).toBe(1);
  });
});
