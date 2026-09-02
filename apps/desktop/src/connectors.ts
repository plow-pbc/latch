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
export const CONNECTOR_TIMEOUT_MS = 30_000;
export const CONNECTOR_FINAL_REFRESH_TIMEOUT_MS = 5_000;
export const CONNECTOR_TIMEOUT_NOTE =
  "We couldn't see a new account. If you reconnected one that was already listed, it's done.";

export interface ConnectorsState {
  busy: boolean;
  error: string | null;
  note: string | null;
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
  wait?: (milliseconds: number) => Promise<void>;
}

type ConnectorAction = {
  generation: number;
  controller: AbortController;
};

const STALE_ACTION = Symbol("stale connector action");

export class Connectors {
  private busy = false;
  private error: string | null = null;
  private note: string | null = null;
  private connecting = false;
  private accounts: ConnectorAccount[] = [];
  private generation = 0;
  private actionAbort: AbortController | null = null;

  constructor(private readonly deps: ConnectorsDeps) {}

  state(): ConnectorsState {
    return {
      busy: this.busy,
      error: this.error,
      note: this.note,
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
      // One deadline for the whole poll, including HTTP time. Without it, ten
      // individually bounded requests could turn a 30-second connect into
      // minutes when Plow accepts each request and then goes quiet.
      const pollingDeadline = AbortSignal.timeout(CONNECTOR_TIMEOUT_MS);
      const pollingSignal = AbortSignal.any([action.controller.signal, pollingDeadline]);

      for (
        let elapsed = 0;
        elapsed < CONNECTOR_TIMEOUT_MS;
        elapsed += CONNECTOR_POLL_INTERVAL_MS
      ) {
        await this.wait(CONNECTOR_POLL_INTERVAL_MS, action);
        if (pollingDeadline.aborted) break;
        let after: ConnectorsOverview;
        try {
          after = await this.load(credential, action, pollingSignal);
        } catch (error) {
          this.assertCurrent(action);
          if (pollingDeadline.aborted) break;
          throw error;
        }
        if (pollingDeadline.aborted) break;
        const connected = connectedAccount(before, after);
        if (!connected) continue;

        this.deps.recordAudit("connector_connected", {
          provider: "google",
          account: connected,
        });
        await this.load(credential, action);
        return;
      }

      this.assertCurrent(action);
      const finalRefreshDeadline = AbortSignal.timeout(CONNECTOR_FINAL_REFRESH_TIMEOUT_MS);
      const finalRefreshSignal = AbortSignal.any([
        action.controller.signal,
        finalRefreshDeadline,
      ]);
      let after: ConnectorsOverview;
      try {
        after = await this.load(credential, action, finalRefreshSignal);
      } catch (error) {
        this.assertCurrent(action);
        if (!finalRefreshDeadline.aborted) throw error;
        this.note = CONNECTOR_TIMEOUT_NOTE;
        return;
      }
      const connected = connectedAccount(before, after);
      if (connected) {
        this.deps.recordAudit("connector_connected", {
          provider: "google",
          account: connected,
        });
        return;
      }
      this.note = CONNECTOR_TIMEOUT_NOTE;
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
    this.error = null;
    this.note = null;
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
      this.error = "This Mac isn't signed in yet.";
      this.note = null;
      return this.publish();
    }

    const action = {
      generation: this.generation,
      controller: new AbortController(),
    };
    this.actionAbort = action.controller;
    this.busy = true;
    this.connecting = connecting;
    this.error = null;
    this.note = null;
    this.publish();
    try {
      await body(credential, action);
      this.assertCurrent(action);
    } catch (error) {
      if (!this.isCurrent(action) || error === STALE_ACTION) return this.state();
      this.error = messageOf(error);
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

  private async wait(milliseconds: number, action: ConnectorAction): Promise<void> {
    if (this.deps.wait) {
      await this.deps.wait(milliseconds);
      this.assertCurrent(action);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(STALE_ACTION);
      };
      const timer = setTimeout(() => {
        action.controller.signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      if (action.controller.signal.aborted) return onAbort();
      action.controller.signal.addEventListener("abort", onAbort, { once: true });
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
