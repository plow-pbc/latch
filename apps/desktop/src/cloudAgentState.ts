/**
 * Cloud-agent state for the main window: what the Agents tab knows about the
 * agents living on the account's lines, their threads, and deletion.
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
  CloudAgentLine,
  CloudAgentDisplayRow,
  toCloudAgentDisplayRow,
} from "./cloudAgentMapper.js";
import {
  CloudAgentResource,
} from "./cloudAgents.js";
import type { AgentIndex } from "./agentIndex.js";
import {
  ChatRecipients,
  activationChatLabel,
  activationChatRecipients,
  smsUrl,
} from "./onboarding.js";
import {
  CloudAgentProvider,
  CloudAgentProviders,
  PlowApi,
  PlowApiError,
  parseActivationChat,
  echoesCredential,
} from "./plowApi.js";
import {
  ChatPerson,
  chatEchoesCredential,
  chatPeople,
  chatRowTitle,
  formatNumber,
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

/**
 * One of Plow's pool numbers, used to name the line on a chat row.
 */
export interface CloudLineOption {
  agentUid: string | null;
  /** Stable identity used by agent resources and chat participants. */
  uid: string;
  /** The line's persona name (`Willow`), or null for an unnamed line. */
  displayName: string | null;
  /** The line's E.164 number. */
  number: string;
}

export interface CloudChatOption {
  uid: string;
  /** Stable identity of the line this thread belongs to. */
  lineUid: string | null;
  /** As served: `pending` until the provider confirms the thread, then `active`. */
  status: string;
  /** The server's own roster size for this chat — see `ActivationChat.memberCount`. */
  memberCount: number;
  /** Whether a roster row is flagged as the account holder's. */
  hasOwnerMember: boolean;
  label: string;
  /**
   * The numbers a message to this chat goes to, or `null` when we do not know
   * them.
   *
   * Null is a real answer, not a gap to paper over. A screen that cannot
   * address the chat must say so rather than send to whatever it can find in
   * the label.
   */
  recipients: ChatRecipients | null;
  /** The humans in this chat, with names and which one is the owner — what
   * `chatRows.ts` builds the title and subtitle from. */
  people: ChatPerson[];
}

/**
 * Everything the Agents tab renders about cloud agents, in one shape.
 *
 * The four error fields are deliberately separate: the provider, agent and
 * chat lists are independent requests, while an action failure says the thing
 * the user just clicked did not happen. Collapsing them can hide one failure
 * behind another request's success or mislabel a background refresh.
 */
export interface CloudAgentsUiState {
  cloudAgents: CloudAgentDisplayRow[];
  /** Provider ids and display names, or null before the roster succeeds. */
  cloudProviders: CloudAgentProvider[] | null;
  /** A provider-list failure, and nothing else. */
  cloudProvidersError: string | null;
  /** The Agent Index's descriptions, keyed on provider id. Empty until a read
   * succeeds and after a failed one: a card without one shows its name. */
  cloudAgentIndex: AgentIndex;
  /** Lines found on the owner's chats that no current agent occupies. */
  cloudFreeLines: CloudAgentLine[];
  /** An agent-list failure, and nothing else. */
  cloudAgentsError: string | null;
  /** A chat-list failure, and nothing else. */
  cloudChatsError: string | null;
  /**
   * The chat list failed because of the CREDENTIAL, not the network.
   *
   * The only failure re-activating fixes. Signing out to recover from a
   * timeout would wipe the cached activation chat.
   */
  cloudChatsNeedReactivation: boolean;
  /** A delete/retry failure, and nothing else. */
  cloudActionError: string | null;
  /**
   * A chat-list attempt SUCCEEDED — even if it returned nothing.
   *
   * The distinction keeps an unresolved agent row from presenting its threads
   * as an authoritative empty result.
   */
  cloudChatsLoaded: boolean;
  cloudLinesLoaded: boolean;
}

/** The slice of `CloudAgentsClient` this state needs. */
export interface CloudAgentsApi {
  changeLine(
    deviceCredential: string,
    agentId: string,
    lineUid: string,
  ): Promise<CloudAgentResource>;
  list(deviceCredential: string): Promise<CloudAgentResource[]>;
  delete(deviceCredential: string, agentId: string): Promise<void>;
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

export interface CloudProvidersApi {
  listCloudAgentProviders(): Promise<CloudAgentProviders>;
}

export interface CloudAgentStateDeps {
  agents: CloudAgentsApi;
  chats: CloudChatsApi;
  providers: CloudProvidersApi;
  /** Plow's pool numbers, used as display metadata for chat rows. */
  lines?: { list(credential: string): Promise<CloudLineOption[]> };
  /** Describes the catalog. Optional: without it every card is name-only. */
  agentIndex?: () => Promise<AgentIndex>;
  home: string;
  onChange?: () => void;
}

/** One pending `awaitNewAgent`: the roster it started from, and its answer. */
type NewAgentWait = { known: Set<string>; finish(id: string | null): void };

export class CloudAgentState {
  /** Keyed on the agent uid, which is stable for the agent's whole life. */
  private rows = new Map<string, CloudAgentDisplayRow>();
  /** Line ownership comes directly from the agent resource. */
  private agentLines = new Map<string, NonNullable<CloudAgentResource["line"]>>();
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
   * Which account-view refresh is the newest. Bumped per read, not per account.
   *
   * `generation` only moves on sign-out, so two refreshes in the same session
   * share one and neither can tell it has been overtaken. A slow FAILURE
   * landing after a fast success then replaces a good chat list with the
   * cached fallback and an error banner — degrading the very fallback this
   * exists to provide, on an account whose chats we had just read fine.
   */
  private viewReads = 0;
  private actionError: string | null = null;
  private chats: CloudChatOption[] = [];
  private chatsLoaded = false;
  /** Live provider list; unavailable until the latest refresh succeeds. */
  private providers: CloudAgentProvider[] | null = null;
  private providersError: string | null = null;
  private agentIndex: AgentIndex = {};
  /** The pending `awaitNewAgent`, if any. One at a time. */
  private newAgentWait: NewAgentWait | null = null;
  private managedPhone: string | null = null;
  /**
   * Bumped by `signedOut`. Every list result belongs
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
   * The chat-and-line view currently in flight, so a caller whose own read was
   * superseded can wait on the one that replaced it.
   *
   * Separate from `currentAction`, and deliberately: that chain serialises the
   * roster against its mutations, while account-view ordering is independent.
   */
  private viewSettled: Promise<void> = Promise.resolve();
  private lines: CloudLineOption[] | null = null;
  /** Agents whose stuck delete is being retried right now — one at a time each. */
  private tearingDown = new Set<string>();

  constructor(private readonly deps: CloudAgentStateDeps) {}

  state(): CloudAgentsUiState {
    return {
      cloudAgents: [...this.rows.values()].sort(byNewestFirst),
      cloudProviders: this.providers === null
        ? null
        : this.providers.map((provider) => ({ ...provider })),
      cloudProvidersError: this.providersError,
      cloudAgentIndex: { ...this.agentIndex },
      cloudFreeLines: this.freeLines(),
      cloudAgentsError: this.agentsError,
      cloudChatsError: this.chatsError,
      cloudChatsNeedReactivation: this.chatsNeedReactivation,
      cloudActionError: this.actionError,
      cloudChatsLoaded: this.chatsLoaded,
      cloudLinesLoaded: this.lines !== null,
    };
  }

  /**
   * Re-read server truth: the providers, agents, their chats, and the line
   * names that identify those chats.
   *
   * Called on tab activation and after every mutation.
   * All four run together and none can fail the others — a provider-list
   * failure does not hide the roster, a chat list that 403s still leaves the
   * roster on screen, and a line failure still leaves chats identified by
   * number. The Agent Index is read beside them and never awaited: a
   * third-party read does not hold up the roster.
   */
  async refresh(): Promise<void> {
    const credential = this.credential();
    if (!credential) return;
    const generation = this.generation;
    const read = ++this.viewReads;
    void this.refreshAgentIndex(generation, read);
    let view = Promise.all([
      this.refreshProviders(generation, read),
      this.refreshChats(credential, generation, read),
      this.refreshLines(credential, generation, read),
    ]).then(() => {});
    this.viewSettled = view;
    await Promise.all([
      this.sequence(() => this.refreshAgents(credential, generation)),
      view,
    ]);
    // A newer account-view read started while ours was in flight. Ours DROPPED
    // its own answers on purpose — a superseded read says nothing about now —
    // so returning here would answer from before either of them. That is
    // exactly what a caller awaiting this must not be handed. Join whatever
    // replaced each read.
    //
    // Not `sequence`: that chain is the roster's, and #224 leaves account-view
    // ordering independent on purpose.
    while (this.viewSettled !== view) {
      view = this.viewSettled;
      await view;
    }
    if (generation === this.generation) this.publish();
  }

  /** Ask Plow which providers can be started by text. */
  private async refreshProviders(
    generation: number,
    read: number,
  ): Promise<void> {
    try {
      const { providers, managedPhone } = await this.deps.providers.listCloudAgentProviders();
      if (generation !== this.generation || read !== this.viewReads) return;
      this.providers = providers.filter((provider) => provider.phrase !== null);
      this.managedPhone = managedPhone;
      this.providersError = null;
    } catch (error) {
      if (generation !== this.generation || read !== this.viewReads) return;
      this.providers = null;
      this.managedPhone = null;
      this.providersError = messageOf(error);
    }
  }

  /** Describe the catalog from the Agent Index, publishing when it lands. It
   * never fails the provider list: without it the cards show names only, which
   * needs no banner. */
  private async refreshAgentIndex(generation: number, read: number): Promise<void> {
    if (!this.deps.agentIndex) return;
    let index: AgentIndex = {};
    try {
      index = await this.deps.agentIndex();
    } catch {
      // Name-only cards; deploying does not depend on the description.
    }
    if (generation !== this.generation || read !== this.viewReads) return;
    this.agentIndex = index;
    this.publish();
  }

  /** Ask Plow which line names identify the chats in the account. */
  private async refreshLines(credential: string, generation: number, read: number): Promise<void> {
    if (!this.deps.lines) return;
    try {
      const lines = await this.deps.lines.list(credential);
      if (generation !== this.generation || read !== this.viewReads) return;
      this.lines = lines;
      this.relabelRows();
    } catch {
      if (generation !== this.generation || read !== this.viewReads) return;
      this.lines = null;
      // Ownership is unknown after a failed refresh; do not offer stale free lines.
      this.relabelRows();
    }
  }

  /** A text-to-start link built only from the current server catalog. */
  newAgentSmsUrl(providerId: string): string | null {
    const phrase = this.providers?.find((provider) => provider.id === providerId)?.phrase;
    if (!this.credential() || !this.managedPhone || !phrase) return null;
    return smsUrl(this.managedPhone, phrase);
  }

  /** A Messages deep link for one resolved agent line, kept in main-process state. */
  agentSmsUrl(agentId: string): string | null {
    const lineUid = this.rows.get(agentId)?.line?.uid;
    return this.lineDetails(lineUid ?? null).smsUrl;
  }

  /**
   * Wait for an agent that was not on the roster when the wait began: the one
   * the owner's setup text just created. Any publish that sees it ends the
   * wait — this one's re-read every `intervalMs`, the renderer's refresh when
   * the owner comes back from Messages, a poll finishing. Answers null when
   * `timeoutMs` passes, a newer wait starts, or this Mac signs out.
   */
  awaitNewAgent({ intervalMs = 5_000, timeoutMs = 120_000 }: { intervalMs?: number; timeoutMs?: number } = {}): Promise<string | null> {
    this.newAgentWait?.finish(null);
    const generation = this.generation;
    return new Promise((resolve) => {
      let tick: ReturnType<typeof setTimeout> | undefined;
      const wait: NewAgentWait = {
        known: new Set(this.rows.keys()),
        finish: (id) => {
          clearTimeout(tick);
          clearTimeout(timeout);
          if (this.newAgentWait === wait) this.newAgentWait = null;
          resolve(id);
        },
      };
      // Re-armed only once the previous re-read lands: a slow agent list must
      // not pile ticks onto the shared sequence() chain.
      const schedule = (): void => {
        tick = setTimeout(() => {
          const credential = this.credential();
          const read = credential ? this.sequence(() => this.refreshAgents(credential, generation)) : Promise.resolve();
          void read.then(() => {
            if (this.newAgentWait !== wait) return;
            if (generation === this.generation) this.publish();
            if (this.newAgentWait === wait) schedule();
          });
        }, intervalMs);
      };
      const timeout = setTimeout(() => wait.finish(null), timeoutMs);
      this.newAgentWait = wait;
      schedule();
    });
  }

  async changeLine(input: { agentId: string; lineUid: string }): Promise<string | null> {
    const credential = this.credential();
    if (!credential) return this.failAction("This Mac isn't signed in yet.");
    if (!this.rows.has(input.agentId) || !input.lineUid.trim()) {
      return this.failAction("Pick an available line for this agent.");
    }
    const generation = this.generation;
    this.actionError = null;
    return this.moveToLine(credential, input.agentId, input.lineUid, generation);
  }

  private async moveToLine(credential: string, agentId: string, lineUid: string, generation: number): Promise<string | null> {
    try {
      const moved = await this.sequence(() => this.deps.agents.changeLine(credential, agentId, lineUid));
      if (generation !== this.generation) return null;
      this.rows.set(agentId, this.rowFor(moved));
      this.publish();
      return agentId;
    } catch (error) {
      if (generation !== this.generation) return null;
      return this.failAction(messageOf(error));
    }
  }

  private startAgentPoll(
    credential: string,
    receipt: CloudAgentResource,
    generation: number,
  ): void {
    this.abortPoll(receipt.agentId);
    const controller = new AbortController();
    this.polls.set(receipt.agentId, controller);
    void this.pollToTerminal(credential, receipt, generation, controller.signal);
  }

  private async pollToTerminal(
    credential: string,
    receipt: CloudAgentResource,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.deps.agents.poll(
        credential,
        receipt,
        (agent) => {
          if (generation === this.generation) this.observe(agent);
        },
        signal,
      );
    } catch (error) {
      if (generation === this.generation && !signal.aborted && !isAbort(error)) {
        this.failAction(messageOf(error));
      }
    } finally {
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
      this.rows.delete(id);
      this.agentLines.delete(id);
      this.publish();
      return true;
    });
    if (refresh) await this.refresh();
  }

  /**
   * This Mac signed out. Every row and every chat in flight belongs
   * to the account that just went away.
   */
  signedOut(): void {
    this.newAgentWait?.finish(null);
    this.lines = null;
    this.generation += 1;
    this.tearingDown.clear();
    for (const agentId of [...this.polls.keys()]) this.abortPoll(agentId);
    this.rows.clear();
    this.agentLines.clear();
    this.chats = [];
    this.chatsLoaded = false;
    this.chatsError = null;
    this.chatsNeedReactivation = false;
    this.providers = null;
    this.managedPhone = null;
    this.providersError = null;
    // Nothing in flight belongs to the next account either.
    this.viewReads += 1;
    this.currentAction = Promise.resolve();
    this.agentsError = null;
    this.actionError = null;
    this.publish();
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
        this.agentLines.delete(agentId);
        this.publish();
      } catch {
        // Still in teardown. The next refresh will find it and try again.
      } finally {
        this.tearingDown.delete(agentId);
      }
    });
  }

  private async refreshAgents(
    credential: string,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) return;
    try {
      const agents = await this.deps.agents.list(credential);
      if (generation !== this.generation) return;
      const listed = new Map<string, CloudAgentDisplayRow>();
      for (const agent of agents) {
        listed.set(agent.agentId, this.rowFor(agent));
      }
      for (const agentId of this.agentLines.keys()) {
        if (!listed.has(agentId)) this.agentLines.delete(agentId);
      }
      this.rows = listed;
      this.agentsError = null;
      // `teardown` is not a state an agent rests in — it is a delete that
      // failed provider-side and is waiting to be asked again. Nothing else
      // will ask, so this does, from whichever refresh sees it.
      for (const agent of agents) {
        if (agent.status === "provisioning" && !this.polls.has(agent.agentId)) {
          this.startAgentPoll(credential, agent, generation);
        }
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

  private async refreshChats(credential: string, generation: number, read: number): Promise<void> {
    try {
      const chats = await this.deps.chats.list(credential);
      if (generation !== this.generation || read !== this.viewReads) return;
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
      if (generation !== this.generation || read !== this.viewReads) return;
      // Whatever went wrong, the account's chats are unknown, and the screen
      // must not read that as "you have no chats" — which is why `chatsLoaded`
      // and the error travel together, and why the roster stays where it is.
      this.chatsLoaded = false;
      this.chatsError = messageOf(error);
      // But not every failure means the same thing to the person reading it.
      // Only a credential the server refused is fixed by re-activating; a
      // timeout or a 5xx is fixed by waiting. Offering to sign out for those
      // would charge a full re-activation over SMS for a blip.
      this.chatsNeedReactivation = isCredentialFailure(error);
      this.chats = [];
      this.relabelRows();
    }
  }

  private observe(agent: CloudAgentResource): void {
    this.rows.set(agent.agentId, this.rowFor(agent));
    this.publish();
  }

  private rowFor(agent: CloudAgentResource): CloudAgentDisplayRow {
    const line = agent.line;
    if (line) this.agentLines.set(agent.agentId, line);
    else this.agentLines.delete(agent.agentId);
    const lineUid = this.agentLineUid(agent);
    const details = this.lineDetails(lineUid);
    return toCloudAgentDisplayRow(agent, {
      line: details.line,
      canMessage: details.canMessage,
      threads: this.threadsFor(lineUid),
    });
  }

  private agentLineUid(agent: Pick<CloudAgentResource, "line">): string | null {
    return agent.line?.uid ?? null;
  }

  /**
   * The lines an agent can actually be created on: no agent occupies them, and
   * this account holds a home chat on them.
   *
   * The chat half is not cosmetic. `GET /v1/lines` answers with the service's
   * entire pool and no ownership predicate — `agentUid` is the only
   * account-scoped fact on a row — so a line this account has never held, or
   * one whose chats went away with a deleted agent, arrives looking free.
   * Offering it produces a refusal at create time, because the server resolves
   * a live home chat on the line before it will claim anything.
   *
   * Nothing is offered while the chat list is unknown. A failed refresh means
   * ownership is unknown, and the whole service pool is the wrong guess to make
   * about it — an empty picker says so, where a full one invites the failure
   * this exists to prevent.
   */
  private freeLines(): CloudAgentLine[] {
    if (!this.chatsLoaded) return [];
    return (this.lines ?? [])
      .filter((line) => line.agentUid === null && this.hasHomeChatOn(line.uid))
      .map((line) => this.lineDetails(line.uid).line!)
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * The server's home-chat test, applied to the chats already loaded.
   *
   * A line qualifies on an ACTIVE one-to-one thread with the account holder and
   * nothing else — the same three facts the API checks before it will claim an
   * agent. A thread still pending, or one with anybody else in it, is a real
   * chat on the line and still not somewhere an agent can be put.
   */
  private hasHomeChatOn(lineUid: string): boolean {
    return this.chats.some((chat) =>
      chat.lineUid === lineUid
      && chat.status === "active"
      && chat.memberCount === 1
      && chat.hasOwnerMember);
  }

  /** Resolve the line's current threads. */
  private threadsFor(lineUid: string | null): { uid: string; label: string }[] {
    if (lineUid === null) return [];
    return this.chats
      .filter((chat) => chat.lineUid === lineUid)
      .map((chat) => ({ uid: chat.uid, label: this.chatTitle(chat) }));
  }

  /** Resolve display and Messages addressability from the same line facts. */
  private lineDetails(lineUid: string | null): {
    line: CloudAgentLine | null;
    canMessage: boolean;
    smsUrl: string | null;
  } {
    if (lineUid === null) return { line: null, canMessage: false, smsUrl: null };
    const agentLine = [...this.agentLines.values()].find((line) => line.uid === lineUid);
    const known = this.lines?.find((line) => line.uid === lineUid);
    const chat = this.chats.find((candidate) => candidate.lineUid === lineUid);
    const name = (known?.displayName ?? agentLine?.displayName ?? "").trim();
    const numbers = [known?.number, agentLine?.number, chat?.recipients?.line]
      .filter((number): number is string => typeof number === "string")
      .map((number) => number.trim())
      .filter(Boolean);
    const messageNumber = numbers.find((number) => E164.test(number)) ?? null;
    const number = formatNumber(messageNumber ?? numbers[0] ?? "");
    return {
      line: {
        uid: lineUid,
        label: name && number ? `${name} · ${number}` : name || number || "Unknown line",
      },
      canMessage: messageNumber !== null,
      smsUrl: messageNumber === null ? null : `sms:${messageNumber}`,
    };
  }

  /** Build a thread label in the main process from the full chat resource. */
  private chatTitle(chat: CloudChatOption): string {
    const line = chat.recipients?.line ?? null;
    const lineName = this.lines?.find((row) => row.number === line)?.displayName ?? null;
    return chatRowTitle(chat.people, line, chat.label || chat.uid, lineName);
  }

  /**
   * Re-resolve what the chat list knows about each row's threads.
   *
   * Recipients arrive with chats, while a title also depends on the line list.
   * Each successful read resolves it from the current account view.
   */
  private relabelRows(): void {
    for (const [agentId, row] of this.rows) {
      const lineUid = this.agentLines.get(agentId)?.uid ?? null;
      const details = this.lineDetails(lineUid);
      const threads = this.threadsFor(lineUid);
      const unchanged = details.line?.uid === row.line?.uid &&
        details.line?.label === row.line?.label &&
        details.canMessage === row.canMessage &&
        threads.length === row.threads.length && threads.every(
        (thread, index) =>
          thread.uid === row.threads[index]?.uid && thread.label === row.threads[index]?.label,
      );
      if (!unchanged) this.rows.set(agentId, {
        ...row,
        line: details.line,
        canMessage: details.canMessage,
        threads,
      });
    }
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
    const wait = this.newAgentWait;
    const fresh = wait && [...this.rows.keys()].find((id) => !wait.known.has(id));
    if (fresh) wait.finish(fresh);
  }
}

/** Newest first; missing or equal creation dates fall back to display name. */
function byNewestFirst(a: CloudAgentDisplayRow, b: CloudAgentDisplayRow): number {
  const aCreated = Date.parse(a.createdAt);
  const bCreated = Date.parse(b.createdAt);
  const aKnown = Number.isFinite(aCreated);
  const bKnown = Number.isFinite(bCreated);
  if (aKnown && bKnown && aCreated !== bCreated) return bCreated - aCreated;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  return a.name.localeCompare(b.name) || a.agentId.localeCompare(b.agentId);
}

/**
 * A delete that failed on the provider's side and needs asking again.
 *
 * Read as a widened string: the client's status union is catching up with the
 * shipped enum, and an unrecognised status must never be a compile error here
 * — it is the server's word, not ours.
 */
function isTeardown(status: string | null): boolean {
  return status === "teardown";
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

/** Plow returns an uncoded 503 today; this arms the card when it adds the code, deliberately never matching detail text. */
function isNoNumbersAvailable(error: unknown): boolean {
  return error instanceof PlowApiError && error.code === "NO_CHAT_LINE_AVAILABLE";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function messageOf(error: unknown): string {
  // PlowApiError messages are written for a human and are credential-free by
  // construction — see plowApi.ts and cloudAgents.ts. Anything else is ours,
  // unexpected, and gets fixed text rather than whatever it happened to carry.
  if (error instanceof PlowApiError) return error.message;
  return "Something went wrong. Try again.";
}

/**
 * `GET /v1/chats` — every chat the account has, for line and thread display.
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
        // `chatEchoesCredential` is the one identifier rule, shared with the
        // activation response handled above. Optional names take the narrower
        // redaction below instead of costing the owner the whole row.
        if (chatEchoesCredential(chat, deviceCredential)) return [];

        const safe = withoutCredentialEchoes(chat, deviceCredential);
        return [{
          uid: chat.uid,
          lineUid: chat.lineUid,
          status: chat.status,
          memberCount: chat.memberCount,
          hasOwnerMember: chat.participants.some((member) => member.isOwner),
          label: activationChatLabel(safe),
          recipients: activationChatRecipients(safe),
          people: chatPeople(safe),
        }];
      });
  }
}

/**
 * `GET /v1/lines` — every pool number the service has, used as display
 * metadata for chats and agent lines.
 *
 * Reachable on either credential this Mac may hold: the stored login
 * session's `*:*`, or, on a Mac paired before Latch kept the session, the
 * narrow device credential's `chats:list`, which the route takes as
 * `GET /v1/chats` does. A device minted before `chats:list` existed holds
 * neither; that is what the 403 below is about, and why its sentence names
 * signing in again.
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

  async list(credential: string): Promise<CloudLineOption[]> {
    const response = await this.api.request("GET", "/v1/lines", { token: credential });

    if (response.status === 403) {
      // A Mac paired before this app kept the session holds a credential whose
      // scopes froze at mint, and no amount of retrying widens them. Signing in
      // again is the whole remedy, so the sentence says exactly that; main's
      // `signInAgainIfOldKey` starts it on the next relay connect.
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
      const row = raw as { uid?: unknown; provider_key?: unknown; display_name?: unknown; agent_uid?: unknown };
      const uid = typeof row.uid === "string" ? row.uid.trim() : "";
      const number = typeof row.provider_key === "string" ? row.provider_key.trim() : "";
      const name = typeof row.display_name === "string" ? row.display_name.trim() : "";
      // The number is E.164 or the row is dropped. Arbitrary server-authored
      // strings are not useful line identities.
      if (!uid || !E164.test(number)) return [];
      // The credential must not come back out through ANY server-authored
      // field, in any encoding. `uid` and `provider_key` are as server-authored
      // as the name is; a row echoing one is refused outright rather than
      // blanked, because there is nothing safe left to show of it.
      if (echoesCredential(uid, credential) || echoesCredential(number, credential)) return [];
      const safeName = name && !echoesCredential(name, credential) ? name : null;
      if (row.agent_uid !== null && typeof row.agent_uid !== "string") return [];
      return [{ uid, displayName: safeName, number, agentUid: row.agent_uid }];
    });
  }
}
