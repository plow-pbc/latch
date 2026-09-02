/**
 * The login gate, exercised as behavior: which window is on screen after each
 * transition a user can actually make.
 *
 * The fake host is a stand-in for Electron and nothing else — it records opens
 * and closes and answers "is it open?" the way real windows do. Assertions are
 * on what is open afterwards, never on which callback fired.
 */
import { describe, expect, it } from "vitest";
import { GateHost, WindowGate, gateTarget } from "../src/windowGate.js";

class FakeWindows implements GateHost {
  credential = "";
  setupComplete = false;
  main = false;
  setup = false;
  /** Every open/close in order, so a test can prove nothing thrashed. */
  readonly log: string[] = [];

  hasCredential(): boolean {
    return this.credential.trim().length > 0;
  }
  isSetupComplete(): boolean {
    return this.setupComplete;
  }
  isMainOpen(): boolean {
    return this.main;
  }
  isSetupOpen(): boolean {
    return this.setup;
  }
  openMain(): void {
    this.log.push(this.main ? "show main" : "open main");
    this.main = true;
  }
  openSetup(): void {
    this.log.push(this.setup ? "show setup" : "open setup");
    this.setup = true;
  }
  closeMain(): void {
    this.log.push("close main");
    this.main = false;
  }
  closeSetup(): void {
    this.log.push("close setup");
    this.setup = false;
  }
  quit(): void {
    this.log.push("quit");
    this.quit_ = true;
  }
  quit_ = false;
}

function build(): { host: FakeWindows; gate: WindowGate } {
  const host = new FakeWindows();
  return { host, gate: new WindowGate(host) };
}

describe("the login gate", () => {
  it.each([false, true])(
    "gives a Mac with no credential the setup window regardless of completion=%s",
    (setupComplete) => {
      const { host, gate } = build();
      host.setupComplete = setupComplete;
      gate.sync();
      expect({ main: host.main, setup: host.setup }).toEqual({ main: false, setup: true });
    },
  );

  it("keeps a credentialed Mac in setup until setup is complete", () => {
    const { host, gate } = build();
    host.credential = "plow_DEVICEtok_secret";
    gate.sync();
    expect({ main: host.main, setup: host.setup }).toEqual({ main: false, setup: true });
  });

  it("gives a credentialed, completed Mac the main window and nothing else", () => {
    const { host, gate } = build();
    host.credential = "plow_DEVICEtok_secret";
    host.setupComplete = true;
    gate.sync();
    expect({ main: host.main, setup: host.setup }).toEqual({ main: true, setup: false });
  });

  it("hands over to the main window when login completes", () => {
    const { host, gate } = build();
    gate.sync();
    expect(host.setup).toBe(true);

    // What `finishWithSession` does: the credential lands in settings, then the
    // data choice completes setup before the wizard's last button syncs the gate.
    host.credential = "plow_DEVICEtok_secret";
    expect(gate.sync()).toBe("setup");
    host.setupComplete = true;
    gate.sync();

    expect({ main: host.main, setup: host.setup }).toEqual({ main: true, setup: false });
    // Never a beat with no window at all — on macOS that is the moment the app
    // looks quit, and it is when the gate's close-means-quit rule would fire.
    expect(host.log).toEqual(["open setup", "show setup", "open main", "close setup"]);
  });

  it("puts a signed-out Mac back behind the gate", () => {
    const { host, gate } = build();
    host.credential = "plow_DEVICEtok_secret";
    host.setupComplete = true;
    gate.sync();

    host.credential = ""; // what settings:signOut writes
    host.setupComplete = false;
    gate.sync();

    expect({ main: host.main, setup: host.setup }).toEqual({ main: false, setup: true });
  });

  it("survives the round trip: signed out, back in, out again", () => {
    const { host, gate } = build();
    gate.sync();
    host.credential = "plow_DEVICEtok_secret";
    host.setupComplete = true;
    gate.sync();
    host.credential = "";
    host.setupComplete = false;
    gate.sync();
    host.credential = "plow_DEVICEtok_again";
    host.setupComplete = true;
    gate.sync();

    expect({ main: host.main, setup: host.setup }).toEqual({ main: true, setup: false });
  });

  it("opens nothing new when nothing changed, because activate and the tray call it", () => {
    const { host, gate } = build();
    host.credential = "plow_DEVICEtok_secret";
    host.setupComplete = true;
    gate.sync();
    gate.sync();
    gate.sync();

    // Three syncs, one window: the later ones only show what is already there.
    expect(host.log).toEqual(["open main", "show main", "show main"]);
  });

  it("treats a blank-but-not-empty credential as no credential", () => {
    const { host, gate } = build();
    host.credential = "   \n";
    gate.sync();
    expect({ main: host.main, setup: host.setup }).toEqual({ main: false, setup: true });
  });

  it("reports which window it settled on", () => {
    const { host, gate } = build();
    expect(gate.sync()).toBe("setup");
    host.credential = "plow_DEVICEtok_secret";
    host.setupComplete = true;
    expect(gate.sync()).toBe("main");
  });

  it("quits when the gate itself is closed — there is nothing behind it", () => {
    const { host, gate } = build();
    gate.sync();
    host.setup = false; // the user closed the window

    expect(gate.setupClosed()).toBe("quit");
    expect(host.quit_).toBe(true);
    expect(host.main).toBe(false);
  });

  it("hands over to the app when the completed setup window closes", () => {
    // Completion is already persisted, so closing is the same handoff as the
    // final in-body button rather than an escape around required setup.
    const { host, gate } = build();
    gate.sync();
    host.credential = "plow_DEVICEtok_secret"; // login completed on that screen
    host.setupComplete = true;
    host.setup = false; // the user closed it rather than clicking Continue

    expect(gate.setupClosed()).toBe("main");
    expect(host.quit_).toBe(false);
    expect({ main: host.main, setup: host.setup }).toEqual({ main: true, setup: false });
  });

  it("does not quit when the gate closes as part of the handover", () => {
    // `sync` closes the setup window itself once the main one is open, and that
    // close fires the same handler. It must not be read as the user quitting.
    const { host, gate } = build();
    gate.sync();
    host.credential = "plow_DEVICEtok_secret";
    host.setupComplete = true;
    gate.sync(); // opens main, closes setup

    expect(gate.setupClosed()).toBe("main");
    expect(host.quit_).toBe(false);
    expect(host.main).toBe(true);
  });

  it("quits when setup is closed after sign-in but before completion", () => {
    const { host, gate } = build();
    host.credential = "plow_DEVICEtok_secret";
    gate.sync();
    host.setup = false;

    expect(gate.setupClosed()).toBe("quit");
    expect(host.quit_).toBe(true);
    expect(host.main).toBe(false);
  });

  it("decides on credential plus completion", () => {
    expect(gateTarget(false, false)).toBe("setup");
    expect(gateTarget(false, true)).toBe("setup");
    expect(gateTarget(true, false)).toBe("setup");
    expect(gateTarget(true, true)).toBe("main");
  });
});
