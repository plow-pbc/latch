/**
 * Claiming a Plow number — the flow that spends a pool line on purpose,
 * beside the pairing that deliberately does not.
 *
 * The whole point of the separation is what this must never do: mint a
 * credential, or touch `relayCredential`. Most of what follows is that
 * property under a different pressure each time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaimLine, ClaimLineDeps } from "../src/claimLine.js";
import { ACTIVATION_POLL_INTERVAL_MS, ACTIVATION_POLL_WINDOW_MS } from "../src/activation.js";
import { ActivationChat, PlowApi, PlowApiError } from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";
import { FakeClock, settle, settleUntil } from "./activationHarness.js";

const DEVICE_TOKEN = "plow_DEVICEtok_alreadysignedin";
const SESSION_TOKEN = "plow_ACTIVATIONsession_secret";
const ACTIVATION_SECRET = "activation_secret_never_shown";

/** The chat a `provision_chat` activation creates: the assigned pool line, and
 * the person who texted the code. */
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

class FakePlow {
  /** One entry per `POST /v1/auth/activate`: the name, and what was asked for. */
  activations: Array<{ name: string; provisionChat: boolean }> = [];
  redeems: Array<FakeRedeem | PlowApiError> = [{ status: "pending" }];
  revoked: string[] = [];
  /** Anything that would mint on the account. Nothing here may call these. */
  minted: string[] = [];

  api(): PlowApi {
    return this as unknown as PlowApi;
  }

  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  holdActivations(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve;
    });
  }
  releaseActivations(): void {
    this.open?.();
    this.gate = null;
    this.open = null;
  }

  async createActivation(name: string, opts: { provisionChat?: boolean } = {}) {
    if (this.gate) await this.gate;
    const secret = `${ACTIVATION_SECRET}_${this.activations.length}`;
    this.activations.push({ name, provisionChat: !!opts.provisionChat });
    return {
      displayCode: `CODE${this.activations.length}`,
      activationSecret: secret,
      sendTo: "+15550001111",
    };
  }

  private redeemGate: Promise<void> | null = null;
  private openRedeems: (() => void) | null = null;
  /** Hold the redeem in flight, so a test can act while it is in the air. */
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

  async redeemActivation(_secret: string) {
    if (this.redeemGate) await this.redeemGate;
    const next = this.redeems.length > 1 ? this.redeems.shift()! : this.redeems[0];
    if (next instanceof PlowApiError) throw next;
    if (next.status === "pending") return next;
    return { status: "verified" as const, token: next.token, chat: next.chat ?? null };
  }

  private revokeGate: Promise<void> | null = null;
  private openRevokes: (() => void) | null = null;
  /** Hold the revoke in flight — it is an await like any other, and a
   * sign-out can land inside it. */
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
    if (this.revokeGate) await this.revokeGate;
    this.revoked.push(token);
  }

  async mintDeviceCredential(): Promise<never> {
    this.minted.push("device");
    throw new Error("claiming a line must never mint a credential");
  }
}

let home: string;
let plow: FakePlow;
let refreshes: number;
const clock = new FakeClock();

function build(extra: Partial<ClaimLineDeps> = {}): ClaimLine {
  return new ClaimLine({
    api: plow.api(),
    home,
    deviceName: "Plow Latch (test)",
    refreshAgents: async () => {
      refreshes += 1;
    },
    now: () => clock.now,
    wait: clock.waiter(),
    ...extra,
  });
}

/** A signed-in Mac: claiming is only ever reached from one. */
function signedInHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "latch-claim-"));
  const settings = loadSettings(dir);
  settings.relayCredential = DEVICE_TOKEN;
  settings.accountUid = "u_123";
  saveSettings(dir, settings);
  return dir;
}

beforeEach(() => {
  home = signedInHome();
  plow = new FakePlow();
  refreshes = 0;
  clock.reset();
});

afterEach(() => {
  // Park every loop this test left running, on both edges. `FakeClock.reset`
  // owns the why — after the file's last test there is no next `beforeEach`,
  // and an unparked loop takes the worker down.
  clock.reset();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("claiming a Plow number", () => {
  it("asks for the pool line — the one caller in the app that does", async () => {
    const claim = build();
    const state = await claim.begin();

    expect(plow.activations).toEqual([{ name: "Plow Latch (test)", provisionChat: true }]);
    expect(state.step).toBe("waiting");
    expect(state.activation?.displayCode).toBe("CODE1");
    // The number the server assigned, verbatim, and the exact body to send.
    expect(state.activation?.sendTo).toBe("+15550001111");
    expect(state.activation?.smsBody).toBe("Plow Activate: CODE1");
  });

  it("keeps the chat and the line, mints nothing, and retires the token", async () => {
    // One completed claim, and the three things that have to be true of it.
    // Separate `it`s here were three copies of one arrange asserting on the
    // same end state, so a change to the flow broke them in triplicate.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN, chat: CHAT }];
    const claim = build();
    await claim.begin();
    await settle();

    const settings = loadSettings(home);
    // KEPT: the chat, labelled as `activationChatLabel` builds it — the line
    // then the members — and the line this claim was assigned. No call answers
    // "which line is mine", so this moment is the only place it appears.
    expect(settings.provisionedChatUid).toBe("cht_D7hfWNK");
    expect(settings.provisionedChatLabel).toBe("+15559876543, +15551230000");
    expect(settings.activationSendTo).toBe("+15550001111");
    expect(claim.state().chat).toEqual({
      uid: "cht_D7hfWNK",
      label: "+15559876543, +15551230000",
    });
    // The new chat is a row on the screen behind the modal.
    expect(refreshes).toBe(1);

    // MINTED: nothing. The whole reason this is a second flow — a device
    // credential minted here would be a live, spend-capable key on a Mac that
    // already has one.
    expect(plow.minted).toEqual([]);
    expect(settings.relayCredential).toBe(DEVICE_TOKEN);
    expect(settings.accountUid).toBe("u_123");

    // RETIRED: the redeem's session token carries `keys:manage` and `relay:*`,
    // so it can mint any credential on the account. It is retired, never
    // stored, and never shown.
    expect(plow.revoked).toEqual([SESSION_TOKEN]);
    expect(JSON.stringify(settings)).not.toContain(SESSION_TOKEN);
    expect(JSON.stringify(claim.state())).not.toContain(SESSION_TOKEN);
  });

  it("mints one code for two clicks, even while the first is still in the air", async () => {
    // A display code IS a credential — whoever texts it claims the line — so a
    // second one nobody is shown is a live credential loose on the account, and
    // a wasted line if it is texted. `activation` is not set until the API
    // answers, so only the single flight can close this.
    plow.holdActivations();
    const claim = build();
    const first = claim.begin();
    const second = claim.begin();
    plow.releaseActivations();
    await Promise.all([first, second]);

    expect(plow.activations).toHaveLength(1);
  });

  it("is cancelled by sign-out, code and chat both", async () => {
    // The hard case is a redeem already in the air. Its answer is one-shot, so
    // the token still has to be retired — but persisting the chat and the line
    // would name, on the next account's screen, a chat bought by the one that
    // just left.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN, chat: CHAT }];
    plow.holdRedeems();
    const claim = build();
    await claim.begin();

    const after = claim.signedOut();
    expect(after.activation).toBeNull();
    expect(after.chat).toBeNull();
    expect(after.step).toBe("idle");

    plow.releaseRedeems();
    await settle();

    expect(claim.state().chat).toBeNull();
    expect(loadSettings(home).provisionedChatUid).toBe("");
    expect(loadSettings(home).activationSendTo).toBe("");
    // Nothing to come back for: the session token is retired anyway.
    expect(plow.revoked).toEqual([SESSION_TOKEN]);
  });

  it("stays cancelled when the sign-out lands inside createActivation", async () => {
    // The mint's continuation runs on the far side of an await the sign-out
    // can land in. Without an epoch check it put the code back on screen and
    // started polling it — a claim the owner had just cancelled, running
    // against the account they had just left.
    plow.holdActivations();
    const claim = build();
    const flight = claim.begin();
    claim.signedOut();
    plow.releaseActivations();
    await flight;
    await settle();

    expect(claim.state().activation).toBeNull();
    expect(claim.state().step).toBe("idle");
    // Nothing is watching it either: no redeem was ever attempted.
    expect(plow.revoked).toEqual([]);
    expect(loadSettings(home).provisionedChatUid).toBe("");
  });

  it("stays cancelled when the sign-out lands inside the revoke", async () => {
    // The revoke is an await too, and checking the epoch only before it left a
    // window where the chat and the line were still written past a sign-out.
    plow.redeems = [{ status: "verified", token: SESSION_TOKEN, chat: CHAT }];
    plow.holdRevokes();
    const claim = build();
    await claim.begin();
    await settleUntil(() => plow.revoked.length === 0 && claim.state().activation !== null);
    // The loop is now parked inside the revoke.
    claim.signedOut();
    plow.releaseRevokes();
    await settle();

    // Retired anyway — that answer is the only one there will be.
    expect(plow.revoked).toEqual([SESSION_TOKEN]);
    // But nothing persisted, and nothing on screen.
    expect(loadSettings(home).provisionedChatUid).toBe("");
    expect(loadSettings(home).activationSendTo).toBe("");
    expect(claim.state().chat).toBeNull();
  });

  it("carries the sms: URL on the state, for main to open", async () => {
    // What the modal's "Open Messages" button opens. Composed from the
    // server's own `send_to`, never from anything the renderer supplies — and
    // read off the state every other reader already has, rather than through
    // an accessor mirroring one field of it.
    const claim = build();
    expect(claim.state().activation).toBeNull();
    const shown = await claim.begin();
    expect(shown.activation?.smsUrl).toBe("sms:+15550001111?&body=Plow%20Activate%3A%20CODE1");
    expect(claim.cancel().activation).toBeNull();
  });

  it("cancels an in-flight claim without leaving the poll running", async () => {
    const claim = build();
    await claim.begin();
    const waitsBefore = clock.waits.length;
    claim.cancel();
    await settle();

    // The loop parked rather than kept polling on a cancelled claim.
    expect(clock.waits.length).toBeLessThanOrEqual(waitsBefore + 1);
    expect(claim.state().activation).toBeNull();
  });

  it("offers a new code when the server retires the old one", async () => {
    plow.redeems = [new PlowApiError("expired", "gone", 410)];
    const claim = build();
    await claim.begin();
    await settleUntil(() => claim.state().activationStale);

    expect(claim.state().message).toContain("expired before your text arrived");
    // A retired code is done with, so the next request mints rather than
    // putting the same dead code back on the clock.
    await claim.newCode();
    expect(plow.activations).toHaveLength(2);
  });

  // A verified answer with nothing usable in it, in both shapes it takes. The
  // outcome is identical — nothing persisted, a fresh code offered — so the
  // difference worth naming is which one leaves a token to retire.
  it.each([
    {
      why: "the code was texted to the wrong number, so nothing was provisioned",
      redeem: { status: "verified" as const, token: SESSION_TOKEN, chat: null },
      // Live whether or not a chat came with it.
      revoked: [SESSION_TOKEN],
    },
    {
      why: "an earlier redeem took the one-shot completion, so this is its echo",
      redeem: { status: "verified" as const, token: null, chat: CHAT },
      // Nothing to retire: there was no token.
      revoked: [],
    },
  ])("offers a new code when $why", async ({ redeem, revoked }) => {
    plow.redeems = [redeem];
    const claim = build();
    await claim.begin();
    await settle();

    expect(claim.state().chat).toBeNull();
    expect(claim.state().activationStale).toBe(true);
    expect(claim.state().message).toContain("didn't hand back a new chat");
    expect(loadSettings(home).provisionedChatUid).toBe("");
    expect(loadSettings(home).activationSendTo).toBe("");
    expect(plow.revoked).toEqual(revoked);
  });

  it("names the exhausted pool when the wait runs out", async () => {
    // An exhausted pool has no `declined` to read: the server takes the
    // request, texts the owner that every number is in use, and leaves the
    // redeem pending forever. The expiry copy is the only place that can say so.
    const claim = build();
    await claim.begin();
    await settleUntil(() => claim.state().activationStale);

    expect(clock.now).toBeGreaterThan(claim.state().activation?.pollUntil ?? Infinity);
    expect(claim.state().message).toContain("every number is in use");
    expect(clock.waits.every((ms) => ms === ACTIVATION_POLL_INTERVAL_MS)).toBe(true);
    expect(clock.waits.length).toBeGreaterThanOrEqual(ACTIVATION_POLL_WINDOW_MS / ACTIVATION_POLL_INTERVAL_MS);
  });

  it("puts the same code back on the clock rather than burning another", async () => {
    // While a code is live its poll loop is the only redeemer; a second mint
    // would strand the one the owner may have already texted.
    const claim = build();
    const first = await claim.begin();
    const again = await claim.newCode();

    expect(plow.activations).toHaveLength(1);
    expect(again.activation?.displayCode).toBe(first.activation?.displayCode);
    expect(again.message).toContain("still works");
  });

  it("never puts the activation secret on the screen", async () => {
    const claim = build();
    const state = await claim.begin();
    expect(JSON.stringify(state)).not.toContain(ACTIVATION_SECRET);
  });
});
