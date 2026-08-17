/**
 * Connecting an MCP client — Claude Code, ChatGPT, a headless server.
 *
 * This used to be the last screen of the login wizard, which was the wrong
 * home for it: logging in happens once per Mac, connecting a client happens
 * once per *client*, is repeatable, and is optional — a Mac can be signed in
 * and reachable with no client attached at all. So it lives in the main
 * window now, and this is its state.
 *
 * The recommended route needs nothing from this file: the MCP URL is enough,
 * and the client walks the user through OAuth on first connect. What is here
 * is the fallback for a client that cannot do OAuth — mint one long-lived
 * credential, show it **once**, and forget it.
 *
 * Pure and Electron-free, like `onboarding.ts`, for the same reason: it is the
 * part with states worth testing, and a state machine that can only be reached
 * by launching a window is one nobody tests.
 */
import { PlowApi, PlowApiError } from "./plowApi.js";
import { loadSettings, Settings } from "./settings.js";

export interface ClientCredential {
  /** What the user called this connection. Display only. */
  name: string;
  /**
   * A ready-to-paste MCP client config, with the credential inside it.
   *
   * The token is not a separate field. It has exactly one job — being pasted
   * into a client — and the config is the pasteable form, so a second copy of
   * it in the state would be one more place for it to be read from and one
   * more place to forget to clear.
   */
  config: string;
}

export interface ConnectClientState {
  /** Where agents POST. From the server via `/v1/relay/info`, never built here. */
  mcpUrl: string;
  accountUid: string;
  /** Whether the device socket is up right now. */
  connected: boolean;
  /** Whether this Mac is signed in at all. NEVER the credential itself. */
  hasCredential: boolean;
  busy: boolean;
  /** One honest line: what happened, or nothing. Never a bare spinner. */
  message: string;
  /** The shown-once credential, present only between minting and dismissal. */
  credential: ClientCredential | null;
}

export interface ConnectClientDeps {
  api: PlowApi;
  home: string;
  isConnected: () => boolean;
  onChange?: () => void;
}

export class ConnectClient {
  private busy = false;
  private message = "";
  /** SECRET while it is set: the only copy of a freshly minted credential.
   * It is in memory, in this field, and on the user's screen — nowhere else. */
  private credential: ClientCredential | null = null;

  constructor(private readonly deps: ConnectClientDeps) {}

  state(): ConnectClientState {
    const settings = this.settings();
    return {
      mcpUrl: settings.mcpUrl,
      accountUid: settings.accountUid,
      connected: this.deps.isConnected(),
      hasCredential: settings.relayCredential.trim().length > 0,
      busy: this.busy,
      message: this.message,
      credential: this.credential,
    };
  }

  /**
   * Mint a static credential for one client.
   *
   * Authorised with this Mac's **device** credential: `relay:device` may create
   * agents, and it is the only credential the app still holds — the login
   * session was retired server-side the moment it was used.
   */
  async createCredential(name: string): Promise<ConnectClientState> {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return this.fail("Give this connection a name.");
    const settings = this.settings();
    if (!settings.relayCredential.trim()) return this.fail("This Mac isn't signed in yet.");

    this.busy = true;
    this.message = "";
    this.publish();
    try {
      const minted = await this.deps.api.createAgent(settings.relayCredential, trimmed);
      this.credential = {
        name: minted.name || trimmed,
        config: agentConfig(settings.mcpUrl, minted.token),
      };
    } catch (error) {
      this.message = messageOf(error);
    } finally {
      this.busy = false;
    }
    return this.publish();
  }

  /**
   * "I've saved it." The app drops its only copy — it was never written down,
   * and the server will not hand it back, so this really is the last of it.
   */
  dismissCredential(): ConnectClientState {
    this.credential = null;
    this.message = "";
    return this.publish();
  }

  private settings(): Settings {
    return loadSettings(this.deps.home);
  }

  private fail(message: string): ConnectClientState {
    this.message = message;
    return this.publish();
  }

  private publish(): ConnectClientState {
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
  // PlowApiError messages are written for a human and carry no secret; see
  // plowApi.ts. Anything else is ours and unexpected.
  if (error instanceof PlowApiError) return error.message;
  return "Something went wrong. Try again.";
}
