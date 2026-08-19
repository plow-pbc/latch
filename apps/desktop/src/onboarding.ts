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
import { PlowApi, PlowApiError } from "./plowApi.js";
import { loadSettings, saveSettings, Settings } from "./settings.js";

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
 * How long the app watches for the text.
 *
 * The server's code lives 30 minutes (`ACTIVATION_CODE_TTL` in
 * `api/plow/auth_routes/router.py`), but a screen that says "waiting" for half
 * an hour is a worse experience than one that gives up early and hands control
 * back. So we stop at five and offer a fresh code — and because the server
 * honours a completion that lands after we stopped looking, "get a new code"
 * re-polls the old secret before minting anything.
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
  /** Epoch ms we stop watching, so the screen can count down. Not the code's
   * own deadline — the server keeps it live for 30 minutes after this. */
  pollUntil: number;
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
    return {
      step: this.step,
      phone: this.phone,
      message: this.message,
      busy: this.busy,
      codeExpiresAt: this.codeExpiresAt,
      activation: this.activation,
      activationStale: this.activationStale,
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
   * A fresh code and a fresh clock — but only if the last one really did go
   * unanswered.
   *
   * We stop watching at five minutes and the server keeps the code live for
   * thirty, so a user who texted at minute six has *already succeeded* and is
   * looking at a screen that says otherwise. One poll on the old secret turns a
   * pointless second code into an instant sign-in.
   */
  async newActivationCode(): Promise<OnboardingState> {
    // SINGLE-FLIGHT. A display code IS a credential — whoever texts it gets the
    // account — so a second mint nobody is shown is a live credential loose on
    // the account, and the screen can only ever show one of them. Two callers
    // race here for real: `settings:signOut` calls `begin` and, in the same
    // breath, opens the setup window whose renderer calls `begin` on boot.
    // `activation` is not set until the API answers, so on a slow
    // `/v1/auth/activate` both sail past that check. Joining the flight in
    // progress is the only place this can be closed.
    if (this.pendingMint) return this.pendingMint;

    const previous = this.activationSecret;
    this.cancelPolling();
    const mintId = ++this.mints;
    // The handle is dropped inside the body rather than by chaining `.finally`
    // onto the result: a chained one adds a turn before the caller resumes, and
    // `wait` here is injectable — under a test clock that extra turn lets the
    // detached poll loop run ahead of the caller. Same guarantee, no new tick.
    const flight = this.run(async () => {
      try {
        if (previous && (await this.tryFinish(previous))) return;
        this.activation = null;
        this.activationSecret = null;
        this.activationStale = false;
        this.step = "activate";
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
   * One redeem. Returns true if it was terminal — signed in, or verified with
   * no token to hand back — and false if there is still nothing to act on.
   *
   * A failed call is `false` rather than a throw: this runs where the fallback
   * is "mint a fresh code", which will surface its own error honestly if the
   * API is genuinely down.
   */
  private async tryFinish(secret: string): Promise<boolean> {
    let result;
    try {
      result = await this.deps.api.redeemActivation(secret);
    } catch {
      return false;
    }
    // The same test the poll loop makes, for the same reason and against the
    // same race: this redeem is also a call in flight, and "Get a New Code"
    // during a sign-out would otherwise mint and persist a credential out of an
    // activation the sign-out had already abandoned. `activationSecret` is
    // still `secret` for the whole legitimate call — `newActivationCode` does
    // not clear it until this returns false.
    if (secret !== this.activationSecret) return false;
    if (result.status !== "verified") return false;
    if (!result.token) {
      // The token is handed to the first redeem that sees the completion and
      // the key is omitted on every one after, so this means it was already
      // read and lost. A new code is the only way forward.
      this.stall("Plow verified this Mac but didn't hand back a login. Get a new code.");
      return true;
    }
    await this.finishWithSession(result.token);
    return true;
  }

  /**
   * The user has gone to Messages. Nothing to do but wait — and say so, rather
   * than leave them staring at a screen that still reads like a to-do.
   */
  messagesOpened(): OnboardingState {
    if (this.step === "activate" && this.activation) this.step = "waiting";
    return this.publish();
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
      // be left on a countdown that no longer runs.
      if (generation !== this.pollGeneration) return;
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
      // account was left holding a live device credential its owner had just
      // retired.
      //
      // `activationSecret` is nulled by every path that abandons an activation
      // for good — sign-out, the phone-code fallback, a completed login — and
      // deliberately KEPT by `giveUp`, which is the case this late accept exists
      // for. So it says what "already holding a credential" was only guessing at.
      const stillOurs = secret === this.activationSecret;
      if (
        result.status === "verified" &&
        result.token &&
        stillOurs &&
        !this.settings().relayCredential.trim()
      ) {
        this.cancelPolling();
        await this.run(() => this.finishWithSession(result.token as string));
        return;
      }
      if (generation !== this.pollGeneration) return;

      if (result.status === "verified") {
        this.cancelPolling();
        this.stall("Plow verified this Mac but didn't hand back a login. Get a new code.");
        this.publish();
        return;
      }

      // Pending, and our five minutes are up. The poll that just answered
      // happened *after* the deadline, so a text racing it has already been
      // caught; what is left is a genuine no-answer.
      if (this.activation && this.now() > this.activation.pollUntil) {
        this.giveUp("We haven't heard from your phone.");
        return;
      }
    }
  }

  /**
   * Stop watching and hand control back. The code itself is still live for the
   * rest of its 30 minutes, which is exactly why "Get a New Code" re-polls this
   * secret before it mints anything.
   */
  private giveUp(reason: string): void {
    this.cancelPolling();
    this.stall(
      `${reason} Send the message exactly as shown — it has to start with “${ACTIVATION_SMS_PREFIX}” — or get a new code.`,
    );
    this.publish();
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
   * Learn the account → mint this Mac's credential → connect.
   *
   * `sessionToken` never leaves this function. It carries `keys:manage` and
   * `relay:*` — it can mint *any* credential on the account — so the app holds
   * it for the two calls it needs and not one longer. There is no client-side
   * cleanup to get wrong: `mintDeviceCredential` retires the session
   * server-side, in the same transaction as the mint.
   */
  private async finishWithSession(sessionToken: string): Promise<void> {
    const info = await this.deps.api.relayInfo(sessionToken);
    const minted = await this.deps.api.mintDeviceCredential(sessionToken, this.deps.deviceName);

    // Written 0600 by saveSettings. This is the only copy of the credential and
    // it is never handed to the renderer.
    const settings = this.settings();
    settings.relayCredential = minted.token;
    settings.accountUid = info.uid;
    settings.mcpUrl = info.mcpUrl;
    this.save(settings);

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

function messageOf(error: unknown): string {
  if (error instanceof PlowApiError) return error.message;
  // Anything else is ours and unexpected; say so rather than showing a stack.
  return "Something went wrong. Try again.";
}
