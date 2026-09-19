/**
 * Main-process state for account connectors.
 *
 * The OAuth URL is deliberately a local variable in `connect`: it goes from
 * Plow straight to the checked external opener and has no representation in
 * `state()`, audit fields, errors, or notifications.
 */
import {
  ConnectorAccount,
  ConnectorsOverview,
  PlowApi,
  PlowApiError,
} from "./plowApi.js";

export const CONNECTOR_POLL_INTERVAL_MS = 3_000;
export const CONNECTOR_TIMEOUT_MS = 5 * 60 * 1_000;
export const CONNECTOR_TIMEOUT_NOTE =
  "We couldn't see a new account. If you reconnected one that was already listed, it's done.";

export interface ConnectorsState {
  busy: boolean;
  message: string;
  noteKind: "neutral" | "error";
  google: {
    accounts: ConnectorAccount[];
    connecting: boolean;
  };
}

type ConnectorApi = Pick<
  PlowApi,
  "listConnectors" | "connectorConnectUrl" | "disconnectConnector" | "setDefaultConnector"
>;

export interface ConnectorsDeps {
  api: ConnectorApi;
  /** Read for every action so sign-in changes cannot leave a stale credential here. */
  credential: () => string;
  /** Electron's external opener, reached only after the connect URL is validated. */
  openExternal: (url: string) => Promise<void>;
  recordAudit: (event: string, fields: Record<string, string>) => void;
  onChange?: () => void;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

type ConnectorAction = {
  generation: number;
  controller: AbortController;
};

const STALE_ACTION = Symbol("stale connector action");

export class Connectors {
  private busy = false;
  private notice: Pick<ConnectorsState, "message" | "noteKind"> = { message: "", noteKind: "error" };
  private connecting = false;
  private accounts: ConnectorAccount[] = [];
  private generation = 0;
  private actionAbort: AbortController | null = null;

  constructor(private readonly deps: ConnectorsDeps) {}

  state(): ConnectorsState {
    return {
      busy: this.busy,
      ...this.notice,
      google: {
        accounts: this.accounts.map((account) => ({ ...account })),
        connecting: this.connecting,
      },
    };
  }

  async refresh(): Promise<ConnectorsState> {
    return this.run(false, async (credential, action) => {
      await this.load(credential, action);
    });
  }

  /**
   * A background re-read of the accounts, for when no window asked. Unlike
   * `refresh` it never goes through `run`: no busy state and no notice, so it
   * cannot drop the owner's click or wipe a message they are reading. A result
   * that lands after an action started or a sign-out is dropped — that one
   * loads for itself — and a failure is silent, as the next poll asks again.
   * Publishes only a list that changed.
   */
  async poll(): Promise<void> {
    const credential = this.deps.credential().trim();
    if (this.busy || !credential) return;
    const generation = this.generation;
    let overview: ConnectorsOverview;
    try {
      overview = await this.deps.api.listConnectors(credential, AbortSignal.timeout(CONNECTOR_TIMEOUT_MS));
    } catch {
      return;
    }
    if (generation !== this.generation) return;
    const accounts = overview.google.accounts.map((account) => ({ ...account }));
    if (JSON.stringify(accounts) === JSON.stringify(this.accounts)) return;
    const knownEmails = new Set(this.accounts.map((account) => account.email));
    const newEmails = accounts
      .map((account) => account.email)
      .filter((email) => !knownEmails.has(email));
    this.accounts = accounts;
    if (newEmails.length > 0) {
      if (
        this.notice.message === CONNECTOR_TIMEOUT_NOTE
        && this.notice.noteKind === "neutral"
      ) {
        this.notice = { message: "", noteKind: "error" };
      }
      for (const email of newEmails) {
        this.deps.recordAudit("connector_connected", { provider: "google", account: email });
      }
    }
    this.publish();
  }

  async connect(): Promise<ConnectorsState> {
    return this.run(true, async (credential, action) => {
      const before = await this.load(credential, action);
      const connectUrl = await this.deps.api.connectorConnectUrl(
        credential,
        action.controller.signal,
      );
      this.assertCurrent(action);
      await this.openConnectUrl(connectUrl);
      this.assertCurrent(action);
      // One deadline for the whole poll, including HTTP time. Without it,
      // individually bounded requests could turn a five-minute connect into
      // much longer when Plow accepts each request and then goes quiet.
      const pollingDeadline = AbortSignal.timeout(CONNECTOR_TIMEOUT_MS);
      const pollingSignal = AbortSignal.any([action.controller.signal, pollingDeadline]);

      for (
        let elapsed = 0;
        elapsed < CONNECTOR_TIMEOUT_MS;
        elapsed += CONNECTOR_POLL_INTERVAL_MS
      ) {
        try {
          await this.wait(CONNECTOR_POLL_INTERVAL_MS, action, pollingSignal);
        } catch (error) {
          this.assertCurrent(action);
          if (pollingDeadline.aborted) break;
          throw error;
        }
        if (pollingDeadline.aborted) break;
        let after: ConnectorsOverview;
        try {
          after = await this.load(credential, action, pollingSignal);
        } catch (error) {
          this.assertCurrent(action);
          if (pollingDeadline.aborted) break;
          throw error;
        }
        const connected = connectedAccount(before, after);
        if (connected) {
          this.deps.recordAudit("connector_connected", {
            provider: "google",
            account: connected,
          });
          return;
        }
        if (pollingDeadline.aborted) break;
      }

      this.assertCurrent(action);
      this.notice = { message: CONNECTOR_TIMEOUT_NOTE, noteKind: "neutral" };
    });
  }

  async disconnect(account: string): Promise<ConnectorsState> {
    return this.run(false, async (credential, action) => {
      const email = account.trim();
      const result = await this.deps.api.disconnectConnector(
        credential,
        email,
        action.controller.signal,
      );
      this.assertCurrent(action);
      if (result.status === "disconnected") {
        this.deps.recordAudit("connector_disconnected", { provider: "google", account: email });
      }
      await this.load(credential, action);
    });
  }

  async setDefault(account: string): Promise<ConnectorsState> {
    return this.run(false, async (credential, action) => {
      const email = account.trim();
      await this.deps.api.setDefaultConnector(credential, email, action.controller.signal);
      this.assertCurrent(action);
      this.deps.recordAudit("connector_default_changed", { provider: "google", account: email });
      await this.load(credential, action);
    });
  }

  signedOut(): ConnectorsState {
    this.generation += 1;
    this.actionAbort?.abort();
    this.actionAbort = null;
    this.accounts = [];
    this.notice = { message: "", noteKind: "error" };
    this.busy = false;
    this.connecting = false;
    return this.publish();
  }

  private async run(
    connecting: boolean,
    body: (credential: string, action: ConnectorAction) => Promise<void>,
  ): Promise<ConnectorsState> {
    // A second main-process action is refused synchronously. The renderer's
    // disabled state arrives one IPC round trip later, so it cannot close the
    // double-click window by itself.
    if (this.busy) return this.state();

    const credential = this.deps.credential().trim();
    if (!credential) {
      this.notice = { message: "This Mac isn't signed in yet.", noteKind: "error" };
      return this.publish();
    }

    // A new generation per action, not only per sign-out: a `poll` that was
    // in flight when this started must not land over what this loads.
    this.generation += 1;
    const action = {
      generation: this.generation,
      controller: new AbortController(),
    };
    this.actionAbort = action.controller;
    this.busy = true;
    this.connecting = connecting;
    this.notice = { message: "", noteKind: "error" };
    this.publish();
    try {
      await body(credential, action);
      this.assertCurrent(action);
    } catch (error) {
      if (!this.isCurrent(action) || error === STALE_ACTION) return this.state();
      this.notice = { message: messageOf(error), noteKind: "error" };
    } finally {
      if (this.actionAbort === action.controller) this.actionAbort = null;
      if (this.isCurrent(action)) {
        this.busy = false;
        this.connecting = false;
      }
    }
    if (!this.isCurrent(action)) return this.state();
    return this.publish();
  }

  private async load(
    credential: string,
    action: ConnectorAction,
    signal: AbortSignal = action.controller.signal,
  ): Promise<ConnectorsOverview> {
    const overview = await this.deps.api.listConnectors(credential, signal);
    this.assertCurrent(action);
    this.accounts = overview.google.accounts.map((account) => ({ ...account }));
    this.publish();
    return overview;
  }

  private async openConnectUrl(raw: string): Promise<void> {
    try {
      const url = new URL(raw);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
        url.hostname.toLowerCase(),
      );
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new Error("unsafe scheme");
      }
      await this.deps.openExternal(raw);
    } catch {
      // An opener error can include the URL it failed on. Keep that error — and
      // therefore its credential-bearing query — out of renderer state.
      throw new PlowApiError("http", "Plow couldn't open the connection page.");
    }
  }

  private async wait(
    milliseconds: number,
    action: ConnectorAction,
    signal: AbortSignal = action.controller.signal,
  ): Promise<void> {
    if (this.deps.wait) {
      await this.deps.wait(milliseconds, signal);
      this.assertCurrent(action);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(STALE_ACTION);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    });
    this.assertCurrent(action);
  }

  private isCurrent(action: ConnectorAction): boolean {
    return action.generation === this.generation && !action.controller.signal.aborted;
  }

  private assertCurrent(action: ConnectorAction): void {
    if (!this.isCurrent(action)) throw STALE_ACTION;
  }

  private publish(): ConnectorsState {
    this.deps.onChange?.();
    return this.state();
  }
}

function connectedAccount(
  before: ConnectorsOverview,
  after: ConnectorsOverview,
): string | null {
  if (after.google.accounts.length <= before.google.accounts.length) return null;
  const previous = new Set(before.google.accounts.map((account) => account.email));
  return after.google.accounts.find((account) => !previous.has(account.email))?.email ?? null;
}

function messageOf(error: unknown): string {
  if (error instanceof PlowApiError) return error.message;
  return "Something went wrong. Try again.";
}
