/**
 * Main-process state for account connectors.
 *
 * The OAuth URL is deliberately a local variable in `connect`: it goes from
 * Plow straight to the checked external opener and has no representation in
 * `state()`, audit fields, errors, or notifications.
 */
import {
  ConnectorAccount,
  ConnectorProvider,
  ConnectorsOverview,
  PlowApi,
  PlowApiError,
} from "./plowApi.js";

export const CONNECTOR_POLL_INTERVAL_MS = 3_000;
export const CONNECTOR_TIMEOUT_MS = 30_000;
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
  /** Electron's external opener, reached only after an `https:` check. */
  openExternal: (url: string) => Promise<void>;
  recordAudit: (event: string, fields: Record<string, string>) => void;
  onChange?: () => void;
  wait?: (milliseconds: number) => Promise<void>;
}

export class Connectors {
  private busy = false;
  private error: string | null = null;
  private note: string | null = null;
  private connecting: ConnectorProvider | null = null;
  private accounts: ConnectorAccount[] = [];

  constructor(private readonly deps: ConnectorsDeps) {}

  state(): ConnectorsState {
    return {
      busy: this.busy,
      error: this.error,
      note: this.note,
      google: {
        accounts: this.accounts.map((account) => ({ ...account })),
        connecting: this.connecting === "google",
      },
    };
  }

  async refresh(): Promise<ConnectorsState> {
    return this.run(null, async (credential) => {
      await this.load(credential);
    });
  }

  async connect(provider: ConnectorProvider): Promise<ConnectorsState> {
    return this.run(provider, async (credential) => {
      const before = await this.load(credential);
      const connectUrl = await this.deps.api.connectorConnectUrl(credential, provider);
      await this.openConnectUrl(connectUrl);
      // One deadline for the whole poll, including HTTP time. Without it, ten
      // individually bounded requests could turn a 30-second connect into
      // minutes when Plow accepts each request and then goes quiet.
      const pollingSignal = AbortSignal.timeout(CONNECTOR_TIMEOUT_MS);

      for (
        let elapsed = 0;
        elapsed < CONNECTOR_TIMEOUT_MS;
        elapsed += CONNECTOR_POLL_INTERVAL_MS
      ) {
        await this.wait(CONNECTOR_POLL_INTERVAL_MS);
        if (pollingSignal.aborted) break;
        let after: ConnectorsOverview;
        try {
          after = await this.load(credential, pollingSignal);
        } catch (error) {
          if (pollingSignal.aborted) break;
          throw error;
        }
        if (pollingSignal.aborted) break;
        const connected = connectedAccount(before, after);
        if (!connected) continue;

        this.deps.recordAudit("connector_connected", {
          provider,
          account: connected,
        });
        await this.load(credential);
        return;
      }

      const after = await this.load(credential);
      const connected = connectedAccount(before, after);
      if (connected) {
        this.deps.recordAudit("connector_connected", {
          provider,
          account: connected,
        });
        return;
      }
      this.note = CONNECTOR_TIMEOUT_NOTE;
    });
  }

  async disconnect(
    provider: ConnectorProvider,
    account: string,
  ): Promise<ConnectorsState> {
    return this.run(null, async (credential) => {
      const email = account.trim();
      const result = await this.deps.api.disconnectConnector(credential, provider, email);
      if (result.status === "disconnected") {
        this.deps.recordAudit("connector_disconnected", { provider, account: email });
      }
      await this.load(credential);
    });
  }

  async setDefault(
    provider: ConnectorProvider,
    account: string,
  ): Promise<ConnectorsState> {
    return this.run(null, async (credential) => {
      const email = account.trim();
      await this.deps.api.setDefaultConnector(credential, provider, email);
      this.deps.recordAudit("connector_default_changed", { provider, account: email });
      await this.load(credential);
    });
  }

  private async run(
    connecting: ConnectorProvider | null,
    body: (credential: string) => Promise<void>,
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

    this.busy = true;
    this.connecting = connecting;
    this.error = null;
    this.note = null;
    this.publish();
    try {
      await body(credential);
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      this.busy = false;
      this.connecting = null;
    }
    return this.publish();
  }

  private async load(
    credential: string,
    signal?: AbortSignal,
  ): Promise<ConnectorsOverview> {
    const overview = await this.deps.api.listConnectors(credential, signal);
    this.accounts = overview.google.accounts.map((account) => ({ ...account }));
    this.publish();
    return overview;
  }

  private async openConnectUrl(raw: string): Promise<void> {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:") throw new Error("unsafe scheme");
      await this.deps.openExternal(raw);
    } catch {
      // An opener error can include the URL it failed on. Keep that error — and
      // therefore its credential-bearing query — out of renderer state.
      throw new PlowApiError("http", "Plow couldn't open the connection page.");
    }
  }

  private wait(milliseconds: number): Promise<void> {
    if (this.deps.wait) return this.deps.wait(milliseconds);
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
