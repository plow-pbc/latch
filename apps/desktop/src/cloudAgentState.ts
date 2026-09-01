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
  RowHandle,
  RowHandles,
  RowKey,
  agentIdOf,
  rowKey,
  targetIdOf,
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
} from "./onboarding.js";
import {
  Activation,
  AgentTarget,
  ApiBaseUrl,
  BUILTIN_TARGET_ID,
  KeyInfo,
  LOCAL_TARGET_ID,
  PlowApi,
  PlowApiError,
  ProvisionedActivationRedeem,
  canonicalAgentHostUrl,
  parseActivationChat,
  parseApiTimestamp,
} from "./plowApi.js";
import {
  ChatPerson,
  chatEchoesCredential,
  chatPeople,
  chatRowTitle,
  formatNumber,
  withoutCredentialEchoes,
} from "./chatRows.js";
import { createHash } from "node:crypto";
import { loadSettings, saveSettings } from "./settings.js";

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
   * Null is a real answer, not a gap to paper over. A screen that cannot
   * address the chat must say so rather than send to whatever it can find in
   * the label.
   */
  recipients: ChatRecipients | null;
  /** The humans in this chat, with names and which one is the owner — what
   * `chatRows.ts` builds the title and subtitle from. */
  people: ChatPerson[];
}

export type CloudLineFlowPhase = "idle" | "activating" | "waiting" | "creating" | "error";

export interface CloudLineFlowUiState {
  phase: CloudLineFlowPhase;
  activation: {
    displayCode: string;
    sendTo: string;
    smsBody: string;
  } | null;
  message: string | null;
  /** The finished agent's renderer HANDLE, to focus by. An agent id alone
   * would focus whichever host's row sorted first, and a `RowKey` would carry
   * host-authored bytes across the boundary. */
  completedRowKey: string | null;
  /** Whether retry must mint a fresh line instead of repeating the final mutation. */
  retryNewLine: boolean;
  /** A terminal condition for which repeating the same request cannot help. */
  terminal: "no_numbers" | null;
}

export interface CloudCreateInput {
  name: string;
  /** Provider executable selected in the New agent form. */
  provider: string;
  /** `null` asks Plow to provision a new line through activation. */
  lineUid: string | null;
  /** Which host provisions this agent. Absent means the built-in Plow. */
  targetId?: string;
}

/**
 * One host, as the renderer is allowed to see it.
 *
 * `AgentTarget` minus its bearer, and the omission is the point: the form
 * needs to name a host, never to authenticate to one.
 */
export interface CloudTargetOption {
  id: string;
  baseUrl: string;
  /** The derived Plow target, which cannot be edited or forgotten. */
  builtin: boolean;
}

export interface CloudChangeLineInput {
  /** The opaque row key; it names the host as well as the agent. */
  rowKey: RowKey;
  /** `null` asks Plow to provision a new line through activation. */
  lineUid: string | null;
}

type CloudLineRequest =
  | ({ kind: "create" } & CloudCreateInput)
  | ({ kind: "change" } & CloudChangeLineInput);

interface CloudLineFlow {
  kind: CloudLineRequest["kind"];
  request: CloudLineRequest | null;
  ui: CloudLineFlowUiState;
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
  /** Lines found on the owner's chats that no current agent occupies. */
  cloudFreeLines: CloudAgentLine[];
  cloudLineFlow: CloudLineFlowUiState;
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
  /** Every host the New agent form may provision on, built-in first. */
  cloudTargets: CloudTargetOption[];
}

/** The slice of `CloudAgentsClient` this state needs. */
export interface CloudAgentsApi {
  create(target: AgentTarget, request: CreateCloudAgentRequest): Promise<CloudAgentResource>;
  changeLine(
    target: AgentTarget,
    agentId: string,
    lineUid: string,
  ): Promise<CloudAgentResource>;
  list(target: AgentTarget): Promise<CloudAgentResource[]>;
  delete(target: AgentTarget, agentId: string): Promise<void>;
  poll(
    target: AgentTarget,
    receipt: CloudAgentResource,
    onTransition?: (agent: CloudAgentResource) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<CloudAgentResource>;
}

export interface CloudActivationApi {
  createProvisionedActivation(): Promise<Activation>;
  redeemProvisionedActivation(secret: string): Promise<ProvisionedActivationRedeem>;
  listApiKeys(deviceCredential: string): Promise<KeyInfo[]>;
  revokeApiKey(deviceCredential: string, id: number): Promise<unknown>;
}

export interface CloudChatsApi {
  list(deviceCredential: string): Promise<CloudChatOption[]>;
}

export interface CloudAgentStateDeps {
  agents: CloudAgentsApi;
  /** The origin the built-in Plow target is derived from — this build's. */
  baseUrl: ApiBaseUrl;
  activation: CloudActivationApi;
  chats: CloudChatsApi;
  /** Plow's pool numbers, used as display metadata for chat rows. */
  lines?: { list(credential: string): Promise<CloudLineOption[]> };
  home: string;
  recordAudit: (
    event: string,
    fields: Record<string, string | number | boolean>,
  ) => void;
  onChange?: () => void;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  /** Value-free diagnostics only; anything passed here may reach a log. */
  warn?: (message: string) => void;
}

export class CloudAgentState {
  /** Keyed on `agent_id`, which is stable for the agent's whole life. */
  private rows = new Map<RowKey, CloudAgentDisplayRow>();
  /** Home-chat identity stays private while chat results resolve each line. */
  private homeChatUids = new Map<RowKey, string>();
  /** Fresh receipts stay visible until the account list catches up. */
  private pending = new Set<RowKey>();
  private polls = new Map<RowKey, AbortController>();
  /** Create choices retained in main; chats may resolve the line after agents load. */
  private retainedCreates = new Map<RowKey, CloudCreateInput>();
  private lineFlowGeneration = 0;
  /** SECRET. Never crosses `state()` and is discarded on every terminal path. */
  private activationSecret: string | null = null;
  private lineFlow: CloudLineFlow | null = null;
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
  private tearingDown = new Set<RowKey>();
  /**
   * Bumped whenever the self-hosted host changes or goes away.
   *
   * A roster read is in flight for as long as the slowest host takes to
   * answer, and `LOCAL_TARGET_ID` is a SLOT, not a machine — so a read that
   * started against the old box would otherwise land after the swap and put
   * its rows back under an id that now points somewhere else. The next Delete
   * would then be addressed to a machine that never had that agent. Same
   * shape as `generation` and `viewReads`: the answer is dropped, not merged.
   */
  private hostRevision = 0;
  /**
   * The renderer's handles for these rows.
   *
   * A `RowKey` embeds the host-authored `agent_id`, so it must not cross into
   * the sandboxed renderer: a self-host could return `base64(bearer)` as its
   * id, pass `echoesCredential`'s literal check, and put reversible credential
   * material in the DOM. The renderer gets a minted token instead and hands it
   * back; only this side can turn it into an identity.
   */
  private readonly handles = new RowHandles();

  constructor(private readonly deps: CloudAgentStateDeps) {}

  state(): CloudAgentsUiState {
    return {
      cloudAgents: [...this.rows.values()].sort(byNewestFirst),
      cloudFreeLines: this.freeLines(),
      cloudLineFlow: {
        ...(this.lineFlow?.ui ?? idleLineFlowUi()),
        activation: this.lineFlow?.ui.activation ? { ...this.lineFlow.ui.activation } : null,
      },
      cloudAgentsError: this.agentsError,
      cloudChatsError: this.chatsError,
      cloudChatsNeedReactivation: this.chatsNeedReactivation,
      cloudActionError: this.actionError,
      cloudChatsLoaded: this.chatsLoaded,
      cloudTargets: this.targets().map((target) => ({
        id: target.id,
        baseUrl: target.baseUrl,
        builtin: target.id === BUILTIN_TARGET_ID,
      })),
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
    const revision = this.hostRevision;
    const read = ++this.viewReads;
    let view = Promise.all([
      this.refreshChats(credential, generation, read),
      this.refreshLines(credential, generation, read),
    ]).then(() => {});
    this.viewSettled = view;
    await Promise.all([
      this.sequence(() => this.refreshAgents(this.targets(), generation, revision)),
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
    const provider = typeof input?.provider === "string" ? input.provider.trim() : "";
    if (!provider) {
      this.setLineFlowError("create", "Pick an agent type.", false);
      return null;
    }
    const rawLineUid = input?.lineUid;
    if (rawLineUid !== null && typeof rawLineUid !== "string") {
      this.setLineFlowError("create", "Pick a line for this agent.", false);
      return null;
    }
    const lineUid = typeof rawLineUid === "string" ? rawLineUid.trim() : null;
    if (rawLineUid !== null && !lineUid) {
      this.setLineFlowError("create", "Pick a line for this agent.", false);
      return null;
    }
    const credential = this.credential();
    if (!credential) {
      this.setLineFlowError("create", "This Mac isn't signed in yet.", false);
      return null;
    }
    // Resolved here rather than at POST time so a host forgotten between
    // opening the form and pressing the button fails on the form, with a
    // sentence, instead of silently provisioning on Plow instead.
    const target = this.target(input?.targetId);
    if (!target) {
      this.setLineFlowError("create", "That host is no longer set up on this Mac.", false);
      return null;
    }

    const request: CloudLineRequest = {
      kind: "create",
      name,
      provider,
      lineUid,
      targetId: target.id,
    };
    const flow = this.beginLineFlow(request);

    if (lineUid !== null) return this.finishLineFlow(request, this.generation, flow);
    return this.startNewLine(request, this.generation, flow);
  }

  /** Stop watching a new-line activation. No cloud-agent POST follows it. */
  cancelLineFlow(): void {
    if (this.lineFlow) {
      this.lineFlowGeneration += 1;
      this.activationSecret = null;
    }
    this.lineFlow = null;
    this.publish();
  }

  /** Retry the action still shown in the line picker. */
  async retryLineFlow(): Promise<string | null> {
    const request = this.lineFlow?.request;
    if (!request) return null;
    return request.kind === "create" ? this.create(request) : this.changeLine(request);
  }

  /** Move an agent to a known line, or mint a new one. */
  async changeLine(input: CloudChangeLineInput): Promise<string | null> {
    const key = input?.rowKey;
    const agentId = key ? agentIdOf(key) : "";
    const rawLineUid = input?.lineUid;
    const lineUid = typeof rawLineUid === "string" ? rawLineUid.trim() : null;
    if (!agentId || !this.rows.has(key)) {
      this.setLineFlowError("change", "That agent is no longer available.", false);
      return null;
    }
    if (rawLineUid !== null && (!lineUid || typeof rawLineUid !== "string")) {
      this.setLineFlowError("change", "Pick a line for this agent.", false);
      return null;
    }
    if (!this.credential()) {
      this.setLineFlowError("change", "This Mac isn't signed in yet.", false);
      return null;
    }

    // The host rides ALONG, not just into the validation above: `finishLineFlow`
    // rebuilds the key from the request, so dropping it here sent the PUT to
    // Plow for an agent that lives on the self-host.
    const request: CloudLineRequest = { kind: "change", rowKey: key, lineUid };
    const flow = this.beginLineFlow(request);

    if (lineUid !== null) return this.finishLineFlow(request, this.generation, flow);
    return this.startNewLine(request, this.generation, flow);
  }

  /** Re-post the exact create body retained for a failed roster row. */
  async retryFailed(key: RowKey): Promise<string | null> {
    const retained = this.retainedCreates.get(key);
    if (!retained || retained.lineUid === null || this.rows.get(key)?.status !== "failed") return null;
    if (!this.target(retained.targetId)) {
      return this.failAction("That host is no longer set up on this Mac.");
    }
    this.actionError = null;
    return this.provision({ ...retained, lineUid: retained.lineUid }, this.generation, null);
  }

  /** Main owns external navigation; the renderer never receives this URL. */
  createSmsUrl(): string | null {
    const activation = this.lineFlow?.ui.activation;
    if (!this.activationSecret || !activation) return null;
    return activationSmsUrl(
      activation.sendTo,
      activation.displayCode,
    );
  }

  /** A Messages deep link for one resolved agent line, kept in main-process state. */
  agentSmsUrl(key: RowKey): string | null {
    const lineUid = this.rows.get(key)?.line?.uid;
    return this.lineDetails(lineUid ?? null).smsUrl;
  }

  private async startNewLine(
    action: CloudLineRequest,
    generation: number,
    flow: number,
  ): Promise<null> {
    const activationStartedAt = (this.deps.now ?? Date.now)();
    let created: Activation;
    try {
      created = await this.deps.activation.createProvisionedActivation();
    } catch (error) {
      if (this.isCurrentLineFlow(action.kind, generation, flow)) {
        if (isNoNumbersAvailable(error)) this.setNoNumbersAvailable(action.kind);
        else this.setLineFlowError(action.kind, messageOf(error), true);
      }
      return null;
    }
    if (!this.isCurrentLineFlow(action.kind, generation, flow)) return null;

    this.activationSecret = created.activationSecret;
    const waiting: CloudLineFlowUiState = {
      phase: "waiting",
      activation: {
        displayCode: created.displayCode,
        sendTo: created.sendTo,
        smsBody: activationSmsBody(created.displayCode),
      },
      message: null,
      completedRowKey: null,
      retryNewLine: false,
      terminal: null,
    };
    this.lineFlow = { kind: action.kind, request: action, ui: waiting };
    this.publish();
    void this.pollNewLine(
      created.activationSecret,
      action,
      generation,
      flow,
      activationStartedAt,
    );
    return null;
  }

  private async pollNewLine(
    secret: string,
    action: CloudLineRequest,
    generation: number,
    flow: number,
    activationStartedAt: number,
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
            action.kind,
            action.kind === "create"
              ? "That code expired. Retry New agent."
              : "That code expired. Try again.",
            true,
          );
          return;
        }
        if (this.lineFlow) {
          this.lineFlow = {
            ...this.lineFlow,
            ui: { ...this.lineFlow.ui, message: messageOf(error) },
          };
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
        this.setLineFlowError(action.kind, "Couldn't read the line for this agent.", true);
        void this.cleanupActivationSession(activationStartedAt);
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

      const request: CloudLineRequest = { ...action, lineUid };
      this.lineFlow = {
        kind: action.kind,
        request,
        ui: { ...idleLineFlowUi(), phase: "creating" },
      };
      this.publish();
      await this.finishLineFlow(request, generation, flow);
      void this.cleanupActivationSession(activationStartedAt);
      return;
    }
  }

  /** Revoke only the credential minted by this verified activation, if unique. */
  private async cleanupActivationSession(activationStartedAt: number): Promise<void> {
    const credential = this.credential();
    if (!credential) {
      this.recordActivationCleanup({ outcome: "no_credential" });
      return;
    }

    let keys: KeyInfo[];
    try {
      keys = await this.deps.activation.listApiKeys(credential);
    } catch (error) {
      this.recordActivationCleanup({
        outcome: "failed",
        stage: "lookup",
        error: messageOf(error),
      });
      return;
    }

    const candidates = keys.filter((key) => {
      if (!key.is_active || key.agent_id !== null) return false;
      if (key.name?.trim() || !key.scopes.includes("*:*")) return false;
      // resolve_bearer_token commits the caller's last_seen_at touch before the
      // list route body, so this Mac is not a never-used candidate.
      if (key.last_seen_at !== null || key.created_at === null) return false;
      const createdAt = parseApiTimestamp(key.created_at);
      // Cross-clock fallback: Plow authors createdAt while this Mac records the
      // flow start; a session id in the redeem response would remove this compare.
      return Number.isFinite(createdAt) && createdAt >= activationStartedAt;
    });
    if (candidates.length === 0) {
      this.recordActivationCleanup({ outcome: "no_match" });
      return;
    }
    if (candidates.length > 1) {
      this.recordActivationCleanup({
        outcome: "ambiguous",
        candidateCount: candidates.length,
      });
      return;
    }

    const [candidate] = candidates;
    try {
      await this.deps.activation.revokeApiKey(credential, candidate.id);
      this.recordActivationCleanup({ outcome: "revoked", keyId: candidate.id });
    } catch (error) {
      this.recordActivationCleanup({
        outcome: "failed",
        stage: "revoke",
        keyId: candidate.id,
        error: messageOf(error),
      });
    }
  }

  private recordActivationCleanup(
    fields: Record<string, string | number | boolean>,
  ): void {
    try {
      this.deps.recordAudit("activation_session_cleanup", fields);
    } catch (error) {
      console.error("[cloud-agent] could not audit activation-session cleanup:", error);
    }
  }

  private finishLineFlow(
    request: CloudLineRequest,
    generation: number,
    flow: number,
  ): Promise<string | null> {
    const lineUid = request.lineUid;
    if (lineUid === null) return Promise.resolve(null);
    return request.kind === "create"
      ? this.provision(
        { name: request.name, provider: request.provider, lineUid, targetId: request.targetId },
        generation,
        flow,
      )
      : this.moveToLine(request.rowKey, agentIdOf(request.rowKey), lineUid, generation, flow);
  }

  private async provision(
    request: CloudCreateInput & { lineUid: string },
    generation: number,
    flow: number | null,
  ): Promise<string | null> {
    const target = this.target(request.targetId);
    if (!target || generation !== this.generation) return null;
    let receipt: CloudAgentResource;
    try {
      receipt = await this.sequence(() => this.deps.agents.create(target, request));
    } catch (error) {
      if (generation !== this.generation || (flow !== null && flow !== this.lineFlowGeneration)) {
        return null;
      }
      if (flow === null) this.failAction(messageOf(error));
      else this.setLineFlowError("create", messageOf(error), false);
      return null;
    }
    if (generation !== this.generation || (flow !== null && flow !== this.lineFlowGeneration)) {
      return null;
    }

    this.pending.add(rowKey(target.id, receipt.agentId));
    this.observe(receipt, request, target);
    this.startAgentPoll(target, receipt, request, generation);
    if (flow !== null) {
      this.completeLineFlow(rowKey(target.id, receipt.agentId));
      this.publish();
    }
    return receipt.agentId;
  }

  private async moveToLine(
    key: RowKey,
    agentId: string,
    lineUid: string,
    generation: number,
    flow: number,
  ): Promise<string | null> {
    const target = this.targetForKey(key);
    if (!target || !this.isCurrentLineFlow("change", generation, flow)) return null;
    let moved: CloudAgentResource;
    try {
      moved = await this.sequence(() => this.deps.agents.changeLine(
        target,
        agentId,
        lineUid,
      ));
    } catch (error) {
      if (!this.isCurrentLineFlow("change", generation, flow)) return null;
      if (error instanceof CloudAgentLineError && error.code === "line_occupied") {
        await this.refresh();
        if (!this.isCurrentLineFlow("change", generation, flow)) return null;
        this.lineFlow = {
          kind: "change",
          request: null,
          ui: { ...idleLineFlowUi(), message: error.message },
        };
        this.publish();
      } else {
        this.setLineFlowError("change", messageOf(error), false);
      }
      return null;
    }
    if (!this.isCurrentLineFlow("change", generation, flow)) return null;

    const previous = this.rows.get(key);
    const display = moved.name || !previous?.name
      ? moved
      : { ...moved, name: previous.name };
    const provider = moved.provider?.trim() ||
      this.retainedCreates.get(key)?.provider;
    if (provider) {
      this.retainedCreates.set(key, {
        lineUid,
        // Same rule as the listing: a self-hosted host's response may not
        // rewrite the owner's name. `previous?.name` is this row's DISPLAY
        // name, which for a self-hosted row is already local-only.
        name: target.id === BUILTIN_TARGET_ID
          ? moved.name ?? previous?.name ?? ""
          : this.retainedCreates.get(key)?.name ?? "",
        provider,
        targetId: target.id,
      });
    } else {
      this.retainedCreates.delete(key);
    }
    // Changing a line does not move an agent between hosts: it is still on the
    // one that answered this PUT, so the key is unchanged.
    this.rows.set(key, this.rowFor(display, target));
    this.completeLineFlow(key);
    this.publish();
    return agentId;
  }

  private startAgentPoll(
    target: AgentTarget,
    receipt: CloudAgentResource,
    request: CloudCreateInput,
    generation: number,
  ): void {
    this.abortPoll(rowKey(target.id, receipt.agentId));
    const controller = new AbortController();
    this.polls.set(rowKey(target.id, receipt.agentId), controller);
    void this.pollToTerminal(target, receipt, request, generation, controller.signal);
  }

  /**
   * The same host, but reading its bearer at REQUEST time rather than now.
   *
   * A poll outlives its own credential: provisioning can run for minutes, and
   * re-entering the host to rotate a `AGENT_MGR_SERVE_TOKEN` deliberately
   * keeps the rows (same machine, new token) — so it does not abort the poll.
   * A captured bearer then goes stale mid-flight, the next tick 401s, and the
   * loop dies with a "Not authorized" banner the owner has already fixed,
   * leaving a provisioning row with nothing watching it.
   *
   * A getter rather than a restart-on-401: the defect is that the credential
   * was copied, so the fix is to stop copying it. The client reads
   * `target.bearer` once per request, which is exactly when the current value
   * is wanted. Falls back to the captured one when the host is gone, and that
   * poll is being aborted anyway.
   */
  private liveTarget(target: AgentTarget): AgentTarget {
    // Matched on ORIGIN as well as id: `local` is a slot, so if the owner
    // pointed it at a different box mid-poll, its bearer belongs to that box
    // and must not be sent to this one. That case aborts the poll anyway.
    const currentBearer = (): string =>
      this.targets().find((row) => row.id === target.id && row.baseUrl === target.baseUrl)
        ?.bearer ?? target.bearer;
    return {
      id: target.id,
      baseUrl: target.baseUrl,
      get bearer(): string {
        return currentBearer();
      },
    };
  }

  private async pollToTerminal(
    target: AgentTarget,
    receipt: CloudAgentResource,
    request: CloudCreateInput,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.deps.agents.poll(
        this.liveTarget(target),
        receipt,
        (agent) => {
          if (generation === this.generation) this.observe(agent, request, target);
        },
        signal,
      );
    } catch (error) {
      if (generation === this.generation && !signal.aborted && !isAbort(error)) {
        this.failAction(messageOf(error));
      }
    } finally {
      const key = rowKey(target.id, receipt.agentId);
      this.pending.delete(key);
      if (this.polls.get(key)?.signal === signal) this.polls.delete(key);
    }
    if (generation === this.generation && !signal.aborted) await this.refresh();
  }

  private abortPoll(key: RowKey): void {
    const controller = this.polls.get(key);
    if (!controller) return;
    this.polls.delete(key);
    controller.abort();
  }

  private isCurrentLineFlow(
    kind: "create" | "change",
    generation: number,
    flow: number,
  ): boolean {
    return generation === this.generation &&
      flow === this.lineFlowGeneration &&
      this.lineFlow?.kind === kind;
  }

  private beginLineFlow(request: CloudLineRequest): number {
    const flow = ++this.lineFlowGeneration;
    this.activationSecret = null;
    this.lineFlow = {
      kind: request.kind,
      request,
      ui: {
        ...idleLineFlowUi(),
        phase: request.lineUid === null ? "activating" : "creating",
      },
    };
    this.publish();
    return flow;
  }

  private completeLineFlow(key: RowKey): void {
    if (!this.lineFlow) return;
    this.lineFlow = {
      ...this.lineFlow,
      request: null,
      ui: { ...idleLineFlowUi(), completedRowKey: this.handles.handleFor(key) },
    };
  }

  private setLineFlowError(
    kind: CloudLineRequest["kind"],
    message: string,
    retryNewLine: boolean,
  ): void {
    this.activationSecret = null;
    this.lineFlow = {
      kind,
      request: this.lineFlow?.kind === kind ? this.lineFlow.request : null,
      ui: {
        ...idleLineFlowUi(),
        phase: "error",
        message,
        retryNewLine,
      },
    };
    this.publish();
  }

  private setNoNumbersAvailable(kind: CloudLineRequest["kind"]): void {
    this.activationSecret = null;
    this.lineFlow = {
      kind,
      request: null,
      ui: {
        ...idleLineFlowUi(),
        phase: "error",
        message: "No numbers are available right now. Try again later.",
        terminal: "no_numbers",
      },
    };
    this.publish();
  }

  /** Remove an agent — the machine and its hold on the line, not just a key. */
  /** The renderer handle for one agent, minting it if this is its first sight.
   * Used for roster rows, so a roster entry and its agent row share a value. */
  handleForAgent(targetId: string, agentId: string): RowHandle {
    return this.handles.handleFor(rowKey(targetId, agentId));
  }

  /** Resolve a renderer handle. `null` for one this process never minted. */
  keyForHandle(handle: string): RowKey | null {
    return this.handles.keyFor(handle);
  }

  async remove(key: RowKey): Promise<void> {
    this.actionError = null;
    const id = agentIdOf(key);
    if (!id) return;
    // The host is IN the key, so it cannot be resolved from a row a same-named
    // agent on another machine had replaced.
    const target = this.targetForKey(key);
    if (!target) {
      this.failAction("This Mac isn't signed in yet.");
      return;
    }

    const generation = this.generation;
    this.abortPoll(key);
    const refresh = await this.sequence(async () => {
      if (generation !== this.generation) return false;
      this.actionError = null;
      try {
        await this.deps.agents.delete(target, id);
      } catch (error) {
        if (generation === this.generation) this.failAction(messageOf(error));
        return false;
      }
      if (generation !== this.generation) return false;
      this.rows.delete(key);
      this.homeChatUids.delete(key);
      this.pending.delete(key);
      this.retainedCreates.delete(key);
      if (target.id !== BUILTIN_TARGET_ID) this.forgetLocalName(id);
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
    this.lineFlow = null;
    this.tearingDown.clear();
    for (const key of [...this.polls.keys()]) this.abortPoll(key);
    this.rows.clear();
    this.homeChatUids.clear();
    this.pending.clear();
    this.retainedCreates.clear();
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
  private retryTeardown(target: AgentTarget, agentId: string, generation: number): void {
    const key = rowKey(target.id, agentId);
    if (this.tearingDown.has(key)) return;
    this.tearingDown.add(key);
    void this.sequence(async () => {
      try {
        if (generation !== this.generation) return;
        await this.deps.agents.delete(target, agentId);
        if (generation !== this.generation) return;
        this.rows.delete(key);
        this.homeChatUids.delete(key);
        this.pending.delete(key);
        this.retainedCreates.delete(key);
        this.publish();
      } catch {
        // Still in teardown. The next refresh will find it and try again.
      } finally {
        this.tearingDown.delete(key);
      }
    });
  }

  /**
   * Read every host's roster and merge them into one list.
   *
   * The hosts are asked CONCURRENTLY and each one's failure is its own. A
   * self-hosted box is asleep, on another network, or simply not serving far
   * more often than Plow is down, and a single try/catch around all of them
   * would let one unreachable laptop blank the Plow agents too. So a host that
   * could not be asked is treated as UNKNOWN rather than empty: its rows stay
   * on screen with an error naming it, exactly as the whole roster used to
   * survive a failed read.
   */
  private async refreshAgents(
    targets: readonly AgentTarget[],
    generation: number,
    revision: number,
  ): Promise<void> {
    if (generation !== this.generation) return;
    const reads = await Promise.all(targets.map(async (target) => {
      try {
        return { target, agents: await this.deps.agents.list(target), error: null };
      } catch (error) {
        return { target, agents: null, error: messageOf(error) };
      }
    }));
    // The host was replaced or forgotten while these reads were in flight, so
    // whatever they say describes a machine this Mac is no longer pointed at.
    if (generation !== this.generation || revision !== this.hostRevision) return;

    const listed = new Map<RowKey, CloudAgentDisplayRow>();
    const errors: string[] = [];
    for (const { target, agents, error } of reads) {
      if (agents === null) {
        // Named only for an added host. Plow's failure keeps reading as the
        // bare sentence it always has — there is nothing to disambiguate when
        // it is the only host on the Mac.
        errors.push(target.id === BUILTIN_TARGET_ID ? error : `${target.baseUrl}: ${error}`);
        for (const [key, row] of this.rows) {
          if (row.targetId === target.id) listed.set(key, row);
        }
        continue;
      }
      for (const agent of agents) {
        const key = rowKey(target.id, agent.agentId);
        const retained = this.retainedCreates.get(key);
        const resourceProvider = agent.provider?.trim() || null;
        const provider = resourceProvider ?? retained?.provider;
        const lineUid = this.agentLineUid(agent);
        // `retainedCreates` is the OWNER'S request, not a cache rebuilt from
        // what a host says. For Plow it may be reconstructed from a listing —
        // Plow authored the create. For a self-hosted host it may only be
        // UPDATED where a local request already exists: after a relaunch there
        // is none, and synthesising one would both invent an empty name and
        // light up Retry for a create this Mac never made.
        const localOnly = target.id !== BUILTIN_TARGET_ID;
        if (provider && (!localOnly || retained)) {
          this.retainedCreates.set(key, {
            lineUid: lineUid ?? retained?.lineUid ?? null,
            // A self-hosted host's echo of the name is host-authored text and
            // must not overwrite what the owner typed — the display projection
            // reads this field precisely to avoid trusting that echo.
            name: localOnly ? retained?.name ?? "" : agent.name ?? retained?.name ?? "",
            provider,
            targetId: target.id,
          });
        } else if (!localOnly || !retained) this.retainedCreates.delete(key);
        listed.set(key, this.rowFor(agent, target));
      }
    }
    for (const [key, row] of this.rows) {
      if (!listed.has(key) && this.pending.has(key)) listed.set(key, row);
    }
    for (const key of this.homeChatUids.keys()) {
      if (!listed.has(key)) this.homeChatUids.delete(key);
    }
    for (const key of this.retainedCreates.keys()) {
      if (!listed.has(key) && !this.pending.has(key)) this.retainedCreates.delete(key);
    }
    this.rows = listed;
    this.agentsError = errors.length ? errors.join(" · ") : null;
    // `teardown` is not a state an agent rests in — it is a delete that
    // failed provider-side and is waiting to be asked again. Nothing else
    // will ask, so this does, from whichever refresh sees it — and it goes
    // back to the host that still holds the machine.
    for (const { target, agents } of reads) {
      for (const agent of agents ?? []) {
        if (isTeardown(agent.status)) this.retryTeardown(target, agent.agentId, generation);
      }
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

  private observe(
    agent: CloudAgentResource,
    request: CloudCreateInput,
    target: AgentTarget,
  ): void {
    const key = rowKey(target.id, agent.agentId);
    if (target.id !== BUILTIN_TARGET_ID) this.rememberLocalName(agent.agentId, request.name);
    this.retainedCreates.set(key, { ...request, targetId: target.id });
    this.rows.set(key, this.rowFor(agent, target, request.name));
    this.publish();
  }

  private rowFor(
    agent: CloudAgentResource,
    target: AgentTarget,
    fallbackName = "",
  ): CloudAgentDisplayRow {
    const displayAgent = fallbackName && !agent.name ? { ...agent, name: fallbackName } : agent;
    const key = rowKey(target.id, agent.agentId);
    const homeChatUid = agent.chatUids[0];
    if (homeChatUid) this.homeChatUids.set(key, homeChatUid);
    else this.homeChatUids.delete(key);
    const lineUid = this.agentLineUid(agent);
    const details = this.lineDetails(lineUid);
    const retained = this.retainedCreates.get(key);
    return toCloudAgentDisplayRow(displayAgent, {
      rowKey: this.handles.handleFor(key),
      // What the OWNER typed, for a self-hosted row: the mapper will not trust
      // the host's echo of it.
      localName: retained?.name || fallbackName || this.localName(target.id, agent.agentId),
      targetId: target.id,
      line: details.line,
      canMessage: details.canMessage,
      canRetry: retained !== undefined && retained.lineUid !== null,
      threads: this.threadsFor(lineUid),
    });
  }

  /** Resolve an agent's line through its first (home) chat. */
  /** Does this Mac know this line, from Plow's own list or its own chats? */
  private knowsLine(lineUid: string): boolean {
    return (this.lines?.some((line) => line.uid === lineUid) ?? false) ||
      this.chats.some((chat) => chat.lineUid === lineUid);
  }

  private agentLineUid(agent: Pick<CloudAgentResource, "chatUids" | "lineUid">): string | null {
    // The host's own answer first — agents are line-scoped since #241 and a
    // response may name its line with no chats — but ONLY if this Mac knows
    // that line.
    //
    // I previously reasoned an unmatched uid was harmless because it is "just
    // a join key". It is not: `lineDetails` puts the uid straight into
    // `row.line.uid`, so an unmatched one is host-authored text sitting in
    // renderer state. Matching it against what Plow told us is what actually
    // makes it a join key.
    if (agent.lineUid && this.knowsLine(agent.lineUid)) return agent.lineUid;
    const homeChatUid = agent.chatUids[0];
    return this.chats.find((chat) => chat.uid === homeChatUid)?.lineUid ?? null;
  }

  private freeLines(): CloudAgentLine[] {
    if (!this.chatsLoaded) return [];
    const occupied = new Set<string>();
    for (const row of this.rows.values()) {
      if (row.line) occupied.add(row.line.uid);
    }
    const seen = new Set<string>();
    const free: CloudAgentLine[] = [];
    for (const chat of this.chats) {
      const uid = chat.lineUid;
      if (!uid || occupied.has(uid) || seen.has(uid)) continue;
      seen.add(uid);
      const line = this.lineDetails(uid).line;
      if (line) free.push(line);
    }
    return free.sort((a, b) => a.label.localeCompare(b.label));
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
    const known = this.lines?.find((line) => line.uid === lineUid);
    const chat = this.chats.find((candidate) => candidate.lineUid === lineUid);
    const name = (known?.displayName ?? "").trim();
    const numbers = [known?.number, chat?.recipients?.line]
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
      // The row's OWN line wins. A resource that named its line directly has
      // no home chat to recompute from, so recomputing cleared it — killing
      // Message and leaving an occupied line looking free.
      const homeChatUid = this.homeChatUids.get(agentId);
      const lineUid = row.line?.uid
        ?? this.chats.find((chat) => chat.uid === homeChatUid)?.lineUid
        ?? null;
      const details = this.lineDetails(lineUid);
      const threads = this.threadsFor(lineUid);
      const retained = this.retainedCreates.get(agentId);
      const resolved = retained && lineUid !== null ? { ...retained, lineUid } : retained;
      if (resolved) this.retainedCreates.set(agentId, { ...resolved, name: row.name });
      const canRetry = resolved !== undefined && resolved.lineUid !== null;
      const unchanged = details.line?.uid === row.line?.uid &&
        details.line?.label === row.line?.label &&
        details.canMessage === row.canMessage &&
        canRetry === row.canRetry &&
        threads.length === row.threads.length && threads.every(
        (thread, index) =>
          thread.uid === row.threads[index]?.uid && thread.label === row.threads[index]?.label,
      );
      if (!unchanged) this.rows.set(agentId, {
        ...row,
        line: details.line,
        canMessage: details.canMessage,
        canRetry,
        threads,
      });
    }
  }

  private credential(): string {
    return loadSettings(this.deps.home).relayCredential.trim();
  }

  /**
   * Every host this Mac can provision on: the built-in Plow first, then the
   * ones its owner added.
   *
   * Derived per call from settings, like the credential, so nothing on this
   * object can go stale against the file. A Mac with no relay credential has
   * NO targets at all — not even its own hosts — because an agent is created
   * against a Plow line, and without a session there are no lines to pick.
   */
  /** The digest a self-hosted agent's owner-given name is filed under. The id
   * is host-authored, so it is never itself written to disk. */
  private static nameDigest(agentId: string): string {
    return createHash("sha256").update(agentId).digest("hex");
  }

  /** Remember what the owner called a self-hosted agent, so a relaunch does
   * not turn every row into "Local agent". */
  private rememberLocalName(agentId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    const settings = loadSettings(this.deps.home);
    const host = settings.agentTarget;
    if (!host) return;
    const digest = CloudAgentState.nameDigest(agentId);
    if (host.agentNames?.[digest] === trimmed) return;
    saveSettings(this.deps.home, {
      ...settings,
      agentTarget: { ...host, agentNames: { ...host.agentNames, [digest]: trimmed } },
    });
  }

  /** Drop a remembered name when its agent goes. */
  private forgetLocalName(agentId: string): void {
    const settings = loadSettings(this.deps.home);
    const host = settings.agentTarget;
    const digest = CloudAgentState.nameDigest(agentId);
    if (!host?.agentNames?.[digest]) return;
    const { [digest]: _gone, ...rest } = host.agentNames;
    saveSettings(this.deps.home, { ...settings, agentTarget: { ...host, agentNames: rest } });
  }

  /** What the owner called this self-hosted agent, across relaunches. */
  private localName(targetId: string, agentId: string): string {
    if (targetId === BUILTIN_TARGET_ID) return "";
    return loadSettings(this.deps.home)
      .agentTarget?.agentNames?.[CloudAgentState.nameDigest(agentId)] ?? "";
  }

  private targets(): AgentTarget[] {
    const settings = loadSettings(this.deps.home);
    const bearer = settings.relayCredential.trim();
    if (!bearer) return [];
    const host = settings.agentTarget;
    return [
      { id: BUILTIN_TARGET_ID, baseUrl: this.deps.baseUrl, bearer },
      // The address is the name: with one host there is nothing to tell apart,
      // and a label the owner had to invent was a field for no reader.
      ...(host ? [{ id: LOCAL_TARGET_ID, baseUrl: host.baseUrl, bearer: host.bearer }] : []),
    ];
  }

  /** The built-in Plow target, or `null` on a Mac that is not signed in. */
  private builtinTarget(): AgentTarget | null {
    return this.targets()[0] ?? null;
  }

  /** A host by id. An id nobody knows resolves to nothing — never to Plow. */
  private target(targetId: string | undefined): AgentTarget | null {
    const wanted = (targetId ?? BUILTIN_TARGET_ID).trim() || BUILTIN_TARGET_ID;
    return this.targets().find((target) => target.id === wanted) ?? null;
  }

  /**
   * The host one agent lives on, from the row that named it.
   *
   * Falls back to the built-in Plow only when there is no row — a delete
   * arriving for a roster entry the agent list has not caught up with. A row
   * that DOES exist is authoritative: sending its delete to Plow because a
   * forgotten host's id no longer resolves would ask the wrong server about
   * someone else's agent id.
   */
  private targetForKey(key: RowKey): AgentTarget | null {
    const row = this.rows.get(key);
    // The key already names the host, so a missing row is not a reason to
    // guess: fall back to the host the key names, not to Plow.
    return row ? this.target(row.targetId) : this.target(targetIdOf(key));
  }

  /**
   * Set this Mac's self-hosted host, replacing whatever was there.
   *
   * A REPLACE, not an append: there is one slot. Re-entering the host is also
   * how a rotated `AGENT_MGR_SERVE_TOKEN` gets in, and that has to overwrite
   * rather than leave a stale row beside the new one.
   */
  addTarget(input: { baseUrl?: unknown; bearer?: unknown }): boolean {
    const bearer = typeof input?.bearer === "string" ? input.bearer.trim() : "";
    // Canonical, and refused outright if it carries anything a host address
    // has no business carrying — see `canonicalAgentHostUrl`.
    const baseUrl = canonicalAgentHostUrl(
      typeof input?.baseUrl === "string" ? input.baseUrl : "",
    );
    if (!baseUrl) {
      this.failAction(
        "That host address isn't usable. It has to be a bare origin like " +
        "http://192.168.1.10:8765 — no user, password, query or path — and only a LAN, " +
        ".local or MagicDNS (.ts.net) address may use http://. Anything else needs https://.",
      );
      return false;
    }
    if (!bearer) {
      this.failAction("Paste the host's AGENT_MGR_SERVE_TOKEN.");
      return false;
    }

    const settings = loadSettings(this.deps.home);
    // Pointing at a DIFFERENT box: the rows on screen belong to the old one and
    // its ids mean nothing here, so they go with it rather than being reconciled
    // against a machine that never had them.
    const replacing = settings.agentTarget !== null && settings.agentTarget.baseUrl !== baseUrl;
    if (replacing) this.dropLocalRows();
    // Rotating a token is the SAME machine, so the owner's names for its
    // agents come with it. They are dropped only when the slot is pointed at a
    // DIFFERENT box, where those digests name nothing.
    const carried = replacing ? undefined : settings.agentTarget?.agentNames;
    saveSettings(this.deps.home, {
      ...settings,
      agentTarget: { baseUrl, bearer, ...(carried ? { agentNames: carried } : {}) },
    });
    this.actionError = null;
    this.publish();
    return true;
  }

  /**
   * Forget the self-hosted host. Its agents go off the roster with it — they
   * live on that machine, and this app has just given up the only way it had
   * to ask. Nothing is torn down: forgetting a host is not deleting its agents.
   */
  forgetTarget(): void {
    const settings = loadSettings(this.deps.home);
    if (!settings.agentTarget) return;
    saveSettings(this.deps.home, { ...settings, agentTarget: null });
    this.dropLocalRows();
    this.actionError = null;
    this.publish();
  }

  /**
   * Everything this Mac knew about the self-hosted host's agents.
   *
   * Bumps `hostRevision` too, so a roster read already in flight against the
   * old machine cannot land afterwards and put these rows straight back.
   */
  private dropLocalRows(): void {
    this.hostRevision += 1;
    for (const [agentId, row] of [...this.rows]) {
      if (row.targetId !== LOCAL_TARGET_ID) continue;
      this.abortPoll(agentId);
      this.rows.delete(agentId);
      this.homeChatUids.delete(agentId);
      this.pending.delete(agentId);
      this.retainedCreates.delete(agentId);
    }
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

function idleLineFlowUi(): CloudLineFlowUiState {
  return {
    phase: "idle",
    activation: null,
    message: null,
    completedRowKey: null,
    retryNewLine: false,
    terminal: null,
  };
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
function isTeardown(status: string): boolean {
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
