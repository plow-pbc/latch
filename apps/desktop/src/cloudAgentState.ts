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
import {
  ChatSetConflictError,
  CloudAgentResource,
  CreateCloudAgentRequest,
  echoesCredential,
  normalizeChatUids,
} from "./cloudAgents.js";
import {
  ChatRecipients,
  activationChatLabel,
  activationChatRecipients,
  storedActivationChat,
} from "./onboarding.js";
import { PlowApi, PlowApiError, parseActivationChat } from "./plowApi.js";
import { loadSettings } from "./settings.js";

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
  /**
   * The numbers a message to this chat goes to, or `null` when we do not know
   * them.
   *
   * Null is a real answer, not a gap to paper over: the fallback chat comes
   * from settings, which persist a uid and a label and never the participants.
   * A screen that cannot address the chat must say so rather than send to
   * whatever it can find in the label.
   */
  recipients: ChatRecipients | null;
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
  cloudAgents: CloudAgentDisplayRow[];
  /** An agent-list failure, and nothing else. */
  cloudAgentsError: string | null;
  /** A chat-list failure, and nothing else. */
  cloudChatsError: string | null;
  /**
   * The chat list failed because of the CREDENTIAL, not the network.
   *
   * The only failure re-activating fixes. Signing out to recover from a
   * timeout would wipe the cached activation chat, which is the fallback that
   * keeps setup working when the list is down — the feature defeating itself
   * on the very failure it exists for.
   */
  cloudChatsNeedReactivation: boolean;
  /** A create/delete/retry failure, and nothing else. */
  cloudActionError: string | null;
  /** Agent ids whose chat-set save is in flight or being reconciled. */
  cloudAgentEditsPending: string[];
  cloudAgentEditsSaving: string[];
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
}

/** The slice of `CloudAgentsClient` this state needs. */
export interface CloudAgentsApi {
  create(deviceCredential: string, request: CreateCloudAgentRequest): Promise<CloudAgentResource>;
  list(deviceCredential: string): Promise<CloudAgentResource[]>;
  delete(deviceCredential: string, agentId: string): Promise<void>;
  updateChats(
    deviceCredential: string,
    agentId: string,
    chatUids: readonly string[],
  ): Promise<CloudAgentResource>;
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
  onChange?: () => void;
}

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
  private chatsNeedReactivation = false;
  /**
   * Which chat refresh is the newest. Bumped per read, not per account.
   *
   * `generation` only moves on sign-out, so two refreshes in the same session
   * share one and neither can tell it has been overtaken. A slow FAILURE
   * landing after a fast success then replaces a good chat list with the
   * cached fallback and an error banner — degrading the very fallback this
   * exists to provide, on an account whose chats we had just read fine.
   */
  private chatReads = 0;
  /**
   * Which agent-list read is the newest. The same guard as `chatReads`, for the
   * same reason: `generation` moves on sign-out alone, so two reads in one
   * session cannot tell which of them is stale.
   *
   * The fourth counter of this shape in this codebase. That is a smell, and the
   * consolidation is deliberately not being done here — see the note on the PR.
   */
  private agentReads = 0;
  private actionError: string | null = null;
  /** The latest roster read already started when an indeterminate PUT failed;
   * `null` while the PUT itself is still in flight. */
  private editsPending = new Map<string, number | null>();
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
  /** The chat read currently in flight, so a caller whose own read was
   * superseded can wait on the one that replaced it. */
  private chatsSettled: Promise<void> = Promise.resolve();
  /** Agents whose stuck delete is being retried right now — one at a time each. */
  private tearingDown = new Set<string>();

  constructor(private readonly deps: CloudAgentStateDeps) {}

  state(): CloudAgentsUiState {
    const settings = loadSettings(this.deps.home);
    return {
      cloudAgents: [...this.rows.values()].sort(byNewestFirst),
      cloudAgentsError: this.agentsError,
      cloudChatsError: this.chatsError,
      cloudChatsNeedReactivation: this.chatsNeedReactivation,
      cloudActionError: this.actionError,
      cloudAgentEditsPending: [...this.editsPending.keys()],
      cloudAgentEditsSaving: [...this.editsPending].flatMap(([id, read]) => read === null ? [id] : []),
      cloudChats: this.chats,
      cloudChatsLoaded: this.chatsLoaded,
      cloudSendTo: settings.activationSendTo.trim() || null,
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
    const credential = this.credential();
    if (!credential) return;
    const generation = this.generation;
    const mutations = this.mutations;
    let chats = this.refreshChats(credential, generation);
    this.chatsSettled = chats;
    await Promise.all([this.refreshAgents(credential, generation, mutations), chats]);
    // A newer chat read started while ours was in flight. Ours DROPPED its own
    // answer on purpose — a superseded read says nothing about now — so
    // returning here would answer from before either of them. That is exactly
    // what a caller awaiting this must not be handed: the picker opens through
    // `cloud:refresh`, and would show the chat list from before the text that
    // sent the owner here. Join whatever replaced it, and whatever replaced that.
    while (this.chatsSettled !== chats) {
      chats = this.chatsSettled;
      await chats;
    }
    if (generation === this.generation) this.publish();
  }

  /**
   * Provision one agent across one or more chats, home first.
   *
   * Returns once Plow has issued the receipt — the row is on screen in
   * `provisioning` at that moment — and leaves the poll running here. The new
   * `agent_id` comes back so `retry` can carry local settings onto it.
   */
  async create(
    chatUids: readonly string[],
    name: string,
    provider: string,
  ): Promise<string | null> {
    this.actionError = null;
    const chats = normalizeChatUids(chatUids);
    if (!chats.length) return this.failAction("Pick at least one chat this agent will answer in.");
    const credential = this.credential();
    if (!credential) return this.failAction("This Mac isn't signed in yet.");

    const generation = this.generation;
    const requested = (name ?? "").trim();
    let receipt: CloudAgentResource;
    try {
      receipt = await this.deps.agents.create(credential, {
        chatUids: chats,
        provider,
        ...(requested ? { name: requested } : {}),
      });
    } catch (error) {
      // A cancelled create is something this side asked for, not a failure the
      // user needs to read. The agent may still exist on the account — the POST
      // can have landed with the receipt lost — and the next list recovers it.
      if (generation === this.generation && !isAbort(error)) {
        return this.failAction(this.actionMessage(error));
      }
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

  /**
   * Replace the set of chats an agent serves, home first.
   *
   * A full replacement and a single round trip: there is no machine to boot, so
   * unlike `create` there is nothing to poll — the answer IS the new state, and
   * the row is rewritten from it before the roster re-read confirms it.
   *
   * The staleness guards are `create`'s, for `create`'s reasons: a sign-out
   * mid-flight belongs to the account that went away, and the mutation counter
   * has to move so a listing already in the air cannot put the old set back on
   * screen.
   */
  async editChats(agentId: string, chatUids: readonly string[]): Promise<void> {
    const id = (agentId ?? "").trim();
    if (id && this.editsPending.has(id)) return;
    this.actionError = null;
    if (!id) return;
    const chats = normalizeChatUids(chatUids);
    if (!chats.length) {
      this.failAction("An agent has to serve at least one chat.");
      return;
    }
    const credential = this.credential();
    if (!credential) {
      this.failAction("This Mac isn't signed in yet.");
      return;
    }

    const generation = this.generation;
    this.editsPending.set(id, null);
    this.publish();
    let updated: CloudAgentResource;
    try {
      updated = await this.deps.agents.updateChats(credential, id, chats);
    } catch (error) {
      if (generation !== this.generation) return;
      const refused = isRefusedEdit(error);
      if (refused) this.editsPending.delete(id);
      else this.editsPending.set(id, this.agentReads);
      this.failAction(this.actionMessage(error));
      // A failure that is not the server's verdict says nothing about what the
      // agent now serves. A timed-out PUT is the case that matters: the request
      // may well have landed, and leaving the old set on screen would be the
      // app asserting a rollback nobody performed. Ask.
      //
      // The counter moves even though we do not know whether anything did: a
      // listing that was already in the air predates the attempt either way,
      // and the refresh below is the one whose answer is worth having.
      if (!refused) {
        this.mutations += 1;
        await this.refresh();
      }
      return;
    }
    if (generation !== this.generation) return;
    if (!this.editsPending.delete(id)) return;
    this.mutations += 1;
    // The row goes to the answer, not to what was asked for: the server decides
    // what the agent serves, and a set it normalised differently must show as
    // what it actually is.
    this.observe(updated, "");
    await this.refresh();
  }

  /** Remove an agent — the machine and its hold on the chat, not just a key. */
  async remove(agentId: string): Promise<void> {
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
    this.editsPending.delete(id);
    this.rows.delete(id);
    this.pending.delete(id);
    this.publish();
    await this.refresh();
  }

  /**
   * This Mac signed out. Every row, every chat and every poll in flight belongs
   * to the account that just went away.
   */
  signedOut(): void {
    this.generation += 1;
    this.tearingDown.clear();
    // Before the rows go: these polls are authorised with a credential that is
    // no longer this Mac's, so every further request they make is a 401.
    for (const agentId of [...this.polls.keys()]) this.abortPoll(agentId);
    this.rows.clear();
    this.pending.clear();
    this.editsPending.clear();
    this.chats = [];
    this.chatsLoaded = false;
    this.chatsError = null;
    this.chatsNeedReactivation = false;
    // Nothing in flight belongs to the next account either.
    this.chatReads += 1;
    this.agentReads += 1;
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

  /**
   * Ask again for a delete the provider did not finish.
   *
   * Silent on failure, deliberately: nobody clicked anything here, so a banner
   * about it would be a report on work the user did not ask for. The agent
   * stays in `teardown`, and the next refresh tries again. One attempt at a
   * time per agent, or every refresh during a slow teardown piles another
   * DELETE onto the same machine.
   */
  private retryTeardown(credential: string, agentId: string, generation: number): void {
    if (this.tearingDown.has(agentId)) return;
    this.tearingDown.add(agentId);
    void (async () => {
      try {
        await this.deps.agents.delete(credential, agentId);
        if (generation !== this.generation) return;
        this.mutations += 1;
        this.rows.delete(agentId);
        this.pending.delete(agentId);
        this.publish();
      } catch {
        // Still in teardown. The next refresh will find it and try again.
      } finally {
        this.tearingDown.delete(agentId);
      }
    })();
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
    const read = ++this.agentReads;
    try {
      const agents = await this.deps.agents.list(credential);
      if (generation !== this.generation || read !== this.agentReads) return;
      const listed = new Map(
        agents.map((agent) => [agent.agentId, this.rowFor(agent)] as const),
      );
      for (const [agentId, failedAtRead] of this.editsPending) {
        if (failedAtRead === null || failedAtRead >= read) continue;
        const reconciled = listed.get(agentId);
        if (reconciled) this.rows.set(agentId, reconciled);
        else this.rows.delete(agentId);
        this.editsPending.delete(agentId);
      }
      // A create or a delete happened while this listing was in the air. It is
      // older than what the user just did, and applying all of it would put a
      // deleted agent back on screen. The mutation's own refresh follows it.
      if (mutations !== this.mutations) return;
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
      // `teardown` is not a state an agent rests in — it is a delete that
      // failed provider-side and is waiting to be asked again. Nothing else
      // will ask, so this does, from whichever refresh sees it.
      for (const agent of agents) {
        if (isTeardown(agent.status)) this.retryTeardown(credential, agent.agentId, generation);
      }
    } catch (error) {
      // A superseded read says nothing about now, and a stale failure putting a
      // banner over a newer good answer is the expensive direction of that.
      if (generation !== this.generation || read !== this.agentReads) return;
      // The rows already on screen are kept: stale truth with a banner beats an
      // empty roster that reads as "you have no agents".
      this.agentsError = messageOf(error);
    }
  }

  private async refreshChats(credential: string, generation: number): Promise<void> {
    const read = ++this.chatReads;
    try {
      const chats = await this.deps.chats.list(credential);
      if (generation !== this.generation || read !== this.chatReads) return;
      this.chats = chats;
      // Only here: the one place a list actually came back. An empty answer is
      // still an answer, and it is the only one the empty state may render.
      this.chatsLoaded = true;
      this.chatsError = null;
      this.chatsNeedReactivation = false;
      // Labels arrive with the chats, so rows resolve theirs on this pass.
      this.relabelRows();
    } catch (error) {
      // A superseded read says nothing about now. Landing late must never undo
      // a newer answer, and a failure undoing a success is the expensive
      // direction of that.
      if (generation !== this.generation || read !== this.chatReads) return;
      // Whatever went wrong, the account's chats are unknown, and the screen
      // must not read that as "you have no chats" — which is why `chatsLoaded`
      // and the error travel together, and why the roster stays where it is.
      this.chatsLoaded = false;
      this.chatsError = messageOf(error);
      // But not every failure means the same thing to the person reading it.
      // Only a credential the server refused is fixed by re-activating; a
      // timeout or a 5xx is fixed by waiting. Offering to sign out for those
      // would destroy the cached activation chat — the very fallback installed
      // on the next line — and charge a full re-activation over SMS for a blip.
      this.chatsNeedReactivation = isCredentialFailure(error);
      // "Unknown" is not "none". Activation left us one chat, and it is still
      // the account's chat whatever the list endpoint just did, so setup stays
      // usable. Offered, never asserted: `chatsLoaded` stays false.
      this.chats = storedChats(this.deps.home);
      // The rows may have been built before this landed, against no labels at
      // all — the success path relabels and this one has to as well, or a raw
      // chat uid sits on screen where a phone number belongs.
      this.relabelRows();
    }
  }

  /** Record one polled or listed resource as a display row, in place. */
  private observe(agent: CloudAgentResource, fallbackName: string): void {
    this.rows.set(agent.agentId, this.rowFor(agent, fallbackName));
    this.publish();
  }

  private rowFor(agent: CloudAgentResource, fallbackName?: string): CloudAgentDisplayRow {
    // Recipients come from HOME and only home: it is the chat the Message
    // button opens, and addressing the rest from this row is not on offer.
    const home = this.chats.find((option) => option.uid === agent.chatUids[0]);
    return toCloudAgentDisplayRow(agent, {
      chatLabels: this.labelsByUid(),
      ...(fallbackName ? { fallbackName } : {}),
      recipients: home?.recipients ?? null,
    });
  }

  /** Every label the chat list knows, by uid. Absent uids stay absent — the
   * mapper falls back to the uid rather than inventing a name for it. */
  private labelsByUid(): Record<string, string> {
    const labels: Record<string, string> = {};
    for (const chat of this.chats) if (chat.label) labels[chat.uid] = chat.label;
    return labels;
  }

  /**
   * Re-resolve what the chat list knows about each row's chats.
   *
   * The labels and the recipients arrive together and go stale together: a row
   * built before the chats landed has uids for labels and no addresses, and
   * both are fixed from the same lookup. Relabelling one without the other is
   * how a row could name a chat it could not message.
   */
  private relabelRows(): void {
    const labels = this.labelsByUid();
    for (const [agentId, row] of this.rows) {
      const chatLabels = row.chatUids.map((uid) => labels[uid] || uid);
      const home = this.chats.find((option) => option.uid === row.chatUids[0]);
      const recipients = home?.recipients ?? null;
      const sameLabels =
        chatLabels.length === row.chatLabels.length &&
        chatLabels.every((label, index) => label === row.chatLabels[index]);
      if (sameLabels && recipients === row.recipients) continue;
      this.rows.set(agentId, { ...row, chatLabels, recipients });
    }
  }

  private credential(): string {
    return loadSettings(this.deps.home).relayCredential.trim();
  }

  private actionMessage(error: unknown): string {
    if (error instanceof ChatSetConflictError) {
      const name = error.conflictingAgentIds
        .map((agentId) => this.rows.get(agentId)?.name?.trim())
        .find(Boolean);
      if (name) return `This chat already belongs to ${name} — edit that agent's chats instead.`;
    }
    return messageOf(error);
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

/**
 * A delete that failed on the provider's side and needs asking again.
 *
 * Read as a widened string: the client's status union is catching up with the
 * shipped enum, and an unrecognised status must never be a compile error here
 * — it is the server's word, not ours.
 */
function isTeardown(status: string): boolean {
  return status === "teardown";
}

/**
 * The chat activation left, as the picker's one-entry list.
 *
 * Reads the same record `onboarding.ts` reads, through the same function, so a
 * Mac cannot show a chat on one screen and a bare uid on the other.
 */
function storedChats(home: string): CloudChatOption[] {
  const chat = storedActivationChat(loadSettings(home));
  // No recipients: settings keep a uid and a label, never the participants. The
  // chat is still offered so setup works, but it cannot be messaged.
  return chat ? [{ ...chat, recipients: null }] : [];
}

/**
 * Did the server refuse this credential?
 *
 * The one class of chat-list failure that re-activating fixes. Everything else
 * — a timeout, a dropped connection, a 5xx — is fixed by waiting, and signing
 * out for it costs the user their cached chat and a re-activation over SMS.
 */
function isCredentialFailure(error: unknown): boolean {
  return (
    error instanceof PlowApiError && (error.kind === "forbidden" || error.kind === "unauthorized")
  );
}

/**
 * Did the server refuse the edit before anything moved?
 *
 * Only a 409 carries that answer. A timeout, a dropped connection, a 5xx, or a
 * response we could not read leaves the outcome unknown, and unknown is not
 * the same as unchanged.
 */
function isRefusedEdit(error: unknown): boolean {
  if (!(error instanceof PlowApiError)) return false;
  return error.status === 409;
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
 * A chat is identified by its title, members or numbers; the shape is the one
 * the activation redeem already returns, so the parse and the label are shared
 * with setup rather than written twice.
 */
export class CloudChatsClient implements CloudChatsApi {
  constructor(private readonly api: PlowApi) {}

  async list(deviceCredential: string): Promise<CloudChatOption[]> {
    const response = await this.api.request("GET", "/v1/chats", {
      token: deviceCredential,
    });

    if (response.status === 403) {
      // 403 has no screen of its own, so the remedy has to be in the sentence.
      // What it must NOT do is name a cause: a credential minted before
      // `chats:use` is the likely one, but the server says only that this
      // token was refused, and re-activating is the move either way.
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
      .map((chat) => {
        const safe = {
          ...chat,
          displayName: echoesCredential(chat.displayName ?? "", deviceCredential) ? null : chat.displayName,
          participants: chat.participants.map((member) => echoesCredential(
            member.displayName ?? "", deviceCredential,
          ) ? { ...member, displayName: null } : member),
        };
        return { uid: chat.uid, label: activationChatLabel(safe), recipients: activationChatRecipients(safe) };
      });
  }
}
