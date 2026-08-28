/**
 * One activation, from minted code to spent answer — the lifecycle both flows
 * that use `/v1/auth/activate` are built on.
 *
 * There are two: **pairing** a Mac (`onboarding.ts`), which asks for no chat
 * and ends in a device credential, and **claiming** a Plow number
 * (`claimLine.ts`), which asks for a pool line and ends in a chat. They were
 * two copies of the same machine with two sets of race rules, which is one set
 * too many: a fix to the mint's single flight, or to what happens when a
 * sign-out lands mid-await, had to be made twice and was once made only once.
 *
 * What lives here is everything neither flow gets to have an opinion about:
 * minting under a single flight, polling on the server's clock, the 410, the
 * countdown stall, and the epochs that make an abandoned activation write
 * nothing. What each flow keeps is its TERMINAL POLICY — what a verified
 * answer means and what to do with it — injected as `onVerified`.
 *
 * **Nothing here puts a credential in a message.** `view()` is what a screen
 * is shown, and the only secret in it is the one the user is meant to read:
 * the display code. The activation *secret* never leaves this file.
 */
import { ActivationChat, ActivationRedeem, PlowApi, PlowApiError } from "./plowApi.js";

/** The half of a redeem a terminal policy is ever handed: the completion. */
export type VerifiedRedeem = Extract<ActivationRedeem, { status: "verified" }>;

/** Codes are 8 digits with a 5-minute life (`api/plow/auth_routes/otp.py`). */
export const CODE_LENGTH = 8;
export const CODE_TTL_MS = 5 * 60_000;

/**
 * How long a screen counts down before it stalls and offers a fresh code.
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
 * silence on both channels. That is why a screen shows the exact body to send
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

/** The live code, as a screen shows it. No secret: see the file header. */
export interface ActivationView {
  /** Shown large. A credential in its own right — whoever texts it gets what
   * the activation was for, and the server cannot tell them apart. */
  displayCode: string;
  /**
   * Where the endpoint said to text it. Never a number chosen here: it is the
   * managed phone for a pairing and the assigned pool line for a claim, and
   * only the server knows which.
   */
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
 * A chat as a screen says it: a chat has no title, so the label is its line
 * number and its members' handles. `uid` is what everything else joins on.
 */
export interface ActivationChatView {
  uid: string;
  label: string;
}

/**
 * How a human recognises a chat that has no name: the number it runs on, then
 * each member's real handle in the API's owner-first order. The first number
 * is the agent participant's line — never the chat's own `provider_key`, which
 * is the provider's thread id and would put "chat_5" where the user is looking
 * for something to text.
 *
 * Both halves are optional in the data, so this never returns an empty string:
 * a chat with neither is still identified by its uid, which is ugly but true.
 */
export function activationChatLabel(chat: ActivationChat): string {
  const line = (chat.line ?? "").trim();
  const handles = chat.participants
    .map((participant) => (participant.providerKey ?? "").trim())
    .filter((handle) => handle && handle !== line);
  const parts = [line, ...handles].filter(Boolean);
  return parts.length ? parts.join(", ") : chat.uid;
}

/**
 * The numbers a message to this chat would go to.
 *
 * Structured, and separate from the label, because they are two different
 * jobs: the label is prose for a human to recognise a chat by, and these are
 * addresses. Scraping the one for the other is how a label with no digits — a
 * bare uid from the fallback — produced an empty recipient list, and how an
 * upgraded home's `"<line> · <display name>"` produced an incomplete one.
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

/** What a flow decides a verified answer means: finished, or stall and say so. */
export type Terminal = { done: true } | { done: false; message: string };

export const FINISHED: Terminal = { done: true };
export const stallWith = (message: string): Terminal => ({ done: false, message });

export interface ActivationHost {
  api: Pick<PlowApi, "createActivation" | "redeemActivation">;
  /** Names the activation in the owner's account. */
  deviceName: string;
  /**
   * Whether to ask for a chat — the ONE request difference between the flows.
   * It assigns one of the account's few pool lines, so pairing says false and
   * claiming says true. See `PlowApi.createActivation`.
   */
  provisionChat: boolean;
  now(): number;
  wait(ms: number): Promise<void>;
  /** Tell the screen something changed. */
  publish(): void;
  /** Clear whatever the host shows beside the code, before a fresh mint. */
  onReset?(): void;
  /** A code is on screen; the host may move its own step. */
  onMinted?(): void;
  /** The watch has stopped. The host may move to a screen that can do
   * something about it — the control that mints a fresh code lives on one
   * screen, and a user who never tapped "Open Messages" is not on it. */
  onStall?(): void;
  /**
   * The one-shot completion, and the only thing the two flows disagree about.
   *
   * Called at most once per activation, with the watch already stopped and the
   * secret already dropped — so a policy that throws or takes a long time
   * cannot leave a second redeemer running. `stillOurs` is false when the
   * activation was abandoned while this answer was in flight; the answer is
   * handed over anyway, because it carries the only copy of what it carries
   * and dropping it silently would strand something already spent.
   */
  onVerified(result: VerifiedRedeem, stillOurs: boolean): Promise<Terminal>;
  /** The flow's own wording around a stall. */
  hint(reason: string): string;
  /** What the server's 410 is called on this screen. */
  expiredReason: string;
}

export class Activation {
  private view_: ActivationView | null = null;
  private stale = false;
  private busy = false;
  private message = "";
  /** SECRET. Held for the life of one activation and nowhere else — never in
   * a view, never on disk, never in a log line. */
  private secret: string | null = null;
  /** Bumped whenever an activation stops being the one we care about. A poll
   * loop whose generation is stale returns instead of writing state. */
  private generation = 0;
  /**
   * Bumped ONLY by `abandon` and never by this class's own bookkeeping, which
   * is what separates it from `generation`.
   *
   * Every await is a window a sign-out can land in, and the continuation on
   * the far side runs against state the sign-out has already cleared. The rule
   * is: capture this before an await, re-check after, write nothing if it
   * moved. `generation` cannot serve — the verified path bumps it itself, so
   * "did it change" would stop meaning "was this abandoned".
   */
  private abandons = 0;
  /** The mint in flight, so a second request joins it rather than burning a
   * second code. `flightId` says which flight it is. */
  private flight: Promise<unknown> | null = null;
  private flightId = 0;
  /**
   * The abandonment epoch the in-flight mint belongs to.
   *
   * A flight from before an `abandon` is not one a later caller may join: its
   * own continuation refuses to write anything (it checks the same epoch), so
   * joining it returns a snapshot with no code in it and mints nothing — the
   * owner clicks, and the screen sits empty. A request made after abandonment
   * gets a replacement instead.
   */
  private flightEpoch = 0;
  private mints = 0;

  constructor(private readonly host: ActivationHost) {}

  /**
   * The slice of a screen's state this owns, in the shape both flows already
   * publish. One reader rather than four accessors: every host spreads it
   * whole, and a field only this class writes has no business having a getter
   * of its own.
   */
  view(): { activation: ActivationView | null; activationStale: boolean; busy: boolean; message: string } {
    return {
      activation: this.view_,
      activationStale: this.stale,
      busy: this.busy,
      message: this.message,
    };
  }

  /** Say something without changing anything else — a screen's own copy. */
  setMessage(message: string): void {
    this.message = message;
  }

  /** The epoch to check an await against. */
  epoch(): number {
    return this.abandons;
  }

  abandonedSince(epoch: number): boolean {
    return this.abandons !== epoch;
  }

  /**
   * Mint a code, or put the one already on screen back on the clock.
   *
   * SINGLE-FLIGHT, and the check a caller cannot make for itself: `view` is
   * not set until the API answers, so two callers racing a slow
   * `/v1/auth/activate` both sail past "is there a code already?" and mint
   * two. A display code IS a credential, so the second — which no screen can
   * show — is one loose on the account.
   *
   * While a code is live its poll loop is the ONLY redeemer, and this puts the
   * same code back on the clock rather than redeeming: a redeem racing the
   * poll's own splits the one-shot completion, and whichever way the responses
   * land, what the activation was for is lost.
   */
  async begin<T>(snapshot: () => T): Promise<T> {
    // `snapshot` is taken HERE rather than by the caller after awaiting,
    // because the poll loop this starts runs detached: an extra turn on the
    // caller's side is one the loop can spend receiving an answer, and the
    // caller then reports a state one event newer than the action it just
    // performed. Under a test clock that gap is a whole poll.
    if (this.flight && this.flightEpoch === this.abandons) {
      await this.flight;
      return snapshot();
    }

    if (this.secret && this.view_) {
      this.view_ = { ...this.view_, pollUntil: this.host.now() + ACTIVATION_POLL_WINDOW_MS };
      this.stale = false;
      this.message =
        "That code still works — send it exactly as shown and this screen will move on by itself.";
      this.host.publish();
      return snapshot();
    }

    this.cancelPolling();
    const id = ++this.mints;
    // The handle is dropped inside the body rather than by chaining `.finally`:
    // a chained one adds a turn before the caller resumes, and `wait` is
    // injectable — under a test clock that extra turn lets the detached poll
    // loop run ahead of the caller.
    const flight: Promise<T> = this.run(async () => {
      try {
        const abandonedAt = this.abandons;
        this.view_ = null;
        this.secret = null;
        this.stale = false;
        this.host.onReset?.();
        const created = await this.host.api.createActivation(this.host.deviceName, {
          provisionChat: this.host.provisionChat,
        });
        // A sign-out landing inside that call must STAY signed out. Without
        // this the continuation puts the code back on screen and starts
        // polling it — an activation the owner had just cancelled, running
        // against the account they had just left. The code is already minted
        // server-side and nothing un-mints one; leaving it unwatched is all
        // this side can do, and it completes nothing here.
        if (this.abandons !== abandonedAt) return;
        this.secret = created.activationSecret;
        this.view_ = {
          displayCode: created.displayCode,
          sendTo: created.sendTo,
          smsBody: activationSmsBody(created.displayCode),
          smsUrl: activationSmsUrl(created.sendTo, created.displayCode),
          pollUntil: this.host.now() + ACTIVATION_POLL_WINDOW_MS,
        };
        this.host.onMinted?.();
        // Polling starts here, not when the user taps "Open Messages": someone
        // who types the message by hand never taps it, and must still get in.
        this.startPolling(created.activationSecret);
      } finally {
        // Only if this flight still owns the handle: nothing else clears it,
        // but a later mint may already own it by the time this one lands.
        if (this.flightId === id) {
          this.flight = null;
          this.flightId = 0;
        }
      }
    }, snapshot) as Promise<T>;
    this.flight = flight;
    this.flightId = id;
    this.flightEpoch = this.abandons;
    // Returned, not awaited: an extra hop here is the gap `run` describes.
    return flight;
  }

  /**
   * Stop caring about this activation: no code, no watcher, no writes from
   * anything already in flight for it.
   */
  abandon(): void {
    this.abandons += 1;
    this.cancelPolling();
    this.view_ = null;
    this.secret = null;
    this.stale = false;
    this.busy = false;
    this.message = "";
  }

  /** Mark the activation as no longer watched, optionally saying why. */
  stall(message?: string): void {
    this.stale = true;
    if (message !== undefined) this.message = message;
    this.host.onStall?.();
  }

  /** Clear the stall without minting — a flow that finished on its own terms. */
  settled(): void {
    this.view_ = null;
    this.stale = false;
    this.message = "";
  }

  /**
   * Run one step with a busy flag, turning any failure into readable text.
   *
   * `snapshot` is taken HERE, and the position is load-bearing at both ends.
   * After the `finally`, so the state handed back says `busy: false` like the
   * step that just finished — a snapshot taken inside the body is taken while
   * the flag is still set, and a renderer that disables its buttons on `busy`
   * (`renderer/onboarding.js`) then paints the first-run screen with every
   * control dead. And inside this function rather than by an awaiting caller,
   * because the poll loop a step starts is detached: an extra turn on the
   * caller's side is one the loop can spend receiving an answer, so the state
   * would come back one event newer than the action that asked for it.
   */
  async run<T>(body: () => Promise<void>, snapshot?: () => T): Promise<T | undefined> {
    this.busy = true;
    this.message = "";
    this.host.publish();
    try {
      await body();
    } catch (error) {
      this.message = messageOf(error);
    } finally {
      this.busy = false;
    }
    this.host.publish();
    return snapshot?.();
  }

  private cancelPolling(): void {
    this.generation += 1;
  }

  private startPolling(secret: string): void {
    this.generation += 1;
    const generation = this.generation;
    void this.poll(secret, generation).catch((error) => {
      // Nothing below throws by design; if something does, the screen must not
      // be left on a countdown that no longer runs — and the secret must not
      // outlive its watcher, or a fresh-code request would re-arm a code
      // nothing is polling. Dropping it keeps the invariant: secret ⇒ loop.
      if (generation !== this.generation) return;
      this.secret = null;
      this.stall(messageOf(error));
      this.host.publish();
    });
  }

  private async poll(secret: string, generation: number): Promise<void> {
    while (generation === this.generation) {
      await this.host.wait(ACTIVATION_POLL_INTERVAL_MS);
      if (generation !== this.generation) return;

      let result: ActivationRedeem;
      try {
        result = await this.host.api.redeemActivation(secret);
      } catch (error) {
        if (generation !== this.generation) return;
        if (error instanceof PlowApiError && error.kind === "expired") {
          // 410 gates only a code nobody completed — the server honours a
          // completion that raced the deadline — so this is authoritative, and
          // once expired the webhook refuses its text. Dropping the secret is
          // what lets a fresh-code request mint.
          this.cancelPolling();
          this.secret = null;
          this.stall(this.host.hint(this.host.expiredReason));
          this.host.publish();
          return;
        }
        // A blip must not end the wait. Say what we saw and keep polling.
        this.message = messageOf(error);
        this.host.publish();
        continue;
      }

      if (result.status === "verified") {
        // Acted on even if this loop was cancelled while the call was in
        // flight: the server hands the completion to the FIRST redeem that
        // sees it and omits it ever after, so dropping this answer would
        // strand an activation the user actually completed.
        //
        // But acting on it must not touch a REPLACEMENT. `mine` is whether
        // this loop is still the current watcher; when it is not, a code the
        // owner has since asked for is on screen with its own loop running,
        // and cancelling polling, dropping `secret` or stalling here would
        // kill that one on behalf of an activation nobody is waiting for.
        // The policy still hears about the answer — with `stillOurs` false, so
        // it persists nothing — because the token in it is real and needs
        // retiring.
        const mine = generation === this.generation;
        const stillOurs = mine && secret === this.secret;
        if (mine) {
          this.cancelPolling();
          this.secret = null;
          // Stalled BEFORE the handoff, whose own network calls can fail: a
          // failure then leaves a screen that mints fresh on "Try Again", not
          // one re-arming a code nothing can complete. A policy that finishes
          // clears it with `settled`.
          this.stall();
        }
        const outcome = await this.host.onVerified(result, stillOurs);
        if (!outcome.done && mine) {
          this.stall(outcome.message);
          this.host.publish();
        }
        return;
      }

      if (generation !== this.generation) return;

      // Pending, and the screen's five minutes are up: stall the countdown and
      // offer a fresh code — once — but keep watching. The code is live for
      // another twenty-five minutes and its completion is handed to the first
      // redeem only, so a loop that stopped here stranded a text at minute
      // fifteen: completed server-side, and nobody ever came for it.
      if (this.view_ && this.host.now() > this.view_.pollUntil && !this.stale) {
        this.stall(this.host.hint("We haven't heard from your phone."));
        this.host.publish();
      }
    }
  }
}

export function messageOf(error: unknown): string {
  if (error instanceof PlowApiError) return error.message;
  // Anything else is ours and unexpected; say so rather than showing a stack.
  return "Something went wrong. Try again.";
}
