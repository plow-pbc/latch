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
import {
  ChatPerson,
  chatEchoesCredential,
  chatPeople,
  chatRowSubtitle,
  chatRowTitle,
  withoutCredentialEchoes,
} from "./chatRows.js";
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
/**
 * One of Plow's pool numbers, as the "Create a new chat" view shows it.
 *
 * `held` is whether one of THIS account's chats already runs on it: a number
 * the owner has is not one they can start a second chat on, so the screen says
 * so rather than offering a dead link.
 */
export interface CloudLineOption {
  /** The line's persona name (`Willow`), or null for an unnamed line. */
  displayName: string | null;
  /** The number to text. Rendered verbatim, never composed here. */
  number: string;
  /** Whether one of THIS account's chats already runs on it. DERIVED in
   * `state()` from the chats held at that moment — never stored, because the
   * two reads settle independently and a stored answer is one of them being
   * wrong. */
  held: boolean;
}

/**
 * A chat as the picker renders it: the option plus its two formatted lines.
 *
 * Built in `state()` rather than by the client, because the subtitle needs the
 * LINE's persona name and only the line list carries that.
 */
export interface CloudChatRow extends CloudChatOption {
  title: string;
  subtitle: string;
  /** The persona name of the line this chat runs on, when Plow's list names
   * it. Sorting is by this first, so every chat on one number sits together
   * without needing a group header to say so. */
  lineName: string | null;
}

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
  /** The humans in this chat, with names and which one is the owner — what
   * `chatRows.ts` builds the title and subtitle from. Empty for the settings
   * fallback chat, which persists no participants. */
  people: ChatPerson[];
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
  cloudChats: CloudChatRow[];
  /**
   * A chat-list attempt SUCCEEDED — even if it returned nothing.
   *
   * The distinction is the whole field: `cloudChats: []` alone cannot tell
   * "this account has no chats" from "we could not ask", and the two want
   * opposite screens. Only the first may be answered with the empty state and
   * its re-activate prompt; the second keeps the roster and shows the error.
   */
  cloudChatsLoaded: boolean;
  /** Plow's numbers, once asked for. `null` until the modal asks — this is not
   * fetched on tab activation, because only one screen shows it. */
  cloudLines: CloudLineOption[] | null;
  cloudLinesError: string | null;
  /**
   * The number to text, from this Mac's activation — the server's `send_to`,
   * never one the app chose. `null` on a Mac that activated before it was kept,
   * and the empty state falls back to re-activate copy.
   */
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
  /** Plow's pool numbers, for the "Create a new chat" view. */
  lines?: { list(credential: string): Promise<Omit<CloudLineOption, "held">[]> };
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
  private actionError: string | null = null;
  /** Agents whose chat sets are being saved or reconciled with a roster read. */
  private editsPending = new Set<string>();
  /** The subset whose PUT has not answered yet. */
  private editsSaving = new Set<string>();
  private chats: CloudChatOption[] = [];
  private chatsLoaded = false;
  /**
   * Bumped by `signedOut`. Every list result and every poll transition belongs
   * to the account that was signed in when it started; one that lands after a
   * sign-out is dropped rather than shown to the next account.
   */
  private generation = 0;
  /**
   * Roster reads and changes apply in the order they were launched. A rejected
   * step is swallowed only on the chain, so one failed request cannot stop the
   * next refresh or click from running.
   */
  private currentAction: Promise<void> = Promise.resolve();
  /**
   * The chat read currently in flight, so a caller whose own read was
   * superseded can wait on the one that replaced it.
   *
   * Separate from `currentAction`, and deliberately: that chain serialises the
   * ROSTER against its mutations. Chat-list ordering is left independent (#224
   * says so), so the picker's await needs its own answer to "has the newest
   * read landed".
   */
  private chatsSettled: Promise<void> = Promise.resolve();
  /** As the server listed them, with no `held` — see `CloudLineOption`. */
  private lines: Omit<CloudLineOption, "held">[] | null = null;
  private linesError: string | null = null;
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
      cloudAgentEditsPending: [...this.editsPending],
      cloudAgentEditsSaving: [...this.editsSaving],
      // Rows are FORMATTED here, not in the renderer: naming a participant,
      // spelling a number and deciding which one is the owner's are rules, and
      // rules belong somewhere testable. `chatRows.ts` owns them.
      cloudChats: this.chats.map((chat) => {
        const line = chat.recipients?.line ?? null;
        const named = this.lines?.find((row) => row.number === line) ?? null;
        return {
          ...chat,
          lineName: named?.displayName ?? null,
          title: chatRowTitle(chat.people ?? [], line, chat.label || chat.uid, named?.displayName ?? null),
          subtitle: chatRowSubtitle(line, named?.displayName ?? null, chat.people ?? []),
        };
      }),
      cloudChatsLoaded: this.chatsLoaded,
      // Computed HERE, on every read, from whichever chat list is current.
      // Storing it at fetch time raced: the chat read and the line read settle
      // independently, so whichever landed second left the other's answer
      // stale — lines fetched before the chats meant a number the owner
      // already held was offered as free.
      //
      // And withheld entirely until the chats HAVE landed. `held` is a claim
      // about this account's chats; with none read, every line looks free, and
      // the screen would offer an Open Messages button for a number the owner
      // already has a thread on. Unknown is not the same as none.
      cloudLines: this.chatsLoaded && this.lines ? markHeldLines(this.lines, this.chats) : null,
      cloudLinesError: this.linesError,
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
    const pendingEdits = new Set(this.editsPending);
    let chats = this.refreshChats(credential, generation);
    this.chatsSettled = chats;
    await Promise.all([
      this.sequence(() => this.refreshAgents(credential, generation, pendingEdits)),
      chats,
    ]);
    // A newer chat read started while ours was in flight. Ours DROPPED its own
    // answer on purpose — a superseded read says nothing about now — so
    // returning here would answer from before either of them. That is exactly
    // what a caller awaiting this must not be handed: the picker opens through
    // `cloud:refresh`, and would show the chat list from before the text that
    // sent the owner here. Join whatever replaced it, and whatever replaced that.
    //
    // Not `sequence`: that chain is the roster's, and #224 leaves chat-list
    // ordering independent on purpose.
    while (this.chatsSettled !== chats) {
      chats = this.chatsSettled;
      await chats;
    }
    if (generation === this.generation) this.publish();
  }

  /**
   * Ask Plow which numbers exist, for the screen that tells the owner to text
   * one. Deliberately NOT part of `refresh`: one view needs it, and every tab
   * activation would pay for it.
   */
  async refreshLines(): Promise<void> {
    const credential = this.credential();
    if (!credential || !this.deps.lines) return;
    const generation = this.generation;
    try {
      const lines = await this.deps.lines.list(credential);
      if (generation !== this.generation) return;
      this.lines = lines;
      this.linesError = null;
    } catch (error) {
      if (generation !== this.generation) return;
      // The list is unknown, not empty: `cloudLines` stays null so the screen
      // shows the error instead of "there are no numbers".
      this.lines = null;
      this.linesError = messageOf(error);
    }
    this.publish();
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
    return this.sequence(async () => {
      if (generation !== this.generation) return null;
      this.actionError = null;
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
      this.pending.add(receipt.agentId);
      this.observe(receipt, requested);
      const controller = new AbortController();
      this.polls.set(receipt.agentId, controller);
      void this.pollToTerminal(credential, receipt, requested, generation, controller.signal);
      return receipt.agentId;
    });
  }

  /**
   * Replace the set of chats an agent serves, home first.
   *
   * A full replacement and a single round trip: there is no machine to boot, so
   * unlike `create` there is nothing to poll — the answer IS the new state, and
   * the row is rewritten from it before the roster re-read confirms it.
   *
   * A sign-out mid-flight belongs to the account that went away. Roster reads
   * cannot put the old set back because they apply through the same sequence.
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
    this.editsPending.add(id);
    this.editsSaving.add(id);
    this.publish();
    const refresh = await this.sequence(async () => {
      if (generation !== this.generation) return false;
      this.actionError = null;
      let updated: CloudAgentResource;
      try {
        updated = await this.deps.agents.updateChats(credential, id, chats);
      } catch (error) {
        if (generation !== this.generation) return false;
        this.editsSaving.delete(id);
        const refused = isRefusedEdit(error);
        if (refused) this.editsPending.delete(id);
        this.failAction(this.actionMessage(error));
        // A failure that is not the server's verdict says nothing about what the
        // agent now serves. A timed-out PUT is the case that matters: the request
        // may well have landed, and leaving the old set on screen would be the
        // app asserting a rollback nobody performed. Ask.
        return !refused;
      }
      if (generation !== this.generation) return false;
      this.editsSaving.delete(id);
      this.editsPending.delete(id);
      // The row goes to the answer, not to what was asked for: the server decides
      // what the agent serves, and a set it normalised differently must show as
      // what it actually is.
      this.observe(updated, "");
      return true;
    });
    if (refresh) await this.refresh();
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
    const refresh = await this.sequence(async () => {
      if (generation !== this.generation) return false;
      this.actionError = null;
      try {
        await this.deps.agents.delete(credential, id);
      } catch (error) {
        if (generation === this.generation) this.failAction(messageOf(error));
        return false;
      }
      if (generation !== this.generation) return false;
      this.editsPending.delete(id);
      this.editsSaving.delete(id);
      this.rows.delete(id);
      this.pending.delete(id);
      this.publish();
      return true;
    });
    if (refresh) await this.refresh();
  }

  /**
   * This Mac signed out. Every row, every chat and every poll in flight belongs
   * to the account that just went away.
   */
  signedOut(): void {
    this.lines = null;
    this.linesError = null;
    this.generation += 1;
    this.tearingDown.clear();
    // Before the rows go: these polls are authorised with a credential that is
    // no longer this Mac's, so every further request they make is a 401.
    for (const agentId of [...this.polls.keys()]) this.abortPoll(agentId);
    this.rows.clear();
    this.pending.clear();
    this.editsPending.clear();
    this.editsSaving.clear();
    this.chats = [];
    this.chatsLoaded = false;
    this.chatsError = null;
    this.chatsNeedReactivation = false;
    // Nothing in flight belongs to the next account either.
    this.chatReads += 1;
    this.currentAction = Promise.resolve();
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
    void this.sequence(async () => {
      try {
        if (generation !== this.generation) return;
        await this.deps.agents.delete(credential, agentId);
        if (generation !== this.generation) return;
        this.rows.delete(agentId);
        this.pending.delete(agentId);
        this.publish();
      } catch {
        // Still in teardown. The next refresh will find it and try again.
      } finally {
        this.tearingDown.delete(agentId);
      }
    });
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
    pendingEdits: ReadonlySet<string>,
  ): Promise<void> {
    if (generation !== this.generation) return;
    try {
      const agents = await this.deps.agents.list(credential);
      if (generation !== this.generation) return;
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
      for (const agentId of pendingEdits) this.editsPending.delete(agentId);
      this.agentsError = null;
      // `teardown` is not a state an agent rests in — it is a delete that
      // failed provider-side and is waiting to be asked again. Nothing else
      // will ask, so this does, from whichever refresh sees it.
      for (const agent of agents) {
        if (isTeardown(agent.status)) this.retryTeardown(credential, agent.agentId, generation);
      }
    } catch (error) {
      if (generation !== this.generation) return;
      // The rows already on screen are kept: stale truth with a banner beats an
      // empty roster that reads as "you have no agents".
      this.agentsError = messageOf(error);
    }
  }

  private sequence<T>(action: () => Promise<T>): Promise<T> {
    const result = this.currentAction.then(action);
    this.currentAction = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
  return chat ? [{ ...chat, recipients: null, people: [] }] : [];
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
/**
 * The `{ data: [...] }` envelope both list endpoints answer with, decoded.
 *
 * One reading, because they had two that differed only in the sentence: a body
 * that is not JSON and a body whose `data` is not an array are the same
 * failure — the server did not send a list — and a decoder that treats them
 * differently in one place and not the other is a difference nobody chose.
 */
async function readListRows(response: Response, invalid: string): Promise<unknown[]> {
  let decoded: unknown = null;
  try {
    decoded = await response.json();
  } catch {
    decoded = null;
  }
  const rows =
    decoded && typeof decoded === "object" && Array.isArray((decoded as { data?: unknown }).data)
      ? (decoded as { data: unknown[] }).data
      : null;
  if (!rows) throw new PlowApiError("http", invalid, response.status);
  return rows;
}

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

    const rows = await readListRows(response, "Plow returned an invalid chat list.");

    return rows
      .map((raw) => parseActivationChat(raw))
      .filter((chat): chat is NonNullable<typeof chat> => chat !== null)
      .flatMap((chat) => {
        // EVERY server-authored string on this row is scanned — the uid, the
        // line, each participant's number and name — not just the names: all
        // of them cross into the renderer through `state()`, as a row title, a
        // subtitle and an `sms:` target. A name can be blanked and the row
        // still means something; an identifier cannot, so the row is DROPPED.
        //
        // `chatEchoesCredential` is the one rule, shared with the redeem that
        // persists the label — which had no check at all until it was the same
        // function.
        if (chatEchoesCredential(chat, deviceCredential)) return [];

        const safe = withoutCredentialEchoes(chat, deviceCredential);
        return [{
          uid: chat.uid,
          label: activationChatLabel(safe),
          recipients: activationChatRecipients(safe),
          people: chatPeople(safe),
        }];
      });
  }
}

/**
 * `GET /v1/lines` — every pool number the service has, so the owner can be
 * told which one to text.
 *
 * Reachable because Latch stores the login session: the route gates on
 * `chats:use`, which a session's `*:*` satisfies and the narrow device
 * credential older Macs still hold does not. That is what the 403 below is
 * about, and why its sentence names signing in again.
 */
/**
 * E.164, which is what plow's lines are: a leading `+`, a non-zero country
 * digit, and at most fifteen digits total. Deliberately strict — this string
 * ends up in an `sms:` URL, so anything that is not plainly a phone number is
 * not a phone number.
 */
const E164 = /^\+[1-9]\d{1,14}$/;

export class CloudLinesClient {
  constructor(private readonly api: PlowApi) {}

  async list(credential: string): Promise<Omit<CloudLineOption, "held">[]> {
    const response = await this.api.request("GET", "/v1/lines", { token: credential });

    if (response.status === 403) {
      // A Mac paired before this app kept the session holds a credential whose
      // scopes froze at mint, and no amount of retrying widens them. Signing in
      // again is the whole remedy, so the sentence says exactly that.
      throw new PlowApiError("forbidden", "Sign in again to see Plow numbers.", 403);
    }
    if (response.status === 401) throw new PlowApiError("unauthorized", "Not authorized.", 401);
    if (!response.ok) {
      throw new PlowApiError("http", `Plow returned ${response.status}.`, response.status);
    }

    const rows = await readListRows(response, "Plow returned an invalid number list.");

    // FAILS CLOSED, row by row. A line with no number is one nobody can text,
    // and rendering it would put a blank where the whole instruction lives; a
    // malformed row is dropped, not defaulted — the rule the chat list keeps.
    return rows.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const row = raw as { provider_key?: unknown; display_name?: unknown };
      const number = typeof row.provider_key === "string" ? row.provider_key.trim() : "";
      const name = typeof row.display_name === "string" ? row.display_name.trim() : "";
      // The number is E.164 or the row is dropped. It is not only rendered —
      // it is matched in `smsLineUrl` and becomes the recipient of an `sms:`
      // URL, so an arbitrary server-authored string reaching here is a string
      // reaching the user's Messages app. A shape check is what keeps "the
      // server said so" from being the whole authorisation.
      // The NUMBER identifies a line here — it is what the row renders, what
      // `smsLineUrl` matches, and what a held chat is compared against. `uid`
      // was parsed, required and never read.
      if (!E164.test(number)) return [];
      // The credential must not come back out through ANY server-authored
      // field, in any encoding. `uid` and `provider_key` are as server-authored
      // as the name is; a row echoing one is refused outright rather than
      // blanked, because there is nothing safe left to show of it.
      if (echoesCredential(number, credential)) return [];
      const safeName = name && !echoesCredential(name, credential) ? name : null;
      return [{ displayName: safeName, number }];
    });
  }
}

/** Which of these numbers the account already has a chat on. Matched on the
 * chat's own line, which is the only place the association is recorded. */
export function markHeldLines(
  lines: readonly Omit<CloudLineOption, "held">[],
  chats: readonly CloudChatOption[],
): CloudLineOption[] {
  const held = new Set(
    chats.flatMap((chat) => {
      const line = chat.recipients?.line?.trim();
      return line ? [line] : [];
    }),
  );
  return lines.map((line) => ({ ...line, held: held.has(line.number) }));
}
