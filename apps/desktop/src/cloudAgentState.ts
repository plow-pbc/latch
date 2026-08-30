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
  echoesCredential,
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
 * failure that makes thread detail unavailable or mislabel a background refresh.
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
   * timeout would wipe the cached activation chat, which can still name a
   * legacy agent's fixed thread when the list is down.
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
}

/** The slice of `CloudAgentsClient` this state needs. */
export interface CloudAgentsApi {
  list(deviceCredential: string): Promise<CloudAgentResource[]>;
  delete(deviceCredential: string, agentId: string): Promise<void>;
}

export interface CloudChatsApi {
  list(deviceCredential: string): Promise<CloudChatOption[]>;
}

export interface CloudAgentStateDeps {
  agents: CloudAgentsApi;
  chats: CloudChatsApi;
  /** Plow's pool numbers, used as display metadata for chat rows. */
  lines?: { list(credential: string): Promise<CloudLineOption[]> };
  home: string;
  onChange?: () => void;
}

export class CloudAgentState {
  /** Keyed on `agent_id`, which is stable for the agent's whole life. */
  private rows = new Map<string, CloudAgentDisplayRow>();
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
      cloudAgentsError: this.agentsError,
      cloudChatsError: this.chatsError,
      cloudChatsNeedReactivation: this.chatsNeedReactivation,
      cloudActionError: this.actionError,
      cloudChatsLoaded: this.chatsLoaded,
    };
  }

  /**
   * Re-read server truth: the agents, their chats, and the line names that
   * identify those chats.
   *
   * Called on tab activation and after every mutation.
   * All three run together and none can fail the others — a chat list that
   * 403s still leaves the roster on screen, and a line failure still leaves
   * chats identified by number.
   */
  async refresh(): Promise<void> {
    const credential = this.credential();
    if (!credential) return;
    const generation = this.generation;
    const read = ++this.viewReads;
    let view = Promise.all([
      this.refreshChats(credential, generation, read),
      this.refreshLines(credential, generation, read),
    ]).then(() => {});
    this.viewSettled = view;
    await Promise.all([
      this.sequence(() => this.refreshAgents(credential, generation)),
      view,
    ]);
    // A newer chat or line read started while ours was in flight. Ours DROPPED
    // its own answer on purpose — a superseded read says nothing about now —
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
      // Keep the previous success as naming metadata for chats already on
      // screen. A line-list failure does not hide the chats or the roster.
      this.relabelRows();
    }
  }

  /** Remove an agent — the machine and its hold on the line, not just a key. */
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
    this.lines = null;
    this.generation += 1;
    this.tearingDown.clear();
    this.rows.clear();
    this.chats = [];
    this.chatsLoaded = false;
    this.chatsError = null;
    this.chatsNeedReactivation = false;
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
      const listed = new Map(
        agents.map((agent) => [agent.agentId, this.rowFor(agent)] as const),
      );
      this.rows = listed;
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
      // would destroy the cached activation chat — the very fallback installed
      // on the next line — and charge a full re-activation over SMS for a blip.
      this.chatsNeedReactivation = isCredentialFailure(error);
      // "Unknown" is not "none". Activation left us one chat, and it can still
      // label a legacy agent's fixed thread. Offered, never asserted:
      // `chatsLoaded` stays false.
      this.chats = storedChats(this.deps.home);
      // The rows may have been built before this landed, against no labels at
      // all — the success path relabels and this one has to as well, or a raw
      // chat uid sits on screen where a phone number belongs.
      this.relabelRows();
    }
  }

  private rowFor(agent: CloudAgentResource): CloudAgentDisplayRow {
    return toCloudAgentDisplayRow(agent, {
      line: this.lineFor(agent.lineUid),
      threads: this.threadsFor(agent.lineUid, agent.chatUids),
    });
  }

  /** Resolve the line's current threads, or a legacy agent's fixed grant. */
  private threadsFor(
    lineUid: string | null,
    legacyChatUids: readonly string[],
  ): { uid: string; label: string }[] {
    if (lineUid !== null) {
      return this.chats
        .filter((chat) => chat.lineUid === lineUid)
        .map((chat) => ({ uid: chat.uid, label: this.chatTitle(chat) }));
    }

    return legacyChatUids.map((uid) => {
      const chat = this.chats.find((candidate) => candidate.uid === uid);
      return { uid, label: chat ? this.chatTitle(chat) : uid };
    });
  }

  /** Resolve the agent's line by stable uid, even when it has no current chats. */
  private lineFor(lineUid: string | null): CloudAgentLine | null {
    if (lineUid === null) return null;
    const known = this.lines?.find((line) => line.uid === lineUid);
    const chat = this.chats.find((candidate) => candidate.lineUid === lineUid);
    const name = (known?.displayName ?? "").trim();
    const number = formatNumber(known?.number ?? chat?.recipients?.line ?? "");
    return {
      uid: lineUid,
      label: name && number ? `${name} · ${number}` : name || number || "Unknown line",
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
   * A row built before either read may have only legacy uids; each successful
   * read resolves it from the current account view.
   */
  private relabelRows(): void {
    for (const [agentId, row] of this.rows) {
      const lineUid = row.line?.uid ?? null;
      const line = this.lineFor(lineUid);
      const threads = this.threadsFor(
        lineUid,
        line === null ? row.threads.map((thread) => thread.uid) : [],
      );
      const unchanged = line?.uid === row.line?.uid && line?.label === row.line?.label &&
        threads.length === row.threads.length && threads.every(
        (thread, index) =>
          thread.uid === row.threads[index]?.uid && thread.label === row.threads[index]?.label,
      );
      if (!unchanged) this.rows.set(agentId, { ...row, line, threads });
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
  }
}

/** Newest first, matching the account roster. */
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
 * The chat activation left, as a one-entry fallback list.
 *
 * Reads the same record `onboarding.ts` reads, through the same function, so a
 * Mac cannot show a chat on one screen and a bare uid on the other.
 */
function storedChats(home: string): CloudChatOption[] {
  const chat = storedActivationChat(loadSettings(home));
  // No recipients: settings keep a uid and a label, never the participants. The
  // chat can still identify a legacy thread, but carries no line association.
  return chat ? [{ ...chat, lineUid: null, recipients: null, people: [] }] : [];
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
        // `chatEchoesCredential` is the one rule, shared with the redeem that
        // persists the label — which had no check at all until it was the same
        // function.
        if (chatEchoesCredential(chat, deviceCredential)) return [];

        const safe = withoutCredentialEchoes(chat, deviceCredential);
        return [{
          uid: chat.uid,
          lineUid: chat.lineUid,
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

  async list(credential: string): Promise<CloudLineOption[]> {
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
      const row = raw as { uid?: unknown; provider_key?: unknown; display_name?: unknown };
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
      return [{ uid, displayName: safeName, number }];
    });
  }
}
