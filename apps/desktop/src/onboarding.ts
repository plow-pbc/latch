/**
 * First-run setup: a code on screen, a text from the user's phone, and a
 * connected Mac — with nothing typed and no token copied out of a browser.
 *
 * Activation goes *outbound*, so the account is created from the text the user
 * sends. It is the one verification path through setup.
 *
 * This is the whole flow as a plain state machine so it can be tested without
 * Electron and rendered offscreen for screenshots.
 *
 * **Nothing here puts a credential in a message.** `state()` is what the
 * sandboxed renderer sees, and the only secret it ever carries is the one the
 * user is meant to read: the activation display code. The activation *secret*
 * and the login session never appear in it at all.
 */
import { ActivationChat, PlowApi, PlowApiError } from "./plowApi.js";
import { chatPeople, chatRowTitle, usableChatDisplayName } from "./chatRows.js";
import { loadSettings, saveSettings, Settings } from "./settings.js";

/**
 * The verification sub-steps retain their existing mechanics. A successful
 * login pauses on a confirmation screen before the post-login data choice.
 */
export type OnboardingStep =
  | "welcome"
  | "privacy"
  | "activate"
  | "waiting"
  | "verified"
  | "data"
  | "availability"
  | "connect"
  | "done";

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
  return chatRowTitle(chatPeople(chat), (chat.line ?? "").trim() || null, chat.uid);
}

export interface OnboardingState {
  step: OnboardingStep;
  /** One honest line: what happened, or what we are waiting for. Never a bare
   * spinner — every failure below produces text here. */
  message: string;
  /** Presentation for `message`; never inferred from human-readable copy. */
  noteKind: "neutral" | "error";
  busy: boolean;
  activation: OnboardingActivation | null;
  /** We have stopped watching this activation. The screen stops counting down
   * and offers a fresh code. */
  activationStale: boolean;
  /** The data screen's pending choice. It is persisted only on Continue. */
  telemetryEnabled: boolean;
}

export interface OnboardingDeps {
  api: PlowApi;
  home: string;
  /** (Re)start the relay from stored settings. */
  startRelay: () => Promise<void>;
  /** Names this Mac in the activation request. */
  deviceName: string;
  /**
   * Turn the availability defaults on — Keep Awake, and Launch at Login where
   * the build can. Called once per home, on reaching the Availability screen,
   * so the switches it shows are on because they ARE on; the marker
   * (`Settings.launchAtLoginDefaulted`) records that it ran. It writes
   * settings itself (Keep Awake persists its opt-in), so it runs between two
   * loads here, never inside one.
   */
  applyAvailabilityDefault?: () => void;
  onChange?: () => void;
  now?: () => number;
  /** How the poll loop waits. Injectable so tests need no real timers. */
  wait?: (ms: number) => Promise<void>;
}

export class Onboarding {
  private step: OnboardingStep;
  private message = "";
  private noteKind: OnboardingState["noteKind"] = "error";
  private busy = false;
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
  private telemetryEnabled: boolean;

  constructor(private readonly deps: OnboardingDeps) {
    const settings = this.settings();
    this.telemetryEnabled = settings.telemetryEnabled;
    this.step = this.initialStep(settings);
  }

  state(): OnboardingState {
    return {
      step: this.step,
      message: this.message,
      noteKind: this.noteKind,
      busy: this.busy,
      activation: this.activation,
      activationStale: this.activationStale,
      telemetryEnabled: this.telemetryEnabled,
    };
  }

  /** Advance the presentational steps and commit the data-screen choice. */
  async advance(): Promise<OnboardingState> {
    if (this.busy) return this.state();
    if (this.step === "welcome") {
      this.step = "privacy";
      return this.publish();
    }
    if (this.step === "privacy") {
      // Returning from verification keeps the live activation and its watcher.
      // Re-entering therefore shows the same code without another network call.
      if (this.activation) {
        this.step = this.activationStale ? "waiting" : "activate";
        return this.publish();
      }
      return this.newActivationCode();
    }
    if (this.step === "verified") {
      // The display code is spent, but stays visible through the confirmation
      // treatment so the screen does not jump while redemption finishes.
      this.activation = null;
      this.step = "data";
      return this.publish();
    }
    if (this.step === "data") {
      const settings = this.settings();
      settings.telemetryEnabled = this.telemetryEnabled;
      this.save(settings);
      if (!settings.launchAtLoginDefaulted) {
        this.deps.applyAvailabilityDefault?.();
        const defaulted = this.settings();
        defaulted.launchAtLoginDefaulted = true;
        this.save(defaulted);
      }
      this.step = "availability";
      return this.publish();
    }
    if (this.step === "availability") {
      this.step = "connect";
      return this.publish();
    }
    if (this.step === "connect") {
      const settings = this.settings();
      settings.setupComplete = true;
      this.save(settings);
      this.step = "done";
      return this.publish();
    }
    return this.publish();
  }

  /** Return through the steps that have a Back affordance. */
  async back(): Promise<OnboardingState> {
    if (this.busy) return this.state();
    if (this.step === "privacy") this.step = "welcome";
    else if (this.step === "activate" || this.step === "waiting") this.step = "privacy";
    else if (this.step === "availability") this.step = "data";
    else if (this.step === "connect") this.step = "availability";
    else return this.state();
    return this.publish();
  }

  /** Change the pending choice; Continue from data is its only disk write. */
  setTelemetryEnabled(enabled: unknown): OnboardingState {
    if (this.busy) return this.state();
    if (this.step === "data" && typeof enabled === "boolean") {
      this.telemetryEnabled = enabled;
      return this.publish();
    }
    return this.state();
  }

  // MARK: activation — the path a brand-new user takes

  /** Retry a mint only when the activation view is already waiting for one. */
  async begin(): Promise<OnboardingState> {
    // Renderer boot is intentionally a read-like no-op on the presentational
    // steps. The first activation is minted only by Continue from Privacy.
    if (this.step !== "activate" || this.activation) {
      return this.state();
    }
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
    // SINGLE-FLIGHT. A display code IS a credential — whoever texts it gets the
    // account — so a second mint nobody is shown is a live credential loose on
    // the account, and the screen can only ever show one of them. A double-click
    // on Privacy Continue and a retry arriving while its mint is in flight can
    // race before `activation` is set. Joining the flight in progress is the
    // only place that gap can be closed.
    if (this.pendingMint) return this.pendingMint;
    if (this.busy) return this.state();

    if (this.activationSecret && this.activation) {
      // Same code, fresh clock — and one honest line about why sending again
      // uses the code they already have.
      this.activation = { ...this.activation, pollUntil: this.now() + ACTIVATION_POLL_WINDOW_MS };
      this.activationStale = false;
      this.message =
        "That code still works — send it exactly as shown and this screen will move on by itself.";
      this.noteKind = "neutral";
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
    if (this.busy) return this.state();
    if (this.step === "activate" && this.activation) this.step = "waiting";
    return this.publish();
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
        this.noteKind = "error";
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
      // for good — sign-out, a completed login, or the server retiring the
      // code — so it says what "already holding a
      // credential" was only guessing at.
      // Asked, never cached. `activationSecret` is nulled by every path that
      // abandons this activation, and the stored credential is cleared by
      // sign-out — so both halves can change under an await, and this is
      // re-evaluated on the far side of one rather than read once at the top.
      const keep = () =>
        secret === this.activationSecret && !this.settings().relayCredential.trim();
      // A verified token this Mac will not keep is revoked best-effort. The
      // redeem answers once, so it must not simply be dropped here.
      if (result.status === "verified" && result.token && !keep()) {
        await this.deps.api.revokeDeviceCredential(result.token).catch(() => {});
      }
      if (result.status === "verified" && result.token && keep()) {
        this.cancelPolling();
        // The redeem consumed the one-shot completion, so the code is spent
        // whatever happens next: retire it BEFORE the handoff, whose network
        // calls can fail. A failure then leaves the stalled screen minting
        // fresh on "Try Again" — not re-arming a code nothing can complete.
        this.activationSecret = null;
        this.stall();
        const finished = await this.run(() => this.finishWithSession(result.token as string));
        // The verified screen is actionable while the relay connects. `run`
        // clears busy and publishes before this await, and nothing after it
        // mutates onboarding state.
        if (finished.step === "verified") await this.deps.startRelay();
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
   * The step move is the whole point. A user who reads the code off the screen
   * and types it into Messages themselves never taps "Open Messages", so they
   * never leave the initial activation view. Set `activationStale` without
   * moving them and the recovery message would have no matching "Try again"
   * control: a dead end. Every path that stops polling comes through here so
   * that cannot drift apart again.
   */
  private stall(message?: string): void {
    if (this.step === "activate" || this.step === "waiting") this.step = "waiting";
    this.activationStale = true;
    if (message !== undefined) {
      this.message = message;
      this.noteKind = "error";
    }
  }

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
    this.message = "";
    this.noteKind = "error";
    this.busy = false;
    const settings = this.settings();
    this.telemetryEnabled = settings.telemetryEnabled;
    this.step = this.initialStep(settings);
    return this.publish();
  }

  /** Put a fixed main-process notice on the setup screen. */
  showMessage(message: string): OnboardingState {
    this.message = message;
    this.noteKind = "error";
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

  /**
   * Learn the account → keep the session → show the verified state.
   *
   * The session IS this Mac's credential. Latch is the owner's manager app,
   * not an agent: it holds the socket, lists chats, mints agents, buys
   * inference and mints connector tokens, and every surface added to it used
   * to mean a plow scope change plus a fleet re-pair, because a device
   * credential's scopes freeze at mint. A session carries `*:*` and expires
   * only after 180 days unused, refreshed by every request it makes.
   *
   * The token the redeem handed back is what gets written. Runtime relay
   * startup owns the idempotent registration and retries it with backoff.
   */
  private async finishWithSession(sessionToken: string): Promise<void> {
    // A sign-out can land inside the account lookup, and it must stay signed out:
    // persisting past it would leave the account a live credential its owner
    // just retired. `pollGeneration` is bumped by every path that abandons this
    // login — reset or a fresh mint — so it is the epoch to
    // check against after each network step.
    //
    // A sign-out landing inside it takes the session with it. The session is
    // revoked best-effort, the same contract sign-out keeps.
    const epoch = this.pollGeneration;
    const info = await this.deps.api.relayInfo(sessionToken);
    if (epoch !== this.pollGeneration) {
      await this.deps.api.revokeDeviceCredential(sessionToken).catch(() => {});
      return;
    }
    // Written 0600 by saveSettings. This is the only copy of the credential and
    // it is never handed to the renderer.
    const settings = this.settings();
    settings.relayCredential = sessionToken;
    settings.accountUid = info.uid;
    settings.mcpUrl = "";
    // Nothing records `sendTo`. Pairing asks for no chat, so it is the managed
    // phone — the number that takes an activation text, not one anyone can be
    // told to text afterwards to get a chat. The cloud-agents screen names the
    // lines the account's own chats run on, which is the only source that
    // cannot be wrong.
    this.save(settings);

    // The activation secret is spent and dropped. The public display value is
    // retained until Continue so the verified treatment can hold the same
    // screen steady.
    //
    // Everything here is derived from the save above; none of it needs the
    // socket to be up.
    this.cancelPolling();
    this.activationSecret = null;
    this.activationStale = false;
    this.message = "";
    this.noteKind = "error";
    this.step = "verified";
    this.telemetryEnabled = settings.telemetryEnabled;
  }

  // MARK: plumbing

  private settings(): Settings {
    return loadSettings(this.deps.home);
  }

  private save(settings: Settings): void {
    saveSettings(this.deps.home, settings);
  }

  private initialStep(settings: Settings): OnboardingStep {
    if (!settings.relayCredential.trim()) return "welcome";
    return settings.setupComplete ? "done" : "data";
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
    this.noteKind = "error";
    this.publish();
    try {
      await body();
    } catch (error) {
      this.message = messageOf(error);
      this.noteKind = "error";
    } finally {
      this.busy = false;
    }
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
