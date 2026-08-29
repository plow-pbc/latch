/**
 * Connecting an MCP client — Claude Code, ChatGPT, a headless server.
 *
 * This has moved more than once — the login wizard's last screen, a "Connect a
 * client" tab, a group inside Settings — and now lives in the Agents tab. The
 * lesson of the round trip is that the content is a place, not a step: Agents
 * is what has access to this Mac, and handing something access is one thing you
 * do there, repeatable and optional (a Mac can be signed in and reachable with
 * no client attached at all). This file is its state, and it has been
 * indifferent to where the screen sits through every one of those moves.
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
import { EMPTY_ROSTER, RosterSections, sectionRoster } from "./rosterSections.js";
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
  /**
   * What can reach this account, in the three sections the screen shows.
   *
   * Sectioned here rather than in the renderer because the section decides the
   * removal call — see `rosterSections.ts`.
   */
  roster: RosterSections;
  /** Why the roster is empty, if it is empty because the read failed. Never a
   * credential, like every message here. */
  rosterError: string | null;
  /**
   * Why the last removal did not happen.
   *
   * Separate from `rosterError` because they are different sentences about
   * different things: one says the list could not be read, the other says a row
   * the user asked to remove is still there.
   */
  removeError: string | null;
}

export interface ConnectClientDeps {
  api: PlowApi;
  home: string;
  isConnected: () => boolean;
  /**
   * Remove a cloud agent, through the state that owns its lifecycle.
   *
   * Not the raw client: `CloudAgentState` holds the poll, the row and the local
   * settings for that agent, and a delete that goes around it leaves all three
   * alive — the row comes back on the next render as a disabled zombie the
   * screen cannot remove again.
   */
  removeCloudAgent: (agentId: string) => Promise<void>;
  /**
   * Sign this Mac out, through the one path that owns that.
   *
   * Revoking this Mac's own key only makes the credential invalid on the
   * server. The stored credential, the relay socket and the window gate all
   * stay live, so the app keeps running as though signed in while every call
   * it makes 401s — and the roster promises immediate sign-out.
   */
  signOutThisMac: () => Promise<void>;
  onChange?: () => void;
}

export class ConnectClient {
  private busy = false;
  private message = "";
  /** SECRET while it is set: the only copy of a freshly minted credential.
   * It is in memory, in this field, and on the user's screen — nowhere else. */
  private credential: ClientCredential | null = null;
  /**
   * The mint in flight, if any. Held so a second request joins it rather than
   * starting another — see `createCredential`. `pendingId` says which flight it
   * is, so a finishing mint only clears the handle if it is still its own.
   */
  private pending: Promise<ConnectClientState> | null = null;
  private pendingId = 0;
  private flights = 0;
  /**
   * Bumped by `signedOut`. A mint that was in the air when the account changed
   * belongs to the old one, and its result is dropped rather than shown.
   */
  private generation = 0;
  /** The last roster read that landed. Survives a failed read: a stale list is
   * more use than an empty one, and `rosterError` says it is stale. */
  private roster: RosterSections = EMPTY_ROSTER;
  private rosterError: string | null = null;
  private removeError: string | null = null;
  /**
   * Which roster read is the newest. Bumped per read, not per account.
   *
   * `generation` only moves on sign-out, so two reads in one session share one
   * and neither can tell it has been overtaken. A tab-selection refresh landing
   * after a removal's refresh then restores its own pre-delete snapshot, and a
   * credential the user just revoked is back on screen marked active — a lie
   * about who can reach the account, which is the one thing this list is for.
   */
  private rosterReads = 0;

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
      roster: this.roster,
      rosterError: this.rosterError,
      removeError: this.removeError,
    };
  }

  /**
   * Re-read what can reach this account.
   *
   * Called when the Agents tab comes up and after any removal — the moments the
   * list can have changed. Nothing polls it.
   */
  async refreshRoster(): Promise<ConnectClientState> {
    const settings = this.settings();
    const credential = settings.relayCredential.trim();
    if (!credential) {
      // Not signed in: no authority to ask with, and an empty roster is the
      // honest answer rather than an error nobody can act on.
      this.roster = EMPTY_ROSTER;
      this.rosterError = null;
      return this.publish();
    }

    const generation = this.generation;
    const read = ++this.rosterReads;
    try {
      const keys = await this.deps.api.listApiKeys(credential);
      // A superseded read describes the account as it was. Landing late must
      // never undo a newer answer — least of all by restoring a session the
      // newer one saw revoked.
      if (generation !== this.generation || read !== this.rosterReads) return this.state();
      this.roster = sectionRoster(keys, { deviceCredential: credential });
      this.rosterError = null;
    } catch (error) {
      if (generation !== this.generation || read !== this.rosterReads) return this.state();
      // The rows already on screen stay: a stale list with a banner beats an
      // empty one that reads as "nothing can reach this account".
      this.rosterError = messageOf(error);
    }
    return this.publish();
  }

  /**
   * Remove one roster row, by whichever call its section demands.
   *
   * **A row with an `agent_id` goes to the cloud-agent endpoint and NEVER to
   * the key revoke.** Revoking a cloud agent's key flips `is_active` and
   * nothing else: the VM keeps running, the chat's webhook keeps firing, and
   * the row vanishes from this list because we filter inactive rows — a live
   * agent that 401s on everything and that nobody can reach to remove.
   *
   * **This Mac's own row signs this Mac out** rather than revoking its key.
   * A revoke alone leaves the credential on disk, the socket dialled and the
   * window open, all of them talking to an account that no longer accepts
   * them.
   *
   * Neither route is taken directly here. Both belong to code that owns more
   * state than a key row — the agent's poll and settings, this Mac's session —
   * and going around either leaves that state behind.
   */
  async removeRosterRow(id: number): Promise<ConnectClientState> {
    this.removeError = null;
    const row = [...this.roster.cloud, ...this.roster.mcp, ...this.roster.other].find(
      (candidate) => candidate.id === id,
    );
    if (!row) return this.failRemove("That row is no longer on this screen.");
    const credential = this.settings().relayCredential.trim();
    if (!credential) return this.failRemove("This Mac isn't signed in yet.");

    const generation = this.generation;
    try {
      // Each route belongs to whoever owns that lifecycle. Only an ordinary
      // credential is this file's to revoke directly.
      if (row.isThisMac) await this.deps.signOutThisMac();
      else if (row.agentId !== null) await this.deps.removeCloudAgent(row.agentId);
      else await this.deps.api.revokeApiKey(credential, id);
    } catch (error) {
      if (generation === this.generation) this.failRemove(messageOf(error));
      return this.state();
    }
    if (generation !== this.generation) return this.state();
    return this.refreshRoster();
  }

  private failRemove(message: string): ConnectClientState {
    this.removeError = message;
    return this.publish();
  }

  /**
   * Mint a static credential for one client.
   *
   * Authorised with this Mac's stored credential — the login session itself,
   * which may create agents.
   */
  async createCredential(name: string): Promise<ConnectClientState> {
    // SINGLE-FLIGHT. Every mint is a long-lived credential on the account, and
    // the screen can only ever show one of them — so a second Enter before the
    // busy re-render lands would leave a credential live on the account that
    // nobody ever saw and nobody can revoke by name. Disabling the button is
    // not enough: the renderer disables it a round trip later, which is exactly
    // the window a double-tap or a held Enter key fits through. Joining the
    // flight in progress is the only place this can be closed.
    if (this.pending) return this.pending;

    const trimmed = (name ?? "").trim();
    if (!trimmed) return this.fail("Give this connection a name.");
    const settings = this.settings();
    if (!settings.relayCredential.trim()) return this.fail("This Mac isn't signed in yet.");

    const generation = this.generation;
    const flightId = ++this.flights;
    this.busy = true;
    this.message = "";
    this.publish();
    const flight = (async () => {
      try {
        const minted = await this.deps.api.createAgent(settings.relayCredential, trimmed);
        // A sign-out while this was in the air: the credential belongs to an
        // account this Mac is no longer on, so it is dropped rather than shown.
        // It stays live on that account until revoked there — nothing this app
        // can reach — but it never crosses into the next session.
        if (generation !== this.generation) return this.state();
        this.credential = {
          name: minted.name || trimmed,
          config: agentConfig(settings.mcpUrl, minted.token),
        };
      } catch (error) {
        if (generation === this.generation) this.message = messageOf(error);
      } finally {
        if (generation === this.generation) this.busy = false;
        // Only if this flight still owns the handle: a sign-out mid-flight
        // drops it, and a mint started after that may already own it.
        if (this.pendingId === flightId) {
          this.pending = null;
          this.pendingId = 0;
        }
      }
      return this.publish();
    })();
    this.pending = flight;
    this.pendingId = flightId;
    return flight;
  }

  /**
   * This Mac signed out. Everything here belonged to the account that just
   * went away.
   *
   * A copy-once credential sitting on screen is the whole reason this exists:
   * without it the main process keeps holding one across a sign-out, and the
   * next sign-in — possibly a different account — opens on the previous
   * account's credential. A mint still in flight is invalidated the same way.
   */
  signedOut(): ConnectClientState {
    this.generation += 1;
    this.roster = EMPTY_ROSTER;
    this.rosterError = null;
    this.removeError = null;
    // Nothing in flight belongs to the next account either.
    this.rosterReads += 1;
    this.credential = null;
    this.message = "";
    this.busy = false;
    // Whatever is still in the air belongs to the old account. Dropping the
    // handle means the next mint starts a flight of its own rather than joining
    // one whose result will be thrown away.
    this.pending = null;
    this.pendingId = 0;
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
        plow: {
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
