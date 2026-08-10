/**
 * First-run login: phone number → code → a connected Mac, with no token ever
 * copied out of a browser.
 *
 * This is the whole flow as a plain state machine so it can be tested without
 * Electron and rendered offscreen for screenshots. It holds the OTP session
 * token in a local variable for the seconds it is needed and never anywhere
 * else — see `completeLogin`.
 *
 * **Nothing here puts a credential in a message.** `state()` is what the
 * sandboxed renderer sees; the only token it ever carries is a freshly minted
 * *agent* credential, which exists to be shown to the user exactly once.
 */
import { PlowApi, PlowApiError } from "./plowApi.js";
import { loadSettings, saveSettings, Settings } from "./settings.js";

export type OnboardingStep = "phone" | "code" | "connected" | "agent";

/** Codes are 8 digits with a 5-minute life (`api/plow/auth_routes/otp.py`). */
export const CODE_LENGTH = 8;
export const CODE_TTL_MS = 5 * 60_000;

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
  /** Epoch ms the entered code stops working, so the screen can count down. */
  codeExpiresAt: number | null;
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
  /** Names the device credential in the user's key list. */
  deviceName: string;
  onChange?: () => void;
  now?: () => number;
  /** Diagnostics. Callers must assume anything passed here reaches a log, so
   * nothing secret is ever passed. */
  warn?: (message: string) => void;
}

export class Onboarding {
  private step: OnboardingStep = "phone";
  private phone = "";
  private message = "";
  private busy = false;
  private codeExpiresAt: number | null = null;
  private agent: OnboardingAgent | null = null;

  constructor(private readonly deps: OnboardingDeps) {
    // A Mac that already holds a credential is past this; it opens on the
    // connected screen, which is also where "create an agent" lives.
    if (this.settings().relayCredential.trim()) this.step = "connected";
  }

  state(): OnboardingState {
    const settings = this.settings();
    return {
      step: this.step,
      phone: this.phone,
      message: this.message,
      busy: this.busy,
      codeExpiresAt: this.codeExpiresAt,
      accountUid: settings.accountUid,
      mcpUrl: settings.mcpUrl,
      connected: this.deps.isConnected(),
      agent: this.agent,
    };
  }

  /**
   * Ask Plow to text a code.
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
    return this.run(() => this.completeLogin(trimmed));
  }

  /**
   * Mint an agent credential with the *device* credential — the OTP session is
   * long gone by now, and `relay:device` is allowed to do exactly this.
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

  /** Re-read connection state, for the screen's status line. */
  refresh(): OnboardingState {
    return this.publish();
  }

  /**
   * Verify → learn the account → mint this Mac's credential → connect → throw
   * the OTP session away.
   *
   * `otpToken` never leaves this function. It carries `keys:manage` and
   * `relay:*` — it can mint *any* credential on the account — so the app holds
   * it for the seconds it needs and not one call longer.
   */
  private async completeLogin(code: string): Promise<void> {
    let otpToken: string;
    try {
      otpToken = await this.deps.api.verifyOtp(this.phone, code);
    } catch (error) {
      if (error instanceof PlowApiError && error.kind === "unauthorized") {
        throw new PlowApiError("unauthorized", "That code didn't work. Check it, or send a new one.", 401);
      }
      throw error;
    }

    const info = await this.deps.api.relayInfo(otpToken);
    const minted = await this.deps.api.mintDeviceCredential(otpToken, this.deps.deviceName);

    // Written 0600 by saveSettings. This is the only copy of the credential and
    // it is never handed to the renderer.
    const settings = this.settings();
    settings.relayCredential = minted.token;
    settings.accountUid = info.uid;
    settings.mcpUrl = info.mcpUrl;
    this.save(settings);

    await this.deps.startRelay();
    await this.discardOtpSession(otpToken, minted.keyPrefix);

    this.step = "connected";
    this.codeExpiresAt = null;
    this.message = "";
  }

  /**
   * Revoke the session `verify` just created. Every verify mints a new row
   * named "Account Portal" and nothing supersedes the previous one, so without
   * this the user's key list grows one entry per login — each of them able to
   * mint any credential on the account.
   *
   * Best effort by necessity: `DELETE /v1/api-keys/{id}` needs `keys:manage`,
   * which the device credential deliberately does not hold, and refuses to
   * revoke the caller's own session. See the report accompanying this chunk.
   */
  private async discardOtpSession(otpToken: string, deviceKeyPrefix: string): Promise<void> {
    try {
      const prefix = otpToken.slice(5, 13); // `plow_` + the 8 chars keys are indexed by
      const keys = await this.deps.api.listKeys(otpToken);
      const mine = keys.find((k) => k.keyPrefix === prefix && k.keyPrefix !== deviceKeyPrefix);
      if (!mine) {
        this.deps.warn?.("login session not found in the key list; leaving it alone");
        return;
      }
      await this.deps.api.revokeKey(otpToken, mine.id);
    } catch (error) {
      // Never fatal: the Mac is connected and working, and the message carries
      // no token — PlowApiError messages are written, not echoed.
      this.deps.warn?.(`could not revoke the login session: ${messageOf(error)}`);
    }
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
