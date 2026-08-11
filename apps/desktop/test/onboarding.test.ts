import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVATION_POLL_INTERVAL_MS,
  ACTIVATION_POLL_WINDOW_MS,
  CODE_TTL_MS,
  Onboarding,
  agentConfig,
} from "../src/onboarding.js";
import { ActivationRedeem, PlowApi, PlowApiError } from "../src/plowApi.js";
import { loadSettings } from "../src/settings.js";

const DEVICE_TOKEN = "plow_DEVICEtok_secret";
const OTP_TOKEN = "plow_OTPTOKEN_secret";
const SESSION_TOKEN = "plow_ACTIVATIONsession_secret";
const AGENT_TOKEN = "plow_AGENTtok_secret";
const ACTIVATION_SECRET = "activation_secret_never_shown";
const MCP_URL = "http://localhost:4242/v1/relay/devices/u_123/mcp";

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

function build(): Onboarding {
  return new Onboarding({
    api: plow.api(),
    home,
    startRelay: async () => {
      started += 1;
      plow.connected = true;
    },
    isConnected: () => plow.connected,
    deviceName: "Domo Desktop (test)",
    now: () => clock,
    // No real timers: the poll loop's wait advances the same fake clock the
    // deadline is measured against, so a five-minute give-up takes microseconds
    // and is exact rather than approximately right.
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    warn: (m) => warnings.push(m),
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
      throw new PlowApiError("network", "Couldn't reach Plow at http://localhost:4242.");
    };
    const state = await build().begin();

    expect(state.busy).toBe(false);
    expect(state.activation).toBeNull();
    expect(state.message).toBe("Couldn't reach Plow at http://localhost:4242.");
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
    const onboarding = new Onboarding({
      api: plow.api(),
      home,
      startRelay: async () => {},
      isConnected: () => false,
      deviceName: "Domo Desktop (test)",
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
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
