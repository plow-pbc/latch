/**
 * First-run setup: a code on screen, a text from the user's phone, and a
 * connected Mac — with nothing typed and no token copied out of a browser.
 *
 * Activation leads, because it is the only path that works for someone who does
 * not have a Plow account yet: it goes *outbound*, so the account is created
 * from the text the user sends. The phone-code (OTP) path is kept behind a quiet
 * link for the two cases activation cannot cover — a Mac with no Messages
 * account signed in, and signing in as one *specific* account rather than as
 * whoever texts.
 *
 * This is the whole flow as a plain state machine so it can be tested without
 * Electron and rendered offscreen for screenshots.
 *
 * **Nothing here puts a credential in a message.** `state()` is what the
 * sandboxed renderer sees, and the only secret it ever carries is the one the
 * user is meant to read: the activation display code. The activation *secret*
 * and the device credential never appear in it at all.
 */
import {
  Activation,
  ActivationChatView,
  ActivationView,
  activationChatLabel,
  ACTIVATION_SMS_PREFIX,
  CODE_LENGTH,
  CODE_TTL_MS,
  FINISHED,
  stallWith,
  Terminal,
  VerifiedRedeem,
} from "./activation.js";
import { ActivationChat, PlowApi, PlowApiError } from "./plowApi.js";
import { loadSettings, saveSettings, Settings } from "./settings.js";

/**
 * The wizard ends at `connected`, a confirmation with one button into the app.
 *
 * There is no step for minting a client credential. Logging in happens once per
 * Mac; connecting a client happens once per client, is repeatable and is
 * optional — see `connectClient.ts`, which is reached from the main window.
 */
export type OnboardingStep = "activate" | "waiting" | "phone" | "code" | "connected";

/**
 * The chat activation provisioned, as the app remembers it.
 *
 * One reading of one persisted record. It was two — this screen's and the
 * cloud-agent picker's — with different ideas about whitespace and a blank
 * label, so the same Mac could show a chat here and a bare uid there.
 *
 * `null` on most Macs — pairing does not ask for a chat — which is why nothing
 * may treat its absence as "this account has no chats". The label falls back to
 * the uid because a chat with neither a line nor members is still a real chat,
 * and an empty row is worse than an ugly one.
 */
export function storedActivationChat(settings: Settings): ActivationChatView | null {
  const uid = settings.provisionedChatUid.trim();
  if (!uid) return null;
  return { uid, label: settings.provisionedChatLabel.trim() || uid };
}

export interface OnboardingState {
  step: OnboardingStep;
  phone: string;
  /** One honest line: what happened, or what we are waiting for. Never a bare
   * spinner — every failure below produces text here. */
  message: string;
  busy: boolean;
  /** Epoch ms the entered OTP code stops working. */
  codeExpiresAt: number | null;
  activation: ActivationView | null;
  /** The chat the account now has, or null on a Mac activated before there was
   * one. Display data — no secret, and nothing here is authoritative. */
  chat: ActivationChatView | null;
  /** We have stopped watching this activation. The screen stops counting down
   * and offers a fresh code. */
  activationStale: boolean;
  accountUid: string;
  mcpUrl: string;
  connected: boolean;
}

export interface OnboardingDeps {
  api: PlowApi;
  home: string;
  /** (Re)start the relay from stored settings. */
  startRelay: () => Promise<void>;
  isConnected: () => boolean;
  /** Names this Mac, both in the activation and in the user's key list. */
  deviceName: string;
  onChange?: () => void;
  now?: () => number;
  /** How the poll loop waits. Injectable so tests need no real timers. */
  wait?: (ms: number) => Promise<void>;
  /** Diagnostics. Callers must assume anything passed here reaches a log, so
   * nothing secret is ever passed — not the activation secret, and not the
   * display code, which is a live credential until it is redeemed. */
  warn?: (message: string) => void;
}

export class Onboarding {
  private step: OnboardingStep;
  private phone = "";
  private codeExpiresAt: number | null = null;
  /** The mint, the poll, the 410, the countdown and the epochs — one copy,
   * shared with the claim flow. What stays here is the terminal policy. */
  private readonly activation: Activation;

  constructor(private readonly deps: OnboardingDeps) {
    // A Mac that already holds a credential is past all of this; it opens on
    // the connected screen, whose one button hands over to the app.
    this.step = this.settings().relayCredential.trim() ? "connected" : "activate";
    this.activation = new Activation({
      api: deps.api,
      deviceName: deps.deviceName,
      // Pairing asks for NO chat: `provision_chat` assigns one of the account's
      // few pool lines, and an owner holding a chat on every line could not
      // pair another Mac at all while signing in spent one. `claimLine.ts` is
      // the flow that asks.
      provisionChat: false,
      now: () => this.now(),
      wait: (ms) => this.wait(ms),
      publish: () => this.deps.onChange?.(),
      onReset: () => {
        this.step = "activate";
      },
      onStall: () => {
        // The step move is the point. "Connect this Mac" has no "Get a New
        // Code" button — it is the screen you are on BEFORE anything has gone
        // wrong — and a user who reads the code off the screen and types it
        // into Messages never taps "Open Messages", so they never leave it.
        // Going stale without moving them says "or get a new code" next to no
        // such control: a dead end, and the one this screen exists to prevent.
        if (this.step === "activate" || this.step === "waiting") this.step = "waiting";
      },
      onVerified: (result, stillOurs) => this.verified(result, stillOurs),
      // The one hint that fixes the silent-failure case: a wrong prefix is
      // answered with a 200, no SMS, and a code left live.
      hint: (reason) =>
        `${reason} Send the message exactly as shown — it has to start with “${ACTIVATION_SMS_PREFIX}” — or try again.`,
      expiredReason: "That code expired before your text arrived.",
    });
  }

  state(): OnboardingState {
    const settings = this.settings();
    return {
      step: this.step,
      phone: this.phone,
      codeExpiresAt: this.codeExpiresAt,
      ...this.activation.view(),
      chat: storedActivationChat(settings),
      accountUid: settings.accountUid,
      mcpUrl: settings.mcpUrl,
      connected: this.deps.isConnected(),
    };
  }

  // MARK: activation — the path a brand-new user takes

  /**
   * Mint the code the user texts, and start polling immediately.
   *
   * Idempotent: opening the window twice must not burn a second code and leave
   * two live activations on the account. The engine's single flight covers the
   * window where the API has been asked and has not answered — two callers
   * race there for real, since `settings:signOut` calls this and, in the same
   * breath, opens the setup window whose renderer calls it again on boot.
   */
  async begin(): Promise<OnboardingState> {
    if (this.step !== "activate" || this.activation.view().activation) return this.publish();
    return this.newActivationCode();
  }

  /**
   * A fresh code — but only once the server has retired the old one.
   *
   * While a code is live its poll loop is the ONLY redeemer, and this puts the
   * same code back on the clock. It must not redeem: a redeem racing the poll's
   * own can split the one-shot completion, and whichever way the responses land
   * a login gets discarded. The engine decides which of the two this is.
   */
  newActivationCode(): Promise<OnboardingState> {
    return this.activation.begin(() => this.state());
  }

  /**
   * The verified answer, and what pairing does with it.
   *
   * The token is the ONLY copy of the session — the server hands it to the
   * first redeem that sees the completion and omits it ever after — so this is
   * reached even when the loop was cancelled mid-call. What decides is
   * `stillOurs`: refusing on "already holding a credential" alone was exactly
   * backwards across a sign-out, which CLEARS the credential, so a redeem in
   * flight when the user signed out passed that test and minted — and
   * persisted — a fresh spend-capable credential the sign-out's revoke had
   * never seen.
   */
  private async verified(result: VerifiedRedeem, stillOurs: boolean): Promise<Terminal> {
    if (result.token && stillOurs && !this.settings().relayCredential.trim()) {
      await this.activation.run(() => this.finishWithSession(result.token as string, result.chat));
      return FINISHED;
    }
    // The token was handed to some earlier redeem and lost — the code is spent.
    return stallWith("Plow verified this Mac but didn't hand back a login. Try again for a fresh code.");
  }

  /**
   * The user has gone to Messages. Nothing to do but wait — and say so, rather
   * than leave them staring at a screen that still reads like a to-do.
   */
  messagesOpened(): OnboardingState {
    if (this.step === "activate" && this.activation.view().activation) this.step = "waiting";
    return this.publish();
  }

  /** The quiet fallback: sign in with a phone code instead. */
  usePhoneCode(): OnboardingState {
    this.activation.abandon();
    this.step = "phone";
    return this.publish();
  }

  /** ...and back, so the fallback is not a one-way door. */
  async useActivation(): Promise<OnboardingState> {
    this.codeExpiresAt = null;
    this.activation.setMessage("");
    this.step = "activate";
    return this.begin();
  }

  // MARK: the phone-code fallback

  /**
   * Ask Plow to text a login code.
   *
   * The API answers `200 {"ok": true}` for an unknown number, an unparseable
   * number and a failed send alike, so it cannot be used to probe whether an
   * account exists. We therefore cannot tell "sent" from "silently didn't", and
   * the copy says "check your phone", never "we've sent you a code".
   */
  async requestCode(phone: string, note = ""): Promise<OnboardingState> {
    const trimmed = (phone ?? "").trim();
    if (!trimmed) return this.fail("Enter your phone number.");
    return this.run(async () => {
      await this.deps.api.requestOtp(trimmed);
      this.phone = trimmed;
      this.step = "code";
      this.codeExpiresAt = this.now() + CODE_TTL_MS;
      // The code screen's own copy says what to do; `message` stays free for
      // things that screen cannot say on its own.
      this.activation.setMessage(note);
    });
  }

  /**
   * Same call again for the number already entered; a new code, a new clock.
   *
   * "Asked for" rather than "sent": the API answers identically whether or not
   * a message went out, so claiming a send would be a claim we cannot back.
   */
  async resendCode(): Promise<OnboardingState> {
    if (!this.phone) return this.fail("Enter your phone number.");
    return this.requestCode(this.phone, "Asked Plow for a new code.");
  }

  /** Back to the phone screen — a mistyped number is otherwise a dead end. */
  editPhone(): OnboardingState {
    this.step = "phone";
    this.codeExpiresAt = null;
    this.activation.setMessage("");
    return this.publish();
  }

  async submitCode(code: string): Promise<OnboardingState> {
    const trimmed = (code ?? "").replace(/\s/g, "");
    if (trimmed.length !== CODE_LENGTH || !/^\d+$/.test(trimmed)) {
      return this.fail(`Enter the ${CODE_LENGTH}-digit code from your phone.`);
    }
    // The server answers 401 for wrong AND expired alike, so pre-empt the
    // expired case here — otherwise a user whose code timed out is told to
    // check their typing.
    if (this.codeExpiresAt !== null && this.now() > this.codeExpiresAt) {
      return this.fail("That code has expired. Send a new one.");
    }
    return this.run(() => this.completeOtpLogin(trimmed));
  }

  // MARK: after either path

  /**
   * Return to the state a fresh launch would be in.
   *
   * The opening step is decided once, in the constructor, and this object
   * outlives a sign-out. Without this the window keeps rendering the connected
   * screen against empty settings — "Signed in — connecting…", a blank
   * endpoint, a blank account — and offers a Continue button into a main window
   * the gate has just taken away. Quitting and relaunching was the only escape,
   * which is not a thing to ask of someone who just clicked Sign Out.
   *
   * The step is re-derived from settings rather than forced to `activate`, so
   * this is honest whichever way the credential went.
   */
  reset(): OnboardingState {
    this.activation.abandon();
    this.phone = "";
    this.codeExpiresAt = null;
    this.step = this.settings().relayCredential.trim() ? "connected" : "activate";
    return this.publish();
  }

  /*
   * There is deliberately no `refresh()` here.
   *
   * It used to exist, be wired to the `onboarding:get` IPC, and call
   * `publish()` — so *reading* the state notified the renderer that the state
   * had changed, and the renderer's change handler read the state again. That
   * closed a loop with nothing to damp it: the window re-rendered about 5,000
   * times a second, and since `render()` rebuilds the DOM with
   * `replaceChildren`, every input and button was destroyed and recreated
   * between one frame and the next. The screen looked perfect and was
   * completely inert — focus could not survive, and a click needs mousedown and
   * mouseup to land on the same element.
   *
   * `state()` is a pure read and is what the getter uses. It already re-reads
   * settings and the live connection flag, which is all `refresh()` was
   * documented to do. Publishing belongs to the methods that change something.
   */

  private async completeOtpLogin(code: string): Promise<void> {
    let otpToken: string;
    try {
      otpToken = await this.deps.api.verifyOtp(this.phone, code);
    } catch (error) {
      if (error instanceof PlowApiError && error.kind === "unauthorized") {
        throw new PlowApiError("unauthorized", "That code didn't work. Check it, or send a new one.", 401);
      }
      throw error;
    }
    await this.finishWithSession(otpToken);
  }

  /**
   * Learn the account → mint this Mac's credential → connect.
   *
   * `sessionToken` never leaves this function. It carries `keys:manage` and
   * `relay:*` — it can mint *any* credential on the account — so the app holds
   * it for the two calls it needs and not one longer. There is no client-side
   * cleanup to get wrong: `mintDeviceCredential` retires the session
   * server-side, in the same transaction as the mint.
   */
  private async finishWithSession(
    sessionToken: string,
    chat: ActivationChat | null = null,
  ): Promise<void> {
    // A sign-out can land inside the awaits below, and it must stay signed
    // out: minting and persisting past it would hand the account a live
    // spend-capable credential its owner just retired. The engine's
    // abandonment epoch is bumped by every path that abandons this login —
    // reset, the phone fallback, a fresh mint — so it is what to check.
    const epoch = this.activation.epoch();
    const info = await this.deps.api.relayInfo(sessionToken);
    if (this.activation.abandonedSince(epoch)) return;
    const minted = await this.deps.api.mintDeviceCredential(sessionToken, this.deps.deviceName);
    if (this.activation.abandonedSince(epoch)) {
      // The sign-out landed during the mint itself, so its revoke never saw
      // this credential. Retire it before it is dropped — best effort, the
      // same contract sign-out's own revoke keeps.
      await this.deps.api.revokeDeviceCredential(minted.token).catch(() => {});
      return;
    }

    // Written 0600 by saveSettings. This is the only copy of the credential and
    // it is never handed to the renderer.
    const settings = this.settings();
    settings.relayCredential = minted.token;
    settings.accountUid = info.uid;
    settings.mcpUrl = info.mcpUrl;
    // Kept, not read and dropped: the redeem that carried it answers once, so
    // this is the only moment the app ever sees the chat it just created. A
    // sign-in with no chat — which is the ordinary one, since pairing does not
    // ask for a chat — leaves whatever was there alone rather than blanking it,
    // because "this redeem carried no chat" is not "the account has none".
    if (chat) {
      settings.provisionedChatUid = chat.uid;
      settings.provisionedChatLabel = activationChatLabel(chat);
    }
    // `activationSendTo` is deliberately NOT written here. Pairing does not ask
    // for a chat, so its `sendTo` is the managed phone — the number that takes
    // an activation text, not a line anyone can be told to text afterwards.
    // Storing it would put the managed phone where the cloud-agents screen
    // says "text this to make a chat", which provisions nothing. `claimLine.ts`
    // is the flow that asks for a pool line, and it is what writes the field.
    this.save(settings);

    // The activation is spent: drop the code and the secret rather than leave
    // either sitting in memory or on a screen behind this one.
    //
    // BEFORE the dial, not after. `startRelay` is a network round-trip, and a
    // sign-out landing inside it resets this instance to `activate` — which the
    // continuation then overwrote with `connected`, leaving a window reporting
    // a session that had just been signed out of. Everything here is derived
    // from the save above; none of it needs the socket to be up.
    this.activation.settled();
    this.step = "connected";
    this.codeExpiresAt = null;

    await this.deps.startRelay();
  }

  // MARK: plumbing

  private settings(): Settings {
    return loadSettings(this.deps.home);
  }

  private save(settings: Settings): void {
    saveSettings(this.deps.home, settings);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private wait(ms: number): Promise<void> {
    if (this.deps.wait) return this.deps.wait(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Run one step with a busy flag, turning any failure into readable text. */
  private async run(body: () => Promise<void>): Promise<OnboardingState> {
    await this.activation.run(body);
    return this.state();
  }

  private fail(message: string): OnboardingState {
    this.activation.setMessage(message);
    return this.publish();
  }

  private publish(): OnboardingState {
    this.deps.onChange?.();
    return this.state();
  }
}
