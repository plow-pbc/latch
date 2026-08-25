/**
 * Cloud-agent state for the main window: what the Agents tab knows about the
 * agents living in the account's chats, and the four things it can do to them.
 *
 * Two rules shape everything here.
 *
 * **All polling is in the main process.** Provisioning takes a minute or two;
 * the renderer never learns that by asking repeatedly. It reads one shape,
 * re-reads it when told the state changed, and the poll loop that drives a
 * receipt to `active` runs here — a create IPC call returns as soon as Plow has
 * issued the receipt, never when the machine is up.
 *
 * **Nothing credential-shaped crosses into the renderer.** The device
 * credential is read from settings per call and never stored on this object,
 * and every agent is reduced to a `CloudAgentDisplayRow` — which has no
 * `session_id` and no provider URL — before it can be marshalled.
 *
 * Electron-free on purpose, like `connectClient.ts`: a state machine that can
 * only be reached by launching a window is one nobody tests.
 */
import {
  CloudAgentDisplayRow,
  toCloudAgentDisplayRow,
} from "./cloudAgentMapper.js";
import { CloudAgentResource, CreateCloudAgentRequest } from "./cloudAgents.js";
import { activationChatLabel } from "./onboarding.js";
import {
  ApiBaseUrl,
  FetchLike,
  PlowApiError,
  REQUEST_TIMEOUT_MS,
  normalizeApiBaseUrl,
  parseActivationChat,
} from "./plowApi.js";
import { CloudAgentLocalSettings, loadSettings, saveSettings } from "./settings.js";

/**
 * The feature flag. Tier-3 endpoints are in flight, not deployed, so the whole
 * group is **off** unless a developer turns it on for this run — there is no
 * user-facing setting to leave in the wrong position when the API lands.
 */
export const CLOUD_AGENTS_ENV = "DOMO_CLOUD_AGENTS";

export function resolveCloudAgentsEnabled(env: Record<string, string | undefined>): boolean {
  const raw = ((env ?? {})[CLOUD_AGENTS_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/**
 * Does landing on this tab put the cloud group on screen?
 *
 * The renderer reaches the Agents tab two ways — a click, which persists the
 * tab, and boot, which restores it — and both have to refresh. Kept here rather
 * than written twice in `main.ts`, because "agents" is not the only answer:
 * `"connect"` is the tab's old key, still in older homes, and a home stored on
 * it lands on Agents.
 */
export function tabShowsCloudAgents(tab: string): boolean {
  return tab === "agents" || tab === "connect";
}

/** One pickable chat. Display data — the same shape setup already shows. */
export interface CloudChatOption {
  uid: string;
  label: string;
}

/**
 * Everything the Agents tab renders about cloud agents, in one shape.
 *
 * The three error fields are deliberately separate: the agent list and chat
 * list are independent requests, while an action failure says the thing the
 * user just clicked did not happen. Collapsing either pair can hide the chat
 * failure that makes setup unavailable or mislabel a background refresh.
 */
export interface CloudAgentsUiState {
  cloudEnabled: boolean;
  cloudAgents: CloudAgentDisplayRow[];
  /** An agent-list failure, and nothing else. */
  cloudAgentsError: string | null;
  /** A chat-list failure, and nothing else. */
  cloudChatsError: string | null;
  /** A create/delete/retry failure, and nothing else. */
  cloudActionError: string | null;
  cloudChats: CloudChatOption[];
  /**
   * A chat-list attempt SUCCEEDED — even if it returned nothing.
   *
   * The distinction is the whole field: `cloudChats: []` alone cannot tell
   * "this account has no chats" from "we could not ask", and the two want
   * opposite screens. Only the first may be answered with the empty state and
   * its re-activate prompt; the second keeps the roster and shows the error.
   */
  cloudChatsLoaded: boolean;
  /**
   * The number to text, from this Mac's activation — the server's `send_to`,
   * never one the app chose. `null` on a Mac that activated before it was kept,
   * and the empty state falls back to re-activate copy.
   */
  cloudSendTo: string | null;
  /**
   * Local per-agent settings, keyed on the same `agent_id` as the rows. Not
   * part of a row because it is ours, not Plow's: a row is server truth.
   */
  cloudAgentSettings: Record<string, CloudAgentLocalSettings>;
}

/** The slice of `CloudAgentsClient` this state needs. */
export interface CloudAgentsApi {
  create(deviceCredential: string, request: CreateCloudAgentRequest): Promise<CloudAgentResource>;
  list(deviceCredential: string): Promise<CloudAgentResource[]>;
  delete(deviceCredential: string, agentId: string): Promise<void>;
  /**
   * The `signal` is how a provision in flight is called off — a sign-out, or a
   * delete of the very agent being polled. A client that does not take one yet
   * simply ignores the extra argument; this side is the one that has to hold
   * the handle, because it is the side that knows when the poll is pointless.
   */
  poll(
    deviceCredential: string,
    receipt: CloudAgentResource,
    onTransition?: (agent: CloudAgentResource) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<CloudAgentResource>;
}

export interface CloudChatsApi {
  list(deviceCredential: string): Promise<CloudChatOption[]>;
}

export interface CloudAgentStateDeps {
  agents: CloudAgentsApi;
  chats: CloudChatsApi;
  home: string;
  /** The feature flag, read once at construction. */
  enabled: boolean;
  onChange?: () => void;
}

const EMPTY_STATE: CloudAgentsUiState = Object.freeze({
  cloudEnabled: false,
  cloudAgents: [],
  cloudAgentsError: null,
  cloudChatsError: null,
  cloudActionError: null,
  cloudChats: [],
  cloudChatsLoaded: false,
  cloudSendTo: null,
  cloudAgentSettings: {},
});

export class CloudAgentState {
  /** Keyed on `agent_id`, which is stable for the agent's whole life. */
  private rows = new Map<string, CloudAgentDisplayRow>();
  /** Agents this process is still polling, so a list that has not caught up
   * with a fresh create cannot make its row disappear again. */
  private pending = new Set<string>();
  /**
   * One abort handle per poll in flight, keyed the same way.
   *
   * A poll runs for as long as provisioning takes, so the two events that make
   * it pointless — the agent being deleted, and this Mac signing out — have to
   * be able to reach it. Without this, deleting a provisioning agent leaves a
   * loop asking Plow about a machine that is gone until it answers `failed`.
   */
  private polls = new Map<string, AbortController>();
  private agentsError: string | null = null;
  /**
   * Held apart from `agentsError` deliberately.
   *
   * The two requests run concurrently and used to share one field, so a chat
   * failure that wrote it could be cleared by an agent list that succeeded a
   * moment later — leaving `cloudChatsLoaded: false` with no error beside it,
   * which is precisely the "you have no chats" reading this exists to prevent.
   * Written only where `chatsLoaded` is written, so the pair can never
   * disagree; `state()` is what merges them for the screen.
   */
  private chatsError: string | null = null;
  private actionError: string | null = null;
  private chats: CloudChatOption[] = [];
  private chatsLoaded = false;
  /**
   * Bumped by `signedOut`. Every list result and every poll transition belongs
   * to the account that was signed in when it started; one that lands after a
   * sign-out is dropped rather than shown to the next account.
   */
  private generation = 0;
  /**
   * How many times the row set has been changed from here.
   *
   * The account generation is not enough: a list started before a delete can
   * land after it and put the removed agent back on screen, which reads as a
   * delete that silently failed. A refresh remembers the count it read at and
   * drops its listing if anything changed underneath it — the mutation is
   * newer, and it is the one the user just performed.
   */
  private mutations = 0;

  constructor(private readonly deps: CloudAgentStateDeps) {}

  state(): CloudAgentsUiState {
    if (!this.deps.enabled) return { ...EMPTY_STATE };
    const settings = loadSettings(this.deps.home);
    return {
      cloudEnabled: true,
      cloudAgents: [...this.rows.values()].sort(byNewestFirst),
      cloudAgentsError: this.agentsError,
      cloudChatsError: this.chatsError,
      cloudActionError: this.actionError,
      cloudChats: this.chats,
      cloudChatsLoaded: this.chatsLoaded,
      cloudSendTo: settings.activationSendTo.trim() || null,
      cloudAgentSettings: settings.cloudAgentSettings,
    };
  }

  /**
   * Re-read server truth: the agents, and the chats the picker offers.
   *
   * Called on tab activation, after every mutation, and at the end of a poll.
   * Both halves run together and neither can fail the other — a chat list that
   * 403s still leaves the roster on screen.
   */
  async refresh(): Promise<void> {
    if (!this.deps.enabled) return;
    const credential = this.credential();
    if (!credential) return;
    const generation = this.generation;
    const mutations = this.mutations;
    await Promise.all([
      this.refreshAgents(credential, generation, mutations),
      this.refreshChats(credential, generation),
    ]);
    if (generation === this.generation) this.publish();
  }

  /**
   * Provision one agent in one chat.
   *
   * Returns once Plow has issued the receipt — the row is on screen in
   * `provisioning` at that moment — and leaves the poll running here. The new
   * `agent_id` comes back so `retry` can carry local settings onto it.
   */
  async create(chatUid: string, name: string): Promise<string | null> {
    if (!this.deps.enabled) return null;
    this.actionError = null;
    const chat = (chatUid ?? "").trim();
    if (!chat) return this.failAction("Pick the chat this agent will answer in.");
    const credential = this.credential();
    if (!credential) return this.failAction("This Mac isn't signed in yet.");

    const generation = this.generation;
    const requested = (name ?? "").trim();
    let receipt: CloudAgentResource;
    try {
      receipt = await this.deps.agents.create(credential, {
        chatUid: chat,
        ...(requested ? { name: requested } : {}),
      });
    } catch (error) {
      // A cancelled create is something this side asked for, not a failure the
      // user needs to read. The agent may still exist on the account — the POST
      // can have landed with the receipt lost — and the next list recovers it.
      if (generation === this.generation && !isAbort(error)) return this.failAction(messageOf(error));
      return null;
    }
    if (generation !== this.generation) return null;
    this.mutations += 1;
    this.pending.add(receipt.agentId);
    this.observe(receipt, requested);
    const controller = new AbortController();
    this.polls.set(receipt.agentId, controller);
    void this.pollToTerminal(credential, receipt, requested, generation, controller.signal);
    return receipt.agentId;
  }

  /** Remove an agent — the machine and its hold on the chat, not just a key. */
  async remove(agentId: string): Promise<void> {
    if (!this.deps.enabled) return;
    this.actionError = null;
    const id = (agentId ?? "").trim();
    if (!id) return;
    const credential = this.credential();
    if (!credential) {
      this.failAction("This Mac isn't signed in yet.");
      return;
    }

    const generation = this.generation;
    // BEFORE the delete, not after it. The delete is a round trip, and a poll
    // left running across it keeps asking Plow about a machine that is being
    // torn down — and can publish a transition for an agent the user has
    // already removed.
    this.abortPoll(id);
    try {
      await this.deps.agents.delete(credential, id);
    } catch (error) {
      if (generation === this.generation) this.failAction(messageOf(error));
      return;
    }
    if (generation !== this.generation) return;
    this.mutations += 1;
    this.rows.delete(id);
    this.pending.delete(id);
    // The agent is gone for good, so its local settings have nothing left to
    // apply to. Keeping them would grow the file forever with dead ids.
    this.writeAgentSettings(id, null);
    this.publish();
    await this.refresh();
  }

  /**
   * Retry a failed agent: delete it, then create another in the same chat.
   *
   * The new agent gets a NEW `agent_id`, so the old one's local settings are
   * carried across explicitly — otherwise Retry silently resets choices the
   * user made about an agent they think of as the same one.
   */
  async retry(agentId: string): Promise<void> {
    if (!this.deps.enabled) return;
    this.actionError = null;
    const id = (agentId ?? "").trim();
    const row = id ? this.rows.get(id) : undefined;
    if (!row) {
      this.failAction("That agent is no longer on this screen.");
      return;
    }
    const credential = this.credential();
    if (!credential) {
      this.failAction("This Mac isn't signed in yet.");
      return;
    }

    const generation = this.generation;
    // Same order as `remove`, and for the same reason.
    this.abortPoll(id);
    try {
      await this.deps.agents.delete(credential, id);
    } catch (error) {
      if (generation === this.generation) this.failAction(messageOf(error));
      return;
    }
    if (generation !== this.generation) return;
    this.mutations += 1;
    this.rows.delete(id);
    this.pending.delete(id);
    // The row goes, the local settings stay. A retry is two round trips, and
    // the panel is open across both of them: an entry deleted here would take
    // a toggle made in the meantime with it, and one snapshotted before them
    // would overwrite that toggle with a stale value. The entry moves once,
    // below, when there is somewhere for it to go.
    this.publish();

    const replacement = await this.create(row.chatUid, row.name);
    if (generation !== this.generation) return;
    // Read at the last possible moment, so what moves is whatever the user
    // last chose — including a toggle that landed while this was in the air.
    // A null replacement means the agent is gone with nowhere to carry to.
    this.moveAgentSettings(id, replacement);
    this.publish();
  }

  /**
   * Write this agent's local settings — today, adversarial review and nothing
   * else.
   *
   * **Local only: it never calls Plow.** The switch is this app's own reviewer,
   * not a property of the machine Plow provisioned, so it applies at once and
   * there is nothing to wait for and nothing that can fail.
   *
   * The panel's two permission controls used to ride along here and go through
   * a reconfigure. They are gone, and so is the pair this file remembered for
   * them, until an endpoint can report what an agent actually may do — the list
   * rows carry no scopes, so a permission control could only ever have shown
   * what this Mac last asked for, which is a second and non-authoritative
   * source of truth about the agent.
   */
  async apply(agentId: string, settings: { adversarialReview: boolean }): Promise<void> {
    if (!this.deps.enabled) return;
    const id = (agentId ?? "").trim();
    if (!id) return;

    this.writeAgentSettings(id, { adversarialReview: settings?.adversarialReview === true });
    this.publish();
  }

  /**
   * This Mac signed out. Every row, every chat and every poll in flight belongs
   * to the account that just went away.
   */
  signedOut(): void {
    this.generation += 1;
    // Before the rows go: these polls are authorised with a credential that is
    // no longer this Mac's, so every further request they make is a 401.
    for (const agentId of [...this.polls.keys()]) this.abortPoll(agentId);
    this.rows.clear();
    this.pending.clear();
    this.chats = [];
    this.chatsLoaded = false;
    this.chatsError = null;
    this.agentsError = null;
    this.actionError = null;
    this.publish();
  }

  private async pollToTerminal(
    credential: string,
    receipt: CloudAgentResource,
    fallbackName: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.deps.agents.poll(
        credential,
        receipt,
        (agent) => {
          if (generation === this.generation) this.observe(agent, fallbackName);
        },
        signal,
      );
    } catch (error) {
      // A cancelled poll is something this side asked for — the agent was
      // deleted, or the Mac signed out. It is not a failure to report.
      if (generation === this.generation && !signal.aborted && !isAbort(error)) {
        this.failAction(messageOf(error));
      }
    } finally {
      this.pending.delete(receipt.agentId);
      if (this.polls.get(receipt.agentId)?.signal === signal) this.polls.delete(receipt.agentId);
    }
    if (generation === this.generation && !signal.aborted) await this.refresh();
  }

  private abortPoll(agentId: string): void {
    const controller = this.polls.get(agentId);
    if (!controller) return;
    this.polls.delete(agentId);
    controller.abort();
  }

  private async refreshAgents(
    credential: string,
    generation: number,
    mutations: number,
  ): Promise<void> {
    try {
      const agents = await this.deps.agents.list(credential);
      if (generation !== this.generation) return;
      // A create or a delete happened while this listing was in the air. It is
      // older than what the user just did, and applying it would put a deleted
      // agent back on screen. The mutation's own refresh follows it.
      if (mutations !== this.mutations) return;
      const listed = new Map(
        agents.map((agent) => [agent.agentId, this.rowFor(agent)] as const),
      );
      // A create whose poll is still running may not be in the account listing
      // yet. Its row stays until the poll finishes, so provisioning does not
      // flicker off the screen and back.
      //
      // In the other direction the listing is the RECOVERY path, not a
      // contradiction: a create cancelled while the POST was in flight can
      // leave an agent on the account whose id this process never saw. It has
      // no local row and nothing to poll, so the only way it comes back is by
      // being listed — which is why nothing here filters the listing down to
      // agents this process happens to know about.
      for (const [agentId, row] of this.rows) {
        if (!listed.has(agentId) && this.pending.has(agentId)) listed.set(agentId, row);
      }
      this.rows = listed;
      this.agentsError = null;
    } catch (error) {
      if (generation !== this.generation) return;
      // The rows already on screen are kept: stale truth with a banner beats an
      // empty roster that reads as "you have no agents".
      this.agentsError = messageOf(error);
    }
  }

  private async refreshChats(credential: string, generation: number): Promise<void> {
    try {
      const chats = await this.deps.chats.list(credential);
      if (generation !== this.generation) return;
      this.chats = chats;
      // Only here: the one place a list actually came back. An empty answer is
      // still an answer, and it is the only one the empty state may render.
      this.chatsLoaded = true;
      this.chatsError = null;
      // Labels arrive with the chats, so rows resolve theirs on this pass.
      this.relabelRows();
    } catch (error) {
      if (generation !== this.generation) return;
      this.chats = [];
      // Every failure is the same failure, 403 included: the account's chats
      // are unknown. What must never happen is the screen reading that as "you
      // have no chats" — which is why `chatsLoaded` and the error travel
      // together, and why the roster stays where it is.
      this.chatsLoaded = false;
      this.chatsError = messageOf(error);
    }
  }

  /** Record one polled or listed resource as a display row, in place. */
  private observe(agent: CloudAgentResource, fallbackName: string): void {
    this.rows.set(agent.agentId, this.rowFor(agent, fallbackName));
    this.publish();
  }

  private rowFor(agent: CloudAgentResource, fallbackName?: string): CloudAgentDisplayRow {
    const chatLabel = this.chats.find((chat) => chat.uid === agent.chatUid)?.label;
    return toCloudAgentDisplayRow(agent, {
      ...(chatLabel ? { chatLabel } : {}),
      ...(fallbackName ? { fallbackName } : {}),
    });
  }

  private relabelRows(): void {
    for (const [agentId, row] of this.rows) {
      const label = this.chats.find((chat) => chat.uid === row.chatUid)?.label;
      if (label && label !== row.chatLabel) this.rows.set(agentId, { ...row, chatLabel: label });
    }
  }

  private readAgentSettings(agentId: string): CloudAgentLocalSettings | null {
    return loadSettings(this.deps.home).cloudAgentSettings[agentId] ?? null;
  }

  /**
   * Move one agent's local settings onto its replacement, or drop them.
   *
   * One load and one save, so the read and the two writes cannot be split by
   * anything: whatever is on disk when this runs is what moves. `toId` of
   * `null` — a retry whose replacement never came — deletes the entry, because
   * an id no row will ever carry again can never be read.
   */
  private moveAgentSettings(fromId: string, toId: string | null): void {
    const settings = loadSettings(this.deps.home);
    if (!(fromId in settings.cloudAgentSettings)) return;
    const carried = settings.cloudAgentSettings[fromId];
    delete settings.cloudAgentSettings[fromId];
    if (toId) settings.cloudAgentSettings[toId] = carried;
    saveSettings(this.deps.home, settings);
  }

  private writeAgentSettings(agentId: string, value: CloudAgentLocalSettings | null): void {
    const settings = loadSettings(this.deps.home);
    if (value) settings.cloudAgentSettings[agentId] = value;
    else if (!(agentId in settings.cloudAgentSettings)) return;
    else delete settings.cloudAgentSettings[agentId];
    saveSettings(this.deps.home, settings);
  }

  private credential(): string {
    return loadSettings(this.deps.home).relayCredential.trim();
  }

  /** Report what the click could not do, and answer `null` to every caller
   * that was waiting on an id. */
  private failAction(message: string): null {
    this.actionError = message;
    this.publish();
    return null;
  }

  private publish(): void {
    this.deps.onChange?.();
  }
}

/** Newest first, so a just-created agent lands at the top of the group. */
function byNewestFirst(a: CloudAgentDisplayRow, b: CloudAgentDisplayRow): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.agentId < b.agentId ? -1 : 1;
}

/** An abort surfaces as `AbortError` however the client raises it. */
function isAbort(error: unknown): boolean {
  return (error as { name?: unknown })?.name === "AbortError";
}

function messageOf(error: unknown): string {
  // PlowApiError messages are written for a human and are credential-free by
  // construction — see plowApi.ts and cloudAgents.ts. Anything else is ours,
  // unexpected, and gets fixed text rather than whatever it happened to carry.
  if (error instanceof PlowApiError) return error.message;
  return "Something went wrong. Try again.";
}

/**
 * `GET /v1/chats` — every chat the account has, for the picker.
 *
 * A chat has no title, so what identifies it is the line it runs on and who is
 * in it; the shape is the one the activation redeem already returns, so the
 * parse and the label are shared with setup rather than written twice.
 */
export class CloudChatsClient implements CloudChatsApi {
  private readonly baseUrl: ApiBaseUrl;

  constructor(
    baseUrl: ApiBaseUrl,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = normalizeApiBaseUrl(baseUrl);
  }

  async list(deviceCredential: string): Promise<CloudChatOption[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/chats`, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${deviceCredential}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const name = (error as { name?: unknown })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new PlowApiError("network", "Plow didn't answer in time. Try again.");
      }
      // A fetch implementation may carry the whole Request, headers included,
      // in the cause. Only fixed text crosses this boundary.
      throw new PlowApiError("network", "Couldn't reach Plow.");
    }

    if (response.status === 403) {
      // A 403 does not say whether the credential or the deployment lacks the
      // required scope. State the limitation, then offer the one local remedy
      // as something to try rather than claiming it will fix the server.
      throw new PlowApiError(
        "forbidden",
        "This Mac cannot list chats yet. Try re-activating it, then try again.",
        403,
      );
    }
    if (response.status === 401) {
      throw new PlowApiError("unauthorized", "Not authorized.", 401);
    }
    if (!response.ok) {
      throw new PlowApiError("http", `Plow returned ${response.status}.`, response.status);
    }

    let decoded: unknown = null;
    try {
      decoded = await response.json();
    } catch {
      decoded = null;
    }
    const rows =
      decoded && typeof decoded === "object" && Array.isArray((decoded as { data?: unknown }).data)
        ? ((decoded as { data: unknown[] }).data)
        : null;
    if (!rows) throw new PlowApiError("http", "Plow returned an invalid chat list.", response.status);

    return rows
      .map((raw) => parseActivationChat(raw))
      .filter((chat): chat is NonNullable<typeof chat> => chat !== null)
      .map((chat) => ({ uid: chat.uid, label: activationChatLabel(chat) }));
  }
}
