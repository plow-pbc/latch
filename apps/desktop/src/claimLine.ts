/**
 * Claiming a Plow number: the second flow beside pairing.
 *
 * Pairing a Mac mints a device credential and deliberately spends no pool line
 * (`createActivation` omits `provision_chat`). Claiming a line is the separate,
 * explicit step that does ask for one — from the cloud-agents modal, on an
 * already-signed-in Mac, when the owner wants a number to text.
 *
 * The two flows share an endpoint and share nothing else. This one:
 *   - asks for a chat (`provisionChat: true`), which assigns a pool line;
 *   - keeps the chat and the line the redeem hands back;
 *   - **mints no credential and never touches `relayCredential`.** The Mac is
 *     already signed in; a second device credential would be a live,
 *     spend-capable key nobody asked for. The redeem's session token is a
 *     throwaway, retired best-effort and never persisted.
 *
 * Written as a plain state machine, indifferent to the relay's connected
 * state, so it is testable without Electron.
 *
 * **Nothing here puts a credential in a message.** `state()` is what the
 * sandboxed renderer sees, and the only secret it carries is the one the user
 * is meant to read: the activation display code. The activation *secret* and
 * the redeem's session token never appear in it at all.
 */
import {
  ACTIVATION_POLL_INTERVAL_MS,
  ACTIVATION_POLL_WINDOW_MS,
  ACTIVATION_SMS_PREFIX,
  activationChatLabel,
  activationSmsBody,
  activationSmsUrl,
  OnboardingActivation,
  OnboardingChat,
} from "./onboarding.js";
import { ActivationChat, PlowApi, PlowApiError } from "./plowApi.js";
import { loadSettings, saveSettings, Settings } from "./settings.js";

/**
 * `idle` is both ends of the flow: before a code exists and after the claim
 * landed. What separates them for the screen is `chat` — the claim's result —
 * so there is no "done" step to clear on the next open.
 */
export type ClaimLineStep = "idle" | "waiting";

export interface ClaimLineState {
  step: ClaimLineStep;
  busy: boolean;
  /** One honest line: what happened, or what we are waiting for. */
  message: string;
  activation: OnboardingActivation | null;
  /** We have stopped watching. The screen offers a fresh code. */
  activationStale: boolean;
  /** The chat this claim provisioned, once it has. Display data only. */
  chat: OnboardingChat | null;
}

export interface ClaimLineDeps {
  api: PlowApi;
  home: string;
  /** Names the activation in the owner's account, as pairing does. */
  deviceName: string;
  /** Re-read the cloud-agent screen: the new chat is a row on it. */
  refreshAgents: () => Promise<void>;
  onChange?: () => void;
  now?: () => number;
  /** How the poll loop waits. Injectable so tests need no real timers. */
  wait?: (ms: number) => Promise<void>;
}

export class ClaimLine {
  private step: ClaimLineStep = "idle";
  private busy = false;
  private message = "";
  private activation: OnboardingActivation | null = null;
  private activationStale = false;
  private chat: OnboardingChat | null = null;
  /** SECRET. Held for the life of one claim and nowhere else — never in
   * `state()`, never on disk, never in a log line. */
  private activationSecret: string | null = null;
  /** Bumped whenever a claim stops being the one we care about. A poll loop
   * whose generation is stale returns instead of writing state. */
  private pollGeneration = 0;
  /** The mint in flight, if any, so a second click joins it rather than
   * burning a second code. `pendingMintId` says which flight it is. */
  private pendingMint: Promise<ClaimLineState> | null = null;
  private pendingMintId = 0;
  private mints = 0;

  constructor(private readonly deps: ClaimLineDeps) {}

  state(): ClaimLineState {
    return {
      step: this.step,
      busy: this.busy,
      message: this.message,
      activation: this.activation,
      activationStale: this.activationStale,
      chat: this.chat,
    };
  }

  /**
   * Start a claim, or hand back the one already on screen.
   *
   * Idempotent for the same reason onboarding's `begin` is: a display code IS a
   * credential — whoever texts it claims the line — so a second one nobody is
   * shown is a live credential loose on the account.
   */
  async begin(): Promise<ClaimLineState> {
    if (this.activation) return this.publish();
    return this.newCode();
  }

  /**
   * A fresh code — but only once the old one is done with.
   *
   * While a code is live its poll loop is the ONLY redeemer, so this puts the
   * same code back on the clock rather than redeeming: a redeem racing the
   * poll's own splits the one-shot completion, and the chat is handed to
   * whichever request got there first and lost either way.
   */
  async newCode(): Promise<ClaimLineState> {
    // SINGLE-FLIGHT, and the check `activation` cannot make: it is not set
    // until the API answers, so two clicks on a slow `/v1/auth/activate` both
    // sail past `begin`'s guard and mint two codes against the pool.
    if (this.pendingMint) return this.pendingMint;

    if (this.activationSecret && this.activation) {
      this.activation = { ...this.activation, pollUntil: this.now() + ACTIVATION_POLL_WINDOW_MS };
      this.activationStale = false;
      this.message =
        "That code still works — send it exactly as shown and this screen will move on by itself.";
      return this.publish();
    }

    this.cancelPolling();
    const mintId = ++this.mints;
    // The handle is dropped inside the body rather than by chaining `.finally`:
    // a chained one adds a turn before the caller resumes, and under a test
    // clock that turn lets the detached poll loop run ahead of the caller.
    const flight = this.run(async () => {
      try {
        this.activation = null;
        this.activationSecret = null;
        this.activationStale = false;
        this.chat = null;
        this.step = "idle";
        // The one caller in the app that asks for a pool line.
        const created = await this.deps.api.createActivation(this.deps.deviceName, {
          provisionChat: true,
        });
        this.activationSecret = created.activationSecret;
        this.activation = {
          displayCode: created.displayCode,
          sendTo: created.sendTo,
          smsBody: activationSmsBody(created.displayCode),
          smsUrl: activationSmsUrl(created.sendTo, created.displayCode),
          pollUntil: this.now() + ACTIVATION_POLL_WINDOW_MS,
        };
        this.step = "waiting";
        // Polling starts here, not when the user taps "Open Messages": someone
        // who types the message by hand never taps it.
        this.startPolling(created.activationSecret);
      } finally {
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
   * Abandon whatever is in flight, and forget the code.
   *
   * The claim is optional and repeatable, so this leaves no wreckage to
   * explain: the screen goes back to offering the button. Sign-out calls it —
   * the code belongs to the account that just went away.
   */
  cancel(): ClaimLineState {
    this.cancelPolling();
    this.activation = null;
    this.activationSecret = null;
    this.activationStale = false;
    this.busy = false;
    this.message = "";
    this.step = "idle";
    return this.publish();
  }

  /** Sign-out, which is `cancel` plus the claim's own result: the chat belongs
   * to the account that just went away. */
  signedOut(): ClaimLineState {
    this.chat = null;
    return this.cancel();
  }

  // MARK: the poll

  private startPolling(secret: string): void {
    this.pollGeneration += 1;
    const generation = this.pollGeneration;
    void this.pollClaim(secret, generation).catch((error) => {
      // Nothing below throws by design; if something does, the screen must not
      // be left counting down against a loop that has stopped — and the secret
      // must not outlive its watcher, or "new code" would re-arm a code
      // nothing is polling.
      if (generation !== this.pollGeneration) return;
      this.activationSecret = null;
      this.stall(messageOf(error));
      this.publish();
    });
  }

  private cancelPolling(): void {
    this.pollGeneration += 1;
  }

  private async pollClaim(secret: string, generation: number): Promise<void> {
    while (generation === this.pollGeneration) {
      await this.wait(ACTIVATION_POLL_INTERVAL_MS);
      if (generation !== this.pollGeneration) return;

      let result;
      try {
        result = await this.deps.api.redeemActivation(secret);
      } catch (error) {
        if (generation !== this.pollGeneration) return;
        if (error instanceof PlowApiError && error.kind === "expired") {
          // 410 gates only a code nobody completed — the server honours a
          // completion that raced the deadline — so this is authoritative.
          this.cancelPolling();
          this.activationSecret = null;
          this.stallWithHint("That code expired before your text arrived.");
          this.publish();
          return;
        }
        // A blip must not end the wait. Say what we saw and keep polling.
        this.message = messageOf(error);
        this.publish();
        continue;
      }

      if (result.status === "verified") {
        // The completion is one-shot: this answer carries the only copy of
        // both the chat and the session token, and a second redeem gets
        // neither. So the TOKEN is dealt with even if the claim was abandoned
        // while this call was in flight — leaving it unretired is the one
        // outcome nothing can come back for.
        //
        // What is NOT unconditional is persisting. `activationSecret` is
        // nulled by every path that abandons a claim, sign-out first among
        // them, so it says whether this is still the claim we care about.
        // Writing a chat and a line past a sign-out would name, on the next
        // account's screen, a chat bought by the one that just left.
        const stillOurs = secret === this.activationSecret;
        this.cancelPolling();
        this.activationSecret = null;
        // The token is a throwaway HERE and a live session token on the
        // account: it carries `keys:manage` and `relay:*`. Nothing in this
        // flow needs it — the Mac is already signed in — so it is retired and
        // never stored. Best-effort: the app's only self-revoke route, and a
        // server that refuses it leaves a short-lived session to expire on its
        // own, which beats keeping one.
        if (result.token) await this.deps.api.revokeDeviceCredential(result.token).catch(() => {});
        if (!stillOurs) return;
        // A verified answer with no chat is the one the wrong number produces:
        // the account activates, the pool line is never asked for the code, and
        // nothing was provisioned. Also what an earlier redeem having taken the
        // completion looks like. Either way there is nothing to keep, and the
        // fix is the same — a fresh code.
        if (!result.chat) {
          this.stall(
            "Plow verified that text but didn't hand back a chat. Get a new code and send it to the number shown.",
          );
          this.publish();
          return;
        }
        await this.run(() => this.finishWithChat(result.chat!));
        return;
      }

      if (generation !== this.pollGeneration) return;

      // Pending, and the screen's five minutes are up. Stall the countdown and
      // offer a fresh code — once — but keep watching: the code is live for
      // another twenty-five minutes server-side.
      //
      // This is also what an exhausted pool looks like from here. The server
      // takes the request, texts the owner that every number is in use, and
      // leaves the redeem pending forever — there is no `declined` to read —
      // so the expiry copy has to name that possibility itself.
      if (this.activation && this.now() > this.activation.pollUntil && !this.activationStale) {
        this.stallWithHint("We haven't heard from your phone.");
        this.publish();
      }
    }
  }

  /** The stall message, carrying the two things that actually go wrong: a
   * body that does not start with the exact prefix (answered 200, no SMS,
   * code left live), and a pool with no line left to give. */
  private stallWithHint(reason: string): void {
    this.stall(
      `${reason} Send the message exactly as shown — it has to start with “${ACTIVATION_SMS_PREFIX}”. ` +
        "If Plow texted that every number is in use, remove an agent and try again.",
    );
  }

  private stall(message?: string): void {
    this.activationStale = true;
    if (message !== undefined) this.message = message;
  }

  /**
   * Keep the chat and the line, and nothing else.
   *
   * No credential is minted and `relayCredential` is not read or written: this
   * Mac's sign-in is untouched by claiming a number.
   */
  private async finishWithChat(chat: ActivationChat): Promise<void> {
    const settings: Settings = loadSettings(this.deps.home);
    settings.provisionedChatUid = chat.uid;
    settings.provisionedChatLabel = activationChatLabel(chat);
    // The line this claim was assigned, verbatim. There is no call that answers
    // "which line is mine" — the relationship exists only inside the activation
    // that created it — so it is stored here or it is lost. Pairing no longer
    // writes this field: pairing's `send_to` is the managed phone, not a line
    // anyone can be told to text.
    const sendTo = this.activation?.sendTo?.trim();
    if (sendTo) settings.activationSendTo = sendTo;
    saveSettings(this.deps.home, settings);

    this.chat = { uid: chat.uid, label: activationChatLabel(chat) };
    this.activation = null;
    this.activationStale = false;
    this.step = "idle";
    this.message = "";
    // The chat is a row on the cloud-agent screen, and the screen is already
    // open behind this modal.
    await this.deps.refreshAgents();
  }

  // MARK: plumbing

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private wait(ms: number): Promise<void> {
    if (this.deps.wait) return this.deps.wait(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Run one step with a busy flag, turning any failure into readable text. */
  private async run(body: () => Promise<void>): Promise<ClaimLineState> {
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

  private publish(): ClaimLineState {
    this.deps.onChange?.();
    return this.state();
  }
}

function messageOf(error: unknown): string {
  if (error instanceof PlowApiError) return error.message;
  return "Something went wrong. Try again.";
}
