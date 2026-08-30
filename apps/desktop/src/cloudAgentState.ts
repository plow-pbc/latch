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
  CloudAgentLineError,
  CloudAgentResource,
  CreateCloudAgentRequest,
  echoesCredential,
} from "./cloudAgents.js";
import {
  ACTIVATION_POLL_INTERVAL_MS,
  ChatRecipients,
  activationSmsBody,
  activationSmsUrl,
  activationChatLabel,
  activationChatRecipients,
  storedActivationChat,
} from "./onboarding.js";
import {
  Activation,
  PlowApi,
  PlowApiError,
  ProvisionedActivationRedeem,
  parseActivationChat,
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

export type CloudCreatePhase = "idle" | "activating" | "waiting" | "creating" | "error";

export interface CloudCreateUiState {
  phase: CloudCreatePhase;
  activation: {
    displayCode: string;
    sendTo: string;
    smsBody: string;
  } | null;
  message: string | null;
  createdAgentId: string | null;
  /** Whether retry must mint a fresh line instead of re-posting the agent body. */
  retryNewLine: boolean;
}

export interface CloudCreateInput {
  name: string;
  /** `null` asks Plow to provision a new line through activation. */
  lineUid: string | null;
}

export interface CloudChangeLineUiState {
  phase: CloudCreatePhase;
  activation: CloudCreateUiState["activation"];
  message: string | null;
  changedAgentId: string | null;
  /** Whether retry must mint a fresh line instead of repeating the PUT. */
  retryNewLine: boolean;
}

export interface CloudChangeLineInput {
  agentId: string;
  /** `null` asks Plow to provision a new line through activation. */
  lineUid: string | null;
}

type CloudLineFlow =
  | { kind: "create"; name: string }
  | { kind: "change"; agentId: string };

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
  /** Lines found on the owner's chats that no current agent occupies. */
  cloudFreeLines: CloudAgentLine[];
  cloudCreate: CloudCreateUiState;
  cloudChangeLine: CloudChangeLineUiState;
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
  create(deviceCredential: string, request: CreateCloudAgentRequest): Promise<CloudAgentResource>;
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

export interface CloudActivationApi {
  createProvisionedActivation(): Promise<Activation>;
  redeemProvisionedActivation(secret: string): Promise<ProvisionedActivationRedeem>;
}

export interface CloudChatsApi {
  list(deviceCredential: string): Promise<CloudChatOption[]>;
}

export interface CloudAgentStateDeps {
  agents: CloudAgentsApi;
  activation: CloudActivationApi;
  chats: CloudChatsApi;
  /** Plow's pool numbers, used as display metadata for chat rows. */
  lines?: { list(credential: string): Promise<CloudLineOption[]> };
  home: string;
  onChange?: () => void;
  wait?: (milliseconds: number) => Promise<void>;
  /** Value-free diagnostics only; anything passed here may reach a log. */
  warn?: (message: string) => void;
}

export class CloudAgentState {
  /** Keyed on `agent_id`, which is stable for the agent's whole life. */
  private rows = new Map<string, CloudAgentDisplayRow>();
  /** Fresh receipts stay visible until the account list catches up. */
  private pending = new Set<string>();
  private polls = new Map<string, AbortController>();
  private retryRequests = new Map<string, CreateCloudAgentRequest>();
  private lineFlowGeneration = 0;
  /** SECRET. Never crosses `state()` and is discarded on every terminal path. */
  private activationSecret: string | null = null;
  private activeLineFlow: "create" | "change" | null = null;
  private activeCreateRequest: CloudCreateInput | null = null;
  private activeChangeRequest: CloudChangeLineInput | null = null;
  private createUi: CloudCreateUiState = {
    phase: "idle",
    activation: null,
    message: null,
    createdAgentId: null,
    retryNewLine: false,
  };
  private changeUi: CloudChangeLineUiState = idleChangeLineUi();
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
      cloudFreeLines: this.freeLines(),
      cloudCreate: {
        ...this.createUi,
        activation: this.createUi.activation ? { ...this.createUi.activation } : null,
      },
      cloudChangeLine: {
        ...this.changeUi,
        activation: this.changeUi.activation ? { ...this.changeUi.activation } : null,
      },
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

  /** Start a new agent on a known line, or mint and watch a brand-new line. */
  async create(input: CloudCreateInput): Promise<string | null> {
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    const rawLineUid = input?.lineUid;
    if (rawLineUid !== null && typeof rawLineUid !== "string") {
      this.setCreateError("Pick a line for this agent.", false);
      return null;
    }
    const lineUid = typeof rawLineUid === "string" ? rawLineUid.trim() : null;
    if (rawLineUid !== null && !lineUid) {
      this.setCreateError("Pick a line for this agent.", false);
      return null;
    }
    const credential = this.credential();
    if (!credential) {
      this.setCreateError("This Mac isn't signed in yet.", false);
      return null;
    }

    const flow = ++this.lineFlowGeneration;
    this.activationSecret = null;
    this.activeLineFlow = "create";
    this.activeCreateRequest = { name, lineUid };
    this.activeChangeRequest = null;
    this.changeUi = idleChangeLineUi();
    this.createUi = {
      phase: lineUid === null ? "activating" : "creating",
      activation: null,
      message: null,
      createdAgentId: null,
      retryNewLine: false,
    };
    this.publish();

    if (lineUid !== null) {
      return this.provision({ name, lineUid }, this.generation, flow);
    }
    return this.startNewLine({ kind: "create", name }, this.generation, flow);
  }

  /** Stop watching a new-line activation. No cloud-agent POST follows it. */
  cancelCreate(): void {
    if (this.activeLineFlow === "create") {
      this.lineFlowGeneration += 1;
      this.activationSecret = null;
      this.activeLineFlow = null;
    }
    this.activeCreateRequest = null;
    this.createUi = idleCreateUi();
    this.publish();
  }

  /** Retry the action still shown in the New agent modal. */
  async retryCreate(): Promise<string | null> {
    const request = this.activeCreateRequest;
    if (!request) return null;
    return this.create(request);
  }

  /** Move any current or legacy agent to a known line, or mint a new one. */
  async changeLine(input: CloudChangeLineInput): Promise<string | null> {
    const agentId = typeof input?.agentId === "string" ? input.agentId.trim() : "";
    const rawLineUid = input?.lineUid;
    const lineUid = typeof rawLineUid === "string" ? rawLineUid.trim() : null;
    if (!agentId || !this.rows.has(agentId)) {
      this.setChangeLineError("That agent is no longer available.", false);
      return null;
    }
    if (rawLineUid !== null && (!lineUid || typeof rawLineUid !== "string")) {
      this.setChangeLineError("Pick a line for this agent.", false);
      return null;
    }
    if (!this.credential()) {
      this.setChangeLineError("This Mac isn't signed in yet.", false);
      return null;
    }

    const flow = ++this.lineFlowGeneration;
    this.activationSecret = null;
    this.activeLineFlow = "change";
    this.activeCreateRequest = null;
    this.createUi = idleCreateUi();
    this.activeChangeRequest = { agentId, lineUid };
    this.changeUi = {
      phase: lineUid === null ? "activating" : "creating",
      activation: null,
      message: null,
      changedAgentId: null,
      retryNewLine: false,
    };
    this.publish();

    if (lineUid !== null) return this.moveToLine(agentId, lineUid, this.generation, flow);
    return this.startNewLine({ kind: "change", agentId }, this.generation, flow);
  }

  cancelChangeLine(): void {
    if (this.activeLineFlow === "change") {
      this.lineFlowGeneration += 1;
      this.activationSecret = null;
      this.activeLineFlow = null;
    }
    this.activeChangeRequest = null;
    this.changeUi = idleChangeLineUi();
    this.publish();
  }

  async retryChangeLine(): Promise<string | null> {
    const request = this.activeChangeRequest;
    if (!request) return null;
    return this.changeLine(request);
  }

  /** Re-post the exact create body retained for a failed roster row. */
  async retryFailed(agentId: string): Promise<string | null> {
    const id = (agentId ?? "").trim();
    const request = this.retryRequests.get(id);
    if (!request || this.rows.get(id)?.status !== "failed") return null;
    const credential = this.credential();
    if (!credential) return this.failAction("This Mac isn't signed in yet.");
    this.actionError = null;
    return this.provision(request, this.generation, null);
  }

  /** Main owns external navigation; the renderer never receives this URL. */
  createSmsUrl(): string | null {
    const activation = this.activeLineFlow === "change"
      ? this.changeUi.activation
      : this.createUi.activation;
    if (!this.activationSecret || !activation) return null;
    return activationSmsUrl(
      activation.sendTo,
      activation.displayCode,
    );
  }

  private async startNewLine(
    action: CloudLineFlow,
    generation: number,
    flow: number,
  ): Promise<null> {
    let created: Activation;
    try {
      created = await this.deps.activation.createProvisionedActivation();
    } catch (error) {
      if (this.isCurrentLineFlow(action.kind, generation, flow)) {
        this.setLineFlowError(action, messageOf(error), true);
      }
      return null;
    }
    if (!this.isCurrentLineFlow(action.kind, generation, flow)) return null;

    this.activationSecret = created.activationSecret;
    const waiting: Omit<CloudCreateUiState, "createdAgentId"> = {
      phase: "waiting",
      activation: {
        displayCode: created.displayCode,
        sendTo: created.sendTo,
        smsBody: activationSmsBody(created.displayCode),
      },
      message: null,
      retryNewLine: false,
    };
    if (action.kind === "create") {
      this.createUi = { ...waiting, createdAgentId: null };
    } else {
      this.changeUi = { ...waiting, changedAgentId: null };
    }
    this.publish();
    void this.pollNewLine(created.activationSecret, action, generation, flow);
    return null;
  }

  private async pollNewLine(
    secret: string,
    action: CloudLineFlow,
    generation: number,
    flow: number,
  ): Promise<void> {
    while (
      this.isCurrentLineFlow(action.kind, generation, flow) &&
      this.activationSecret === secret
    ) {
      await (this.deps.wait ?? defaultWait)(ACTIVATION_POLL_INTERVAL_MS);
      if (!this.isCurrentLineFlow(action.kind, generation, flow) || this.activationSecret !== secret) {
        return;
      }

      let result: ProvisionedActivationRedeem;
      try {
        result = await this.deps.activation.redeemProvisionedActivation(secret);
      } catch (error) {
        if (!this.isCurrentLineFlow(action.kind, generation, flow)) return;
        if (error instanceof PlowApiError && error.kind === "expired") {
          this.activationSecret = null;
          this.setLineFlowError(
            action,
            action.kind === "create"
              ? "That code expired. Retry New agent."
              : "That code expired. Try again.",
            true,
          );
          return;
        }
        if (action.kind === "create") {
          this.createUi = { ...this.createUi, message: messageOf(error) };
        } else {
          this.changeUi = { ...this.changeUi, message: messageOf(error) };
        }
        this.publish();
        continue;
      }
      if (result.status === "pending") continue;
      if (!this.isCurrentLineFlow(action.kind, generation, flow)) return;

      this.activationSecret = null;
      const lineUid = (result.chat?.lineUid ?? "").trim();
      const credential = this.credential();
      if (!lineUid || echoesCredential(lineUid, credential)) {
        this.deps.warn?.(
          `[cloud-agent] verified activation missing line uid: ${JSON.stringify(result.shape)}`,
        );
        this.setLineFlowError(action, "Couldn't read the line for this agent.", true);
        return;
      }

      if (result.chat && !chatEchoesCredential(result.chat, credential)) {
        const safe = withoutCredentialEchoes(result.chat, credential);
        const createdChat: CloudChatOption = {
          uid: safe.uid,
          lineUid: safe.lineUid,
          label: activationChatLabel(safe),
          recipients: activationChatRecipients(safe),
          people: chatPeople(safe),
        };
        this.chats = [
          ...this.chats.filter((chat) => chat.uid !== createdChat.uid),
          createdChat,
        ];
        this.relabelRows();
      }

      if (action.kind === "create") {
        const request = { name: action.name, lineUid };
        this.activeCreateRequest = request;
        this.createUi = {
          phase: "creating",
          activation: null,
          message: null,
          createdAgentId: null,
          retryNewLine: false,
        };
        this.publish();
        await this.provision(request, generation, flow);
      } else {
        this.activeChangeRequest = { agentId: action.agentId, lineUid };
        this.changeUi = {
          phase: "creating",
          activation: null,
          message: null,
          changedAgentId: null,
          retryNewLine: false,
        };
        this.publish();
        await this.moveToLine(action.agentId, lineUid, generation, flow);
      }
      return;
    }
  }

  private async provision(
    request: CreateCloudAgentRequest,
    generation: number,
    flow: number | null,
  ): Promise<string | null> {
    const credential = this.credential();
    if (!credential || generation !== this.generation) return null;
    let receipt: CloudAgentResource;
    try {
      receipt = await this.sequence(() => this.deps.agents.create(credential, request));
    } catch (error) {
      if (generation !== this.generation || (flow !== null && flow !== this.lineFlowGeneration)) {
        return null;
      }
      if (flow === null) this.failAction(messageOf(error));
      else this.setCreateError(messageOf(error), false);
      return null;
    }
    if (generation !== this.generation || (flow !== null && flow !== this.lineFlowGeneration)) {
      return null;
    }

    this.retryRequests.set(receipt.agentId, { ...request });
    this.pending.add(receipt.agentId);
    this.observe(receipt, request);
    this.startAgentPoll(credential, receipt, request, generation);
    if (flow !== null) {
      this.activeLineFlow = null;
      this.createUi = {
        phase: "idle",
        activation: null,
        message: null,
        createdAgentId: receipt.agentId,
        retryNewLine: false,
      };
      this.publish();
    }
    return receipt.agentId;
  }

  private async moveToLine(
    agentId: string,
    lineUid: string,
    generation: number,
    flow: number,
  ): Promise<string | null> {
    const credential = this.credential();
    if (!credential || !this.isCurrentLineFlow("change", generation, flow)) return null;
    let moved: CloudAgentResource;
    try {
      moved = await this.sequence(() => this.deps.agents.changeLine(
        credential,
        agentId,
        lineUid,
      ));
    } catch (error) {
      if (!this.isCurrentLineFlow("change", generation, flow)) return null;
      if (error instanceof CloudAgentLineError && error.code === "line_occupied") {
        await this.refresh();
        if (!this.isCurrentLineFlow("change", generation, flow)) return null;
        this.activeChangeRequest = null;
        this.changeUi = {
          ...idleChangeLineUi(),
          message: error.message,
        };
        this.publish();
      } else {
        this.setChangeLineError(messageOf(error), false);
      }
      return null;
    }
    if (!this.isCurrentLineFlow("change", generation, flow)) return null;

    const previous = this.rows.get(agentId);
    const display = moved.name || !previous?.name
      ? moved
      : { ...moved, name: previous.name };
    this.rows.set(agentId, this.rowFor(display));
    this.retryRequests.set(agentId, {
      lineUid,
      name: moved.name ?? previous?.name ?? "",
    });
    this.activeLineFlow = null;
    this.changeUi = {
      phase: "idle",
      activation: null,
      message: null,
      changedAgentId: agentId,
      retryNewLine: false,
    };
    this.publish();
    return agentId;
  }

  private startAgentPoll(
    credential: string,
    receipt: CloudAgentResource,
    request: CreateCloudAgentRequest,
    generation: number,
  ): void {
    this.abortPoll(receipt.agentId);
    const controller = new AbortController();
    this.polls.set(receipt.agentId, controller);
    void this.pollToTerminal(credential, receipt, request, generation, controller.signal);
  }

  private async pollToTerminal(
    credential: string,
    receipt: CloudAgentResource,
    request: CreateCloudAgentRequest,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.deps.agents.poll(
        credential,
        receipt,
        (agent) => {
          if (generation === this.generation) this.observe(agent, request);
        },
        signal,
      );
    } catch (error) {
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

  private isCurrentLineFlow(
    kind: "create" | "change",
    generation: number,
    flow: number,
  ): boolean {
    return generation === this.generation &&
      flow === this.lineFlowGeneration &&
      this.activeLineFlow === kind;
  }

  private setCreateError(message: string, retryNewLine: boolean): void {
    this.activationSecret = null;
    this.createUi = {
      phase: "error",
      activation: null,
      message,
      createdAgentId: null,
      retryNewLine,
    };
    this.publish();
  }

  private setChangeLineError(message: string, retryNewLine: boolean): void {
    this.activationSecret = null;
    this.changeUi = {
      phase: "error",
      activation: null,
      message,
      changedAgentId: null,
      retryNewLine,
    };
    this.publish();
  }

  private setLineFlowError(
    action: CloudLineFlow,
    message: string,
    retryNewLine: boolean,
  ): void {
    if (action.kind === "create") this.setCreateError(message, retryNewLine);
    else this.setChangeLineError(message, retryNewLine);
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
      this.pending.delete(id);
      this.retryRequests.delete(id);
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
    this.lineFlowGeneration += 1;
    this.activationSecret = null;
    this.activeLineFlow = null;
    this.activeCreateRequest = null;
    this.activeChangeRequest = null;
    this.createUi = idleCreateUi();
    this.changeUi = idleChangeLineUi();
    this.tearingDown.clear();
    for (const agentId of [...this.polls.keys()]) this.abortPoll(agentId);
    this.rows.clear();
    this.pending.clear();
    this.retryRequests.clear();
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
        this.pending.delete(agentId);
        this.retryRequests.delete(agentId);
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
      for (const agent of agents) {
        const lineUid = this.agentLineUid(agent);
        if (lineUid !== null) {
          this.retryRequests.set(agent.agentId, {
            lineUid,
            name: agent.name ?? "",
          });
        }
      }
      for (const [agentId, row] of this.rows) {
        if (!listed.has(agentId) && this.pending.has(agentId)) listed.set(agentId, row);
      }
      for (const agentId of this.retryRequests.keys()) {
        if (!listed.has(agentId)) this.retryRequests.delete(agentId);
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

  private observe(agent: CloudAgentResource, request: CreateCloudAgentRequest): void {
    this.retryRequests.set(agent.agentId, { ...request });
    this.rows.set(agent.agentId, this.rowFor(agent, request.name));
    this.publish();
  }

  private rowFor(agent: CloudAgentResource, fallbackName = ""): CloudAgentDisplayRow {
    const displayAgent = fallbackName && !agent.name ? { ...agent, name: fallbackName } : agent;
    const lineUid = this.agentLineUid(agent);
    return toCloudAgentDisplayRow(displayAgent, {
      line: this.lineFor(lineUid),
      threads: this.threadsFor(lineUid, agent.chatUids),
    });
  }

  /** Resolve older API rows through their first (home) chat. */
  private agentLineUid(agent: Pick<CloudAgentResource, "lineUid" | "chatUids">): string | null {
    if (agent.lineUid !== null) return agent.lineUid;
    const homeChatUid = agent.chatUids[0];
    return this.chats.find((chat) => chat.uid === homeChatUid)?.lineUid ?? null;
  }

  private freeLines(): CloudAgentLine[] {
    if (!this.chatsLoaded) return [];
    const occupied = new Set<string>();
    const legacyChatUids = new Set<string>();
    for (const row of this.rows.values()) {
      if (row.line) {
        occupied.add(row.line.uid);
      } else {
        for (const thread of row.threads) legacyChatUids.add(thread.uid);
      }
    }
    for (const chat of this.chats) {
      if (chat.lineUid && legacyChatUids.has(chat.uid)) occupied.add(chat.lineUid);
    }
    const seen = new Set<string>();
    const free: CloudAgentLine[] = [];
    for (const chat of this.chats) {
      const uid = chat.lineUid;
      if (!uid || occupied.has(uid) || seen.has(uid)) continue;
      seen.add(uid);
      const line = this.lineFor(uid);
      if (line) free.push(line);
    }
    return free.sort((a, b) => a.label.localeCompare(b.label));
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
      const lineUid = row.line?.uid ??
        this.chats.find((chat) => chat.uid === row.threads[0]?.uid)?.lineUid ??
        null;
      const line = this.lineFor(lineUid);
      const threads = this.threadsFor(
        lineUid,
        line === null ? row.threads.map((thread) => thread.uid) : [],
      );
      if (lineUid !== null) {
        this.retryRequests.set(agentId, { lineUid, name: row.name });
      }
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

const defaultWait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function idleCreateUi(): CloudCreateUiState {
  return {
    phase: "idle",
    activation: null,
    message: null,
    createdAgentId: null,
    retryNewLine: false,
  };
}

function idleChangeLineUi(): CloudChangeLineUiState {
  return {
    phase: "idle",
    activation: null,
    message: null,
    changedAgentId: null,
    retryNewLine: false,
  };
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
