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
 * sandboxed renderer sees; the only secrets it ever carries are the two the user
 * is meant to read — the activation display code, and a freshly minted *agent*
 * credential shown exactly once. The activation *secret* and the device
 * credential never appear in it at all.
 */
import { PlowApi, PlowApiError } from "./plowApi.js";
import { loadSettings, saveSettings, Settings } from "./settings.js";

export type OnboardingStep = "activate" | "waiting" | "phone" | "code" | "connected" | "agent";

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

export interface OnboardingAgent {
  name: string;
  /** Shown once. The app does not store it and cannot show it again. */
  token: string;
  /** A ready-to-paste MCP client config containing that token. */
  config: string;
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
  agent: OnboardingAgent | null;
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
   * Bumped when a sign-out invalidates everything in flight.
   *
   * Narrow on purpose. It guards ONE thing: a mutation that started before the
   * sign-out publishing its result afterwards. `createAgent` is the case —
   * the request captures the credential, the user signs out, and the
   * continuation then put the agent screen back over a window that had already
   * been reset, with a token minted against an account this Mac has left.
   *
   * It does not try to stop that work, wait for it, or undo it. The agent key
   * it minted is not revoked here; agent keys are never persisted and sign-out
   * has never retired them. That is a separate product question.
   */
  private stateGeneration = 0;
  private agent: OnboardingAgent | null = null;

  constructor(private readonly deps: OnboardingDeps) {
    // A Mac that already holds a credential is past all of this; it opens on the
    // connected screen, which is also where "create an agent" lives.
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
      agent: this.agent,
    };
  }

  // MARK: activation — the path a brand-new user takes

  /**
   * Mint the code the user texts, and start polling immediately.
   *
   * Idempotent: opening the window twice must not burn a second code and leave
   * two live activations on the account.
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
    const previous = this.activationSecret;
    this.cancelPolling();
    return this.run(async () => {
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
    });
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
   * Mint an agent credential with the *device* credential — the login session
   * is long gone by now, and `relay:device` is allowed to do exactly this.
   */
  async createAgent(name: string): Promise<OnboardingState> {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return this.fail("Give the agent a name.");
    const settings = this.settings();
    if (!settings.relayCredential.trim()) return this.fail("This Mac isn't signed in yet.");
    const generation = this.stateGeneration;
    return this.run(async () => {
      const minted = await this.deps.api.createAgent(settings.relayCredential, trimmed);
      // Signed out while this was on the wire: the window has already been
      // reset, and the token belongs to an account this Mac has left.
      if (generation !== this.stateGeneration) return;
      this.agent = {
        name: minted.name || trimmed,
        token: minted.token,
        config: agentConfig(settings.mcpUrl, minted.token),
      };
      this.step = "agent";
    });
  }

  /** Drop the shown-once credential from memory and go back. */
  dismissAgent(): OnboardingState {
    this.agent = null;
    this.step = "connected";
    this.message = "";
    return this.publish();
  }

  /**
   * This Mac just signed out. Become a Mac that has never signed in.
   *
   * The constructor is the only other place that decides this, and it runs
   * once — so an instance that outlives a sign-out went on reporting `connected`
   * with a stale account and endpoint behind it. Reopening the window from
   * Settings showed "Signed in — connecting…" and offered Create Agent, which
   * then failed on its own credential check. Sign-out is a transition three
   * owners have to make (settings, relay, this); this is the third one, stated
   * rather than implied.
   *
   * Everything in front of the reset is synchronous, so the instant this
   * returns to the event loop it is already signed out and there is no window
   * in which a `state()` can still say otherwise. The activation that follows
   * is a courtesy for a window that is ALREADY OPEN — resetting to `activate`
   * without one would leave it on a code-less screen, because nothing reopens
   * it to call `begin()`. `begin()` is idempotent, so a window opening
   * afterwards does not mint a second code — and it cancels the poll loop on
   * its way to minting the fresh one, which is why there is no
   * `cancelPolling()` here: a second one does nothing the first does not, and
   * no test could tell the two apart.
   */
  signedOut(): OnboardingState {
    this.cancelPolling();
    this.stateGeneration += 1;
    this.step = "activate";
    this.activation = null;
    // SECRETS, both of them, and both belonging to the account just left: the
    // activation that minted the old credential, and the agent token shown once
    // on the connected screen. Neither may outlive the sign-out in memory.
    this.activationSecret = null;
    this.agent = null;
    this.activationStale = false;
    this.codeExpiresAt = null;
    this.phone = "";
    this.message = "";
    // The reset owns this too. Work started before the sign-out no longer
    // clears it — see `stateGeneration` — so leaving it set would strand the
    // window on a spinner belonging to an account it has left.
    this.busy = false;
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
    const generation = this.stateGeneration;
    this.busy = true;
    this.message = "";
    this.publish();
    try {
      await body();
    } catch (error) {
      // A stale failure belongs to a screen the user has left; reporting it
      // would put the old account's error over the new activation.
      if (generation === this.stateGeneration) this.message = messageOf(error);
    } finally {
      // Only ours to clear. A sign-out starts its own work, and this `finally`
      // arriving late would report that work as finished.
      if (generation === this.stateGeneration) this.busy = false;
    }
    return generation === this.stateGeneration ? this.publish() : this.state();
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

/** What to paste into an MCP client. The credential is a header, never part of
 * the URL — a URL ends up in shell history, logs and stored registrations. */
export function agentConfig(mcpUrl: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        domo: {
          type: "http",
          url: mcpUrl,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

function messageOf(error: unknown): string {
  if (error instanceof PlowApiError) return error.message;
  // Anything else is ours and unexpected; say so rather than showing a stack.
  return "Something went wrong. Try again.";
}
