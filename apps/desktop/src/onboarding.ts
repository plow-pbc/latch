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
import { ActivationRedeem, PlowApi, PlowApiError } from "./plowApi.js";
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
  /**
   * Register work a quit must not terminate in the middle of, and hand back the
   * same promise. Injected because the gate is Electron's business — and
   * REQUIRED, because the one thing it guards is a credential outliving the
   * process. A default would let a construction site forget it silently, which
   * is exactly how that guarantee would be lost.
   */
  critical: <T>(work: Promise<T>) => Promise<T>;
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
   * Bumped whenever a LOGIN is abandoned — not merely a poll loop.
   *
   * The difference is the point. Five fixes in this chain each moved a window
   * later: refuse a late redeem, refuse a stale secret, reset earlier. A yield
   * inside `finishWithSession` then opened the window again one layer down,
   * because the check had always been about WHERE the work paused. This is
   * about WHETHER the login it belongs to still exists, so it invalidates
   * in-flight work wherever it happened to yield.
   *
   * Two paths abandon a login, and they are the only two: `signedOut()` and
   * `usePhoneCode()` — a sign-out, and a switch to a method that may sign in a
   * different account entirely.
   *
   * Two more deliberately do NOT, and the distinction is retry vs abandon.
   * `giveUp()` stops watching, but the code stays live for the rest of its
   * thirty minutes and re-polling it is the recovery. `newActivationCode()`
   * re-polls that very secret before it mints anything — bumping there would
   * throw away a login the user had actually completed and then find the token
   * already consumed, stranding them on "didn't hand back a login" with a
   * credential that had been minted and handed back.
   */
  private loginGeneration = 0;
  /**
   * The app is going away. Set synchronously by `quitting()`, and never unset —
   * a process that has begun exiting does not come back.
   */
  private isQuitting = false;
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
    // A fresh code starts a fresh poll loop, and that loop's whole job is to
    // turn into a session token. No token exists yet, so there is nothing to
    // dispose of by starting one — this is exactly what the quit latch forbids.
    // `begin()` comes through here too, so this is the only door.
    if (this.isQuitting) return this.publish();
    const previous = this.activationSecret;
    this.cancelPolling();
    return this.run(async () => {
      if (previous && (await this.deps.critical(this.tryFinish(previous)))) return;
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
    // Leaving for the OTP path abandons the activation login — a different
    // account may be signed in from here.
    this.loginGeneration += 1;
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

  /**
   * One redeem, and the login it may complete, as a single unit of work.
   *
   * The split matters only to the shutdown gate: everything a delivered session
   * token needs — the request that carries it and the mint that retires it —
   * has to sit inside ONE registration, so a quit either waits for all of it or
   * arrives before any of it. The loop's own bookkeeping stays in the loop.
   */
  private async redeemAndDispose(
    secret: string,
  ): Promise<{ finished: true } | { finished: false; error: unknown } | { finished: false; result: ActivationRedeem }> {
    let result;
    try {
      result = await this.deps.api.redeemActivation(secret);
    } catch (error) {
      return { finished: false, error };
    }
    // A verified answer is acted on even if this loop was cancelled while the
    // call was in flight: dropping it would strand an activation the user
    // actually completed, and the token it carries is the only handle that can
    // retire the session. That is why a stale generation is not enough to
    // refuse it — see the note in `finishWithSession`.
    //
    // What decides instead is whether this is still OUR activation.
    // `activationSecret` is nulled by every path that abandons an activation
    // for good — sign-out, the phone-code fallback, a completed login — and
    // deliberately KEPT by `giveUp`, which is the case this exists for.
    const stillOurs = secret === this.activationSecret;
    if (
      result.status === "verified" &&
      result.token &&
      stillOurs &&
      !this.settings().relayCredential.trim()
    ) {
      this.cancelPolling();
      await this.run(() => this.finishWithSession(result.token as string));
      return { finished: true };
    }
    return { finished: false, result };
  }

  private cancelPolling(): void {
    this.pollGeneration += 1;
  }

  private async pollActivation(secret: string, generation: number): Promise<void> {
    while (generation === this.pollGeneration) {
      await this.wait(ACTIVATION_POLL_INTERVAL_MS);
      if (generation !== this.pollGeneration) return;

      // ONE tracked transaction: the request that may deliver a session token,
      // and the disposal of whatever it delivers. Registering only once the
      // request RETURNS leaves the token in flight over an empty gate — a quit
      // there snapshots nothing, exits, and the session is stranded. Two spans
      // back to back do not fix it either: the first settles before the second
      // registers, and a quit already waiting on the first is released by that
      // settle with the second nowhere in its snapshot.
      const attempt = await this.deps.critical(this.redeemAndDispose(secret));
      if (attempt.finished) return;
      if ("error" in attempt) {
        const error = attempt.error;
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
      const result = attempt.result;
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
    return this.run(() => this.deps.critical(this.completeOtpLogin(trimmed)));
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
    return this.run(async () => {
      const minted = await this.deps.api.createAgent(settings.relayCredential, trimmed);
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
  async signedOut(): Promise<OnboardingState> {
    // First, and synchronously: no yield separates the settings clear in
    // `revokeAndSignOut` from this bump, so any login already in flight is
    // invalidated before it can get a turn.
    this.loginGeneration += 1;
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
    // No `message = ""` and no `publish()` here: `begin()` reaches `run()`,
    // which does both synchronously before it awaits anything.
    return this.begin();
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
    if (this.isQuitting) return; // see tryFinish
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
  /**
   * The app is quitting. Abandon every login, in flight or not yet started.
   *
   * SYNCHRONOUS on purpose, and `main.ts` calls it before the shutdown gate is
   * read. The gate can only hold work that has been registered, and the first
   * registration a login makes is around the MINT — so between `relayInfo()`
   * starting and that registration the gate is empty, `deferQuit` finds nothing
   * to wait for, and the quit is allowed. If that continuation then resumed
   * during teardown it would start a server-side mint the exiting process would
   * neither persist nor revoke. Nothing the gate can do closes that; the login
   * has to already be dead by the time the gate is asked.
   *
   * The generation bump kills the logins that are already running. The flag
   * kills the ones that have not started — a poll loop can still land a
   * verified answer while the window is closing, and it would capture the bumped
   * generation and sail past every check that only compares it.
   *
   * Registering nothing with the gate is deliberate: a quit with no onboarding
   * work in flight must not be delayed by this at all.
   */
  quitting(): void {
    this.isQuitting = true;
    this.loginGeneration += 1;
    // Stops the poll loop before its NEXT redeem. One already on the wire is
    // deliberately left alone: it may be carrying a token, and the late accept
    // below runs before the generation check for exactly that reason.
    this.cancelPolling();
  }

  /**
   * Finish a login we already hold a session token for. **Callers must wrap
   * this in `deps.critical`** — see the note on the token below.
   *
   * There is no early exit here, and that is the whole point. `sessionToken`
   * carries `keys:manage` and `relay:*`: it can mint ANY credential on the
   * account, and it is the single most dangerous thing this app ever holds. The
   * ONLY thing that retires it is `mintDeviceCredential`, which sets
   * `revoke_calling_session` and kills it in the same transaction as the mint.
   *
   * So once a token has been delivered, refusing to continue does not make the
   * app safer — it strands a live `keys:manage` session on the account and
   * throws away the only handle that could have retired it. Abandoning a login
   * means minting a credential we do not want and handing it straight back,
   * which `mintAndCommit`'s generation check already does. A device credential
   * we can revoke is a far smaller liability than a session we cannot.
   */
  private async finishWithSession(sessionToken: string): Promise<void> {
    // Captured before the first yield. What it decides is whether the minted
    // credential is KEPT — never whether the mint happens.
    const login = this.loginGeneration;
    let info;
    try {
      info = await this.deps.api.relayInfo(sessionToken);
    } catch (error) {
      // The account lookup failed, and this is the last moment anything holds
      // the session token — it lives only in this frame. Letting the error
      // straight out would end the login with a live `keys:manage` session on
      // the account and no handle left to retire it.
      //
      // So mint anyway. Not because a credential is wanted — there is nothing
      // to save it against — but because `revoke_calling_session` rides on that
      // one call and is the only thing that kills the session. `null` info
      // routes what it produces through the same hand-back the abandoned-login
      // path uses.
      try {
        await this.mintAndCommit(sessionToken, null, login);
      } catch {
        // The mint failed too — the API is having a bad day and there is
        // nothing further to try. The original failure is the honest one.
      }
      throw error;
    }
    await this.mintAndCommit(sessionToken, info, login);
  }

  /** The half of a login that can create a credential. See finishWithSession. */
  /**
   * `info` is null when the account lookup failed: mint to kill the session,
   * then hand the credential back. There is nothing to save it against, and a
   * credential with no `accountUid` or `mcpUrl` behind it is not a sign-in.
   */
  private async mintAndCommit(
    sessionToken: string,
    info: { uid: string; mcpUrl: string } | null,
    login: number,
  ): Promise<void> {
    const minted = await this.deps.api.mintDeviceCredential(sessionToken, this.deps.deviceName);
    // Checked the instant the mint returns. This exit CANNOT just return: the
    // credential now exists on the account, and the sign-out that beat us to it
    // revoked a different one. Persisting it would leave the account holding a
    // live, spend-capable credential its owner had just retired, so it is
    // handed back instead.
    //
    // `isQuitting` is asked as well as the generation, and it is not redundant:
    // a login that ENTERS after the latch captures the already-bumped
    // generation, so comparing generations alone waves it through and saves a
    // credential on the way out the door. The mint still had to happen — it is
    // what retires the session token — but keeping what it produced is a
    // different question, and the answer during a quit is always no.
    if (info === null || login !== this.loginGeneration || this.isQuitting) {
      // Awaited, so the hand-back is INSIDE this span rather than beside it.
      // Registering it separately meant this span settled while the revoke was
      // still pending, and a quit that had already snapshotted the outstanding
      // work never saw it — the credential outlived the process.
      await this.discardLostCredential(minted.token);
      return;
    }

    // From here to `save` there is NO await, so the check above and the write
    // below cannot be separated by a sign-out. That is what makes the pair a
    // guard rather than another slightly-later window.
    // Written 0600 by saveSettings. This is the only copy of the credential and
    // it is never handed to the renderer.
    const settings = this.settings();
    settings.relayCredential = minted.token;
    settings.accountUid = info.uid;
    settings.mcpUrl = info.mcpUrl;
    this.save(settings);

    try {
      await this.deps.startRelay();
    } catch (error) {
      // The FAILURE continuation is generation-aware too. A sign-out during the
      // dial means this message would land on a screen the user has already
      // left — and `run()` would put it there, over the fresh activation.
      if (login !== this.loginGeneration) return;
      throw error;
    }
    // …and the success continuation, which is the one that actually did damage:
    // it reported `connected` and cleared the activation the sign-out had just
    // started, leaving a window claiming to be signed in with no credential
    // behind it. The save above is not undone here because the sign-out's own
    // clear already ran — this state is all that is left to get wrong.
    if (login !== this.loginGeneration) return;

    // The activation is spent: drop the code and the secret rather than leave
    // either sitting in memory or on a screen behind this one.
    this.cancelPolling();
    this.activation = null;
    this.activationSecret = null;
    this.activationStale = false;
    this.step = "connected";
    this.codeExpiresAt = null;
    this.message = "";
  }

  /**
   * Hand back a credential minted into a race we lost.
   *
   * AWAITED by its caller and unable to throw. Awaited because the credential
   * is live until this lands, so the span a quit waits on has to still be open
   * while it is on the wire — the earlier shape registered it with the gate
   * separately, and a quit that had already snapshotted the outstanding work
   * never saw it. Unable to throw because the login it belonged to is gone and
   * there is nobody to report a failure to; failing to hand it back leaves
   * exactly what we had before this existed, so best-effort is strictly better
   * and never worse. A hang is bounded by the quit's own two seconds.
   */
  private discardLostCredential(token: string): Promise<void> {
    return this.deps.api.revokeDeviceCredential(token).catch(() => {});
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
