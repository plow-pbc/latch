import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVATION_POLL_INTERVAL_MS,
  ACTIVATION_POLL_WINDOW_MS,
  CODE_TTL_MS,
  activationChatLabel,
  Onboarding,
  OnboardingDeps,
} from "../src/onboarding.js";
import { ActivationChat, PlowApi, PlowApiError, parseActivationChat } from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";
import { signOutOfPlow } from "../src/settingsActions.js";

const DEVICE_TOKEN = "plow_DEVICEtok_secret";
const OTP_TOKEN = "plow_OTPTOKEN_secret";
const SESSION_TOKEN = "plow_ACTIVATIONsession_secret";
const ACTIVATION_SECRET = "activation_secret_never_shown";
const MCP_URL = "http://localhost:4242/v1/relay/devices/u_123/mcp";

/** The chat a `provision_chat` activation creates, as `parseActivationChat`
 * hands it over: the assigned pool line, and the person who texted it. */
const CHAT: ActivationChat = {
  uid: "cht_D7hfWNK",
  status: "active",
  line: "+15559876543",
  createdAt: "2026-08-24T18:02:11Z",
  participants: [{ providerKey: "+15551230000" }],
};

type FakeRedeem =
  | { status: "pending" }
  | { status: "verified"; token: string | null; chat?: ActivationChat | null };

/** A stand-in Plow: records what was called, answers what the real one does. */
class FakePlow {
  requested: string[] = [];
  minted: Array<{ token: string; name: string }> = [];
  connected = false;
  verifyFails: "unauthorized" | "network" | null = null;
  requestFails: "provider_unavailable" | "network" | null = null;

  /** Activations minted, newest last — one per `POST /v1/auth/activate`. */
  activations: string[] = [];
  /** Redeem answers, consumed in order; the last one repeats forever. `chat`
   * is optional here and defaults to none, so a test only names it when the
   * chat is what it is about. */
  redeems: Array<FakeRedeem | PlowApiError> = [{ status: "pending" }];
  redeemCalls: string[] = [];

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
    return { status: "verified", token: next.token, chat: next.chat ?? null };
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
    deviceName: "Plow Latch (test)",
    now: () => clock,
    // No real timers: the poll loop's wait advances the same fake clock the
    // deadline is measured against, so a five-minute give-up takes microseconds
    // and is exact rather than approximately right.
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
      // The server's 410 ends the real loop; a fake that only ever answers
      // "pending" never gets one, and under this instant clock the loop would
      // spin the worker to death. Park it well past anything a test asserts.
      if (waits.length > 2_000) await new Promise(() => {});
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

/** Let the poll loop run just until a condition holds — for states the loop
 * passes THROUGH rather than ends in, now that a stalled screen keeps polling. */
async function settleUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 5000 && !check(); i += 1) await Promise.resolve();
  expect(check()).toBe(true);
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
    expect(plow.activations).toEqual(["Plow Latch (test)"]);

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

  it("keeps the chat the redeem carried, and shows the number the server assigned", async () => {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN, chat: CHAT }];
    const onboarding = build();

    const shown = await onboarding.begin();
    // The screen shows the line THIS activation was assigned. The chat is only
    // provisioned if the code lands on that line, so a number chosen here would
    // sign the user in and silently create nothing.
    expect(shown.activation?.sendTo).toBe("+15550001111");
    await settle();

    // Read once and kept: the redeem hands the chat back exactly once, so a
    // later window has no way to ask for it again.
    const settings = loadSettings(home);
    expect(settings.provisionedChatUid).toBe("cht_D7hfWNK");
    expect(settings.provisionedChatLabel).toBe("+15559876543, +15551230000");
    expect(onboarding.state().chat).toEqual({
      uid: "cht_D7hfWNK",
      label: "+15559876543, +15551230000",
    });
    // A fresh window on the same home still knows about it.
    expect(build().state().chat?.uid).toBe("cht_D7hfWNK");
  });

  it("leaves a stored chat alone when a redeem carries none", async () => {
    // "This redeem carried no chat" is not "the account has no chat": the
    // phone-code path never carries one, and neither does a redeem from a Plow
    // that predates chats. Blanking on that answer would erase a chat the
    // account really has, and nothing can re-read the redeem to get it back.
    const seeded = loadSettings(home);
    seeded.provisionedChatUid = "cht_ALREADY";
    seeded.provisionedChatLabel = "+15559876543 · Ada Lovelace";
    saveSettings(home, seeded);

    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.begin();
    await settle();

    expect(onboarding.state().step).toBe("connected");
    expect(loadSettings(home).provisionedChatUid).toBe("cht_ALREADY");
    expect(onboarding.state().chat?.uid).toBe("cht_ALREADY");
  });

  it("keeps the number the server told the user to text, verbatim", async () => {
    // A pool line is assigned per activation and no call answers "which line is
    // mine", so the completed activation is the only place it ever appears. The
    // cloud-agents screen tells a chatless account to text it.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN, chat: CHAT }];
    const onboarding = build();
    const shown = await onboarding.begin();
    await settle();

    expect(loadSettings(home).activationSendTo).toBe(shown.activation?.sendTo);
    expect(loadSettings(home).activationSendTo).toBe("+15550001111");
  });

  it("stores no number at all when the sign-in never had an activation", async () => {
    // The phone-code path is texted no number, so there is none to remember —
    // and an empty field must stay empty rather than be filled with a guess.
    const onboarding = build();
    await onboarding.requestCode("+15551110000");
    await onboarding.submitCode("12345678");

    expect(onboarding.state().step).toBe("connected");
    expect(loadSettings(home).activationSendTo).toBe("");
  });

  it("leaves a stored number alone when a sign-in has no activation to name one", async () => {
    // "This sign-in had no activation" is not "there is no line": the number
    // came from the activation that made this account's chat, and the redeem
    // that carried it cannot be asked twice. Blanking it here would leave the
    // cloud-agents screen with nothing to tell the user to text.
    const seeded = loadSettings(home);
    seeded.activationSendTo = "+15559876543";
    saveSettings(home, seeded);

    const onboarding = build();
    await onboarding.requestCode("+15551110000");
    await onboarding.submitCode("12345678");

    expect(onboarding.state().step).toBe("connected");
    expect(loadSettings(home).activationSendTo).toBe("+15559876543");
  });

  it("has no chat to show on a Mac whose activation never made one", async () => {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.begin();
    await settle();

    expect(loadSettings(home).provisionedChatUid).toBe("");
    expect(onboarding.state().chat).toBeNull();
  });

  it("labels a chat off the wire with the phone number, never the thread id", () => {
    // The bug this pins: the chat's own `provider_key` is the provider's THREAD
    // ID ("chat_5"), and the number lives on the agent participant's line.
    // Reading the wrong one put an opaque id where the user looks for something
    // to text. Parsed from the real shape rather than a hand-made
    // `ActivationChat`, because the two halves are only wrong together.
    const chat = parseActivationChat({
      uid: "cht_D7hfWNK",
      object: "chat",
      status: "active",
      provider_key: "chat_5",
      created_at: "2026-08-24T18:02:11Z",
      participants: [
        {
          type: "agent",
          uid: "cpt_agent",
          line: { uid: "lin_7", provider_type: "linq", provider_key: "+15559876543" },
        },
        {
          type: "member",
          uid: "cpt_ada",
          status: "active",
          display_name: "Ada Lovelace",
          provider_key: "+15551230000",
        },
      ],
    })!;

    const label = activationChatLabel(chat);
    expect(label).toBe("+15559876543, +15551230000");
    expect(label).not.toContain("chat_5");
  });

  it("names a chat by its line, owner handle and remaining handles — a chat has no title", () => {
    expect(activationChatLabel({
      ...CHAT,
      participants: [
        { providerKey: "+15551230000" },
        { providerKey: "+15557654321" },
      ],
    })).toBe("+15559876543, +15551230000, +15557654321");
    // A member whose address IS the line is not said twice.
    expect(
      activationChatLabel({
        ...CHAT,
        participants: [...CHAT.participants, { providerKey: "+15559876543" }],
      }),
    ).toBe("+15559876543, +15551230000");
    expect(activationChatLabel({ ...CHAT, participants: [] })).toBe("+15559876543");
    // A member is identified by the real handle, never a display name.
    expect(
      activationChatLabel({
        ...CHAT,
        line: null,
        participants: [{ providerKey: "+15551230000" }],
      }),
    ).toBe("+15551230000");
    // Nothing to say but the uid beats an empty line on the last setup screen.
    expect(activationChatLabel({ ...CHAT, line: null, participants: [] })).toBe("cht_D7hfWNK");
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

  it("signs in a text that lands after the screen stalled — the live mba failure", async () => {
    // Reported from a live run: code minted at 15:02, screen stalled at 15:07,
    // text sent at 15:17. The server completed the activation and held the
    // session token for the first redeem — which never came, because the old
    // loop cancelled itself at five minutes. The Mac sat on "we haven't heard
    // from your phone" while the phone said "You're all set!".
    const onboarding = build();
    await onboarding.begin();
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
    await settleUntil(() => onboarding.state().step === "connected");

    expect(loadSettings(home).relayCredential).toBe(DEVICE_TOKEN);
    expect(plow.activations).toHaveLength(1);
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

  it("re-arms the SAME code while the server still honours it — a live code is never abandoned", async () => {
    // Minting a replacement would leave the live old code with no watcher: its
    // completion is handed out exactly once, so a user who texts the code they
    // already copied would succeed on the phone and strand the Mac — the same
    // stranding this PR exists to end.
    const onboarding = build();
    await onboarding.begin();
    await settleUntil(() => onboarding.state().activationStale);

    const state = await onboarding.newActivationCode();
    expect(plow.activations).toHaveLength(1);
    expect(state.activation?.displayCode).toBe("CODE1");
    expect(state.activationStale).toBe(false);
    expect(state.message).toContain("still works");

    // And the re-armed watch is real: a text now signs in.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    await settleUntil(() => onboarding.state().step === "connected");
  });

  it("mints a fresh code only once the server has retired the old one", async () => {
    const onboarding = build();
    await onboarding.begin();
    await settleUntil(() => onboarding.state().activationStale);

    plow.redeems = [new PlowApiError("expired", "Activation expired", 410)];
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

describe("one code, however many callers ask for it", () => {
  it("does not burn a second code when two callers ask while the API is slow", async () => {
    // A display code IS a credential: whoever texts it gets the account. A
    // second one minted behind the first is live on the account, shown to
    // nobody, and revocable by nobody — the screen only ever displays one.
    plow.holdActivations();
    const onboarding = build();

    const first = onboarding.begin();
    const second = onboarding.begin();
    const third = onboarding.newActivationCode();
    plow.releaseActivations();
    const [a, b, c] = await Promise.all([first, second, third]);

    expect(plow.activations).toHaveLength(1);
    // ...and all three callers are looking at the one code that exists.
    for (const state of [a, b, c]) expect(state.activation?.displayCode).toBe("CODE1");
    onboarding.reset(); // stop the poll loop this started
  });

  it("survives the sequence sign-out actually produces", async () => {
    // `settings:signOut` resets, syncs the gate — which opens the setup window,
    // whose renderer calls `begin` on boot — and calls `begin` itself. On a slow
    // `/v1/auth/activate` both of those are in flight at once.
    plow.holdActivations();
    const onboarding = build();
    onboarding.reset();
    const fromSignOut = onboarding.begin();
    const fromRenderer = onboarding.begin();
    plow.releaseActivations();
    await Promise.all([fromSignOut, fromRenderer]);

    expect(plow.activations).toHaveLength(1);
    onboarding.reset();
  });

  it("does not wedge the button once the mint has landed", async () => {
    // Single-flight must not wedge the button: "Get a New Code" after the mint
    // returns runs a real re-check rather than joining a spent flight — and
    // since the code is still live, the re-check re-arms it, not replaces it.
    const onboarding = build();
    await onboarding.begin();
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
    const failed = await onboarding.begin();
    expect(failed.message).toBe("Couldn't reach Plow.");
    expect(failed.activation).toBeNull();

    plow.createActivation = original;
    const state = await onboarding.begin();
    expect(state.activation?.displayCode).toBeTruthy();
    onboarding.reset();
  });
});

describe("signing out", () => {
  it("returns to the activation screen without needing a restart", async () => {
    // Reported live: Sign Out blanked the credential in settings but left the
    // state machine on "connected", because `step` is decided in the
    // constructor. The window kept rendering the connected screen against empty
    // settings — "Signed in — connecting…", blank endpoint, blank account — and
    // the only way back to signing in was quitting the app.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.begin();
    await settle();
    expect(onboarding.state().step).toBe("connected");

    // What `settings:signOut` does to disk, then the reset it must also do.
    const settings = loadSettings(home);
    settings.relayCredential = "";
    settings.accountUid = "";
    settings.mcpUrl = "";
    saveSettings(home, settings);

    const state = onboarding.reset();
    expect(state.step).toBe("activate");
    // ...and nothing from the old session is left behind.
    expect(state.activation).toBeNull();
    expect(state.accountUid).toBe("");
    expect(state.mcpUrl).toBe("");
    expect(state.busy).toBe(false);

    // From there the normal path works: it mints a code, no restart involved.
    const begun = await onboarding.begin();
    expect(begun.activation?.displayCode).toBeTruthy();
  });

  /** Sign in by the phone path, then blank the credential the way sign-out does. */
  async function signedInThenOut(): Promise<Onboarding> {
    const onboarding = buildOnPhonePath();
    await onboarding.requestCode("+15551110000");
    await onboarding.submitCode("12345678");
    expect(onboarding.state().step).toBe("connected");

    const settings = loadSettings(home);
    settings.relayCredential = "";
    settings.accountUid = "";
    settings.mcpUrl = "";
    saveSettings(home, settings);
    plow.connected = false; // signing out restarts the relay, which drops the socket
    return onboarding;
  }

  it("mints a fresh code when the user starts again", async () => {
    const onboarding = await signedInThenOut();
    onboarding.reset();
    const state = await onboarding.begin();
    expect(state.step).toBe("activate");
    expect(state.activation?.displayCode).toBeTruthy();
    expect(plow.activations.length).toBe(1); // the first login used the OTP path

    // `begin` starts a detached poll loop, and its injected `wait` advances the
    // clock every test in this file shares. Left running it drifts the next
    // test's deadlines — so stop it, the way every other exit from that screen
    // does.
    onboarding.reset();
  });

  it("keeps nothing from the session that ended", async () => {
    const onboarding = await signedInThenOut();
    const state = onboarding.reset();
    expect(state.phone).toBe("");
    expect(state.connected).toBe(false);
    expect(state.activation).toBeNull();
    expect(state.codeExpiresAt).toBeNull();
    expect(JSON.stringify(state)).not.toContain(DEVICE_TOKEN);
    expect(JSON.stringify(state)).not.toContain(OTP_TOKEN);
  });

  it("stays on the connected screen if a credential is somehow still there", () => {
    // reset() re-derives from settings rather than assuming; a reset with a
    // live credential must not throw the user back to activation.
    const onboarding = build();
    const settings = loadSettings(home);
    settings.relayCredential = DEVICE_TOKEN;
    saveSettings(home, settings);
    expect(onboarding.reset().step).toBe("connected");
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

    const serialized = JSON.stringify(connectedState);
    expect(serialized).not.toContain(DEVICE_TOKEN);
    expect(serialized).not.toContain(OTP_TOKEN);
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

  it("forgets the chat too — the next sign-in may be a different account", async () => {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN, chat: CHAT }];
    const onboarding = build();
    await onboarding.begin();
    await settle();
    expect(loadSettings(home).provisionedChatUid).toBe("cht_D7hfWNK");

    signOutOfPlow(home);

    // Leaving it would name a chat this Mac can no longer reach on the setup
    // screen of whatever account signs in next.
    expect(loadSettings(home).provisionedChatUid).toBe("");
    expect(loadSettings(home).provisionedChatLabel).toBe("");
    // The line goes with it: it belongs to the activation of the account just
    // left, and the next account gets its own.
    expect(loadSettings(home).activationSendTo).toBe("");
    expect(onboarding.reset().chat).toBeNull();
  });

  it("the reported path: signing out leaves a window that is NOT connected", async () => {
    // The instance outlives the sign-out, and the constructor is the only other
    // place that decides this — so it went on reporting the account just left.
    // The screen offered Create Agent over a stale endpoint, which then failed
    // its own credential check.
    const onboarding = await signedIn();
    signOutOfPlow(home);
    plow.connected = false;

    const changesBefore = changes;
    const after = onboarding.reset();

    expect(after.step).not.toBe("connected");
    expect(after.step).toBe("activate");
    // The account just left is gone from the state the window renders.
    expect(after.accountUid).toBe("");
    expect(after.mcpUrl).toBe("");
    expect(after.connected).toBe(false);
    // An open window is told to re-read.
    expect(changes).toBeGreaterThan(changesBefore);
    // …and it has nothing to draw yet: the reset mints no code, so a window
    // left open would sit on "Getting a code from Plow…" until something asks
    // for one. That is what `settings:signOut` calls `begin()` for when the
    // window IS open, and what the renderer's own startup `begin()` does when
    // it is reopened. Either way, this is the call and this is its answer.
    expect(after.activation).toBeNull();
    const reopened = await onboarding.begin();
    expect(reopened.step).toBe("activate");
    expect(reopened.activation?.displayCode).toBeTruthy();
    expect(plow.activations).toHaveLength(2); // one per sign-in attempt, not more
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
    onboarding.reset();
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
      onboarding.reset();
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

describe("a sign-out while startRelay is dialling", () => {
  it("is not overwritten by the continuation's connected state", async () => {
    // `startRelay` is a network round-trip, and a sign-out landing inside it
    // resets this instance to `activate`. The continuation then set
    // `connected` on top, leaving a window reporting the session it had just
    // been signed out of — with a credential the sign-out had already erased.
    let release = () => {};
    const dialing = new Promise<void>((r) => {
      release = () => r();
    });
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }, { status: "pending" }];
    const onboarding = build({
      startRelay: async () => {
        started += 1;
        await dialing;
        plow.connected = true;
      },
    });
    const begun = onboarding.begin();
    await settle();

    signOutOfPlow(home);
    onboarding.reset();
    expect(onboarding.state().step).toBe("activate");

    release();
    await begun;
    await settle();

    expect(onboarding.state().step).not.toBe("connected");
    expect(loadSettings(home).relayCredential).toBe("");
  });
});
