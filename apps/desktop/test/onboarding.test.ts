import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVATION_POLL_INTERVAL_MS,
  ACTIVATION_POLL_WINDOW_MS,
  CODE_TTL_MS,
  activationChatLabel,
  KEYCHAIN_LOCKED_MESSAGE,
  LOOSE_SESSION_WARNING,
  Onboarding,
  OnboardingDeps,
} from "../src/onboarding.js";
import { ActivationChat, PlowApi, PlowApiError, parseActivationChat } from "../src/plowApi.js";
import { loadSettings, saveSettings, useCredentialCodec } from "../src/settings.js";
import { signOutOfPlow } from "../src/settingsActions.js";

const DEVICE_TOKEN = "plow_DEVICEtok_secret";
const OTP_TOKEN = "plow_OTPTOKEN_secret";
const SESSION_TOKEN = "plow_ACTIVATIONsession_secret";
const ACTIVATION_SECRET = "activation_secret_never_shown";
const MCP_URL = "http://localhost:4242/v1/relay/devices/u_123/mcp";

/** A chat as `parseActivationChat` hands it over: the line it runs on, and the
 * person on the other end. */
const CHAT: ActivationChat = {
  uid: "cht_D7hfWNK",
  status: "active",
  displayName: null,
  line: "+15559876543",
  createdAt: "2026-08-24T18:02:11Z",
  participants: [{ providerKey: "+15551230000", displayName: null, isOwner: true }],
};

function wireChat({
  displayName,
  line = "+15550000000",
  members,
}: {
  displayName?: string;
  line?: string;
  members: Array<{ displayName: string; providerKey?: string; role: "owner" | "member" }>;
}): Record<string, unknown> {
  return {
    uid: "cht_fixture",
    object: "chat",
    status: "active",
    provider_key: "thread_fixture",
    ...(displayName === undefined ? {} : { display_name: displayName }),
    participants: [
      {
        type: "agent",
        line: { uid: "ln_fixture", provider_type: "imessage", provider_key: line },
      },
      ...members.map((member, index) => ({
        type: "member",
        uid: `cp_${index}`,
        display_name: member.displayName,
        role: member.role,
        provider_type: "imessage",
        provider_key: member.providerKey ?? `+1555000000${index}`,
      })),
    ],
    created_at: "2026-08-27T22:22:52Z",
  };
}

type FakeRedeem =
  | { status: "pending" }
  | { status: "verified"; token: string | null; chat?: ActivationChat | null };

/** A stand-in Plow: records what was called, answers what the real one does. */
class FakePlow {
  requested: string[] = [];
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
    // Recorded BEFORE the gate, so a test can wait for the call to be in
    // flight rather than for it to finish.
    this.redeemCalls.push(secret);
    if (this.redeemGate) await this.redeemGate;
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

  revoked: string[] = [];
  /** Every call, counted before it is awaited, so a test can wait for the call
   * rather than for its completion. */
  revokeCalls: string[] = [];

  /** Make every revoke fail, the way an unreachable Plow does. */
  revokeFails = false;
  /** ...or only these, so a test can let one through and refuse the next. */
  revokeRefuses: string[] = [];
  /** Tokens the server says are already gone — what a 401 on
   * `/v1/relay/devices/self/revoke` means, since the token authenticates it. */
  revokeUnauthorized: string[] = [];
  /** Tokens that authenticate but may not be revoked: a 403, and a session
   * that is very much alive. */
  revokeForbidden: string[] = [];

  private revokeGate: Promise<void> | null = null;
  private openRevokes: (() => void) | null = null;
  /** Hold every revoke open, so a test can start a second caller while the
   * first is still on the wire. */
  holdRevokes(): void {
    this.revokeGate = new Promise((resolve) => {
      this.openRevokes = resolve;
    });
  }
  releaseRevokes(): void {
    this.openRevokes?.();
    this.revokeGate = null;
    this.openRevokes = null;
  }

  async revokeDeviceCredential(token: string): Promise<void> {
    // Counted before the gate, so a test can wait for the call to be IN
    // FLIGHT rather than for it to finish.
    this.revokeCalls.push(token);
    if (this.revokeGate) await this.revokeGate;
    if (this.revokeUnauthorized.includes(token)) {
      throw new PlowApiError("unauthorized", "Not authorized.", 401);
    }
    if (this.revokeForbidden.includes(token)) {
      throw new PlowApiError("forbidden", "Not permitted.", 403);
    }
    if (this.revokeFails || this.revokeRefuses.includes(token)) {
      throw new PlowApiError("network", "unreachable");
    }
    this.revoked.push(token);
  }

  private redeemGate: Promise<void> | null = null;
  private openRedeems: (() => void) | null = null;
  holdRedeems(): void {
    this.redeemGate = new Promise((resolve) => {
      this.openRedeems = resolve;
    });
  }
  releaseRedeems(): void {
    this.openRedeems?.();
    this.redeemGate = null;
    this.openRedeems = null;
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
/** Bumped per test; a wait built under an older value parks — see `wait`. */
let harnessGen = 0;

/** The same shape `settings.test.ts` uses: reversible, and `available()` is
 * what a locked keychain answers false to. */
const fakeCodec = (available = true) => ({
  available: () => available,
  encrypt: (plain: string) => `sealed:${Buffer.from(plain).toString("base64")}`,
  decrypt: (cipher: string) => {
    if (!cipher.startsWith("sealed:")) throw new Error("not ours");
    return Buffer.from(cipher.slice("sealed:".length), "base64").toString();
  },
});

function build(extra: Partial<OnboardingDeps> = {}): Onboarding {
  const gen = harnessGen;
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
  harnessGen += 1;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-onboarding-"));
  plow = new FakePlow();
  warnings = [];
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
    expect(loadSettings(home).relayCredential).toBe(SESSION_TOKEN);
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
    expect(settings.provisionedChatLabel).toBe("+1 555-987-6543 · You");
    expect(onboarding.state().chat).toEqual({
      uid: "cht_D7hfWNK",
      label: "+1 555-987-6543 · You",
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

  it("stores no number: pairing's sendTo is the managed phone, not a line", async () => {
    // Pairing asks for no chat, so the server answers with the number that
    // takes an activation text — not a pool line anyone can be told to text
    // afterwards to get a chat. Storing it put the managed phone where the
    // cloud-agents screen says "text this to make a chat", which provisions
    // nothing. A number for a chat is a pool line, reached by texting it.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN, chat: CHAT }];
    const onboarding = build();
    const shown = await onboarding.begin();
    await settle();

    expect(shown.activation?.sendTo).toBe("+15550001111");
  });

  it.each([
    ["its line", (token: string) => ({ ...CHAT, line: token.slice(0, 12) })],
    ["a participant's number", (token: string) => ({
      ...CHAT,
      participants: [{ providerKey: token.slice(0, 12), displayName: "Ada", isOwner: false }],
    })],
    ["its uid", (token: string) => ({ ...CHAT, uid: `cht_${token.slice(0, 12)}` })],
  ])("never writes a chat to disk when %s echoes the session token", async (_why, make) => {
    // The label is built from the line, the uids, the numbers and the names,
    // and THIS is the one place they are written to disk. The redeem carries
    // the session token in the same breath, so a server that echoed it here
    // would have persisted it and rendered it.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN, chat: make(SESSION_TOKEN) }];
    const onboarding = build();
    await onboarding.begin();
    await settle();

    // The sign-in still completes — the chat is what is dropped, and the
    // account's list is re-read on the Agents tab anyway.
    expect(loadSettings(home).relayCredential).toBe(SESSION_TOKEN);
    expect(loadSettings(home).provisionedChatUid).toBe("");
    expect(loadSettings(home).provisionedChatLabel).toBe("");
    const persisted = JSON.stringify(loadSettings(home));
    expect(persisted.split(SESSION_TOKEN).length - 1).toBe(1); // the credential, and nothing else
    expect(JSON.stringify(onboarding.state())).not.toContain(SESSION_TOKEN.slice(0, 12));
    // Said, without repeating any of the fields that triggered it.
    expect(warnings.join(" ")).toContain("echoed the credential");
    expect(warnings.join(" ")).not.toContain(SESSION_TOKEN.slice(0, 12));
  });

  it("keeps a chat whose NAME echoes, with the name removed", async () => {
    // A name can be blanked and the row still means something; dropping it
    // would lose a chat the owner actually has.
    plow.redeems = [{
      status: "verified",
      token: SESSION_TOKEN,
      chat: { ...CHAT, displayName: SESSION_TOKEN.slice(0, 12) },
    }];
    const onboarding = build();
    await onboarding.begin();
    await settle();

    expect(loadSettings(home).provisionedChatUid).toBe(CHAT.uid);
    expect(loadSettings(home).provisionedChatLabel).not.toContain(SESSION_TOKEN.slice(0, 12));
    expect(loadSettings(home).provisionedChatLabel).toBeTruthy();
  });

  it("has no chat to show on a Mac whose activation never made one", async () => {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const onboarding = build();
    await onboarding.begin();
    await settle();

    expect(loadSettings(home).provisionedChatUid).toBe("");
    expect(onboarding.state().chat).toBeNull();
  });

  // The label is `chatRows`' title now — the ONE place participants become
  // people. It leads with the line, names the owner "You", and stands a
  // formatted number in for anyone without a usable name. A top-level chat
  // title still wins outright when the provider gives one.
  it.each([
    ["prefers a chat's top-level display name", {
      displayName: "Weekend crew",
      members: [{ displayName: "Morgan", providerKey: "+15550001001", role: "member" as const }],
    }, "Weekend crew"],
    ["keeps an emoji-only top-level display name", {
      displayName: "🎉",
      members: [{ displayName: "Riley", providerKey: "+15550002001", role: "member" as const }],
    }, "🎉"],
    ["rejects a phone-number-shaped top-level display name and names the people", {
      displayName: "+1 (555) 000-4001, +1 (555) 000-4002",
      line: "+15550004000",
      members: [
        { displayName: "Riley", providerKey: "+15550004001", role: "owner" as const },
        { displayName: "Casey", providerKey: "+15550004002", role: "member" as const },
      ],
    }, "+1 555-000-4000 · You · Casey"],
    ["names the owner You and everyone else by name", {
      line: "+15550005000",
      members: [
        { displayName: "Whoever", providerKey: "+15550005001", role: "owner" as const },
        { displayName: "Riley", providerKey: "+15550005002", role: "member" as const },
      ],
    }, "+1 555-000-5000 · You · Riley"],
    ["stands a number in for a name that just repeats the handle", {
      line: "+15550003000",
      members: [{ displayName: "+15550003001", providerKey: "+15550003001", role: "member" as const }],
    }, "+1 555-000-3000 · +1 555-000-3001"],
    ["lists the line once when a member is on it", {
      line: "+15550006000",
      members: [
        { displayName: "Riley", providerKey: "+15550006000", role: "member" as const },
        { displayName: "Casey", providerKey: "+15550006002", role: "member" as const },
      ],
    }, "+1 555-000-6000 · Casey"],
  ])("%s", (_case, fields, expected) => {
    expect(activationChatLabel(parseActivationChat(wireChat(fields))!)).toBe(expected);
  });

  it("falls back to numbers when the wire has no usable display names", () => {
    // The bug this pins: the chat's own `provider_key` is the provider's THREAD
    // ID ("chat_5"), and the number lives on the agent participant's line.
    // Reading the wrong one put an opaque id where the user looks for something
    // to text. Parsed from the real shape rather than a hand-made
    // `ActivationChat`, because the two halves are only wrong together.
    const chat = parseActivationChat(wireChat({
      line: "+15559876543",
      members: [
        { displayName: "You", providerKey: "+15551230000", role: "owner" },
      ],
    }))!;

    // The owner reads as "You" and the line is formatted; what this pins is
    // that the LINE is the number shown, never the chat's own `provider_key`.
    const label = activationChatLabel(chat);
    expect(label).toBe("+1 555-987-6543 · You");
    expect(label).not.toContain("thread_fixture");
    expect(label).not.toContain("thread_fixture");
  });

  it("falls back to its line, owner handle and remaining handles", () => {
    expect(activationChatLabel({
      ...CHAT,
      participants: [
        { providerKey: "+15551230000", displayName: null, isOwner: true },
        { providerKey: "+15557654321", displayName: null, isOwner: false },
      ],
    })).toBe("+1 555-987-6543 · You · +1 555-765-4321");
    // A member whose address IS the line is not said twice.
    expect(
      activationChatLabel({
        ...CHAT,
        participants: [
          ...CHAT.participants,
          { providerKey: "+15559876543", displayName: null, isOwner: false },
        ],
      }),
    ).toBe("+1 555-987-6543 · You");
    expect(activationChatLabel({ ...CHAT, participants: [] })).toBe("+1 555-987-6543");
    // A member without a usable display name is identified by its real handle.
    expect(
      activationChatLabel({
        ...CHAT,
        line: null,
        participants: [{ providerKey: "+15551230000", displayName: null, isOwner: false }],
      }),
    ).toBe("+1 555-123-0000");
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

    expect(loadSettings(home).relayCredential).toBe(SESSION_TOKEN);
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

    // And the screen's promise holds without the control even being needed:
    // the watch never stopped, so a late text signs in on the next poll. The
    // click just re-arms the countdown; it must not break the sign-in.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    await onboarding.newActivationCode();
    await settleUntil(() => onboarding.state().step === "connected");
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
    await onboarding.begin();
    await settleUntil(() => onboarding.state().activationStale);

    plow.redeems = [new PlowApiError("network", "Couldn't reach Plow.")];
    await onboarding.newActivationCode();
    expect(plow.activations).toHaveLength(1);
    expect(onboarding.state().activation?.displayCode).toBe("CODE1");

    // And the kept code still signs in when its text lands.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    await settleUntil(() => onboarding.state().step === "connected");
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
    expect(state.message).toBe("Plow verified this Mac but didn't hand back a login. Try again for a fresh code.");
    expect(plow.redeemCalls).toHaveLength(1);

    // The spent code is dropped, so the promised control actually works: the
    // next click mints instead of re-arming a code that can never sign in.
    expect((await onboarding.newActivationCode()).activation?.displayCode).toBe("CODE2");
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
    // Single-flight must not wedge the button: "Try Again" after the mint
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
    expect(settings.relayCredential).toBe(OTP_TOKEN);
    expect(settings.mcpUrl).toBe(MCP_URL);
  });

  it("does not persist a token when the sign-out lands during its revoke", async () => {
    // The decision to keep is re-asked on the far side of the revoke await,
    // never read once at the top: `activationSecret` and the stored credential
    // can BOTH change while that call is on the wire, and a stale yes would
    // write a session the sign-out had already retired.
    let releaseRevoke = () => {};
    const revokeInAir = new Promise<void>((r) => {
      releaseRevoke = () => r();
    });
    plow.holdRedeems();
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    const original = plow.revokeDeviceCredential.bind(plow);
    plow.revokeDeviceCredential = async (token: string) => {
      // Recorded before the gate: the test waits for the call to be IN FLIGHT,
      // and waiting for it to finish would wait on the gate it holds.
      plow.revokeCalls.push(token);
      await revokeInAir;
      return original(token);
    };

    const onboarding = build();
    await onboarding.begin();
    // Wait for the redeem to be ON THE WIRE, then give up on the code: the
    // answer that comes back is one this Mac will not keep.
    await settleUntil(() => plow.redeemCalls.length === 1);
    onboarding.usePhoneCode();
    plow.releaseRedeems();
    await settleUntil(() => plow.revokeCalls.length === 1);

    // ...and signs out while that revoke is still in flight.
    signOutOfPlow(home);
    onboarding.reset();
    releaseRevoke();
    await settle();

    expect(plow.revoked).toEqual([SESSION_TOKEN]);
    expect(loadSettings(home).relayCredential).toBe("");
    expect(onboarding.state().step).not.toBe("connected");
  });

  it("keeps the login session AS the credential, minting nothing", async () => {
    // Latch is the owner's manager app, not an agent: the session it was just
    // handed is what it holds. `POST /v1/relay/devices` — a narrow credential
    // plus `revoke_calling_session` — is gone, and the fake throws if anything
    // reaches for it.
    const onboarding = buildOnPhonePath();
    await onboarding.requestCode("+15551110000");
    await onboarding.submitCode("12345678");

    // `PlowApi` has no `mintDeviceCredential` to reach for: the method is
    // deleted, so this cannot regress into a second step without a compile
    // error first.
    expect(loadSettings(home).relayCredential).toBe(OTP_TOKEN);
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
    const credential = loadSettings(home).relayCredential;

    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    await settle();

    // The credential this Mac already holds is not overwritten by a redeem it
    // did not ask for — and the session that redeem carried is RETIRED rather
    // than dropped. The redeem answers once, so a token declined here is a live
    // session on the account that nothing holds a reference to: not sign-out,
    // not the next launch. Nobody could ever retire it.
    expect(loadSettings(home).relayCredential).toBe(credential);
    expect(plow.revoked).toContain(SESSION_TOKEN);
  });

  it("a redeem in flight across the sign-out cannot mint", async () => {
    // A verified answer is deliberately acted on even when its poll loop has
    // been cancelled — the server hands the session token to the first redeem
    // that sees the completion and never again, so dropping it would strand an
    // activation the user really completed. The only thing that used to make
    // it moot was already holding a credential, and SIGN-OUT CLEARS THE
    // CREDENTIAL. The poll loop is the only redeemer there is, so its redeem
    // is the only one that can be on the wire.
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

    await settle();
    expect(plow.redeemCalls).toContain(inFlight);

    // The user signs out while that call is still on the wire.
    signOutOfPlow(home);
    onboarding.reset();

    // …and only now does the server answer "verified".
    release();
    await settle();

    // Nothing was persisted, and the window did not slide back to the account
    // the user just left.
    expect(loadSettings(home).relayCredential).toBe("");
    expect(loadSettings(home).accountUid).toBe("");
    expect(onboarding.state().step).not.toBe("connected");
  });
});

describe("a sign-out while the credential handoff is in the air", () => {
  // One await now, not two: the mint that used to follow `relayInfo` is gone,
  // so `relayInfo` is the whole window a sign-out can land in. Nothing needs
  // retiring on that path — the session is the owner's own, created by their
  // text, and sign-out's revoke is what retires it.
  // The session IS revoked on this path now. It exists on the account, the
  // sign-out's own revoke ran before it did, and the redeem that carried it
  // answers once — so a token dropped here is one nobody can ever retire.
  for (const race of [{ stage: "relayInfo", revoked: [SESSION_TOKEN] }] as const) {
    it(`stays signed out when the sign-out lands during ${race.stage}`, async () => {
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
      await onboarding.begin();
      await settle();

      signOutOfPlow(home);
      onboarding.reset();
      release();
      await settle();

      // Nothing is persisted and the window stays signed out. Nothing is
      // retired either: the session is the owner's own, and sign-out's revoke
      // is what retires it.
      expect(plow.revoked).toEqual(race.revoked);
      expect(loadSettings(home).relayCredential).toBe("");
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

describe("a verified session this Mac does not keep", () => {
  /** Break the handoff, so the session is verified and never persisted. */
  function breakHandoff(): void {
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];
    plow.relayInfo = async () => {
      throw new PlowApiError("network", "Plow is unreachable.");
    };
  }

  it("retires it when the handoff fails, rather than dropping it", async () => {
    // `relayInfo` rejecting used to throw straight past the token. The redeem
    // that produced it answers exactly once, so this Mac was the only thing in
    // the world that could retire the session — and it had just let go.
    breakHandoff();
    const onboarding = build();
    await onboarding.begin();
    await settle();

    expect(plow.revoked).toEqual([SESSION_TOKEN]);
    // Confirmed, so nothing is held.
    expect(loadSettings(home).pendingRevocations).toEqual([]);
    expect(loadSettings(home).relayCredential).toBe("");
    expect(onboarding.state().step).not.toBe("connected");
  });

  it("holds it when the revoke fails too, and says so on screen", async () => {
    // Both calls down: the session is live on the account for 180 days, and
    // the token is the only handle. It goes to disk rather than on the floor.
    breakHandoff();
    plow.revokeFails = true;
    const onboarding = build();
    await onboarding.begin();
    await settle();

    expect(loadSettings(home).pendingRevocations).toEqual([SESSION_TOKEN]);
    // The loose session outranks the timeout that caused it: a network blip is
    // retryable, an unretired account session is the owner's to act on.
    expect(onboarding.state().message).toBe(LOOSE_SESSION_WARNING);
    // Said, never shown: the warning names no value.
    expect(onboarding.state().message).not.toContain(SESSION_TOKEN);
    expect(warnings.join(" ")).not.toContain(SESSION_TOKEN);
  });

  it("never leaves the token in the state the renderer reads", async () => {
    breakHandoff();
    plow.revokeFails = true;
    const onboarding = build();
    await onboarding.begin();
    await settle();

    expect(JSON.stringify(onboarding.state())).not.toContain(SESSION_TOKEN);
  });
});

describe("a session held for a later revoke", () => {
  function heldSession(): void {
    const settings = loadSettings(home);
    settings.pendingRevocations = [SESSION_TOKEN];
    saveSettings(home, settings);
  }

  it("is retired on the next launch, and forgotten once Plow confirms", async () => {
    heldSession();
    await build().retryPendingRevocations();

    expect(plow.revoked).toEqual([SESSION_TOKEN]);
    expect(loadSettings(home).pendingRevocations).toEqual([]);
  });

  it("is retried before a fresh code is minted", async () => {
    // The last moment before the owner logs in again — and a Mac about to
    // activate is a Mac that can reach Plow.
    heldSession();
    const onboarding = build();
    await onboarding.begin();

    expect(plow.revoked).toEqual([SESSION_TOKEN]);
    expect(loadSettings(home).pendingRevocations).toEqual([]);
    // ...and the code was still minted.
    expect(onboarding.state().activation?.displayCode).toBe("CODE1");
  });

  it("is kept when the retry fails too, and does not stop the mint", async () => {
    heldSession();
    plow.revokeFails = true;
    const onboarding = build();
    await onboarding.begin();

    expect(loadSettings(home).pendingRevocations).toEqual([SESSION_TOKEN]);
    expect(onboarding.state().activation?.displayCode).toBe("CODE1");
    expect(onboarding.state().message).toBe(LOOSE_SESSION_WARNING);
  });

  it("survives a sign-out, which is the moment it matters most", () => {
    // Sign-out clears everything about the account — but the whole point of
    // this field is a session sign-out's own revoke never saw.
    heldSession();
    signOutOfPlow(home);
    expect(loadSettings(home).pendingRevocations).toEqual([SESSION_TOKEN]);
  });

  it("keeps BOTH when two logins fail their revoke, rather than overwriting", async () => {
    // The field was one slot, and a slot is a silent drop: the second failed
    // revoke assigned over the first, and that first session — live on the
    // account, its only handle now gone — was orphaned exactly the way the
    // whole mechanism exists to prevent. Two bad-network logins is all it took,
    // so this drives two, through the real activation path.
    const FIRST = "plow_sk_first_orphan";
    const SECOND = "plow_sk_second_orphan";
    plow.relayInfo = async () => {
      throw new PlowApiError("network", "Plow is unreachable.");
    };
    plow.revokeFails = true;

    const onboarding = build();
    plow.redeems = [{ status: "verified", token: FIRST }];
    await onboarding.begin();
    await settle();
    expect(loadSettings(home).pendingRevocations).toEqual([FIRST]);

    // A second go at signing in, and a second session Plow will not take back.
    plow.redeems = [{ status: "verified", token: SECOND }];
    await onboarding.newActivationCode();
    await settle();

    expect(loadSettings(home).pendingRevocations).toEqual([FIRST, SECOND]);
  });

  it("retries every held session, and keeps the ones that fail again", async () => {
    const FIRST = "plow_sk_first_orphan";
    const SECOND = "plow_sk_second_orphan";
    const settings = loadSettings(home);
    settings.pendingRevocations = [FIRST, SECOND];
    saveSettings(home, settings);

    // Plow takes the first and refuses the second: the confirmed one leaves,
    // the refused one stays. A retry is not all-or-nothing.
    const onboarding = build();
    plow.revokeRefuses = [SECOND];
    await onboarding.retryPendingRevocations();

    expect(plow.revoked).toEqual([FIRST]);
    expect(loadSettings(home).pendingRevocations).toEqual([SECOND]);

    // ...and once Plow will take it, the list empties.
    plow.revokeRefuses = [];
    await onboarding.retryPendingRevocations();
    expect(plow.revoked).toEqual([FIRST, SECOND]);
    expect(loadSettings(home).pendingRevocations).toEqual([]);
  });

  it("holds one token once, however many times its retry fails", async () => {
    heldSession();
    plow.revokeFails = true;
    const onboarding = build();
    await onboarding.retryPendingRevocations();
    await onboarding.retryPendingRevocations();
    await onboarding.retryPendingRevocations();

    expect(loadSettings(home).pendingRevocations).toEqual([SESSION_TOKEN]);
  });

  it("sweeps ONCE when launch and an activation both ask at the same time", async () => {
    // Launch starts a sweep and the first activation starts another; on a slow
    // network they overlap, both read the same list, and both revoke the same
    // token. The second call then gets a 401 — because the first one worked —
    // and the token went back on the list as a session that no longer exists.
    heldSession();
    plow.holdRevokes();
    const onboarding = build();

    const fromLaunch = onboarding.retryPendingRevocations();
    const fromActivation = onboarding.retryPendingRevocations();
    await settleUntil(() => plow.revokeCalls.length >= 1);
    plow.releaseRevokes();
    await Promise.all([fromLaunch, fromActivation]);

    // One call, not two: the second caller joined the flight in progress.
    expect(plow.revokeCalls).toEqual([SESSION_TOKEN]);
    expect(plow.revoked).toEqual([SESSION_TOKEN]);
    expect(loadSettings(home).pendingRevocations).toEqual([]);
  });

  it("starts a fresh sweep once the last one has finished", async () => {
    // Single-flight is not once-per-process: the handle is dropped when the
    // sweep ends, so the next launch or activation really does try again.
    heldSession();
    plow.revokeRefuses = [SESSION_TOKEN];
    const onboarding = build();
    await onboarding.retryPendingRevocations();
    expect(loadSettings(home).pendingRevocations).toEqual([SESSION_TOKEN]);

    plow.revokeRefuses = [];
    await onboarding.retryPendingRevocations();
    expect(plow.revoked).toEqual([SESSION_TOKEN]);
    expect(loadSettings(home).pendingRevocations).toEqual([]);
  });

  it("drops a token Plow says is already revoked, rather than holding it forever", async () => {
    // A 401 here is the token saying it no longer works — the revoke
    // authenticates WITH the token it retires. Treating that as a failure put
    // it back on the list, so a session that was already gone warned on every
    // screen and made worktree cleanup refuse for as long as the home lived.
    heldSession();
    plow.revokeUnauthorized = [SESSION_TOKEN];
    const onboarding = build();
    await onboarding.retryPendingRevocations();

    expect(loadSettings(home).pendingRevocations).toEqual([]);
    // Nothing is loose, so nothing is warned about.
    expect(onboarding.state().message).not.toBe(LOOSE_SESSION_WARNING);
  });

  it("keeps holding the ones that failed for a reason a retry could fix", async () => {
    // The 401 release must not become "give up on anything that errors": a
    // network failure is still a session this Mac has to come back for.
    const DEAD = "plow_sk_already_revoked";
    const LIVE = "plow_sk_still_live";
    const settings = loadSettings(home);
    settings.pendingRevocations = [DEAD, LIVE];
    saveSettings(home, settings);
    plow.revokeUnauthorized = [DEAD];
    plow.revokeRefuses = [LIVE];

    await build().retryPendingRevocations();

    expect(loadSettings(home).pendingRevocations).toEqual([LIVE]);
  });

  it("keeps a 403 staged — that session authenticated, so it is alive", async () => {
    // A 403 is the OPPOSITE of a 401 here: the token did authenticate, so the
    // session exists; only this call was refused. Dropping the handle to a
    // live `*:*` session because the server would not let us retire it is the
    // orphan the whole mechanism exists to prevent, and the owner needs that
    // handle to retire it in Plow.
    heldSession();
    plow.revokeForbidden = [SESSION_TOKEN];
    const onboarding = build();
    await onboarding.retryPendingRevocations();

    expect(loadSettings(home).pendingRevocations).toEqual([SESSION_TOKEN]);
    expect(onboarding.state().message).toBe(LOOSE_SESSION_WARNING);
  });

  it("still sweeps after a first sweep that had nothing to do", async () => {
    // A sweep with an empty list runs to completion synchronously, so it used
    // to clear the single-flight handle BEFORE the handle was assigned — and
    // the settled promise stayed parked there for the life of the process.
    // Every later launch and activation "joined" a sweep that had already
    // finished, and nothing was ever retried again.
    const onboarding = build();
    await onboarding.retryPendingRevocations();
    expect(plow.revokeCalls).toEqual([]);

    // ...now a login fails to retire its session, and an activation retries.
    heldSession();
    await onboarding.retryPendingRevocations();

    expect(plow.revoked).toEqual([SESSION_TOKEN]);
    expect(loadSettings(home).pendingRevocations).toEqual([]);
  });

  it("still sweeps on a fresh activation after an empty first sweep", async () => {
    // The same bug through the door it actually comes in by: launch sweeps an
    // empty list, then the owner starts a login and that mint's own retry is
    // the one that has to work.
    const onboarding = build();
    await onboarding.retryPendingRevocations();
    heldSession();

    await onboarding.begin();

    expect(plow.revoked).toEqual([SESSION_TOKEN]);
  });
});

describe("a Mac holding a credential it cannot read", () => {
  /** Seal a credential, then take the keychain away. */
  function locked(): void {
    useCredentialCodec(fakeCodec());
    const settings = loadSettings(home);
    settings.relayCredential = "plow_sk_sealed_and_unreadable";
    saveSettings(home, settings);
    useCredentialCodec(fakeCodec(false));
  }

  afterEach(() => useCredentialCodec(null));

  it("says so, and offers no way to sign in over it", () => {
    locked();
    const state = build().state();

    expect(state.locked).toBe(true);
    // Said the moment the screen opens — nobody has to press something that
    // cannot work in order to be told why.
    expect(state.message).toBe(KEYCHAIN_LOCKED_MESSAGE);
  });

  it("refuses to mint an activation code", async () => {
    locked();
    const onboarding = build();
    const shown = await onboarding.begin();

    expect(plow.activations).toEqual([]);
    expect(shown.activation).toBeNull();
    expect(shown.message).toBe(KEYCHAIN_LOCKED_MESSAGE);
  });

  it("refuses the phone-code path too", async () => {
    locked();
    const onboarding = build();
    await onboarding.requestCode("+15551230000");
    expect(plow.requested).toEqual([]);

    await onboarding.submitCode("12345678");
    expect(loadSettings(home).relayCredential).toBe("");
  });

  it("never seals a new credential over the one it cannot read", async () => {
    // The orphan this state exists to prevent: sign in again while locked and
    // the new credential's seal overwrites the old one, whose session is live
    // for 180 days with nothing left that could retire it.
    locked();
    const sealedBefore = JSON.parse(
      fs.readFileSync(path.join(home, "app/settings.json"), "utf8"),
    ) as Record<string, unknown>;
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN }];

    const onboarding = build();
    await onboarding.begin();
    await settle();

    const after = JSON.parse(
      fs.readFileSync(path.join(home, "app/settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(after.relayCredentialEnc).toBe(sealedBefore.relayCredentialEnc);
    // ...and it comes back intact once the keychain does.
    useCredentialCodec(fakeCodec());
    expect(loadSettings(home).relayCredential).toBe("plow_sk_sealed_and_unreadable");
  });

  it("goes back to ordinary setup once the keychain returns and it signs out", async () => {
    locked();
    useCredentialCodec(fakeCodec());
    signOutOfPlow(home);

    const onboarding = build();
    expect(onboarding.state().locked).toBe(false);
    await onboarding.begin();
    expect(onboarding.state().activation?.displayCode).toBe("CODE1");
  });
});
