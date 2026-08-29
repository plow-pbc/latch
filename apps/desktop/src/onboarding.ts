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
 * and the login session never appear in it at all.
 */
import {
  chatEchoesCredential,
  chatPeople,
  chatRowTitle,
  usableChatDisplayName,
  withoutCredentialEchoes,
} from "./chatRows.js";
import { ActivationChat, PlowApi, PlowApiError } from "./plowApi.js";
import {
  credentialLocked,
  holdForRevocation,
  loadSettings,
  releaseRevocation,
  saveSettings,
  Settings,
} from "./settings.js";

/**
 * The wizard ends at `connected`, a confirmation with one button into the app.
 *
 * There is no step for minting a client credential. Logging in happens once per
 * Mac; connecting a client happens once per client, is repeatable and is
 * optional — see `connectClient.ts`, which is reached from the main window.
 */
export type OnboardingStep = "activate" | "waiting" | "phone" | "code" | "connected";

/** Codes are 8 digits with a 5-minute life (`api/plow/auth_routes/otp.py`). */
export const CODE_LENGTH = 8;
export const CODE_TTL_MS = 5 * 60_000;

/**
 * How long the screen counts down before it stalls and offers a fresh code.
 *
 * A screen that says "waiting" for half an hour is a worse experience than one
 * that hands control back early — but stalling the SCREEN is all that happens
 * at five minutes. The server keeps the code live for thirty
 * (`ACTIVATION_CODE_TTL` in `api/plow/auth_routes/router.py`) and hands the
 * session token to the FIRST redeem that sees the completion, so a watch that
 * stopped with the countdown left a text at minute fifteen completed
 * server-side with nobody listening: the phone said "You're all set!" while the
 * Mac said it hadn't heard. The poll therefore continues quietly for the code's
 * whole server life, and stops only on the server's own word — the 410. No
 * client-side clock seconds that judgment: the server owns the code's life,
 * and a local mirror of its TTL would just be a second owner to drift.
 */
export const ACTIVATION_POLL_WINDOW_MS = 5 * 60_000;
export const ACTIVATION_POLL_INTERVAL_MS = 3_000;

/**
 * The webhook matches `^Plow Activate:\s*(\S+)` case-insensitively
 * (`api/plow/channels/linq/routes/webhook.py:65`). Leading whitespace and case
 * are forgiven; a *prefix* is not — `Hi, Plow Activate: X` does not match, and
 * the API answers 200, sends no SMS and leaves the code live, so the user gets
 * silence on both channels. That is why the screen shows the exact body to send
 * rather than describing it.
 */
export const ACTIVATION_SMS_PREFIX = "Plow Activate:";

/**
 * What the setup screen says when a session this Mac will not keep could not
 * be retired.
 *
 * A fixed sentence, composed here and never from a server string: the only
 * value in scope at the point it is shown is the session token itself. It says
 * both halves — Latch is holding on to retry, and the owner can end it now —
 * because a retry that keeps failing is a live `*:*` session for 180 days.
 */
/**
 * What setup says when this Mac holds a credential it cannot read.
 *
 * It names the remedy and, more importantly, names the thing NOT to do: the
 * obvious move on a screen asking you to sign in is to sign in, and that is
 * the one action that would strand the session already on disk.
 */
export const KEYCHAIN_LOCKED_MESSAGE =
  "Latch can't reach this Mac's keychain, so it can't read the Plow login it already has. " +
  "Quit Latch and open it again — signing in again here would leave the session it's holding " +
  "live on your account with no way to retire it.";

export const LOOSE_SESSION_WARNING =
  "A Plow login session couldn't be retired. Latch is holding it and will try again — " +
  "or revoke it in Plow.";

export function activationSmsBody(displayCode: string): string {
  return `${ACTIVATION_SMS_PREFIX} ${displayCode}`;
}

/** The draft Messages opens with, in the form the shipping Plow app uses
 * (`app/Phoenix/DaemonClient.swift`): `sms:<phone>?&body=<encoded>`. */
export function activationSmsUrl(sendTo: string, displayCode: string): string {
  return `sms:${sendTo}?&body=${encodeURIComponent(activationSmsBody(displayCode))}`;
}

export interface OnboardingActivation {
  /** Shown large. A credential in its own right — whoever texts it gets the
   * account, and the server cannot tell them apart. The screen says so. */
  displayCode: string;
  /** Whatever the API returned. Never a hardcoded number: it is per-environment
   * config and may be a pool line rather than the managed phone. */
  sendTo: string;
  /** The exact message body, so the user can copy it rather than retype it. */
  smsBody: string;
  /** `sms:` URL for the "Open Messages" button. */
  smsUrl: string;
  /** Epoch ms the screen's countdown ends and it offers a fresh code. Not the
   * code's own deadline, and not the watch's: the poll runs on quietly until
   * the server retires the code. */
  pollUntil: number;
}

/**
 * The chat the activation provisioned, as the screen says it.
 *
 * The label is its title, its members' names or its numbers — see
 * `activationChatLabel`. `uid` is what everything else joins on.
 */
export interface OnboardingChat {
  uid: string;
  label: string;
}

/**
 * The chat activation provisioned, as the app remembers it.
 *
 * One reading of one persisted record. It was two — this screen's and the
 * cloud-agent picker's — with different ideas about whitespace and a blank
 * label, so the same Mac could show a chat here and a bare uid there.
 *
 * `null` on a Mac that activated before `provision_chat`, which is why nothing
 * may treat its absence as "this account has no chats". The label falls back to
 * the uid because a chat with neither a line nor members is still a real chat,
 * and an empty row is worse than an ugly one.
 */
export function storedActivationChat(settings: Settings): OnboardingChat | null {
  const uid = settings.provisionedChatUid.trim();
  if (!uid) return null;
  return { uid, label: settings.provisionedChatLabel.trim() || uid };
}

/**
 * How a human recognises a chat: its title when present, otherwise each
 * member's usable name or real handle, with non-owners first. If the provider
 * has no usable names, use the number it runs on and each member's handle in
 * API owner-first order. The first fallback number is the agent participant's
 * line — never the chat's own `provider_key`, which is the provider's thread id
 * and would put "chat_5" where the user is looking for something to text.
 *
 * Both halves are optional in the data, so this never returns an empty string —
 * a chat with neither is still identified by its uid, which is ugly but true,
 * and beats a blank line on the last screen of setup.
 */
/**
 * The numbers a message to this chat would go to.
 *
 * Structured, and separate from the label, because they are two different
 * jobs: the label is prose for a human to recognise a chat by, and these are
 * addresses. Scraping the one for the other is how a label with no digits — a
 * bare uid from the fallback — produced an empty recipient list, and how an
 * upgraded home's `"<line> · <display name>"` produced an incomplete one.
 *
 * `line` is the pool line the chat runs on, which is the agent's own number.
 * `members` are the humans, in the order the server listed them; ordering them
 * for display is the screen's business, not this function's.
 */
export interface ChatRecipients {
  line: string | null;
  members: string[];
}

export function activationChatRecipients(chat: ActivationChat): ChatRecipients {
  return {
    line: (chat.line ?? "").trim() || null,
    members: chat.participants
      .map((p) => (p.providerKey ?? "").trim())
      .filter((number) => number.length > 0),
  };
}


export function activationChatLabel(chat: ActivationChat): string {
  const displayName = usableChatDisplayName(chat.displayName);
  if (displayName) return displayName;
  // Presentation is `chatRows`', not this file's: it decides who counts as a
  // participant, which of them is the owner, and how a number is spelled. This
  // used to keep a second answer to all three, and the two drifted — the label
  // dropped the owner while the picker's row named them "You".
  return chatRowTitle(chatPeople(chat), (chat.line ?? "").trim() || null, chat.uid);
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
  activation: OnboardingActivation | null;
  /** The chat the account now has, or null on a Mac activated before there was
   * one. Display data — no secret, and nothing here is authoritative. */
  chat: OnboardingChat | null;
  /** We have stopped watching this activation. The screen stops counting down
   * and offers a fresh code. */
  activationStale: boolean;
  /** This Mac has a credential it cannot read — see `credentialLocked`. Setup
   * says so and refuses to start a login that would overwrite it. */
  locked: boolean;
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
  private message = "";
  private busy = false;
  private codeExpiresAt: number | null = null;
  private activation: OnboardingActivation | null = null;
  private activationStale = false;
  /** SECRET. Held here for the life of one activation and nowhere else — never
   * in `state()`, never on disk, never in a log line. */
  private activationSecret: string | null = null;
  /** Bumped whenever an activation stops being the one we care about. A poll
   * loop whose generation is stale returns instead of writing state. */
  private pollGeneration = 0;
  /**
   * The mint in flight, if any. Held so a second request joins it rather than
   * burning a second code — see `newActivationCode`. `pendingMintId` says which
   * flight it is, so a finishing mint only drops the handle if it is its own.
   */
  /** The retry sweep in flight, if any. Held so a second caller joins it
   * rather than racing it onto the same tokens — see
   * `retryPendingRevocations`. */
  private retrying: Promise<void> | null = null;
  private pendingMint: Promise<OnboardingState> | null = null;
  private pendingMintId = 0;
  private mints = 0;

  constructor(private readonly deps: OnboardingDeps) {
    // A Mac that already holds a credential is past all of this; it opens on
    // the connected screen, whose one button hands over to the app.
    this.step = this.settings().relayCredential.trim() ? "connected" : "activate";
  }

  state(): OnboardingState {
    const settings = this.settings();
    const locked = credentialLocked(settings);
    return {
      step: this.step,
      phone: this.phone,
      // A locked Mac has one thing to say and it is not whatever the wizard
      // was last doing. Derived here rather than assigned on a failed click,
      // so the screen is right the moment it opens — nobody has to press
      // something that cannot work in order to be told why.
      message: locked ? KEYCHAIN_LOCKED_MESSAGE : this.message,
      busy: this.busy,
      codeExpiresAt: this.codeExpiresAt,
      activation: this.activation,
      chat: storedActivationChat(settings),
      activationStale: this.activationStale,
      locked,
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
   * two live activations on the account. The check below covers a second call
   * once a code is on screen; the window *before* that — where the API has been
   * asked and has not answered — is covered by the single flight in
   * `newActivationCode`, which is the only thing here that mints.
   */
  async begin(): Promise<OnboardingState> {
    if (this.step !== "activate" || this.activation) return this.publish();
    return this.newActivationCode();
  }

  /**
   * A fresh code — but only once the server has retired the old one.
   *
   * While a code is live, its poll loop is the ONLY redeemer, and this button
   * just puts the same code back on the clock. The button must not redeem: a
   * redeem racing the poll's own can split the one-shot completion — one
   * request consumes the token, the other answers tokenless "verified" — and
   * whichever way the responses land, a login gets discarded. The loop is
   * guaranteed to be running whenever `activationSecret` is set, because every
   * path that ends it clears the secret in the same breath; a cleared secret
   * is what lets this mint.
   */
  async newActivationCode(): Promise<OnboardingState> {
    // Before the single-flight check, and before anything that could burn a
    // code: a login started here would seal over a credential this Mac still
    // has and cannot read.
    if (this.locked()) return this.fail(KEYCHAIN_LOCKED_MESSAGE);
    // SINGLE-FLIGHT. A display code IS a credential — whoever texts it gets the
    // account — so a second mint nobody is shown is a live credential loose on
    // the account, and the screen can only ever show one of them. Two callers
    // race here for real: `settings:signOut` calls `begin` and, in the same
    // breath, opens the setup window whose renderer calls `begin` on boot.
    // `activation` is not set until the API answers, so on a slow
    // `/v1/auth/activate` both sail past that check. Joining the flight in
    // progress is the only place this can be closed.
    if (this.pendingMint) return this.pendingMint;

    if (this.activationSecret && this.activation) {
      // Same code, fresh clock — and one honest line about why "Try Again"
      // is showing the code they already have.
      this.activation = { ...this.activation, pollUntil: this.now() + ACTIVATION_POLL_WINDOW_MS };
      this.activationStale = false;
      this.message =
        "That code still works — send it exactly as shown and this screen will move on by itself.";
      return this.publish();
    }

    this.cancelPolling();
    const mintId = ++this.mints;
    // The handle is dropped inside the body rather than by chaining `.finally`
    // onto the result: a chained one adds a turn before the caller resumes, and
    // `wait` here is injectable — under a test clock that extra turn lets the
    // detached poll loop run ahead of the caller. Same guarantee, no new tick.
    const flight = this.run(async () => {
      try {
        this.activation = null;
        this.activationSecret = null;
        this.activationStale = false;
        this.step = "activate";
        // Before minting, not after: a Mac about to log in again is a Mac that
        // can reach Plow, and it is the last moment to retire a session left
        // over from a login that did not finish. It cannot fail this mint —
        // `retryPendingRevocation` swallows its own failure — but a second
        // failure does leave the warning on screen under the fresh code, which
        // is where the owner can act on it.
        await this.retryPendingRevocations();
        const created = await this.deps.api.createActivation(this.deps.deviceName);
        this.activationSecret = created.activationSecret;
        this.activation = {
          displayCode: created.displayCode,
          sendTo: created.sendTo,
          smsBody: activationSmsBody(created.displayCode),
          smsUrl: activationSmsUrl(created.sendTo, created.displayCode),
          pollUntil: this.now() + ACTIVATION_POLL_WINDOW_MS,
        };
        // Polling starts here, not when the user taps the button: a user who
        // types the message by hand never taps it, and must still get in.
        this.startPolling(created.activationSecret);
      } finally {
        // Only if this flight still owns the handle: nothing else clears it,
        // but a later mint may already own it by the time this one lands.
        if (this.pendingMintId === mintId) {
          this.pendingMint = null;
          this.pendingMintId = 0;
        }
      }
    });
    this.pendingMint = flight;
    this.pendingMintId = mintId;
    return flight;
  }

  /**
   * The user has gone to Messages. Nothing to do but wait — and say so, rather
   * than leave them staring at a screen that still reads like a to-do.
   */
  messagesOpened(): OnboardingState {
    if (this.step === "activate" && this.activation) this.step = "waiting";
    return this.publish();
  }

  /**
   * Say something on the setup screen that did not come from a step this
   * object ran — today, that a sign-out could not retire its session.
   *
   * `reset()` has already put this instance back on `activate`, so the message
   * has a screen to land on; it is cleared by the next thing that runs, which
   * is the point. Nothing secret ever reaches here: the caller composes a fixed
   * sentence, never the credential.
   */
  warnSignOut(message: string): void {
    this.message = message;
    this.publish();
  }

  /** The quiet fallback: sign in with a phone code instead. */
  usePhoneCode(): OnboardingState {
    this.cancelPolling();
    this.activation = null;
    this.activationSecret = null;
    this.activationStale = false;
    this.step = "phone";
    this.message = "";
    return this.publish();
  }

  /** ...and back, so the fallback is not a one-way door. */
  async useActivation(): Promise<OnboardingState> {
    this.codeExpiresAt = null;
    this.message = "";
    this.step = "activate";
    return this.begin();
  }

  /**
   * Ask the server whether the text has arrived, until it has.
   *
   * Runs detached: every branch ends in `publish()`, so the screen follows
   * along, and no caller awaits it.
   */
  private startPolling(secret: string): void {
    this.pollGeneration += 1;
    const generation = this.pollGeneration;
    void this.pollActivation(secret, generation).catch((error) => {
      // Nothing above throws by design; if something does, the screen must not
      // be left on a countdown that no longer runs — and the secret must not
      // outlive its watcher, or "Try Again" would re-arm a code nothing
      // is polling. Dropping it keeps the invariant: secret set ⇒ loop alive.
      if (generation !== this.pollGeneration) return;
      this.activationSecret = null;
      this.stall(messageOf(error));
      this.publish();
    });
  }

  private cancelPolling(): void {
    this.pollGeneration += 1;
  }

  private async pollActivation(secret: string, generation: number): Promise<void> {
    while (generation === this.pollGeneration) {
      await this.wait(ACTIVATION_POLL_INTERVAL_MS);
      if (generation !== this.pollGeneration) return;

      let result;
      try {
        result = await this.deps.api.redeemActivation(secret);
      } catch (error) {
        if (generation !== this.pollGeneration) return;
        if (error instanceof PlowApiError && error.kind === "expired") {
          // 410 only ever gates a code nobody completed — the server returns the
          // token for one completed past the deadline — so this is authoritative.
          this.giveUp("That code expired before your text arrived.");
          return;
        }
        // A blip must not end the wait. Say what we saw and keep polling.
        this.message = messageOf(error);
        this.publish();
        continue;
      }
      // A verified answer carries the ONLY copy of the session token — the
      // server hands it to the first redeem that sees the completion and omits
      // the key entirely ever after. So it is acted on even if this loop was
      // cancelled while the call was in flight: dropping it on the floor would
      // strand an activation the user actually completed, unrecoverably. That
      // is why a stale generation is not enough to refuse it.
      //
      // What decides instead is whether this is still OUR activation. Refusing
      // on "already holding a credential" alone was exactly backwards across a
      // sign-out: sign-out CLEARS the credential, so a redeem in flight when the
      // user signed out passed the test and minted — and persisted — a fresh
      // spend-capable credential that the sign-out's revoke had never seen. The
      // account was left holding a live credential its owner had just retired.
      //
      // `activationSecret` is nulled by every path that abandons an activation
      // for good — sign-out, the phone-code fallback, a completed login, the
      // server retiring the code — so it says what "already holding a
      // credential" was only guessing at.
      // Asked, never cached. `activationSecret` is nulled by every path that
      // abandons this activation, and the stored credential is cleared by
      // sign-out — so both halves can change under an await, and this is
      // re-evaluated on the far side of one rather than read once at the top.
      const keep = () =>
        secret === this.activationSecret && !this.settings().relayCredential.trim();
      // A verified token this Mac will NOT keep goes to `retireOrRetain`,
      // which is the only thing here allowed to let go of one.
      if (result.status === "verified" && result.token && !keep()) {
        await this.retireOrRetain(result.token);
      }
      if (result.status === "verified" && result.token && keep()) {
        this.cancelPolling();
        // The redeem consumed the one-shot completion, so the code is spent
        // whatever happens next: retire it BEFORE the handoff, whose network
        // calls can fail. A failure then leaves the stalled screen minting
        // fresh on "Try Again" — not re-arming a code nothing can complete.
        this.activationSecret = null;
        this.stall();
        await this.run(() => this.finishWithSession(result.token as string, result.chat));
        return;
      }
      if (generation !== this.pollGeneration) return;

      if (result.status === "verified") {
        // The token was handed to some earlier redeem and lost — the code is
        // spent. Dropping the secret is what lets "Try Again" mint.
        this.cancelPolling();
        this.activationSecret = null;
        this.stall("Plow verified this Mac but didn't hand back a login. Try again for a fresh code.");
        this.publish();
        return;
      }

      // Pending, and the screen's five minutes are up: stall the countdown and
      // offer a fresh code — once — but keep watching. The code is live for
      // another twenty-five minutes and its completion is handed to the first
      // redeem only, so a loop that stopped here stranded a text at minute
      // fifteen: completed server-side, and nobody ever came for the token.
      if (this.activation && this.now() > this.activation.pollUntil && !this.activationStale) {
        this.stallWithHint("We haven't heard from your phone.");
        this.publish();
      }
    }
  }

  /**
   * Stop watching for good — the server has retired the code. A 410 gates only
   * a code nobody completed, and once expired the webhook refuses its text, so
   * nothing can arrive for this secret any more. Dropping it is what lets
   * "Try Again" mint.
   */
  private giveUp(reason: string): void {
    this.cancelPolling();
    this.activationSecret = null;
    this.stallWithHint(reason);
    this.publish();
  }

  /** The stall message, with the one hint that fixes the silent-failure case
   * (a wrong prefix is answered with a 200, no SMS, and a code left live). */
  private stallWithHint(reason: string): void {
    this.stall(
      `${reason} Send the message exactly as shown — it has to start with “${ACTIVATION_SMS_PREFIX}” — or try again.`,
    );
  }

  /**
   * Mark this activation as no longer being watched, and put the user on the
   * screen that can do something about it.
   *
   * The step move is the whole point. "Connect this Mac" has no "Get a New
   * Code" button — it is the screen you are on *before* anything has gone
   * wrong — and a user who reads the code off the screen and types it into
   * Messages themselves never taps "Open Messages", so they never leave it. Set
   * `activationStale` without moving them and the message says "or get a new
   * code" next to no such control: a dead end, and precisely the one this
   * screen exists to prevent. Every path that stops polling comes through here
   * so that cannot drift apart again.
   */
  private stall(message?: string): void {
    if (this.step === "activate" || this.step === "waiting") this.step = "waiting";
    this.activationStale = true;
    if (message !== undefined) this.message = message;
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
    if (this.locked()) return this.fail(KEYCHAIN_LOCKED_MESSAGE);
    const trimmed = (phone ?? "").trim();
    if (!trimmed) return this.fail("Enter your phone number.");
    return this.run(async () => {
      await this.deps.api.requestOtp(trimmed);
      this.phone = trimmed;
      this.step = "code";
      this.codeExpiresAt = this.now() + CODE_TTL_MS;
      // The code screen's own copy says what to do; `message` stays free for
      // things that screen cannot say on its own.
      this.message = note;
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
    this.message = "";
    return this.publish();
  }

  async submitCode(code: string): Promise<OnboardingState> {
    if (this.locked()) return this.fail(KEYCHAIN_LOCKED_MESSAGE);
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
    this.cancelPolling();
    this.activation = null;
    this.activationSecret = null;
    this.activationStale = false;
    this.phone = "";
    this.codeExpiresAt = null;
    this.message = "";
    this.busy = false;
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
   * Learn the account → keep the session → connect.
   *
   * The session IS this Mac's credential. Latch is the owner's manager app,
   * not an agent: it holds the socket, lists chats, mints agents, buys
   * inference and mints connector tokens, and every surface added to it used
   * to mean a plow scope change plus a fleet re-pair, because a device
   * credential's scopes freeze at mint. A session carries `*:*` and expires
   * only after 180 days unused, refreshed by every request it makes.
   *
   * So there is no second step. `POST /v1/relay/devices` — which minted a
   * narrow credential and spent this session in the same transaction — is
   * gone; the token the redeem handed back is what gets written.
   */
  private async finishWithSession(
    sessionToken: string,
    chat: ActivationChat | null = null,
  ): Promise<void> {
    // A sign-out can land inside the await below, and it must stay signed out:
    // persisting past it would leave the account a live credential its owner
    // just retired. `pollGeneration` is bumped by every path that abandons this
    // login — reset, the phone fallback, a fresh mint — so it is the epoch to
    // check against. One await now rather than two, so one check.
    //
    // A sign-out landing inside it takes the session WITH it. Dropping the
    // token there orphaned it: the redeem answers once, sign-out's own revoke
    // ran before this session existed on disk, and nothing afterwards holds a
    // reference to retire it by. `retireOrRetain` is the only exit.
    //
    // The same is true of the `relayInfo` call itself, and of the write below.
    // Until `save` returns, this Mac's ONLY handle on a live account session is
    // the local variable — so both are wrapped rather than allowed to throw
    // past it, which is exactly how a transient timeout used to leave a
    // 180-day `*:*` session with nothing anywhere able to retire it.
    const epoch = this.pollGeneration;
    let info;
    try {
      info = await this.deps.api.relayInfo(sessionToken);
    } catch (error) {
      throw await this.orphaned(sessionToken, error);
    }
    if (epoch !== this.pollGeneration) {
      await this.retireOrRetain(sessionToken);
      return;
    }

    // Written 0600 by saveSettings. This is the only copy of the credential and
    // it is never handed to the renderer.
    const settings = this.settings();
    settings.relayCredential = sessionToken;
    settings.accountUid = info.uid;
    settings.mcpUrl = info.mcpUrl;
    // Kept, not read and dropped: the redeem that carried it answers once, so
    // this is the only moment the app ever sees the chat it just created. A
    // sign-in with no chat — the phone-code path, or a Mac activated before
    // `provision_chat` — leaves whatever was there alone rather than blanking
    // it, because "this redeem carried no chat" is not "the account has none".
    // The label is built from the chat's line, uids, numbers and names — all
    // server-authored, and this is the one place they are written to DISK. A
    // chat echoing the session token is dropped whole: the sign-in still
    // completes, and the account's chat list is re-read on the Agents tab
    // anyway, so nothing is lost but a row nobody could have trusted.
    if (chat && !chatEchoesCredential(chat, sessionToken)) {
      settings.provisionedChatUid = chat.uid;
      settings.provisionedChatLabel = activationChatLabel(withoutCredentialEchoes(chat, sessionToken));
    } else if (chat) {
      // No detail, and no field values: the point of the check is that one of
      // them is the credential.
      this.deps.warn?.("dropped a provisioned chat whose fields echoed the credential");
    }
    // Nothing records `sendTo`. Pairing asks for no chat, so it is the managed
    // phone — the number that takes an activation text, not one anyone can be
    // told to text afterwards to get a chat. The cloud-agents screen names the
    // lines the account's own chats run on, which is the only source that
    // cannot be wrong.
    try {
      this.save(settings);
    } catch (error) {
      throw await this.orphaned(sessionToken, error);
    }

    // The activation is spent: drop the code and the secret rather than leave
    // either sitting in memory or on a screen behind this one.
    //
    // BEFORE the dial, not after. `startRelay` is a network round-trip, and a
    // sign-out landing inside it resets this instance to `activate` — which the
    // continuation then overwrote with `connected`, leaving a window reporting
    // a session that had just been signed out of. Everything here is derived
    // from the save above; none of it needs the socket to be up.
    this.cancelPolling();
    this.activation = null;
    this.activationSecret = null;
    this.activationStale = false;
    this.step = "connected";
    this.codeExpiresAt = null;
    this.message = "";

    await this.deps.startRelay();
  }

  // MARK: the login session's lifecycle

  /**
   * The one owner of a verified session token this Mac is not going to keep.
   *
   * The redeem that produced it answers EXACTLY ONCE — the server hands the
   * token to the first caller that sees the completion and omits it ever after
   * — so from the moment it is in hand, this process is the only thing in the
   * world that can retire it. Every path that reaches a verified token and
   * does not persist it comes through here, and the token leaves memory in
   * exactly two ways: the server confirmed the revoke, or it is on disk in
   * `pendingRevocations` waiting for the next try. Never on the floor.
   *
   * Best-effort was the bug, not the design: a swallowed revoke used to be
   * indistinguishable from a successful one, and the difference is a full
   * `*:*` session live on the owner's account for 180 days.
   *
   * Returns whether the server confirmed.
   */
  private async retireOrRetain(token: string): Promise<boolean> {
    try {
      await this.deps.api.revokeDeviceCredential(token);
    } catch (error) {
      if (alreadyDead(error)) {
        // The revoke authenticates WITH the token being revoked
        // (`/v1/relay/devices/self/revoke` — the server knows which credential
        // is calling), so a 401 is that token saying it no longer works. There
        // is nothing left to retire, and holding it anyway is not caution: it
        // is a permanent warning on the setup screen and a worktree cleanup
        // that refuses for good, over a session that is already gone. Only a
        // 401 — see `alreadyDead`; a 403 is a session that is very much alive.
        releaseRevocation(this.deps.home, token);
        return true;
      }
      holdForRevocation(this.deps.home, token);
      // No value: the only one in scope IS the session.
      this.deps.warn?.("could not revoke a login session; holding it to retry");
      this.message = LOOSE_SESSION_WARNING;
      this.publish();
      return false;
    }
    releaseRevocation(this.deps.home, token);
    return true;
  }

  /**
   * Try again to retire EVERY session an earlier revoke could not.
   *
   * Called on launch (`main.ts`) and before every fresh activation, which are
   * the two moments a Mac that failed once is most likely to be able to reach
   * Plow again. Never throws and never blocks what called it: whichever
   * entries fail again stay exactly where they were.
   *
   * Over a snapshot, and one at a time: `retireOrRetain` writes settings on
   * both outcomes, so walking the live list would skip entries as it shrank.
   */
  async retryPendingRevocations(): Promise<void> {
    // SINGLE-FLIGHT. Launch starts one of these and the first activation
    // starts another, and on a slow network they overlap — so both read the
    // same list and both revoke the same token. The second call gets a 401,
    // because the first one worked. Before this the 401 was just another
    // failure and the token went back on the list: a session that no longer
    // existed, warned about on every screen and refused by worktree cleanup
    // for as long as the home lived. Joining the flight in progress is where
    // that closes; the 401 handling above is the belt to this braces, because
    // the same collision can happen across two processes.
    if (this.retrying) return this.retrying;
    const flight = this.sweepPendingRevocations();
    this.retrying = flight;
    // The handle is dropped AFTER it is taken, and only if it is still this
    // sweep's. Dropping it inside the body was a trap the empty case sprang
    // every time: with nothing held, the body runs to completion
    // synchronously, so it cleared the handle BEFORE the line above set it —
    // and the settled promise stayed parked here for the life of the process,
    // making every later launch or activation "join" a sweep that had already
    // finished. Nothing was ever retried again. The identity check is what
    // keeps a newer sweep from being cleared by an older one finishing.
    //
    // `then(clear, clear)` rather than `finally`: the caller gets `flight`
    // itself, so this cleanup rides its own chain and adds no turn before the
    // caller resumes — the reason `newActivationCode` avoids a chained
    // `finally` too.
    const clear = () => {
      if (this.retrying === flight) this.retrying = null;
    };
    flight.then(clear, clear);
    return flight;
  }

  /**
   * One pass over the held list. Never throws — the contract
   * `retryPendingRevocations` advertises, and what lets its callers treat it
   * as fire-and-forget. A token whose retry blows up in an unexpected way
   * stays held, which is the safe direction.
   */
  private async sweepPendingRevocations(): Promise<void> {
    for (const token of [...this.settings().pendingRevocations]) {
      try {
        await this.retireOrRetain(token);
      } catch {
        /* stays held */
      }
    }
  }

  /**
   * A verified token that could not be persisted, and the failure to report.
   *
   * Which failure the owner most needs is not the one that was thrown: a
   * `relayInfo` timeout the app can simply be asked to retry matters less than
   * a full account session now loose on their account. So the loose session
   * wins the message when there is one.
   */
  private async orphaned(token: string, error: unknown): Promise<unknown> {
    if (await this.retireOrRetain(token)) return error;
    return new PlowApiError("http", LOOSE_SESSION_WARNING);
  }

  // MARK: plumbing

  private settings(): Settings {
    return loadSettings(this.deps.home);
  }

  /** Holding a credential it cannot read — see `credentialLocked`. */
  private locked(): boolean {
    return credentialLocked(this.settings());
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
    this.busy = true;
    this.message = "";
    this.publish();
    try {
      await body();
    } catch (error) {
      this.message = messageOf(error);
    } finally {
      this.busy = false;
    }
    return this.publish();
  }

  private fail(message: string): OnboardingState {
    this.message = message;
    return this.publish();
  }

  private publish(): OnboardingState {
    this.deps.onChange?.();
    return this.state();
  }
}

/**
 * Is this failure the token telling us it is already gone?
 *
 * 401 and nothing else. The revoke authenticates with the very token it
 * retires, and `unauthorized` is the API's own word for "a wrong or expired
 * code, or a revoked token" — so a 401 is not a failure to revoke, it is a
 * revoke that has already happened.
 *
 * A 403 is the opposite and used to be lumped in here, which was a real bug:
 * it means the token DID authenticate — so the session is alive — and only
 * that this call was not permitted. Dropping the handle to a live `*:*`
 * session because the server would not let us retire it is precisely the
 * orphan this whole mechanism exists to prevent, and the owner needs that
 * handle to retire it in Plow. A 403 stays held.
 */
function alreadyDead(error: unknown): boolean {
  return error instanceof PlowApiError && error.kind === "unauthorized";
}

function messageOf(error: unknown): string {
  if (error instanceof PlowApiError) return error.message;
  // Anything else is ours and unexpected; say so rather than showing a stack.
  return "Something went wrong. Try again.";
}
