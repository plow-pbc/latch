/**
 * Claiming a Plow number: the second flow beside pairing.
 *
 * Pairing a Mac mints a device credential and deliberately spends no pool line
 * (`createActivation` omits `provision_chat`). Claiming a line is the separate,
 * explicit step that does ask for one — from the cloud-agents modal, on an
 * already-signed-in Mac, when the owner wants a number to text.
 *
 * The lifecycle is `activation.ts`'s: one mint under a single flight, one poll,
 * one set of race rules. What is HERE is the terminal policy — what a verified
 * answer means to a claim:
 *   - keep the chat and the line it hands back;
 *   - **mint nothing, and never touch `relayCredential`.** The Mac is already
 *     signed in; a second device credential would be a live, spend-capable key
 *     nobody asked for. The redeem's session token is a throwaway, retired
 *     best-effort and never persisted.
 *
 * **Nothing here puts a credential in a message.** `state()` is what the
 * sandboxed renderer sees, and the only secret it carries is the one the user
 * is meant to read: the activation display code.
 */
import {
  Activation,
  ActivationChatView,
  ActivationView,
  activationChatLabel,
  ACTIVATION_SMS_PREFIX,
  FINISHED,
  stallWith,
  Terminal,
  VerifiedRedeem,
} from "./activation.js";
import { PlowApi } from "./plowApi.js";
import { loadSettings, saveSettings } from "./settings.js";

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
  activation: ActivationView | null;
  /** We have stopped watching. The screen offers a fresh code. */
  activationStale: boolean;
  /** The chat this claim provisioned, once it has. Display data only. */
  chat: ActivationChatView | null;
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
  private chat: ActivationChatView | null = null;
  private readonly activation: Activation;

  constructor(private readonly deps: ClaimLineDeps) {
    this.activation = new Activation({
      api: deps.api,
      deviceName: deps.deviceName,
      // The one caller in the app that asks for a pool line.
      provisionChat: true,
      now: () => (deps.now ? deps.now() : Date.now()),
      wait: (ms) => (deps.wait ? deps.wait(ms) : new Promise((r) => setTimeout(r, ms))),
      publish: () => deps.onChange?.(),
      onReset: () => {
        this.chat = null;
        this.step = "idle";
      },
      onMinted: () => {
        this.step = "waiting";
      },
      onVerified: (result, stillOurs) => this.verified(result, stillOurs),
      hint: (reason) =>
        // The two things that actually go wrong: a body that does not start
        // with the exact prefix (answered 200, no SMS, code left live), and a
        // pool with no line left to give. An exhausted pool has no `declined`
        // to read — the server texts the owner and leaves the redeem pending
        // forever — so this copy is the only place that can name it.
        `${reason} Send the message exactly as shown — it has to start with “${ACTIVATION_SMS_PREFIX}”. ` +
        "If Plow texted that every number is in use, remove an agent and try again.",
      expiredReason: "That code expired before your text arrived.",
    });
  }

  state(): ClaimLineState {
    return { step: this.step, ...this.activation.view(), chat: this.chat };
  }

  /** Start a claim, or hand back the one already on screen. */
  begin(): Promise<ClaimLineState> {
    return this.activation.begin(() => this.state());
  }

  /** A fresh code — or the same one back on the clock, which is `begin`'s job
   * to tell apart. */
  async newCode(): Promise<ClaimLineState> {
    return this.begin();
  }

  /**
   * Abandon whatever is in flight, and forget the code.
   *
   * The claim is optional and repeatable, so this leaves no wreckage to
   * explain: the screen goes back to offering the button.
   */
  cancel(): ClaimLineState {
    this.activation.abandon();
    this.step = "idle";
    this.deps.onChange?.();
    return this.state();
  }

  /** Sign-out, which is `cancel` plus the claim's own result: the chat belongs
   * to the account that just went away. */
  signedOut(): ClaimLineState {
    this.chat = null;
    return this.cancel();
  }

  /**
   * Keep the chat and the line, and nothing else.
   *
   * No credential is minted and `relayCredential` is not read or written: this
   * Mac's sign-in is untouched by claiming a number.
   */
  private async verified(result: VerifiedRedeem, stillOurs: boolean): Promise<Terminal> {
    const epoch = this.activation.epoch();
    // The token is a throwaway HERE and a live session token on the account:
    // it carries `keys:manage` and `relay:*`. Nothing in this flow needs it —
    // the Mac is already signed in — so it is retired and never stored.
    // `POST /v1/relay/devices/self/revoke` accepts it: its guard is
    // `relay:device`, and a session's `relay:*` satisfies that wildcard. It is
    // the only self-retirement route the API has — `DELETE /api-keys/{id}`
    // refuses the calling session — and stays best-effort because a Mac that
    // cannot reach Plow must still finish the claim.
    if (result.token) await this.deps.api.revokeDeviceCredential(result.token).catch(() => {});
    // Re-checked AFTER the revoke, not only before it: the revoke is an await
    // a sign-out can land in, and writing past one would name, on the next
    // account's screen, a chat bought by the one that just left.
    if (!stillOurs || this.activation.abandonedSince(epoch)) return FINISHED;
    // Nothing usable came back, in either shape it takes: no chat (texted to
    // the wrong number, so the account activated and the assigned line never
    // saw it), or no token (an earlier redeem took the one-shot completion and
    // this is its echo). A claim needs both; the fix for either is a new code.
    if (!result.chat || !result.token) {
      return stallWith(
        "Plow verified that text but didn't hand back a new chat. Get a new code and send it to the number shown.",
      );
    }

    const chat = result.chat;
    const sendTo = this.activation.view().activation?.sendTo?.trim();
    await this.activation.run(async () => {
      const settings = loadSettings(this.deps.home);
      settings.provisionedChatUid = chat.uid;
      settings.provisionedChatLabel = activationChatLabel(chat);
      // The line this claim was assigned, verbatim. No call answers "which
      // line is mine" — the relationship exists only inside the activation
      // that created it — so it is stored here or it is lost. Pairing does not
      // write this: pairing's `send_to` is the managed phone, not a line
      // anyone can be told to text.
      if (sendTo) settings.activationSendTo = sendTo;
      saveSettings(this.deps.home, settings);

      this.chat = { uid: chat.uid, label: activationChatLabel(chat) };
      this.step = "idle";
      this.activation.settled();
      // The chat is a row on the cloud-agent screen, already open behind this
      // modal. Last, and after every write above: a sign-out landing in this
      // await has a fully-written claim behind it.
      await this.deps.refreshAgents();
    });
    return FINISHED;
  }
}
