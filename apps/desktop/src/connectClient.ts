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
import { AgentRosterRow, agentRosterRows } from "./agentRoster.js";
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
  /**
   * What else can reach this Mac's relay, as display rows.
   *
   * `[]` means "nothing to show" and covers both an account with no agents and
   * a roster we have not managed to read — `rosterError` is what tells those
   * apart. Never `null`, so the screen has one shape to render.
   *
   * These rows are the projection from `agentRoster.ts`: id, name, kind, and
   * two timestamps. The token prefix, the raw scopes and the usage counters
   * stop in the main process.
   */
  roster: AgentRosterRow[];
  /** Why the roster is empty, if it is empty because the read failed. Written
   * for a human, and — like every message here — never carries a credential. */
  rosterError: string | null;
  /**
   * Why the last revoke did not happen.
   *
   * Separate from `rosterError` because the two are different sentences about
   * different things: one says the list could not be read, the other says a row
   * the user asked to remove is still there. Collapsing them prints "couldn't
   * load agents" over a list that loaded perfectly well.
   */
  revokeError: string | null;
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
  private roster: AgentRosterRow[] = [];
  private rosterError: string | null = null;
  /** A REVOKE failure only — nothing writes both this and `rosterError`.
   * Cleared by the NEXT revoke attempt and by sign-out, and by nothing else:
   * see `setRoster` for why a list landing must not take it away. */
  private revokeError: string | null = null;
  /** The list in flight, if any. A second *reader* joins it — see `refreshRoster`. */
  private rosterPending: Promise<ConnectClientState> | null = null;
  /**
   * Which list read is the newest. A read that started before a mutation can
   * still be in the air after it, and its answer is a description of the
   * account as it was — so only the latest read is allowed to land.
   */
  private rosterFlights = 0;

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
      revokeError: this.revokeError,
    };
  }

  /**
   * Re-read what can reach this Mac's relay.
   *
   * Read-triggered rather than polled: the main process calls this when the
   * renderer asks for the state, which is exactly tab activation, a mint, a
   * revoke, and the renderer's own retry after a failure — the four moments
   * the list can have changed, and no clock.
   *
   * That only works because it publishes *on change*. A getter that notifies
   * unconditionally is the re-render loop this file warns about elsewhere:
   * publish -> renderer re-reads -> publish. Comparing against what the screen
   * already has breaks it — a steady roster settles after one extra round trip,
   * and a failing one settles on its first error message.
   */
  async refreshRoster(options: { fresh?: boolean } = {}): Promise<ConnectClientState> {
    // Two readers arriving together ask once. A reader after a MUTATION must
    // not: a list that was already in the air when the revoke was sent left
    // Plow before the row went away, so joining it would resolve the revoke
    // with the row it just removed still on screen.
    if (!options.fresh && this.rosterPending) return this.rosterPending;

    const generation = this.generation;
    const settings = this.settings();
    if (!settings.relayCredential.trim()) {
      // Not signed in: there is no authority to ask with, and an empty roster
      // is the honest answer rather than an error the user cannot act on.
      return this.setRoster([], null);
    }

    const flightId = ++this.rosterFlights;
    const flight = (async () => {
      try {
        const keys = await this.deps.api.listApiKeys(settings.relayCredential);
        // Stale in two ways, and both are dropped: a different account now
        // (generation), or a newer read already started, which makes this one
        // a description of the account before the mutation that superseded it.
        if (generation !== this.generation || flightId !== this.rosterFlights) return this.state();
        return this.setRoster(agentRosterRows(keys), null);
      } catch (error) {
        if (generation !== this.generation || flightId !== this.rosterFlights) return this.state();
        // The rows already on screen stay: the connect card above them, and
        // everything else in this state, is untouched by a failed list.
        return this.setRoster(this.roster, messageOf(error));
      } finally {
        // Only if this flight still owns the handle — a fresh read started
        // after it has already taken it, and clearing it here would send the
        // next reader off to ask again instead of joining that one.
        if (flightId === this.rosterFlights) this.rosterPending = null;
      }
    })();
    this.rosterPending = flight;
    return flight;
  }

  /**
   * Revoke one listed credential.
   *
   * Safe by construction: this Mac's own device credential holds `relay:device`
   * and so is never one of these rows — there is no way to revoke the app you
   * are clicking in. The refresh is awaited so the caller's state already
   * reflects the row being gone.
   */
  async revokeCredential(id: number): Promise<ConnectClientState> {
    // The id arrives across the bridge from a sandboxed renderer, and it is
    // pasted straight into a request path. Anything that is not a plain row id
    // is refused here, before `plowApi` is called at all — a float, a negative,
    // a NaN or a string can only be a bug or an attempt at something else, and
    // neither should reach the network.
    if (!isRosterId(id)) return this.failRevoke("That isn't something this Mac can revoke.");
    const generation = this.generation;
    const settings = this.settings();
    if (!settings.relayCredential.trim()) return this.failRevoke("This Mac isn't signed in yet.");
    // And it must be a row the user is actually looking at. Ids are small
    // sequential integers on a shared table, so a renderer that could name any
    // of them could walk the account revoking credentials that were never
    // relay-capable and never listed here — including the portal login. The
    // roster is the whole of what this channel may act on.
    if (!this.roster.some((row) => row.id === id)) {
      return this.failRevoke("That isn't something this Mac can revoke.");
    }

    this.busy = true;
    // The previous attempt's complaint goes. `rosterError` is not this call's
    // to clear — whether the list can be read is a question a revoke does not
    // answer, and the refresh below is what settles it.
    this.revokeError = null;
    this.publish();
    try {
      await this.deps.api.revokeApiKey(settings.relayCredential, id);
    } catch (error) {
      if (generation !== this.generation) return this.state();
      this.busy = false;
      this.revokeError = messageOf(error);
      return this.publish();
    }
    if (generation !== this.generation) return this.state();
    this.busy = false;
    // The revoke is a soft delete server-side; the row stops qualifying only
    // because the refreshed list reports it inactive. So the list is the
    // source of truth here, not a local splice — and it has to be a list read
    // that started AFTER the revoke landed, or it would still contain the row.
    await this.refreshRoster({ fresh: true });
    return this.publish();
  }

  /**
   * Mint a static credential for one client.
   *
   * Authorised with this Mac's **device** credential: `relay:device` may create
   * agents, and it is the only credential the app still holds — the login
   * session was retired server-side the moment it was used.
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
      // The credential goes on screen NOW, before anything else is asked of
      // Plow. This is the one screen in the app whose whole job is to be
      // copied from, it is shown exactly once, and the roster read that
      // follows can take as long as a request takes — holding the mint behind
      // it is a spinner over the thing the user is waiting to read.
      this.publish();
      // The roster gained a row, so it is re-read after. The screen already
      // has what it needs; the new agent arrives in the render this second
      // publish drives.
      if (generation === this.generation) await this.refreshRoster({ fresh: true });
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
    this.credential = null;
    this.message = "";
    this.busy = false;
    // Whatever is still in the air belongs to the old account. Dropping the
    // handle means the next mint starts a flight of its own rather than joining
    // one whose result will be thrown away.
    this.pending = null;
    this.pendingId = 0;
    // The roster belonged to that account too, and the next sign-in may be a
    // different one. The generation check drops whatever that read returns —
    // so the handle has to go with it, or the next account joins a request
    // whose answer is thrown away, and the tab sits falsely empty with no
    // re-read scheduled.
    this.rosterPending = null;
    this.roster = [];
    this.rosterError = null;
    this.revokeError = null;
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

  /** Publish only if the screen would look different — see `refreshRoster`. */
  private setRoster(rows: AgentRosterRow[], error: string | null): ConnectClientState {
    // `revokeError` is deliberately untouched, including when the list comes
    // back clean. Reads here are triggered by the renderer asking for the
    // state, and a failed revoke makes it ask — so clearing on a successful
    // list would wipe the message one round trip after it was written, before
    // anyone had read it. It goes when the user tries again, or signs out.
    const same =
      this.rosterError === error && JSON.stringify(this.roster) === JSON.stringify(rows);
    this.roster = rows;
    this.rosterError = error;
    return same ? this.state() : this.publish();
  }

  /** A revoke failed, or was refused. Never `message`, never `rosterError`. */
  private failRevoke(message: string): ConnectClientState {
    this.revokeError = message;
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

/**
 * A roster row id as Plow issues them: a non-negative safe integer, nothing
 * else. Exported so the IPC handler can refuse a bad one at the bridge rather
 * than one call deeper.
 */
export function isRosterId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0;
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
