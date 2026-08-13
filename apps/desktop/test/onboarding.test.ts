import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVATION_POLL_INTERVAL_MS,
  ACTIVATION_POLL_WINDOW_MS,
  CODE_TTL_MS,
  Onboarding,
  OnboardingDeps,
  agentConfig,
} from "../src/onboarding.js";
import { ActivationRedeem, PlowApi, PlowApiError } from "../src/plowApi.js";
import { loadSettings } from "../src/settings.js";
import { signOutOfPlow } from "../src/settingsActions.js";

const DEVICE_TOKEN = "plow_DEVICEtok_secret";
const OTP_TOKEN = "plow_OTPTOKEN_secret";
const SESSION_TOKEN = "plow_ACTIVATIONsession_secret";
const AGENT_TOKEN = "plow_AGENTtok_secret";
const ACTIVATION_SECRET = "activation_secret_never_shown";
const MCP_URL = "http://localhost:18804/v1/relay/devices/u_123/mcp";

/** A stand-in Plow: records what was called, answers what the real one does. */
class FakePlow {
  requested: string[] = [];
  minted: Array<{ token: string; name: string }> = [];
  connected = false;
  verifyFails: "unauthorized" | "network" | null = null;
  requestFails: "provider_unavailable" | "network" | null = null;

  /** Activations minted, newest last — one per `POST /v1/auth/activate`. */
  activations: string[] = [];
  /** Redeem answers, consumed in order; the last one repeats forever. */
  redeems: Array<ActivationRedeem | PlowApiError> = [{ status: "pending" }];
  redeemCalls: string[] = [];

  api(): PlowApi {
    return this as unknown as PlowApi;
  }

  async createActivation(name: string) {
    const secret = `${ACTIVATION_SECRET}_${this.activations.length}`;
    this.activations.push(name);
    return { displayCode: `CODE${this.activations.length}`, activationSecret: secret, sendTo: "+15550001111" };
  }

  async redeemActivation(secret: string): Promise<ActivationRedeem> {
    this.redeemCalls.push(secret);
    const next = this.redeems.length > 1 ? this.redeems.shift()! : this.redeems[0];
    if (next instanceof PlowApiError) throw next;
    return next;
  }

  async requestOtp(phone: string): Promise<void> {
    if (this.requestFails) throw new PlowApiError(this.requestFails, "provider down");
    this.requested.push(phone);
  }

  async verifyOtp(): Promise<string> {
    if (this.verifyFails) throw new PlowApiError(this.verifyFails, "nope", 401);
    return OTP_TOKEN;
  }

  /** Credentials handed back with `/self/revoke`. */
  revoked: string[] = [];

  async revokeDeviceCredential(token: string): Promise<void> {
    this.revoked.push(token);
  }

  async relayInfo(token: string) {
    // The login session, whichever path minted it — never the device credential.
    expect([OTP_TOKEN, SESSION_TOKEN]).toContain(token);
    return { uid: "u_123", mcpUrl: MCP_URL, deviceConnected: this.connected };
  }

  async mintDeviceCredential(token: string, name: string) {
    expect([OTP_TOKEN, SESSION_TOKEN]).toContain(token);
    this.minted.push({ token, name });
    return { token: DEVICE_TOKEN, keyPrefix: DEVICE_TOKEN.slice(5, 13), name };
  }

  async createAgent(token: string, name: string) {
    // The device credential mints agents — the OTP session is long gone.
    expect(token).toBe(DEVICE_TOKEN);
    return { token: AGENT_TOKEN, keyPrefix: AGENT_TOKEN.slice(5, 13), name };
  }

}

let home: string;
let plow: FakePlow;
let warnings: string[];
let started: number;
let clock: number;
/** Every `wait` the poll loop made, so a test can prove the interval. */
let waits: number[];
/** How many times the instance told the window to re-read. */
let changes: number;

function build(extra: Partial<OnboardingDeps> = {}): Onboarding {
  return new Onboarding({
    api: plow.api(),
    home,
    startRelay: async () => {
      started += 1;
      plow.connected = true;
    },
    isConnected: () => plow.connected,
    // Identity by default; the tests that care pass their own and watch it.
    critical: (work) => work,
    deviceName: "Domo Desktop (test)",
    now: () => clock,
    // No real timers: the poll loop's wait advances the same fake clock the
    // deadline is measured against, so a five-minute give-up takes microseconds
    // and is exact rather than approximately right.
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    onChange: () => {
      changes += 1;
    },
    warn: (m) => warnings.push(m),
    ...extra,
  });
}

/** Let the detached poll loop run until it has nothing left to do. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5000; i += 1) await Promise.resolve();
}

/** Start on the phone-code path, which is now behind a link rather than first. */
function buildOnPhonePath(): Onboarding {
  const onboarding = build();
  onboarding.usePhoneCode();
  return onboarding;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-onboarding-"));
  plow = new FakePlow();
  warnings = [];
  started = 0;
  waits = [];
  changes = 0;
  clock = 1_700_000_000_000;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("activation — the path a brand-new user takes", () => {
  it("shows a code, says where to text it, and connects when the text lands", async () => {
    plow.redeems = [{ status: "pending" }, { status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();

    const shown = await onboarding.begin();
    expect(shown.step).toBe("activate");
    expect(shown.activation?.displayCode).toBe("CODE1");
    // The exact body, because a wrong prefix is answered with silence.
    expect(shown.activation?.smsBody).toBe("Plow Activate: CODE1");
    // Whatever the API returned — per-environment config, never a constant.
    expect(shown.activation?.sendTo).toBe("+15550001111");
    expect(shown.activation?.smsUrl).toBe("sms:+15550001111?&body=Plow%20Activate%3A%20CODE1");
    // The Mac names itself in the activation, so the session is identifiable.
    expect(plow.activations).toEqual(["Domo Desktop (test)"]);

    // The user types nothing. Polling was already running before they tapped.
    expect(onboarding.messagesOpened().step).toBe("waiting");
    await settle();

    const state = onboarding.state();
    expect(state.step).toBe("connected");
    expect(state.connected).toBe(true);
    expect(waits.every((ms) => ms === ACTIVATION_POLL_INTERVAL_MS)).toBe(true);
    expect(loadSettings(home).relayCredential).toBe(DEVICE_TOKEN);
    // The spent activation is dropped rather than left on a screen behind this.
    expect(state.activation).toBeNull();
  });

  it("polls without waiting to be told to — a hand-typed message still gets in", async () => {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.begin();
    // No messagesOpened() at all.
    await settle();

    expect(onboarding.state().step).toBe("connected");
  });

  it("does not burn a second code when the window is reopened", async () => {
    const onboarding = build();
    await onboarding.begin();
    await onboarding.begin();

    expect(plow.activations).toHaveLength(1);
  });

  it("gives up after five minutes and says what to check, rather than spinning", async () => {
    const onboarding = build();
    await onboarding.begin();
    await settle();

    const state = onboarding.state();
    expect(state.activationStale).toBe(true);
    expect(state.busy).toBe(false);
    // The silent failure has no other feedback: a message that does not START
    // with the prefix gets a 200, no SMS, and a code left live.
    expect(state.message).toContain("Plow Activate:");
    expect(state.message).toContain("haven't heard from your phone");
    // Five minutes of polling at the stated interval, and then it stopped.
    expect(waits.length).toBeCloseTo(ACTIVATION_POLL_WINDOW_MS / ACTIVATION_POLL_INTERVAL_MS, -1);
    const after = waits.length;
    await settle();
    expect(waits.length).toBe(after);
  });

  it("never strands the user on a screen with no way to re-check", async () => {
    // Reported from a live run: the user read the code off the screen and typed
    // it into Messages themselves, so they never tapped "Open Messages" and
    // never left the "Connect this Mac" screen. That screen has no "Get a New
    // Code" button — it is the one you are on before anything has gone wrong.
    // Giving up there set the message "or get a new code" beside no such
    // control, and their activation (which completed server-side just after the
    // loop stopped) could never be re-checked. Dead end.
    const onboarding = build();
    await onboarding.begin();
    expect(onboarding.state().step).toBe("activate"); // never tapped Open Messages
    await settle();

    const state = onboarding.state();
    expect(state.activationStale).toBe(true);
    // "waiting" is the screen that carries the control. The invariant that
    // matters is that giving up never leaves them anywhere else.
    expect(state.step).toBe("waiting");

    // And the control does what the message promises: the text landed after we
    // stopped watching, so one poll on the old secret signs them straight in.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    expect((await onboarding.newActivationCode()).step).toBe("connected");
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
      await onboarding.begin();
      await settle();

      expect(onboarding.state().activationStale).toBe(true);
      expect(onboarding.state().step).toBe("waiting");
    }
  });

  it("polls the old code before minting a new one, because completion beats expiry", async () => {
    const onboarding = build();
    await onboarding.begin();
    await settle();
    expect(onboarding.state().activationStale).toBe(true);

    // They texted at minute six. The server honoured it; we had stopped looking.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const state = await onboarding.newActivationCode();

    expect(state.step).toBe("connected");
    // And no second code was ever minted.
    expect(plow.activations).toHaveLength(1);
  });

  it("mints a fresh code when that poll really does come back pending", async () => {
    const onboarding = build();
    await onboarding.begin();
    await settle();

    const state = await onboarding.newActivationCode();
    expect(plow.activations).toHaveLength(2);
    expect(state.activation?.displayCode).toBe("CODE2");
    expect(state.activationStale).toBe(false);
    expect(state.step).toBe("activate");
  });

  it("reads a verified activation exactly once, and never re-reads it", async () => {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.begin();
    await settle();

    // One redeem saw the completion and got the token. A second would come back
    // verified with the `token` key omitted entirely — so there is no second.
    expect(plow.redeemCalls).toHaveLength(1);
    expect(onboarding.state().step).toBe("connected");
  });

  it("says so, honestly, when verified comes back with no token to hand over", async () => {
    plow.redeems = [{ status: "verified", token: null }];
    const onboarding = build();
    await onboarding.begin();
    await settle();

    const state = onboarding.state();
    expect(state.step).not.toBe("connected");
    expect(state.activationStale).toBe(true);
    expect(state.message).toBe("Plow verified this Mac but didn't hand back a login. Get a new code.");
    expect(plow.redeemCalls).toHaveLength(1);
  });

  it("treats a 410 as authoritative and offers a fresh code", async () => {
    plow.redeems = [new PlowApiError("expired", "Activation expired", 410)];
    const onboarding = build();
    await onboarding.begin();
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
    await onboarding.begin();
    await settle();

    expect(onboarding.state().step).toBe("connected");
    expect(plow.redeemCalls).toHaveLength(2);
  });

  it("says so when the very first call cannot reach Plow", async () => {
    plow.createActivation = async () => {
      throw new PlowApiError("network", "Couldn't reach Plow at http://localhost:18804.");
    };
    const state = await build().begin();

    expect(state.busy).toBe(false);
    expect(state.activation).toBeNull();
    expect(state.message).toBe("Couldn't reach Plow at http://localhost:18804.");
  });

  it("stops polling when the user switches to the phone-code fallback", async () => {
    const onboarding = build();
    await onboarding.begin();
    expect(onboarding.usePhoneCode().step).toBe("phone");
    // Polls in flight when the user left are allowed to land; what must not
    // happen is the loop carrying on behind the fallback screen forever.
    const atSwitch = plow.redeemCalls.length;
    await settle();

    expect(plow.redeemCalls.length).toBe(atSwitch);
    expect(onboarding.state().activation).toBeNull();
  });

  it("never lets the renderer see the activation secret", async () => {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    const shown = await onboarding.begin();
    expect(JSON.stringify(shown)).not.toContain(ACTIVATION_SECRET);

    await settle();
    expect(JSON.stringify(onboarding.state())).not.toContain(ACTIVATION_SECRET);
    expect(JSON.stringify(onboarding.state())).not.toContain(SESSION_TOKEN);
    // Nor does anything secret reach the log sink.
    expect(warnings.join(" ")).not.toContain(ACTIVATION_SECRET);
    // The display code is a credential too — it is shown, never logged.
    expect(warnings.join(" ")).not.toContain("CODE1");
  });
});

describe("the phone-code fallback still works", () => {
  it("walks phone → code → connected and stores what the server told it", async () => {
    const onboarding = build();
    // It is a fallback now: the app opens on activation and this is one link away.
    expect(onboarding.state().step).toBe("activate");
    expect(onboarding.usePhoneCode().step).toBe("phone");

    let state = await onboarding.requestCode(" +1 555 111 0000 ");
    expect(plow.requested).toEqual(["+1 555 111 0000"]);
    expect(state.step).toBe("code");
    expect(state.codeExpiresAt).toBe(clock + CODE_TTL_MS);
    // The copy cannot promise a code was sent — the API answers the same for an
    // unknown number, an unparseable one and a failed send — so the first ask
    // leaves the message line to the screen's own wording.
    expect(state.message).toBe("");

    state = await onboarding.submitCode("12345678");
    expect(state.step).toBe("connected");
    expect(state.accountUid).toBe("u_123");
    expect(state.mcpUrl).toBe(MCP_URL);
    expect(started).toBe(1);

    // The endpoint came from GET /v1/relay/info; the app never builds it.
    const settings = loadSettings(home);
    expect(settings.relayCredential).toBe(DEVICE_TOKEN);
    expect(settings.mcpUrl).toBe(MCP_URL);
  });

  it("keeps the login session nowhere — the mint retires it server-side", async () => {
    const onboarding = buildOnPhonePath();
    await onboarding.requestCode("+15551110000");
    await onboarding.submitCode("12345678");

    // There is no client-side revoke left to get wrong: `mintDeviceCredential`
    // passes `revoke_calling_session`, so the session dies in the same
    // transaction as the mint. All the app has to do is not keep a copy.
    expect(JSON.stringify(loadSettings(home))).not.toContain(OTP_TOKEN);
    expect(warnings).toEqual([]);
  });

  it("writes settings owner-only", async () => {
    // The spec names this hazard by name: settings.json holds the device
    // credential, and it used to be written with no mode at all. The
    // first-run transcript checks the mode too, but a permission bit on a
    // file holding a credential is worth pinning in CI in its own right.
    const onboarding = buildOnPhonePath();
    await onboarding.requestCode("+15551110000");
    await onboarding.submitCode("12345678");

    const mode = fs.statSync(path.join(home, "app/settings.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("opens on the connected screen when this Mac already holds a credential", async () => {
    const first = buildOnPhonePath();
    await first.requestCode("+15551110000");
    await first.submitCode("12345678");

    expect(build().state().step).toBe("connected");
  });
});

describe("honest messages instead of a spinner", () => {
  it("names a wrong code as a wrong code", async () => {
    plow.verifyFails = "unauthorized";
    const onboarding = buildOnPhonePath();
    await onboarding.requestCode("+15551110000");
    const state = await onboarding.submitCode("00000000");

    expect(state.step).toBe("code");
    expect(state.message).toBe("That code didn't work. Check it, or send a new one.");
    expect(state.busy).toBe(false);
  });

  it("distinguishes an expired code, which the server cannot", async () => {
    const onboarding = buildOnPhonePath();
    await onboarding.requestCode("+15551110000");
    clock += CODE_TTL_MS + 1;
    const state = await onboarding.submitCode("12345678");

    expect(state.message).toBe("That code has expired. Send a new one.");
  });

  it("resends with a fresh clock", async () => {
    const onboarding = buildOnPhonePath();
    await onboarding.requestCode("+15551110000");
    clock += 60_000;
    const state = await onboarding.resendCode();

    expect(plow.requested).toEqual(["+15551110000", "+15551110000"]);
    expect(state.codeExpiresAt).toBe(clock + CODE_TTL_MS);
    // "Asked", never "sent" — the API cannot tell us which.
    expect(state.message).toBe("Asked Plow for a new code.");
  });

  it("says so when the API is unreachable", async () => {
    plow.requestFails = "network";
    const state = await buildOnPhonePath().requestCode("+15551110000");

    expect(state.step).toBe("phone");
    expect(state.message).toBe("provider down");
    expect(state.busy).toBe(false);
  });

  it("rejects a code that is not eight digits without a round trip", async () => {
    const onboarding = buildOnPhonePath();
    await onboarding.requestCode("+15551110000");
    const state = await onboarding.submitCode("1234");

    expect(state.message).toBe("Enter the 8-digit code from your phone.");
  });
});

describe("creating an agent", () => {
  it("yields a credential and a pasteable config, shown once", async () => {
    const onboarding = buildOnPhonePath();
    await onboarding.requestCode("+15551110000");
    await onboarding.submitCode("12345678");

    const state = await onboarding.createAgent("Claude Code");
    expect(state.step).toBe("agent");
    expect(state.agent?.token).toBe(AGENT_TOKEN);
    // The credential is a header, never part of a URL.
    expect(JSON.parse(state.agent!.config).mcpServers.domo.url).toBe(MCP_URL);
    expect(JSON.parse(state.agent!.config).mcpServers.domo.headers.Authorization).toBe(
      `Bearer ${AGENT_TOKEN}`,
    );

    // Dismissing drops it: the app cannot show it a second time.
    const after = onboarding.dismissAgent();
    expect(after.agent).toBeNull();
    expect(after.step).toBe("connected");
    expect(JSON.stringify(loadSettings(home))).not.toContain(AGENT_TOKEN);
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
    const onboarding = build({
      onChange: () => {
        notifications += 1;
      },
    });

    for (let i = 0; i < 5; i += 1) onboarding.state();
    expect(notifications).toBe(0);

    // And the methods that DO change something still notify — the fix must not
    // be "stop publishing everywhere".
    await onboarding.begin();
    expect(notifications).toBeGreaterThan(0);
  });
});

describe("what the renderer is allowed to see", () => {
  it("never carries the device credential in the state", async () => {
    const onboarding = buildOnPhonePath();
    await onboarding.requestCode("+15551110000");
    const connectedState = await onboarding.submitCode("12345678");
    const agentState = await onboarding.createAgent("Claude Code");

    for (const state of [connectedState, agentState]) {
      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain(DEVICE_TOKEN);
      expect(serialized).not.toContain(OTP_TOKEN);
    }
  });
});

describe("agentConfig", () => {
  it("puts the credential in a header, because URLs end up in logs", () => {
    const config = JSON.parse(agentConfig(MCP_URL, "plow_tok"));
    expect(config.mcpServers.domo.url).not.toContain("plow_tok");
    expect(config.mcpServers.domo.headers.Authorization).toBe("Bearer plow_tok");
  });
});

/**
 * Sign-out is a transition three owners have to make: the stored settings, the
 * relay socket, and this state machine. It had only ever been made by the first
 * two, and this instance outlives both — so it went on reporting the account
 * that had just been left.
 */
describe("signing out", () => {
  /** A Mac signed in the ordinary way, sitting on the connected screen. */
  async function signedIn(): Promise<Onboarding> {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.begin();
    await settle();
    expect(onboarding.state().step).toBe("connected");
    // Any activation minted from here on is a fresh code nobody has texted yet.
    plow.redeems = [{ status: "pending" }];
    return onboarding;
  }

  it("the reported path: not connected, and on a screen it can actually use", async () => {
    // Sign out, reopen Settings, and the window must not be the connected one.
    // It used to be: the instance outlives the sign-out, and the constructor is
    // the only other place that decides this. The screen offered Create Agent
    // over a stale endpoint, which then failed its own credential check.
    const onboarding = await signedIn();
    signOutOfPlow(home);
    plow.connected = false;

    const codesBefore = plow.activations.length;
    const changesBefore = changes;
    const pending = onboarding.signedOut();
    // Synchronous, all of it: no `state()` read between the call and its first
    // await may still say connected. Nothing here waits on a drain.
    expect(onboarding.state().step).toBe("activate");
    const after = await pending;

    // Reopening the window is a fresh `onboarding:get` plus the `begin()` the
    // renderer fires on load — exactly what the Sign In button produces.
    const reopened = await onboarding.begin();
    expect(reopened.step).not.toBe("connected");
    expect(reopened.step).toBe("activate");
    // The account just left is gone from the state the window renders.
    expect(reopened.accountUid).toBe("");
    expect(reopened.mcpUrl).toBe("");
    expect(reopened.connected).toBe(false);
    // An ALREADY-OPEN window was told to re-read and given something to draw —
    // nothing reopens it to call `begin()` on its behalf — and a window opening
    // afterwards does not burn a second code.
    expect(changes).toBeGreaterThan(changesBefore);
    expect(after.activation?.displayCode).toBeTruthy();
    expect(plow.activations.length).toBe(codesBefore + 1);
    // Create Agent still refuses if it is reached, but it is not on this screen.
    expect((await onboarding.createAgent("Claude Code")).message).toContain("isn't signed in");
  });

  it("drops the agent token shown for the account just left", async () => {
    // Shown once and held in memory until dismissed. Sign-out is a dismissal.
    const onboarding = await signedIn();
    expect((await onboarding.createAgent("Claude Code")).agent?.token).toBe(AGENT_TOKEN);

    signOutOfPlow(home);
    const after = await onboarding.signedOut();

    expect(after.agent).toBeNull();
    expect(JSON.stringify(after)).not.toContain(AGENT_TOKEN);
    expect(JSON.stringify(after)).not.toContain(DEVICE_TOKEN);
  });

  it("does not resurrect the activation that was live when it signed out", async () => {
    // `newActivationCode` deliberately retries the previous secret — a user who
    // texted late has already succeeded, and one poll turns a pointless second
    // code into an instant sign-in. After a SIGN-OUT that same retry would sign
    // them straight back in to the account they just left.
    //
    // A signed-in Mac whose window is showing an activation code is a state the
    // machine offers: `useActivation()` is on the bridge, and it mints one.
    const onboarding = await signedIn();
    const live = await onboarding.useActivation();
    expect(live.step).toBe("activate");
    const spent = `${ACTIVATION_SECRET}_1`; // the one useActivation just minted
    const before = plow.redeemCalls.length;

    signOutOfPlow(home);
    await onboarding.signedOut();
    await settle();

    expect(plow.redeemCalls.slice(before)).not.toContain(spent);
    expect(loadSettings(home).relayCredential).toBe("");
  });

  it("a verified redeem never mints OVER a credential this Mac already holds", async () => {
    // The other half of the same conditional, and not about sign-out at all: a
    // signed-in Mac showing an activation code (`useActivation()` is on the
    // bridge) whose code is then texted. Minting there would overwrite the live
    // credential and orphan it on the account — spend-capable, and now unknown
    // to the only thing that could revoke it.
    const onboarding = await signedIn();
    expect((await onboarding.useActivation()).step).toBe("activate");
    const mintedBefore = plow.minted.length;
    const credential = loadSettings(home).relayCredential;

    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    await settle();

    expect(plow.minted.length).toBe(mintedBefore);
    expect(loadSettings(home).relayCredential).toBe(credential);
  });

  // The two ways a redeem can be on the wire when the user signs out. Both end
  // in `finishWithSession`, and both must refuse — but they arrive by different
  // callers, so each is driven on its own.
  const inFlightRedeems = [
    {
      name: "the poll loop's own redeem",
      // The loop is already running from `useActivation()`; nothing to start.
      start: (_o: Onboarding) => null as Promise<unknown> | null,
    },
    {
      name: "the re-poll 'Get a New Code' makes before minting",
      start: (o: Onboarding) => o.newActivationCode(),
    },
  ];

  for (const entry of inFlightRedeems) {
    it(`${entry.name}, in flight across the sign-out, cannot mint`, async () => {
      // A verified answer is deliberately acted on even when its poll loop has
      // been cancelled — the server hands the session token to the first redeem
      // that sees the completion and never again, so dropping it would strand an
      // activation the user really completed. The only thing that used to make
      // it moot was already holding a credential, and SIGN-OUT CLEARS THE
      // CREDENTIAL.
      const onboarding = await signedIn();
      expect((await onboarding.useActivation()).step).toBe("activate");

      // Hold THIS activation's redeem mid-call — and only this one, so the
      // fresh code the sign-out mints behaves like the untexted code it is.
      const inFlight = `${ACTIVATION_SECRET}_1`;
      let release = () => {};
      const onTheWire = new Promise<void>((r) => {
        release = () => r();
      });
      plow.redeemActivation = async (secret: string) => {
        plow.redeemCalls.push(secret);
        if (secret !== inFlight) return { status: "pending" };
        await onTheWire;
        return { status: "verified", token: SESSION_TOKEN };
      };

      const started = entry.start(onboarding);
      await settle();
      expect(plow.redeemCalls).toContain(inFlight);

      // The user signs out while that call is still on the wire.
      signOutOfPlow(home);
      await onboarding.signedOut();
      const mintedBefore = plow.minted.length;

      // …and only now does the server answer "verified".
      release();
      if (started) await started;
      await settle();

      // Nothing was minted, nothing was persisted, and the window did not slide
      // back to the account the user just left.
      expect(plow.minted.length).toBe(mintedBefore);
      expect(loadSettings(home).relayCredential).toBe("");
      expect(loadSettings(home).accountUid).toBe("");
      expect(onboarding.state().step).not.toBe("connected");
    });
  }
});

/**
 * The sixth defect, and the one the generation counter exists for: an
 * activation that passes every ownership check, ENTERS `finishWithSession()`,
 * and then yields — after which sign-out can clear and revoke the old
 * credential before the continuation persists and reconnects a fresh one.
 *
 * Each earlier fix moved the window later. This asks a different question — is
 * the login this belongs to still the one we are running? — so it does not
 * matter WHERE the work paused. Both yields are driven separately, because a
 * guard on one of them is not a guard on the other, and the consequences
 * differ: before the mint nothing exists yet; after it, a live credential does.
 */
describe("a sign-out during finishWithSession", () => {
  /** Sign in, then park inside `finishWithSession` at the named call. */
  async function parkedInside(
    where: "relayInfo" | "mintDeviceCredential",
    extra: Partial<OnboardingDeps> = {},
  ) {
    let release = () => {};
    const onTheWire = new Promise<void>((r) => {
      release = () => r();
    });
    const realRelayInfo = plow.relayInfo.bind(plow);
    const realMint = plow.mintDeviceCredential.bind(plow);
    if (where === "relayInfo") {
      plow.relayInfo = async (token: string) => {
        await onTheWire;
        return realRelayInfo(token);
      };
    } else {
      plow.mintDeviceCredential = async (token: string, name: string) => {
        await onTheWire;
        return realMint(token, name);
      };
    }

    // Verified once — this login — then pending forever, so the fresh code the
    // sign-out mints behaves like the untexted code it is.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }, { status: "pending" }];
    const onboarding = build(extra);
    const begun = onboarding.begin();
    await settle();
    return { onboarding, release, begun };
  }

  // The two yield points, and the reason they cannot share an assertion: before
  // the mint nothing exists yet, so the cheapest exit is right; after it a live
  // credential does, so the exit has to hand it back.
  const yieldPoints = [
    { where: "relayInfo" as const, minted: 0, revoked: [] as string[] },
    { where: "mintDeviceCredential" as const, minted: 1, revoked: [DEVICE_TOKEN] },
  ];

  for (const point of yieldPoints) {
    it(`yielding in ${point.where} creates ${point.minted} credential(s) and hands back ${point.revoked.length}`, async () => {
      const { onboarding, release, begun } = await parkedInside(point.where);
      await onboarding.signedOut();

      release();
      await begun;
      await settle();

      expect(plow.minted).toHaveLength(point.minted);
      expect(plow.revoked).toEqual(point.revoked);
      // Never persisted, and the relay was never brought up on it.
      expect(loadSettings(home).relayCredential).toBe("");
      expect(loadSettings(home).accountUid).toBe("");
      expect(onboarding.state().step).not.toBe("connected");
    });
  }

  // The continuation AFTER the save, which an earlier report of mine called
  // safe because the save had already happened. The save is safe; this is not.
  // A sign-out during the dial clears the credential and starts a fresh
  // activation, and a stale continuation then wiped that activation — reporting
  // `connected` with nothing behind it on the success side, and painting a dial
  // error over the new screen on the failure side.
  const relayOutcomes = [
    {
      name: "resolves",
      startRelay: (parked: Promise<void>) => async () => {
        started += 1;
        await parked;
        plow.connected = true;
      },
      // The fresh activation's own five-minute give-up would rewrite `message`
      // during `settle()`, so only the failure case stops the clock.
      holdClock: false,
      check: (onboarding: Onboarding) => {
        expect(onboarding.state().step).not.toBe("connected");
      },
    },
    {
      name: "rejects",
      startRelay: (parked: Promise<void>) => async () => {
        started += 1;
        await parked;
        throw new PlowApiError("network", "Couldn't dial the relay.");
      },
      holdClock: true,
      check: (onboarding: Onboarding) => {
        // `run()` would have caught the rethrow and put it on the activation
        // screen the user is now looking at.
        expect(onboarding.state().message).not.toContain("Couldn't dial the relay");
        expect(onboarding.state().step).not.toBe("connected");
      },
    },
  ];

  for (const outcome of relayOutcomes) {
    it(`a sign-out while startRelay ${outcome.name} leaves the fresh activation alone`, async () => {
      let release = () => {};
      const parked = new Promise<void>((r) => {
        release = () => r();
      });
      plow.redeems = [{ status: "verified", token: SESSION_TOKEN }, { status: "pending" }];
      const onboarding = build({
        startRelay: outcome.startRelay(parked),
        ...(outcome.holdClock ? { wait: async (ms: number) => void waits.push(ms) } : {}),
      });
      const begun = onboarding.begin();
      await settle();

      // The user signs out while the relay is still dialling.
      signOutOfPlow(home);
      await onboarding.signedOut();
      const freshCode = onboarding.state().activation?.displayCode;
      expect(freshCode).toBeTruthy();

      release();
      await begun;
      await settle();

      outcome.check(onboarding);
      expect(loadSettings(home).relayCredential).toBe("");
      // The activation the sign-out started is still the one on screen.
      expect(onboarding.state().activation?.displayCode).toBe(freshCode);
    });
  }

  it("the mint-to-commit span is registered as critical shutdown work", async () => {
    // A quit between the mint starting and the credential being saved or handed
    // back is what leaves a live credential on an account nobody can revoke it
    // from. The gate has to be holding something for that whole span.
    const tracked: Promise<unknown>[] = [];
    let release = () => {};
    const onTheWire = new Promise<void>((r) => {
      release = () => r();
    });
    const realMint = plow.mintDeviceCredential.bind(plow);
    plow.mintDeviceCredential = async (token: string, name: string) => {
      await onTheWire;
      return realMint(token, name);
    };
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }, { status: "pending" }];
    const onboarding = build({
      critical: (work) => {
        tracked.push(work);
        return work;
      },
    });
    const begun = onboarding.begin();
    await settle();

    // Parked inside the mint: the span must already be registered.
    expect(tracked).toHaveLength(1);
    let done = false;
    void tracked[0].then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false); // …and still outstanding while the mint is out

    release();
    await begun;
    await settle();
    expect(done).toBe(true);
    expect(loadSettings(home).relayCredential).toBe(DEVICE_TOKEN);
  });

  // The bug this pins: the hand-back used to register with the gate on its own
  // account, AFTER the span it belonged to had settled. A quit snapshots the
  // outstanding work, so one that had already looked never saw the late
  // registration and exited with the credential still live. Both cases watch
  // the SPAN — which is the thing a quit actually waits on — rather than the
  // login's own promise.
  const handBackOutcomes = [
    { name: "lands", hangs: false },
    // A hand-back that never answers must hold the span open for as long as the
    // credential is live. What stops that becoming a hung app is the quit's own
    // two-second bound, which `shutdownGate.test.ts` pins.
    { name: "never answers", hangs: true },
  ];

  for (const outcome of handBackOutcomes) {
    it(`the hand-back is INSIDE the tracked span when it ${outcome.name}`, async () => {
      const tracked: Promise<unknown>[] = [];
      let releaseRevoke = () => {};
      const revokeOnTheWire = new Promise<void>((r) => {
        releaseRevoke = () => r();
      });
      const { onboarding, release, begun } = await parkedInside("mintDeviceCredential", {
        critical: (work) => {
          tracked.push(work);
          return work;
        },
      });
      plow.revokeDeviceCredential = async (token: string) => {
        plow.revoked.push(token);
        await revokeOnTheWire;
      };
      await onboarding.signedOut();

      release();
      await settle();

      // ONE registration — the mint-to-commit span — and no second one to be
      // missed by a snapshot already taken.
      expect(tracked).toHaveLength(1);
      expect(plow.revoked).toEqual([DEVICE_TOKEN]);

      // …and that one span is still outstanding while the revoke is on the wire.
      let spanSettled = false;
      void tracked[0].then(() => {
        spanSettled = true;
      });
      await settle();
      expect(spanSettled).toBe(false);

      if (outcome.hangs) return; // the quit's bound is what ends this one
      releaseRevoke();
      await begun;
      await settle();
      expect(spanSettled).toBe(true);
    });
  }

  it("a FAILING hand-back is absorbed, and never reported to the user", async () => {
    // The login it belonged to is gone, so there is nobody to report to. A
    // rejection here must not reach `run()`'s catch, which maps whatever it
    // sees to a generic apology and paints it on the screen the user moved to.
    //
    // The login is abandoned with `usePhoneCode()` rather than a sign-out on
    // purpose: it bumps the same generation but starts no replacement
    // activation, so `message` is a clean read rather than a race with a fresh
    // poll loop's own give-up text.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const { onboarding, release, begun } = await parkedInside("mintDeviceCredential");
    plow.revokeDeviceCredential = async () => {
      throw new PlowApiError("network", "Couldn't reach Plow.");
    };
    expect(onboarding.usePhoneCode().step).toBe("phone");

    release();
    await begun;
    await settle();
    // Let a stray rejection surface before we look.
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", onUnhandled);

    // Neither route out: not onto the screen through `run()`'s catch, and not
    // into the process as an unhandled rejection. A best-effort cleanup that
    // can crash the app is worse than no cleanup.
    expect(unhandled).toEqual([]);
    expect(onboarding.state().message).toBe("");
    expect(onboarding.state().step).toBe("phone");
    expect(loadSettings(home).relayCredential).toBe("");
  });

  it("switching to the phone-code path abandons the login in flight too", async () => {
    // The other path that abandons a login rather than retrying it: the OTP
    // fallback can sign in a different account entirely, so an activation still
    // finishing must not persist a credential underneath it.
    const { onboarding, release, begun } = await parkedInside("mintDeviceCredential");

    expect(onboarding.usePhoneCode().step).toBe("phone");
    release();
    await begun;
    await settle();

    expect(plow.minted).toHaveLength(1);
    expect(plow.revoked).toEqual([DEVICE_TOKEN]);
    expect(loadSettings(home).relayCredential).toBe("");
    expect(onboarding.state().step).toBe("phone");
  });

  it("a slow mint that outlives the poll window still signs you in", async () => {
    // The counterpart to all of the above: nothing has abandoned this login, so
    // however long it takes, it lands. `giveUp` cannot even run here — the loop
    // left its `while` the moment it entered `finishWithSession` — which is why
    // `giveUp` needs no bump of its own.
    const { onboarding, release, begun } = await parkedInside("mintDeviceCredential");
    await begun;
    clock += ACTIVATION_POLL_WINDOW_MS + 1;
    await settle();

    release();
    await settle();

    expect(loadSettings(home).relayCredential).toBe(DEVICE_TOKEN);
    expect(plow.revoked).toEqual([]);
    expect(onboarding.state().step).toBe("connected");
  });

  it("asking for a new code does NOT abandon a login already finishing", async () => {
    // `newActivationCode` re-polls the previous secret precisely because a user
    // who texted late has already succeeded. Treating it as an abandonment
    // would invalidate the finish already in flight, hand back the credential
    // it had just minted, and then find the token consumed — stranding a user
    // whose activation genuinely worked. Retry, not abandon.
    const { onboarding, release, begun } = await parkedInside("mintDeviceCredential");
    await begun;

    // The user gets impatient and asks for a new code while the mint is out.
    const asked = onboarding.newActivationCode();
    release();
    await asked;
    await settle();

    expect(loadSettings(home).relayCredential).toBe(DEVICE_TOKEN);
    expect(plow.revoked).toEqual([]);
    expect(onboarding.state().step).toBe("connected");
  });

  it("an UNINTERRUPTED login still signs in, and hands nothing back", async () => {
    // The guard must cost the ordinary path nothing.
    const { onboarding, release, begun } = await parkedInside("mintDeviceCredential");
    release();
    await begun;
    await settle();

    expect(onboarding.state().step).toBe("connected");
    expect(loadSettings(home).relayCredential).toBe(DEVICE_TOKEN);
    expect(plow.revoked).toEqual([]);
  });
});
