import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLog } from "@domo/device-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_FINAL_REFRESH_TIMEOUT_MS,
  CONNECTOR_POLL_INTERVAL_MS,
  CONNECTOR_TIMEOUT_NOTE,
  CONNECTOR_TIMEOUT_MS,
  Connectors,
  ConnectorsState,
} from "../src/connectors.js";
import {
  ConnectorAccount,
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
  ...overrides,
});

class FakePlow {
  listAnswers: ConnectorsOverview[] = [overview()];
  listCredentials: string[] = [];
  connects: string[] = [];
  disconnects: Array<{ credential: string; account: string }> = [];
  defaults: Array<{ credential: string; account: string }> = [];
  connectUrl: string | Promise<string> = CONNECT_URL;
  disconnectStatus = "disconnected";
  pollGate: ((signal: AbortSignal, call: number) => Promise<ConnectorsOverview>) | null = null;

  async listConnectors(
    credential: string,
    signal?: AbortSignal,
  ): Promise<ConnectorsOverview> {
    this.listCredentials.push(credential);
    if (signal && this.pollGate) return this.pollGate(signal, this.listCredentials.length);
    const answer = this.listAnswers.length > 1
      ? this.listAnswers.shift()!
      : this.listAnswers[0];
    return structuredClone(answer);
  }

  async connectorConnectUrl(
    credential: string,
    _signal?: AbortSignal,
  ): Promise<string> {
    this.connects.push(credential);
    return this.connectUrl;
  }

  async disconnectConnector(
    credential: string,
    email: string,
    _signal?: AbortSignal,
  ): Promise<{ status: string }> {
    this.disconnects.push({ credential, account: email });
    return { status: this.disconnectStatus };
  }

  async setDefaultConnector(
    credential: string,
    email: string,
    _signal?: AbortSignal,
  ): Promise<void> {
    this.defaults.push({ credential, account: email });
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

    const state = await connectors.connect();

    expect(plow.connects).toEqual([CREDENTIAL]);
    expect(opened).toEqual([CONNECT_URL]);
    expect(waits).toEqual([CONNECTOR_POLL_INTERVAL_MS]);
    // Baseline, successful poll, then the explicit final refresh.
    expect(plow.listCredentials).toEqual([CREDENTIAL, CREDENTIAL, CREDENTIAL]);
    expect(state).toEqual({
      busy: false,
      error: null,
      note: null,
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

  it("refreshes after thirty seconds and leaves a neutral re-auth note", async () => {
    const plow = new FakePlow();
    const { connectors, opened, audits, waits } = build(plow);

    const state = await connectors.connect();

    expect(opened).toEqual([CONNECT_URL]);
    expect(waits).toHaveLength(CONNECTOR_TIMEOUT_MS / CONNECTOR_POLL_INTERVAL_MS);
    expect(waits.reduce((total, milliseconds) => total + milliseconds, 0))
      .toBe(CONNECTOR_TIMEOUT_MS);
    // Baseline, ten polls, then one last un-aborted refresh in case the
    // browser flow completed as the polling deadline expired.
    expect(plow.listCredentials).toHaveLength(2 + waits.length);
    expect(state.busy).toBe(false);
    expect(state.google.connecting).toBe(false);
    expect(state.error).toBeNull();
    expect(state.note).toBe(CONNECTOR_TIMEOUT_NOTE);
    expect(audits).toEqual([]);
  });

  it("records a new account that appears only on the final refresh", async () => {
    const plow = new FakePlow();
    plow.listAnswers = [
      overview(),
      ...Array.from(
        { length: CONNECTOR_TIMEOUT_MS / CONNECTOR_POLL_INTERVAL_MS },
        () => overview(),
      ),
      overview([account("late@example.com", { isDefault: true })]),
    ];
    const { connectors, audits, waits } = build(plow);

    const state = await connectors.connect();

    expect(waits).toHaveLength(CONNECTOR_TIMEOUT_MS / CONNECTOR_POLL_INTERVAL_MS);
    expect(state.error).toBeNull();
    expect(state.note).toBeNull();
    expect(state.google.accounts).toEqual([
      account("late@example.com", { isDefault: true }),
    ]);
    expect(audits).toEqual([{
      event: "connector_connected",
      fields: { provider: "google", account: "late@example.com" },
    }]);
  });

  it("applies the thirty-second deadline to a poll request that never answers", async () => {
    const polling = new AbortController();
    const finalRefresh = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) =>
      milliseconds === CONNECTOR_TIMEOUT_MS ? polling.signal : finalRefresh.signal);
    const plow = new FakePlow();
    plow.pollGate = async (signal, call) => {
      if (call !== 2) return overview();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    };
    const { connectors } = build(plow);

    const pending = connectors.connect();
    while (plow.listCredentials.length < 2) await Promise.resolve();
    polling.abort(new DOMException("The operation was aborted.", "TimeoutError"));
    const state = await pending;

    expect(timeout).toHaveBeenCalledWith(CONNECTOR_TIMEOUT_MS);
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
    expect(state.note).toBe(CONNECTOR_TIMEOUT_NOTE);
  });

  it("bounds a final refresh that never answers and releases the card", async () => {
    const polling = new AbortController();
    const finalRefresh = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) =>
      milliseconds === CONNECTOR_TIMEOUT_MS ? polling.signal : finalRefresh.signal);
    const plow = new FakePlow();
    plow.pollGate = async (signal, call) => {
      const finalCall = 2 + CONNECTOR_TIMEOUT_MS / CONNECTOR_POLL_INTERVAL_MS;
      if (call !== finalCall) return overview();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    };
    const { connectors } = build(plow);

    const pending = connectors.connect();
    await vi.waitFor(() => {
      expect(timeout).toHaveBeenCalledWith(CONNECTOR_FINAL_REFRESH_TIMEOUT_MS);
    });
    finalRefresh.abort(new DOMException("The operation was aborted.", "TimeoutError"));
    const state = await pending;
    expect(state.busy).toBe(false);
    expect(state.google.connecting).toBe(false);
    expect(state.error).toBeNull();
    expect(state.note).toBe(CONNECTOR_TIMEOUT_NOTE);
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

    const first = connectors.connect();
    while (plow.connects.length === 0) await Promise.resolve();
    const refused = await connectors.disconnect("ada@example.com");

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

    const state = await connectors.connect();

    expect(opened).toEqual([]);
    expect(state.error).toBe("Plow couldn't open the connection page.");
    expect(JSON.stringify(state)).not.toContain(String(plow.connectUrl));
  });

  it.each([
    "http://localhost:4242/v1/connectors/gmail/connect?code=local",
    "http://127.0.0.1:4242/v1/connectors/gmail/connect?code=local",
    "http://[::1]:4242/v1/connectors/gmail/connect?code=local",
  ])("opens a loopback HTTP connect URL: %s", async (connectUrl) => {
    const plow = new FakePlow();
    plow.connectUrl = connectUrl;
    plow.listAnswers = [
      overview(),
      overview([account("local@example.com")]),
      overview([account("local@example.com")]),
    ];
    const { connectors, opened } = build(plow);

    const state = await connectors.connect();

    expect(opened).toEqual([connectUrl]);
    expect(state.error).toBeNull();
  });
});

describe("connector account actions", () => {
  it("disconnects only the named account, audits a deletion, and refreshes", async () => {
    const plow = new FakePlow();
    plow.listAnswers = [overview([account("grace@example.com", { isDefault: true })])];
    const { connectors, audits } = build(plow);

    const state = await connectors.disconnect("  ada@example.com  ");

    expect(plow.disconnects).toEqual([{
      credential: CREDENTIAL,
      account: "ada@example.com",
    }]);
    expect(audits).toEqual([{
      event: "connector_disconnected",
      fields: { provider: "google", account: "ada@example.com" },
    }]);
    expect(state.google.accounts).toEqual([account("grace@example.com", { isDefault: true })]);
  });

  it("does not audit when the named account was already disconnected", async () => {
    const plow = new FakePlow();
    plow.disconnectStatus = "not_connected";
    plow.listAnswers = [overview([account("grace@example.com", { isDefault: true })])];
    const { connectors, audits } = build(plow);

    const state = await connectors.disconnect("ada@example.com");

    expect(plow.disconnects).toHaveLength(1);
    expect(audits).toEqual([]);
    expect(state.google.accounts).toEqual([account("grace@example.com", { isDefault: true })]);
  });

  it("sets the named default, audits it, and refreshes", async () => {
    const plow = new FakePlow();
    plow.listAnswers = [overview([
      account("ada@example.com"),
      account("grace@example.com", { isDefault: true }),
    ])];
    const { connectors, audits } = build(plow);

    const state = await connectors.setDefault("grace@example.com");

    expect(plow.defaults).toEqual([{
      credential: CREDENTIAL,
      account: "grace@example.com",
    }]);
    expect(audits).toEqual([{
      event: "connector_default_changed",
      fields: { provider: "google", account: "grace@example.com" },
    }]);
    expect(state.google.accounts[1].isDefault).toBe(true);
  });
});

describe("connector account lifecycle", () => {
  it("clears both windows on sign-out and ignores a late old-account poll", async () => {
    const latePoll = deferred<ConnectorsOverview>();
    const plow = new FakePlow();
    const oldAccounts = overview([account("old@example.com", { isDefault: true })]);
    let pollSignal: AbortSignal | null = null;
    plow.pollGate = async (signal, call) => {
      if (call === 1) return oldAccounts;
      pollSignal = signal;
      return latePoll.promise;
    };
    const onboardingWindowStates: ConnectorsState[] = [];
    const mainWindowStates: ConnectorsState[] = [];
    let connectors!: Connectors;
    let audits!: Harness["audits"];
    ({ connectors, audits } = build(plow, {
      onChange: () => {
        onboardingWindowStates.push(connectors.state());
        mainWindowStates.push(connectors.state());
      },
    }));

    const pending = connectors.connect();
    while (!pollSignal) await Promise.resolve();
    const signedOut = connectors.signedOut();
    latePoll.resolve(overview([
      account("old@example.com", { isDefault: true }),
      account("late@example.com"),
    ]));
    await pending;

    expect(pollSignal).not.toBeNull();
    expect(pollSignal!.aborted).toBe(true);
    expect(signedOut).toEqual({
      busy: false,
      error: null,
      note: null,
      google: { accounts: [], connecting: false },
    });
    expect(connectors.state()).toEqual(signedOut);
    expect(onboardingWindowStates.at(-1)).toEqual(signedOut);
    expect(mainWindowStates.at(-1)).toEqual(signedOut);
    expect(audits).toEqual([]);
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
      states.push(await connectors.connect());
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
