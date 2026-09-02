import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLog } from "@domo/device-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_POLL_INTERVAL_MS,
  CONNECTOR_TIMEOUT_MESSAGE,
  CONNECTOR_TIMEOUT_MS,
  Connectors,
  ConnectorsState,
} from "../src/connectors.js";
import {
  ConnectorAccount,
  ConnectorProvider,
  ConnectorsOverview,
} from "../src/plowApi.js";
import { deferred } from "./deferred.js";

const CREDENTIAL = "plow_device_connector_secret_123456";
const CONNECT_CODE = "FAKE_CONNECT_URL_MUST_NOT_LEAK";
const CONNECT_URL = `https://api.plow.co/v1/connectors/gmail/connect?code=${CONNECT_CODE}`;

const overview = (accounts: ConnectorAccount[] = []): ConnectorsOverview => ({
  google: { accounts },
});
const account = (
  email: string,
  overrides: Partial<ConnectorAccount> = {},
): ConnectorAccount => ({
  email,
  isDefault: false,
  needsReauth: false,
  ...overrides,
});

class FakePlow {
  listAnswers: ConnectorsOverview[] = [overview()];
  listCredentials: string[] = [];
  connects: Array<{ credential: string; provider: ConnectorProvider }> = [];
  disconnects: Array<{ credential: string; provider: ConnectorProvider; account: string }> = [];
  defaults: Array<{ credential: string; provider: ConnectorProvider; account: string }> = [];
  connectUrl: string | Promise<string> = CONNECT_URL;
  pollGate: ((signal: AbortSignal) => Promise<ConnectorsOverview>) | null = null;

  async listConnectors(
    credential: string,
    signal?: AbortSignal,
  ): Promise<ConnectorsOverview> {
    this.listCredentials.push(credential);
    if (signal && this.pollGate) return this.pollGate(signal);
    const answer = this.listAnswers.length > 1
      ? this.listAnswers.shift()!
      : this.listAnswers[0];
    return structuredClone(answer);
  }

  async connectorConnectUrl(
    credential: string,
    provider: ConnectorProvider,
  ): Promise<string> {
    this.connects.push({ credential, provider });
    return this.connectUrl;
  }

  async disconnectConnector(
    credential: string,
    provider: ConnectorProvider,
    email: string,
  ): Promise<void> {
    this.disconnects.push({ credential, provider, account: email });
  }

  async setDefaultConnector(
    credential: string,
    provider: ConnectorProvider,
    email: string,
  ): Promise<void> {
    this.defaults.push({ credential, provider, account: email });
  }
}

interface Harness {
  connectors: Connectors;
  opened: string[];
  audits: Array<{ event: string; fields: Record<string, string> }>;
  waits: number[];
}

function build(
  plow: FakePlow,
  options: {
    wait?: (milliseconds: number) => Promise<void>;
    onChange?: () => void;
    recordAudit?: (event: string, fields: Record<string, string>) => void;
    openExternal?: (url: string) => Promise<void>;
  } = {},
): Harness {
  const opened: string[] = [];
  const audits: Array<{ event: string; fields: Record<string, string> }> = [];
  const waits: number[] = [];
  const connectors = new Connectors({
    api: plow,
    credential: () => CREDENTIAL,
    openExternal: options.openExternal ?? (async (url) => {
      opened.push(url);
    }),
    recordAudit: options.recordAudit ?? ((event, fields) => {
      audits.push({ event, fields });
    }),
    onChange: options.onChange,
    wait: options.wait ?? (async (milliseconds) => {
      waits.push(milliseconds);
    }),
  });
  return { connectors, opened, audits, waits };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connecting a Google account", () => {
  it("opens the checked browser URL and polls every three seconds until a new account appears", async () => {
    const plow = new FakePlow();
    plow.listAnswers = [
      overview(),
      overview([account("ada@example.com", { isDefault: true })]),
      overview([account("ada@example.com", { isDefault: true })]),
    ];
    const { connectors, opened, audits, waits } = build(plow);

    const state = await connectors.connect("google");

    expect(plow.connects).toEqual([{ credential: CREDENTIAL, provider: "google" }]);
    expect(opened).toEqual([CONNECT_URL]);
    expect(waits).toEqual([CONNECTOR_POLL_INTERVAL_MS]);
    // Baseline, successful poll, then the explicit final refresh.
    expect(plow.listCredentials).toEqual([CREDENTIAL, CREDENTIAL, CREDENTIAL]);
    expect(state).toEqual({
      busy: false,
      error: null,
      google: {
        accounts: [account("ada@example.com", { isDefault: true })],
        connecting: false,
      },
    });
    expect(audits).toEqual([{
      event: "connector_connected",
      fields: { provider: "google", account: "ada@example.com" },
    }]);
  });

  it("treats a cleared reauthorization flag as a completed connection", async () => {
    const plow = new FakePlow();
    plow.listAnswers = [
      overview([account("ada@example.com", { isDefault: true, needsReauth: true })]),
      overview([account("ada@example.com", { isDefault: true })]),
      overview([account("ada@example.com", { isDefault: true })]),
    ];
    const { connectors, audits } = build(plow);

    await connectors.connect("google");

    expect(audits).toEqual([{
      event: "connector_connected",
      fields: { provider: "google", account: "ada@example.com" },
    }]);
  });

  it("stops after thirty seconds and leaves the control ready to try again", async () => {
    const plow = new FakePlow();
    const { connectors, opened, audits, waits } = build(plow);

    const state = await connectors.connect("google");

    expect(opened).toEqual([CONNECT_URL]);
    expect(waits).toHaveLength(CONNECTOR_TIMEOUT_MS / CONNECTOR_POLL_INTERVAL_MS);
    expect(waits.reduce((total, milliseconds) => total + milliseconds, 0))
      .toBe(CONNECTOR_TIMEOUT_MS);
    expect(plow.listCredentials).toHaveLength(1 + waits.length);
    expect(state.busy).toBe(false);
    expect(state.google.connecting).toBe(false);
    expect(state.error).toBe(CONNECTOR_TIMEOUT_MESSAGE);
    expect(audits).toEqual([]);
  });

  it("applies the thirty-second deadline to a poll request that never answers", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const plow = new FakePlow();
    plow.pollGate = async (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    });
    const { connectors } = build(plow);

    const pending = connectors.connect("google");
    while (plow.listCredentials.length < 2) await Promise.resolve();
    controller.abort(new DOMException("The operation was aborted.", "TimeoutError"));
    const state = await pending;

    expect(timeout).toHaveBeenCalledWith(CONNECTOR_TIMEOUT_MS);
    expect(state.busy).toBe(false);
    expect(state.error).toBe(CONNECTOR_TIMEOUT_MESSAGE);
  });

  it("refuses a second action while the first is in flight", async () => {
    const plow = new FakePlow();
    const connectUrl = deferred<string>();
    plow.connectUrl = connectUrl.promise;
    plow.listAnswers = [
      overview(),
      overview([account("ada@example.com")]),
      overview([account("ada@example.com")]),
    ];
    const { connectors } = build(plow);

    const first = connectors.connect("google");
    while (plow.connects.length === 0) await Promise.resolve();
    const refused = await connectors.disconnect("google", "ada@example.com");

    expect(refused.busy).toBe(true);
    expect(refused.google.connecting).toBe(true);
    expect(plow.disconnects).toEqual([]);

    connectUrl.resolve(CONNECT_URL);
    await first;
  });

  it("refuses a non-HTTPS connect URL without handing it to the external opener", async () => {
    const plow = new FakePlow();
    plow.connectUrl = "http://api.plow.co/v1/connectors/gmail/connect?code=unsafe";
    const { connectors, opened } = build(plow);

    const state = await connectors.connect("google");

    expect(opened).toEqual([]);
    expect(state.error).toBe("Plow couldn't open the connection page.");
    expect(JSON.stringify(state)).not.toContain(String(plow.connectUrl));
  });
});

describe("connector account actions", () => {
  it("disconnects only the named account, audits it, and refreshes", async () => {
    const plow = new FakePlow();
    plow.listAnswers = [overview([account("grace@example.com", { isDefault: true })])];
    const { connectors, audits } = build(plow);

    const state = await connectors.disconnect("google", "  ada@example.com  ");

    expect(plow.disconnects).toEqual([{
      credential: CREDENTIAL,
      provider: "google",
      account: "ada@example.com",
    }]);
    expect(audits).toEqual([{
      event: "connector_disconnected",
      fields: { provider: "google", account: "ada@example.com" },
    }]);
    expect(state.google.accounts).toEqual([account("grace@example.com", { isDefault: true })]);
  });

  it("sets the named default, audits it, and refreshes", async () => {
    const plow = new FakePlow();
    plow.listAnswers = [overview([
      account("ada@example.com"),
      account("grace@example.com", { isDefault: true }),
    ])];
    const { connectors, audits } = build(plow);

    const state = await connectors.setDefault("google", "grace@example.com");

    expect(plow.defaults).toEqual([{
      credential: CREDENTIAL,
      provider: "google",
      account: "grace@example.com",
    }]);
    expect(audits).toEqual([{
      event: "connector_default_changed",
      fields: { provider: "google", account: "grace@example.com" },
    }]);
    expect(state.google.accounts[1].isDefault).toBe(true);
  });

  it("surfaces an account that needs reauthorization", async () => {
    const plow = new FakePlow();
    plow.listAnswers = [overview([
      account("ada@example.com", { isDefault: true, needsReauth: true }),
    ])];

    const state = await build(plow).connectors.refresh();

    expect(state.google.accounts).toEqual([
      account("ada@example.com", { isDefault: true, needsReauth: true }),
    ]);
  });
});

describe("connect URL privacy", () => {
  it("keeps the fake connect URL out of every audit, log, and published state output", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-connectors-"));
    const audit = new AuditLog(path.join(home, "device/audit.ndjson"));
    const plow = new FakePlow();
    plow.listAnswers = [
      overview(),
      overview([account("ada@example.com", { isDefault: true })]),
      overview([account("ada@example.com", { isDefault: true })]),
    ];
    const logs: unknown[][] = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
        logs.push(values);
      });
    }
    const states: ConnectorsState[] = [];
    const opened: string[] = [];
    let connectors!: Connectors;
    connectors = new Connectors({
      api: plow,
      credential: () => CREDENTIAL,
      openExternal: async (url) => {
        opened.push(url);
      },
      recordAudit: (event, fields) => audit.record(event, fields),
      onChange: () => states.push(connectors.state()),
      wait: async () => {},
    });

    try {
      states.push(await connectors.connect("google"));
      expect(opened).toEqual([CONNECT_URL]);

      const durableOutputs = JSON.stringify({
        audit: audit.entries(),
        logs,
        states,
      });
      expect(durableOutputs).not.toContain(CONNECT_URL);
      expect(durableOutputs).not.toContain(CONNECT_CODE);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
