import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVATION_POLL_INTERVAL_MS,
  ACTIVATION_POLL_WINDOW_MS,
  Onboarding,
  OnboardingDeps,
} from "../src/onboarding.js";
import { PlowApi, PlowApiError } from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";
import { signOutOfPlow } from "../src/settingsActions.js";

const DEVICE_TOKEN = "plow_DEVICEtok_secret";
const SESSION_TOKEN = "plow_ACTIVATIONsession_secret";
const ACTIVATION_SECRET = "activation_secret_never_shown";
const DEVICE_MCP_URL = "http://localhost:4242/v1/relay/devices/device-1/mcp";

type FakeRedeem =
  | { status: "pending" }
  | { status: "verified"; token: string | null };

/** A stand-in Plow: records what was called, answers what the real one does. */
class FakePlow {
  /** Activations minted, newest last — one per `POST /v1/auth/activate`. */
  activations: string[] = [];
  /** Redeem answers, consumed in order; the last one repeats forever. `chat`
   * is optional here and defaults to none, so a test only names it when the
   * chat is what it is about. */
  redeems: Array<FakeRedeem | PlowApiError> = [{ status: "pending" }];
  redeemCalls: string[] = [];
  registrations: Array<{ token: string; deviceId: string; hostname: string }> = [];
  registrationFails = false;

  api(): PlowApi {
    return this as unknown as PlowApi;
  }

  /** Set to hold every mint open until `release()`, the way a slow API does. */
  private mintGate: Promise<void> | null = null;
  private openMintGate: (() => void) | null = null;

  /** Make `/v1/auth/activate` hang, so a test can act while a mint is in air. */
  holdActivations(): void {
    this.mintGate = new Promise((resolve) => {
      this.openMintGate = resolve;
    });
  }

  releaseActivations(): void {
    this.openMintGate?.();
    this.mintGate = null;
    this.openMintGate = null;
  }

  async createActivation(name: string) {
    if (this.mintGate) await this.mintGate;
    const secret = `${ACTIVATION_SECRET}_${this.activations.length}`;
    this.activations.push(name);
    return { displayCode: `CODE${this.activations.length}`, activationSecret: secret, sendTo: "+15550001111" };
  }

  async redeemActivation(secret: string): Promise<ActivationRedeem> {
    this.redeemCalls.push(secret);
    const next = this.redeems.length > 1 ? this.redeems.shift()! : this.redeems[0];
    if (next instanceof PlowApiError) throw next;
    if (next.status === "pending") return next;
    return { status: "verified", token: next.token, chat: null };
  }

  async relayInfo(token: string) {
    expect(token).toBe(SESSION_TOKEN);
    return { uid: "u_123" };
  }

  async registerRelayDevice(token: string, deviceId: string, hostname: string) {
    if (this.registrationFails) {
      throw new PlowApiError("http", "Plow could not register this Mac.");
    }
    this.registrations.push({ token, deviceId, hostname });
    return { mcpUrl: DEVICE_MCP_URL };
  }

  revoked: string[] = [];

  async revokeDeviceCredential(token: string): Promise<void> {
    this.revoked.push(token);
  }

}

let home: string;
let plow: FakePlow;
let started: number;
let clock: number;
/** Every `wait` the poll loop made, so a test can prove the interval. */
let waits: number[];
/** How many times the instance told the window to re-read. */
let changes: number;
/** Bumped per test; a wait built under an older value parks — see `wait`. */
let harnessGen = 0;

function build(extra: Partial<OnboardingDeps> = {}, startAtPrivacy = true): Onboarding {
  const gen = harnessGen;
  const onboarding = new Onboarding({
    api: plow.api(),
    home,
    startRelay: async () => {
      started += 1;
      const settings = loadSettings(home);
      try {
        const registered = await plow.registerRelayDevice(
          settings.relayCredential,
          "device-1",
          "test-mac",
        );
        settings.mcpUrl = registered.mcpUrl;
        saveSettings(home, settings);
      } catch {
        // Production leaves registration failures on RelayClient's backoff.
        return;
      }
    },
    deviceName: "Plow Latch (test)",
    now: () => clock,
    // No real timers: the poll loop's wait advances the same fake clock the
    // deadline is measured against, so a five-minute give-up takes microseconds
    // and is exact rather than approximately right.
    wait: async (ms) => {
      // The server's 410 ends the real loop; a fake that only ever answers
      // "pending" never gets one, so a loop can outlive its test. Under this
      // instant clock it would spin the worker to death — and even short of
      // that, it would keep mutating the next test's shared clock. Park any
      // loop from a previous test the moment it comes up for air.
      if (gen !== harnessGen) await new Promise(() => {});
      waits.push(ms);
      clock += ms;
    },
    onChange: () => {
      changes += 1;
    },
    ...extra,
  });
  // Most tests exercise the established activation mechanics.
  // Put those at Privacy, immediately before the one newly deferred mint;
  // transition tests opt out and start at Welcome.
  if (startAtPrivacy && onboarding.state().step === "welcome") void onboarding.advance();
  return onboarding;
}

/** Let the detached poll loop run until it has nothing left to do. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5000; i += 1) await Promise.resolve();
}

/** Let the poll loop run just until a condition holds — for states the loop
 * passes THROUGH rather than ends in, now that a stalled screen keeps polling. */
async function settleUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 5000 && !check(); i += 1) await Promise.resolve();
  expect(check()).toBe(true);
}

beforeEach(() => {
  harnessGen += 1;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-onboarding-"));
  plow = new FakePlow();
  started = 0;
  waits = [];
  changes = 0;
  clock = 1_700_000_000_000;
});

afterEach(() => {
  // Park every poll loop this test left running, BEFORE the next test exists.
  // An activation that never completes polls forever, and `wait` resolves
  // instantly under the fake clock — so a loop still live when the file's last
  // test ends spins until its `waits` array hits V8's element limit and takes
  // the worker with it. Bumping here makes the park unconditional.
  harnessGen += 1;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("wizard steps around the existing verification flow", () => {
  it("does no network work on Welcome or Privacy and mints on Privacy Continue", async () => {
    const onboarding = build({}, false);

    expect(onboarding.state().step).toBe("welcome");
    expect((await onboarding.begin()).step).toBe("welcome");
    expect(plow.activations).toEqual([]);

    expect((await onboarding.advance()).step).toBe("privacy");
    expect((await onboarding.begin()).step).toBe("privacy");
    expect(plow.activations).toEqual([]);

    const verify = await onboarding.advance();
    expect(verify.step).toBe("activate");
    expect(verify.activation?.displayCode).toBe("CODE1");
    expect(plow.activations).toEqual(["Plow Latch (test)"]);
    onboarding.reset();
  });

  it("backs from Privacy to Welcome", async () => {
    const onboarding = build({}, false);
    await onboarding.advance();
    expect((await onboarding.back()).step).toBe("welcome");
  });

  it.each(["activate", "waiting"] as const)(
    "backs from %s to Privacy without discarding the activation",
    async (step) => {
      const onboarding = build();
      const verify = await onboarding.advance();
      if (step === "waiting") onboarding.messagesOpened();

      expect((await onboarding.back()).step).toBe("privacy");
      expect(onboarding.state().activation?.displayCode).toBe(verify.activation?.displayCode);
      expect(plow.activations).toHaveLength(1);
      onboarding.reset();
    },
  );

  it("re-enters a live verification on the activation-code view", async () => {
    const pendingWaits: Array<() => void> = [];
    const onboarding = build({
      wait: () => new Promise<void>((resolve) => pendingWaits.push(resolve)),
    });
    const verify = await onboarding.advance();
    const displayCode = verify.activation?.displayCode;
    onboarding.messagesOpened();
    expect((await onboarding.back()).step).toBe("privacy");

    pendingWaits.shift()!();
    await settleUntil(() => plow.redeemCalls.length === 1);
    const reentered = await onboarding.advance();

    expect(reentered.step).toBe("activate");
    expect(reentered.activation?.displayCode).toBe(displayCode);
    expect(plow.activations).toHaveLength(1);
    onboarding.reset();
  });

  it("re-enters a locally stale verification on its waiting view", async () => {
    const pendingWaits: Array<() => void> = [];
    const onboarding = build({
      wait: () => new Promise<void>((resolve) => pendingWaits.push(resolve)),
    });
    const verify = await onboarding.advance();
    const displayCode = verify.activation?.displayCode;
    onboarding.messagesOpened();
    await onboarding.back();

    clock = verify.activation!.pollUntil + 1;
    pendingWaits.shift()!();
    await settleUntil(() => onboarding.state().activationStale);
    const reentered = await onboarding.advance();

    expect(reentered.step).toBe("waiting");
    expect(reentered.activation?.displayCode).toBe(displayCode);
    expect(plow.activations).toHaveLength(1);
    onboarding.reset();
  });

  it("offers Back from Availability and Connect but not from Verified, Data or Done", async () => {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    let notifications = 0;
    const onboarding = build(
      {
        onChange: () => {
          notifications += 1;
        },
      },
    );

    await onboarding.advance();
    await settle();
    expect(onboarding.state().step).toBe("verified");
    notifications = 0;
    expect((await onboarding.back()).step).toBe("verified");
    expect(notifications).toBe(0);

    expect((await onboarding.advance()).step).toBe("data");
    notifications = 0;
    expect((await onboarding.back()).step).toBe("data");
    expect(notifications).toBe(0);

    expect((await onboarding.advance()).step).toBe("availability");
    notifications = 0;
    expect((await onboarding.back()).step).toBe("data");
    expect(notifications).toBe(1);

    await onboarding.advance();
    expect((await onboarding.advance()).step).toBe("connect");
    notifications = 0;
    expect((await onboarding.back()).step).toBe("availability");
    expect(notifications).toBe(1);

    await onboarding.advance();
    await onboarding.advance();
    notifications = 0;
    expect((await onboarding.back()).step).toBe("done");
    expect(notifications).toBe(0);
  });

  it("does not publish an ignored telemetry choice", () => {
    let notifications = 0;
    const onboarding = build({
      onChange: () => {
        notifications += 1;
      },
    });
    notifications = 0;

    expect(onboarding.setTelemetryEnabled(false).step).toBe("privacy");
    expect(notifications).toBe(0);
  });

  it("holds a redeemed login on verified until Continue moves to data", async () => {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build({}, false);
    await onboarding.advance();
    await onboarding.advance();
    await settle();

    expect(onboarding.state().step).toBe("verified");
    expect(onboarding.state().activation?.displayCode).toBe("CODE1");
    expect(loadSettings(home).relayCredential).toBe(SESSION_TOKEN);
    expect(loadSettings(home).setupComplete).toBe(false);

    expect((await onboarding.advance()).step).toBe("data");
    expect(onboarding.state().activation).toBeNull();
  });

  it("writes telemetry on leaving data and completion only on leaving connect", async () => {
    const settings = loadSettings(home);
    settings.relayCredential = DEVICE_TOKEN;
    saveSettings(home, settings);
    const onboarding = build({}, false);

    expect(onboarding.state()).toMatchObject({ step: "data", telemetryEnabled: true });
    expect(onboarding.setTelemetryEnabled(false).telemetryEnabled).toBe(false);
    expect(loadSettings(home)).toMatchObject({ telemetryEnabled: true, setupComplete: false });

    expect((await onboarding.advance()).step).toBe("availability");
    expect(loadSettings(home)).toMatchObject({ telemetryEnabled: false, setupComplete: false });
    // The persisted gate deliberately resumes incomplete setup at Data, so a
    // returning install still makes the telemetry choice before Connect.
    expect(build({}, false).state().step).toBe("data");

    expect((await onboarding.advance()).step).toBe("connect");
    expect((await onboarding.advance()).step).toBe("done");
    expect(loadSettings(home)).toMatchObject({ telemetryEnabled: false, setupComplete: true });
    expect(build({}, false).state().step).toBe("done");
  });

  it("lands the availability default once, on reaching the screen, and keeps what it wrote", async () => {
    const settings = loadSettings(home);
    settings.relayCredential = DEVICE_TOKEN;
    saveSettings(home, settings);
    expect(loadSettings(home).launchAtLoginDefaulted).toBe(false);

    // The production dep persists Keep Awake's opt-in itself. The write must
    // survive the step's own settings write — the first cut clobbered it.
    let applied = 0;
    const applyAvailabilityDefault = () => {
      applied += 1;
      const live = loadSettings(home);
      live.keepAwakeWhileRunning = true;
      saveSettings(home, live);
    };
    let onboarding = build({ applyAvailabilityDefault }, false);
    onboarding.setTelemetryEnabled(false);
    expect((await onboarding.advance()).step).toBe("availability");
    expect(applied).toBe(1);
    expect(loadSettings(home)).toMatchObject({
      keepAwakeWhileRunning: true,
      telemetryEnabled: false,
      launchAtLoginDefaulted: true,
    });

    // A second pass (Back, Continue) is silent, and so is a re-setup over the
    // same home — sign-out keeps the marker, so a choice the user made stays.
    await onboarding.back();
    expect((await onboarding.advance()).step).toBe("availability");
    onboarding = build({ applyAvailabilityDefault }, false);
    await onboarding.advance();
    expect(applied).toBe(1);
  });

});

describe("activation — the path a brand-new user takes", () => {
  it("shows a code, says where to text it, and connects when the text lands", async () => {
    plow.redeems = [{ status: "pending" }, { status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();

    const shown = await onboarding.advance();
    expect(shown.step).toBe("activate");
    expect(shown.activation?.displayCode).toBe("CODE1");
    // The exact body, because a wrong prefix is answered with silence.
    expect(shown.activation?.smsBody).toBe("Plow Activate: CODE1");
    // Whatever the API returned — per-environment config, never a constant.
    expect(shown.activation?.sendTo).toBe("+15550001111");
    expect(shown.activation?.smsUrl).toBe("sms:+15550001111?&body=Plow%20Activate%3A%20CODE1");
    // The Mac names itself in the activation, so the session is identifiable.
    expect(plow.activations).toEqual(["Plow Latch (test)"]);

    // The user types nothing. Polling was already running before they tapped.
    expect(onboarding.messagesOpened().step).toBe("waiting");
    await settle();

    const verified = onboarding.state();
    expect(verified.step).toBe("verified");
    expect(verified.activation?.displayCode).toBe("CODE1");
    expect(waits.every((ms) => ms === ACTIVATION_POLL_INTERVAL_MS)).toBe(true);
    expect(loadSettings(home).relayCredential).toBe(SESSION_TOKEN);
    expect(plow.registrations).toEqual([
      { token: SESSION_TOKEN, deviceId: "device-1", hostname: "test-mac" },
    ]);
    expect(loadSettings(home).mcpUrl).toBe(DEVICE_MCP_URL);
    const data = await onboarding.advance();
    expect(data.step).toBe("data");
    // The spent activation is dropped after the confirmation screen.
    expect(data.activation).toBeNull();
  });

  it("polls without waiting to be told to — a hand-typed message still gets in", async () => {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.advance();
    // No messagesOpened() at all.
    await settle();

    expect(onboarding.state().step).toBe("verified");
  });

  it("does not burn a second code when the window is reopened", async () => {
    const onboarding = build();
    await onboarding.advance();
    await onboarding.begin();

    expect(plow.activations).toHaveLength(1);
  });

  it("signs in a text that lands after the screen stalled — the live mba failure", async () => {
    // Reported from a live run: code minted at 15:02, screen stalled at 15:07,
    // text sent at 15:17. The server completed the activation and held the
    // session token for the first redeem — which never came, because the old
    // loop cancelled itself at five minutes. The Mac sat on "we haven't heard
    // from your phone" while the phone said "You're all set!".
    const onboarding = build();
    await onboarding.advance();
    await settleUntil(() => onboarding.state().activationStale);
    expect(onboarding.state().step).toBe("waiting");
    expect(onboarding.state().busy).toBe(false);
    // The silent failure has no other feedback: a message that does not START
    // with the prefix gets a 200, no SMS, and a code left live.
    expect(onboarding.state().message).toContain("Plow Activate:");
    expect(onboarding.state().message).toContain("haven't heard from your phone");

    // Minute fifteen: the text arrives. No click, no new code — the next poll
    // must catch it.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    await settleUntil(() => onboarding.state().step === "verified");

    expect(loadSettings(home).relayCredential).toBe(SESSION_TOKEN);
    expect(plow.activations).toHaveLength(1);
  });

  it("never strands the user on a screen with no way to re-check", async () => {
    // Reported from a live run: the user read the code off the screen and typed
    // it into Messages themselves, so they never tapped "Open Messages" and
    // never left the initial activation screen. Giving up there used to leave
    // its recovery control on a different view, and their activation (which
    // completed server-side just after the loop stopped) could never be
    // re-checked. Dead end.
    const onboarding = build();
    await onboarding.advance();
    expect(onboarding.state().step).toBe("activate"); // never tapped Open Messages
    await settle();

    const state = onboarding.state();
    expect(state.activationStale).toBe(true);
    // "waiting" is the screen that carries the control. The invariant that
    // matters is that giving up never leaves them anywhere else.
    expect(state.step).toBe("waiting");

    // And the screen's promise holds without the control even being needed:
    // the watch never stopped, so a late text signs in on the next poll. The
    // click just re-arms the countdown; it must not break the sign-in.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    await onboarding.newActivationCode();
    await settleUntil(() => onboarding.state().step === "verified");
    expect(plow.activations).toHaveLength(1);
  });

  it("puts every give-up on the screen that can act on it", async () => {
    // One invariant covering all four ways polling can stop, so a new one
    // cannot quietly reintroduce the dead end above.
    for (const redeems of [
      [new PlowApiError("expired", "Activation expired", 410)],
      [{ status: "verified", token: null } as const],
      [{ status: "pending" } as const], // runs out the five-minute window
    ]) {
      plow = new FakePlow();
      plow.redeems = [...redeems];
      const onboarding = build();
      await onboarding.advance();
      await settle();

      expect(onboarding.state().activationStale).toBe(true);
      expect(onboarding.state().step).toBe("waiting");
    }
  });

  it("re-arms the SAME code while the server still honours it — a live code is never abandoned", async () => {
    // Minting a replacement would leave the live old code with no watcher: its
    // completion is handed out exactly once, so a user who texts the code they
    // already copied would succeed on the phone and strand the Mac — the same
    // stranding this PR exists to end.
    const onboarding = build();
    await onboarding.advance();
    await settleUntil(() => onboarding.state().activationStale);

    const state = await onboarding.newActivationCode();
    expect(plow.activations).toHaveLength(1);
    expect(state.activation?.displayCode).toBe("CODE1");
    expect(state.activationStale).toBe(false);
    expect(state.message).toContain("still works");
    expect(state.noteKind).toBe("neutral");

    // And the re-armed watch is real: a text now signs in.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    await settleUntil(() => onboarding.state().step === "verified");
  });

  it("mints a fresh code only once the server has retired the old one", async () => {
    const onboarding = build();
    await onboarding.advance();
    await settleUntil(() => onboarding.state().activationStale);

    // The POLL receives the 410 — the button never redeems. Only then does a
    // click mint.
    plow.redeems = [new PlowApiError("expired", "Activation expired", 410)];
    await settleUntil(() => onboarding.state().message.includes("expired before your text arrived"));
    const state = await onboarding.newActivationCode();
    expect(plow.activations).toHaveLength(2);
    expect(state.activation?.displayCode).toBe("CODE2");
    expect(state.activationStale).toBe(false);
    expect(state.step).toBe("activate");
  });

  it("keeps a live code through a transient failure — only a 410 says it is dead", async () => {
    // A timeout or 5xx says nothing about the code, and a click during the
    // outage must not mint over it: the abandoned code's completion has no
    // watcher — the stranding again, this time triggered by a blip.
    const onboarding = build();
    await onboarding.advance();
    await settleUntil(() => onboarding.state().activationStale);

    plow.redeems = [new PlowApiError("network", "Couldn't reach Plow.")];
    await onboarding.newActivationCode();
    expect(plow.activations).toHaveLength(1);
    expect(onboarding.state().activation?.displayCode).toBe("CODE1");

    // And the kept code still signs in when its text lands.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    await settleUntil(() => onboarding.state().step === "verified");
  });

  it("reads a verified activation exactly once, and never re-reads it", async () => {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.advance();
    await settle();

    // One redeem saw the completion and got the token. A second would come back
    // verified with the `token` key omitted entirely — so there is no second.
    expect(plow.redeemCalls).toHaveLength(1);
    expect(onboarding.state().step).toBe("verified");
  });

  it("says so, honestly, when verified comes back with no token to hand over", async () => {
    plow.redeems = [{ status: "verified", token: null }];
    const onboarding = build();
    await onboarding.advance();
    await settle();

    const state = onboarding.state();
    expect(state.step).not.toBe("connected");
    expect(state.activationStale).toBe(true);
    expect(state.message).toBe("Plow verified this Mac but didn't hand back a login. Try again for a fresh code.");
    expect(plow.redeemCalls).toHaveLength(1);

    // The spent code is dropped, so the promised control actually works: the
    // next click mints instead of re-arming a code that can never sign in.
    expect((await onboarding.newActivationCode()).activation?.displayCode).toBe("CODE2");
  });

  it("treats a 410 as authoritative and offers a fresh code", async () => {
    plow.redeems = [new PlowApiError("expired", "Activation expired", 410)];
    const onboarding = build();
    await onboarding.advance();
    await settle();

    const state = onboarding.state();
    expect(state.activationStale).toBe(true);
    expect(state.message).toContain("expired before your text arrived");
    expect(plow.redeemCalls).toHaveLength(1);
  });

  it("keeps waiting through a network blip, but says what it saw", async () => {
    plow.redeems = [
      new PlowApiError("network", "Couldn't reach Plow at http://x."),
      { status: "verified", token: SESSION_TOKEN },
    ];
    const onboarding = build();
    await onboarding.advance();
    await settle();

    expect(onboarding.state().step).toBe("verified");
    expect(plow.redeemCalls).toHaveLength(2);
  });

  it("says so when the very first call cannot reach Plow", async () => {
    plow.createActivation = async () => {
      throw new PlowApiError("network", "Couldn't reach Plow at http://localhost:4242.");
    };
    const state = await build().advance();

    expect(state.busy).toBe(false);
    expect(state.activation).toBeNull();
    expect(state.message).toBe("Couldn't reach Plow at http://localhost:4242.");
  });

  it("never lets the renderer see the activation secret", async () => {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    const shown = await onboarding.advance();
    expect(JSON.stringify(shown)).not.toContain(ACTIVATION_SECRET);

    await settle();
    expect(JSON.stringify(onboarding.state())).not.toContain(ACTIVATION_SECRET);
    expect(JSON.stringify(onboarding.state())).not.toContain(SESSION_TOKEN);
  });
});

describe("one code, however many callers ask for it", () => {
  it("does not burn a second code when two callers ask while the API is slow", async () => {
    // A display code IS a credential: whoever texts it gets the account. A
    // second one minted behind the first is live on the account, shown to
    // nobody, and revocable by nobody — the screen only ever displays one.
    plow.holdActivations();
    const onboarding = build();

    const first = onboarding.advance();
    const second = onboarding.begin();
    const third = onboarding.newActivationCode();
    plow.releaseActivations();
    const [a, b, c] = await Promise.all([first, second, third]);

    expect(plow.activations).toHaveLength(1);
    // ...and all three callers are looking at the one code that exists.
    for (const state of [a, b, c]) expect(state.activation?.displayCode).toBe("CODE1");
    onboarding.reset(); // stop the poll loop this started
  });

  it("does not mint during sign-out window boot, then single-flights Privacy Continue", async () => {
    plow.holdActivations();
    const onboarding = build();
    onboarding.reset();
    const fromSignOut = onboarding.begin();
    const fromRenderer = onboarding.begin();
    await Promise.all([fromSignOut, fromRenderer]);
    expect(plow.activations).toHaveLength(0);

    await onboarding.advance();
    const fromContinue = onboarding.advance();
    const duplicate = onboarding.begin();
    plow.releaseActivations();
    await Promise.all([fromContinue, duplicate]);
    expect(plow.activations).toHaveLength(1);
    onboarding.reset();
  });

  it("does not wedge the button once the mint has landed", async () => {
    // Single-flight must not wedge the button: "Try Again" after the mint
    // returns runs a real re-check rather than joining a spent flight — and
    // since the code is still live, the re-check re-arms it, not replaces it.
    const onboarding = build();
    await onboarding.advance();
    expect(plow.activations).toHaveLength(1);

    const state = await onboarding.newActivationCode();
    expect(state.activation?.displayCode).toBe("CODE1");
    expect(plow.activations).toHaveLength(1);
    onboarding.reset();
  });

  it("does not wedge after a mint that failed", async () => {
    const onboarding = build();
    const boom = new PlowApiError("network", "Couldn't reach Plow.");
    const original = plow.createActivation.bind(plow);
    plow.createActivation = async () => {
      throw boom;
    };
    const failed = await onboarding.advance();
    expect(failed.message).toBe("Couldn't reach Plow.");
    expect(failed.activation).toBeNull();

    plow.createActivation = original;
    const state = await onboarding.begin();
    expect(state.activation?.displayCode).toBeTruthy();
    onboarding.reset();
  });
});

describe("signing out", () => {
  it("shows the fixed revoke warning on the setup screen", () => {
    const onboarding = build({}, false);
    const warning =
      "Signed out on this Mac. Plow could not be reached to revoke the session — revoke it in Plow's account settings.";

    const state = onboarding.showMessage(warning);

    expect(state.step).toBe("welcome");
    expect(state.message).toBe(warning);
  });

  it("returns to Welcome without needing a restart", async () => {
    // Reported live: Sign Out blanked the credential in settings but left the
    // state machine on "connected", because `step` is decided in the
    // constructor. The window kept rendering the connected screen against empty
    // settings — "Signed in — connecting…", blank endpoint, blank account — and
    // the only way back to signing in was quitting the app.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.advance();
    await settle();
    expect(onboarding.state().step).toBe("verified");

    // What `settings:signOut` does to disk, then the reset it must also do.
    const settings = loadSettings(home);
    settings.relayCredential = "";
    settings.accountUid = "";
    settings.mcpUrl = "";
    saveSettings(home, settings);

    const state = onboarding.reset();
    expect(state.step).toBe("welcome");
    expect(state.activation).toBeNull();
    expect(state.busy).toBe(false);

    // From there the normal path works: Welcome and Privacy do no network,
    // then Continue from Privacy mints a code without a restart.
    expect((await onboarding.advance()).step).toBe("privacy");
    const begun = await onboarding.advance();
    expect(begun.activation?.displayCode).toBeTruthy();
  });

  /** Sign in, then blank the credential the way sign-out does. */
  async function signedInThenOut(): Promise<Onboarding> {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.advance();
    await settle();
    expect(onboarding.state().step).toBe("verified");

    const settings = loadSettings(home);
    settings.relayCredential = "";
    settings.accountUid = "";
    settings.mcpUrl = "";
    saveSettings(home, settings);
    return onboarding;
  }

  it("mints a fresh code when the user starts again", async () => {
    const onboarding = await signedInThenOut();
    onboarding.reset();
    await onboarding.advance();
    const state = await onboarding.advance();
    expect(state.step).toBe("activate");
    expect(state.activation?.displayCode).toBeTruthy();
    expect(plow.activations.length).toBe(2);

    // Leaving Privacy starts a detached poll loop, and its injected `wait`
    // advances the clock every test in this file shares. Left running it drifts
    // the next test's deadlines — so stop it, the way every other exit from
    // that screen does.
    onboarding.reset();
  });

  it("keeps nothing from the session that ended", async () => {
    const onboarding = await signedInThenOut();
    const state = onboarding.reset();
    expect(state.activation).toBeNull();
    expect(JSON.stringify(state)).not.toContain(DEVICE_TOKEN);
    expect(JSON.stringify(state)).not.toContain(SESSION_TOKEN);
  });

  it("stays on the data screen if a credential is somehow still there", () => {
    // reset() re-derives from settings rather than assuming; a reset with a
    // live credential must not throw the user back to activation.
    const onboarding = build();
    const settings = loadSettings(home);
    settings.relayCredential = DEVICE_TOKEN;
    saveSettings(home, settings);
    expect(onboarding.reset().step).toBe("data");
  });
});

describe("reading the state is a read", () => {
  it("never notifies, because the renderer re-reads on every notification", async () => {
    // The bug this pins: `onboarding:get` was wired to a `refresh()` that
    // called `publish()`. The renderer's change handler calls `get`. So a read
    // triggered a change, which triggered a read — about 5,000 re-renders a
    // second, each one rebuilding the DOM with `replaceChildren`. The window
    // rendered perfectly and accepted no click and no keystroke, because focus
    // could not survive and mousedown/mouseup never landed on the same node.
    //
    // Asserting on renders-per-second would be a timing test. The invariant is
    // simpler and exact: reading must not notify.
    let notifications = 0;
    const onboarding = build(
      {
        onChange: () => {
          notifications += 1;
        },
      },
      false,
    );

    for (let i = 0; i < 5; i += 1) onboarding.state();
    expect(notifications).toBe(0);

    // And the methods that DO change something still notify — the fix must not
    // be "stop publishing everywhere".
    await onboarding.advance();
    expect(notifications).toBeGreaterThan(0);
  });
});

describe("what the renderer is allowed to see", () => {
  it("never carries the login session in the state", async () => {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.advance();
    await settle();

    expect(JSON.stringify(onboarding.state())).not.toContain(SESSION_TOKEN);
  });
});

describe("the activation credential handoff", () => {
  async function signIn(): Promise<Onboarding> {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.advance();
    await settle();
    return onboarding;
  }

  it("keeps the login session as this Mac's credential", async () => {
    await signIn();

    expect(loadSettings(home).relayCredential).toBe(SESSION_TOKEN);
  });

  it("keeps the session while device registration retries", async () => {
    plow.registrationFails = true;
    const onboarding = await signIn();

    expect(onboarding.state().step).toBe("verified");
    expect(loadSettings(home).relayCredential).toBe(SESSION_TOKEN);
    expect(loadSettings(home).mcpUrl).toBe("");
    expect(started).toBe(1);
  });

  it("writes settings owner-only", async () => {
    await signIn();

    const mode = fs.statSync(path.join(home, "app/settings.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("opens on data when this Mac already holds an incomplete credential", async () => {
    await signIn();

    expect(build().state().step).toBe("data");
  });
});

/**
 * Sign-out is a transition three owners have to make: the stored settings, the
 * relay socket, and this state machine. It had only ever been made by the first
 * two, and this instance outlives both — so it went on reporting the account
 * that had just been left.
 */
describe("signing out", () => {
  /** A Mac signed in the ordinary way, sitting on the data screen. */
  async function signedIn(): Promise<Onboarding> {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.advance();
    await settle();
    expect(onboarding.state().step).toBe("verified");
    await onboarding.advance();
    expect(onboarding.state().step).toBe("data");
    // Any activation minted from here on is a fresh code nobody has texted yet.
    plow.redeems = [{ status: "pending" }];
    return onboarding;
  }

  it("the reported path: signing out returns the window to Welcome", async () => {
    // The instance outlives the sign-out, and the constructor is the only other
    // place that decides this — so it went on reporting the account just left.
    // The screen offered Create Agent over a stale endpoint, which then failed
    // its own credential check.
    const onboarding = await signedIn();
    signOutOfPlow(home);

    const changesBefore = changes;
    const after = onboarding.reset();

    expect(after.step).not.toBe("connected");
    expect(after.step).toBe("welcome");
    // An open window is told to re-read.
    expect(changes).toBeGreaterThan(changesBefore);
    // …and it has nothing to draw yet: Welcome and Privacy are local screens,
    // and only leaving Privacy asks for an activation.
    expect(after.activation).toBeNull();
    await onboarding.advance();
    const reopened = await onboarding.advance();
    expect(reopened.step).toBe("activate");
    expect(reopened.activation?.displayCode).toBeTruthy();
    expect(plow.activations).toHaveLength(2); // one per sign-in attempt, not more
  });
});

describe("while the credential handoff is in the air", () => {
  it("keeps the verified session when a new-code request lands during relayInfo", async () => {
    let release = () => {};
    const inAir = new Promise<void>((resolve) => {
      release = resolve;
    });
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const original = plow.relayInfo.bind(plow);
    plow.relayInfo = async (token: string) => {
      await inAir;
      return original(token);
    };
    const onboarding = build();
    await onboarding.advance();
    await settle();
    expect(onboarding.state().busy).toBe(true);

    plow.redeems = [{ status: "pending" }];
    const during = await onboarding.newActivationCode();
    expect(during.busy).toBe(true);
    expect(plow.activations).toHaveLength(1);

    release();
    await settle();

    expect(plow.revoked).toEqual([]);
    expect(loadSettings(home).relayCredential).toBe(SESSION_TOKEN);
    expect(onboarding.state().step).toBe("verified");
  });

  it("stays signed out when the sign-out lands during relayInfo", async () => {
    let release = () => {};
    const inAir = new Promise<void>((r) => {
      release = () => r();
    });
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const original = plow.relayInfo.bind(plow);
    plow.relayInfo = async (token: string) => {
      await inAir;
      return original(token);
    };
    const onboarding = build();
    await onboarding.advance();
    await settle();

    signOutOfPlow(home);
    onboarding.reset();
    release();
    await settle();

    // Nothing is persisted, the session is retired best-effort, and the
    // window stays signed out.
    expect(plow.revoked).toEqual([SESSION_TOKEN]);
    expect(loadSettings(home).relayCredential).toBe("");
    expect(onboarding.state().step).not.toBe("connected");
  });
});

describe("while startRelay is dialling", () => {
  it("lets Continue advance from verified while the relay dial is pending", async () => {
    let release = () => {};
    const dialing = new Promise<void>((resolve) => {
      release = resolve;
    });
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build({
      startRelay: async () => {
        started += 1;
        await dialing;
      },
    });
    await onboarding.advance();
    await settle();
    expect(onboarding.state()).toMatchObject({ step: "verified", busy: false });

    const advanced = await onboarding.advance();
    release();
    await settle();

    expect(advanced.step).toBe("data");
    expect(onboarding.state().step).toBe("data");
  });

  it("is not overwritten by the post-login state", async () => {
    // The verified step is assigned before `startRelay` begins its network round
    // trip. A sign-out landing inside that await resets this instance to
    // Welcome, and the completed relay call must not overwrite the reset.
    let release = () => {};
    const dialing = new Promise<void>((r) => {
      release = () => r();
    });
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }, { status: "pending" }];
    const onboarding = build({
      startRelay: async () => {
        started += 1;
        await dialing;
      },
    });
    const begun = onboarding.advance();
    await settle();
    expect(onboarding.state().step).toBe("verified");

    signOutOfPlow(home);
    onboarding.reset();
    expect(onboarding.state().step).toBe("welcome");

    release();
    await begun;
    await settle();

    expect(onboarding.state().step).not.toBe("connected");
    expect(loadSettings(home).relayCredential).toBe("");
  });
});
