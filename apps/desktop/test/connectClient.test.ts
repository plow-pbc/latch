/**
 * Connecting an MCP client: the URL is enough for the OAuth route, and this is
 * the fallback that mints a static credential — shown once and then gone.
 *
 * These tests moved here with the feature. It used to be the wizard's last
 * screen; the assertions about who mints it, what the config looks like, and
 * that it cannot be shown twice are the same ones, now against the module that
 * owns them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectClient } from "../src/connectClient.js";
import { KeyInfo, PlowApi, PlowApiError } from "../src/plowApi.js";
import { Deferred, deferred } from "./deferred.js";
import { loadSettings, saveSettings } from "../src/settings.js";

const DEVICE_TOKEN = "plow_DEVICEtok_secret";

/**
 * What plow publishes as `key_prefix`: `token[5:13]`, the eight characters
 * AFTER the `plow_` scheme. A hand-written prefix with the scheme on the front
 * made the old `startsWith` match look right here while it never matched in
 * production.
 */
const keyPrefixOf = (token: string) => token.slice(5, 13);
const CLIENT_TOKEN = "plow_CLIENTtok_shown_once";
const MCP_URL = "http://localhost:18804/v1/relay/devices/u_123/mcp";

/** A stand-in Plow that records who asked for what. */
class FakePlow {
  minted: Array<{ token: string; name: string }> = [];
  /** Every credential handed back, in order. Distinct, like the real ones. */
  issued: string[] = [];
  fails: PlowApiError | null = null;
  mcpConfigOverride: string | null = null;
  /** What `listApiKeys` will answer with. */
  keys: KeyInfo[] = [];
  /** Hold one list open, so a test can land reads out of order. */
  listGate: (() => Promise<KeyInfo[]> | null) | null = null;
  /** Every key revoke that was actually issued, in order. */
  revoked: number[] = [];
  /** Set to hold every mint open until `release()`, the way a slow API does. */
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  api(): PlowApi {
    return this as unknown as PlowApi;
  }

  async listApiKeys(_token: string): Promise<KeyInfo[]> {
    const held = this.listGate?.();
    if (held) return held;
    if (this.fails) throw this.fails;
    return this.keys;
  }

  async revokeApiKey(_token: string, id: number) {
    this.revoked.push(id);
    return { status: "revoked", id };
  }

  /** Make mints hang, so a test can act while one is in flight. */
  hold(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open?.();
    this.gate = null;
    this.open = null;
  }

  async createAgent(token: string, name: string) {
    if (this.gate) await this.gate;
    if (this.fails) throw this.fails;
    // Each mint is a distinct long-lived credential on the account, exactly as
    // the real endpoint is — so a test can see a second one that nobody asked
    // for rather than two copies of the same string.
    const issued = `${CLIENT_TOKEN}_${this.minted.length + 1}`;
    this.minted.push({ token, name });
    this.issued.push(issued);
    return {
      token: issued,
      keyPrefix: issued.slice(5, 13),
      name,
      mcpConfig: this.mcpConfigOverride ?? JSON.stringify({
        mcpServers: {
          "plow-mbp": {
            type: "http",
            url: "http://localhost:18804/v1/relay/devices/device-mbp/mcp",
            headers: { Authorization: `Bearer ${issued}` },
          },
          "plow-mba": {
            type: "http",
            url: "http://localhost:18804/v1/relay/devices/device-mba/mcp",
            headers: { Authorization: `Bearer ${issued}` },
          },
        },
      }),
    };
  }
}

let home: string;
let plow: FakePlow;
let connected: boolean;
let changes: number;
/** Every cloud-agent removal the roster routed, in order. */
let agentDeletes: string[];
/** How many times the roster asked this Mac to sign out. */
let signOuts: number;

function build(options: { deleteFails?: boolean } = {}): ConnectClient {
  return new ConnectClient({
    api: plow.api(),
    home,
    isConnected: () => connected,
    removeCloudAgent: async (agentId: string) => {
      agentDeletes.push(agentId);
      if (options.deleteFails) throw new PlowApiError("http", "Plow returned 500.", 500);
    },
    signOutThisMac: async () => {
      signOuts += 1;
    },
    onChange: () => {
      changes += 1;
    },
  });
}

/** A Mac that has been through login: a device credential and an endpoint. */
function signIn(): void {
  const settings = loadSettings(home);
  settings.relayCredential = DEVICE_TOKEN;
  settings.accountUid = "u_123";
  settings.mcpUrl = MCP_URL;
  saveSettings(home, settings);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-connect-"));
  plow = new FakePlow();
  connected = true;
  agentDeletes = [];
  signOuts = 0;
  changes = 0;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the screen a signed-in Mac shows", () => {
  it("leads with the endpoint and the socket, and never the credential", () => {
    signIn();
    const state = build().state();
    expect(state.mcpUrl).toBe(MCP_URL);
    expect(state.accountUid).toBe("u_123");
    expect(state.connected).toBe(true);
    expect(state.hasCredential).toBe(true);
    // The device credential has no business in a sandboxed web view.
    expect(JSON.stringify(state)).not.toContain(DEVICE_TOKEN);
  });

  it("says the socket is down when it is, rather than claiming otherwise", () => {
    signIn();
    connected = false;
    expect(build().state().connected).toBe(false);
  });

  it("reports a Mac that is not signed in as exactly that", () => {
    const state = build().state();
    expect(state.hasCredential).toBe(false);
    expect(state.mcpUrl).toBe("");
  });
});

describe("the static-credential fallback", () => {
  it("mints with the device credential and hands back a pasteable config", async () => {
    signIn();
    const connect = build();
    const state = await connect.createCredential("Claude Code");

    // The device credential mints agents; the login session is long gone.
    expect(plow.minted).toEqual([{ token: DEVICE_TOKEN, name: "Claude Code" }]);
    expect(state.credential?.name).toBe("Claude Code");

    const config = JSON.parse(state.credential!.config);
    expect(Object.keys(config.mcpServers)).toEqual(["plow-mbp", "plow-mba"]);
    expect(config.mcpServers["plow-mbp"].headers.Authorization).toBe(`Bearer ${plow.issued[0]}`);
    expect(config.mcpServers["plow-mba"].headers.Authorization).toBe(`Bearer ${plow.issued[0]}`);
    // A URL ends up in shell history, logs and stored registrations.
    expect(config.mcpServers["plow-mbp"].url).not.toContain(CLIENT_TOKEN);
  });

  it("shows it once — after 'I've saved it' the app cannot produce it again", async () => {
    signIn();
    const connect = build();
    await connect.createCredential("Claude Code");
    expect(connect.state().credential).not.toBeNull();

    const after = connect.dismissCredential();
    expect(after.credential).toBeNull();
    expect(JSON.stringify(after)).not.toContain(CLIENT_TOKEN);
    // And it stays gone: re-reading the state is not a way to get it back.
    expect(connect.state().credential).toBeNull();
    expect(JSON.stringify(connect.state())).not.toContain(CLIENT_TOKEN);
  });

  it.each([
    ["an unreadable config", "not json"],
    [
      "a config carrying a different credential",
      JSON.stringify({
        mcpServers: {
          "plow-mbp": {
            headers: { Authorization: "Bearer plow_someone_elses_token" },
          },
        },
      }),
    ],
  ])("refuses %s", async (_case, config) => {
    signIn();
    plow.mcpConfigOverride = config;

    const state = await build().createCredential("Claude Code");

    expect(state.credential).toBeNull();
    expect(state.message).toBe("Plow returned an invalid MCP configuration.");
  });

  it("never writes the minted credential to disk — the app is not its keeper", async () => {
    signIn();
    await build().createCredential("Claude Code");
    const onDisk = fs.readFileSync(path.join(home, "app/settings.json"), "utf8");
    expect(onDisk).not.toContain(CLIENT_TOKEN);
    expect(loadSettings(home).relayCredential).toBe(DEVICE_TOKEN);
  });

  it("asks for a name rather than minting an unnamed credential", async () => {
    signIn();
    const connect = build();
    const state = await connect.createCredential("   ");
    expect(state.message).toBe("Give this connection a name.");
    expect(state.credential).toBeNull();
    expect(plow.minted).toEqual([]);
  });

  it("trims the name it sends, so a stray space is not part of it", async () => {
    signIn();
    await build().createCredential("  Claude Code  ");
    expect(plow.minted[0].name).toBe("Claude Code");
  });

  it("refuses when this Mac holds no credential to mint with", async () => {
    const state = await build().createCredential("Claude Code");
    expect(state.message).toBe("This Mac isn't signed in yet.");
    expect(plow.minted).toEqual([]);
  });

  it("turns a failed mint into a sentence, not a spinner", async () => {
    signIn();
    plow.fails = new PlowApiError("network", "Couldn't reach Plow at http://localhost:18804.");
    const state = await build().createCredential("Claude Code");
    expect(state.message).toBe("Couldn't reach Plow at http://localhost:18804.");
    expect(state.busy).toBe(false);
    expect(state.credential).toBeNull();
  });

  it("tells the screen it is working, so a slow mint is not a dead window", async () => {
    signIn();
    const connect = build();
    const pending = connect.createCredential("Claude Code");
    expect(connect.state().busy).toBe(true);
    await pending;
    expect(connect.state().busy).toBe(false);
    // Busy on, busy off: the screen is notified both times.
    expect(changes).toBe(2);
  });
});

describe("one click, one credential", () => {
  it("does not mint twice when the button is hit twice before the screen catches up", async () => {
    // The renderer disables the button a round trip later, so a double-tap or a
    // held Enter lands two calls in that window. Every extra mint is a
    // long-lived credential live on the account that nobody was ever shown.
    signIn();
    plow.hold();
    const connect = build();

    const first = connect.createCredential("Claude Code");
    const second = connect.createCredential("Claude Code");
    const third = connect.createCredential("Claude Code");
    plow.release();
    const [a, b, c] = await Promise.all([first, second, third]);

    expect(plow.minted).toHaveLength(1);
    // And all three callers get the one credential that was minted.
    for (const state of [a, b, c]) expect(state.credential?.config).toContain(plow.issued[0]);
  });

  it("lets the next one through once the first has landed", async () => {
    signIn();
    const connect = build();
    await connect.createCredential("Claude Code");
    connect.dismissCredential();
    await connect.createCredential("ChatGPT");

    expect(plow.minted.map((m) => m.name)).toEqual(["Claude Code", "ChatGPT"]);
  });

  it("lets the next one through after a failed mint, rather than wedging", async () => {
    signIn();
    plow.fails = new PlowApiError("network", "Couldn't reach Plow.");
    const connect = build();
    await connect.createCredential("Claude Code");

    plow.fails = null;
    const state = await connect.createCredential("Claude Code");
    expect(state.credential).not.toBeNull();
  });
});

describe("signing out takes the credential with it", () => {
  it("drops a shown-once credential rather than carrying it into the next session", async () => {
    // It belongs to the account that just went away — and the next sign-in may
    // be a different account entirely.
    signIn();
    const connect = build();
    await connect.createCredential("Claude Code");
    expect(connect.state().credential).not.toBeNull();

    const after = connect.signedOut();
    expect(after.credential).toBeNull();
    expect(JSON.stringify(after)).not.toContain(CLIENT_TOKEN);
    expect(JSON.stringify(connect.state())).not.toContain(CLIENT_TOKEN);
  });

  it("never shows a mint that was in the air when the account went away", async () => {
    signIn();
    plow.hold();
    const connect = build();
    const inFlight = connect.createCredential("Claude Code");

    connect.signedOut();
    plow.release();
    const state = await inFlight;

    // The mint did reach Plow — that credential is live on the old account
    // until it is revoked there — but it never reaches this session's screen.
    expect(plow.minted).toHaveLength(1);
    expect(state.credential).toBeNull();
    expect(connect.state().credential).toBeNull();
    expect(JSON.stringify(connect.state())).not.toContain(CLIENT_TOKEN);
  });

  it("clears the busy flag, so the next session is not stuck on 'Talking to Plow'", async () => {
    signIn();
    plow.hold();
    const connect = build();
    const inFlight = connect.createCredential("Claude Code");
    expect(connect.state().busy).toBe(true);

    expect(connect.signedOut().busy).toBe(false);
    plow.release();
    await inFlight;
    expect(connect.state().busy).toBe(false);
  });

  it("does not leave the next account joining the old account's mint", async () => {
    signIn();
    plow.hold();
    const connect = build();
    const abandoned = connect.createCredential("Claude Code");
    connect.signedOut();

    // Signed in again — a fresh mint must be its own, not the one still in the
    // air from before.
    const next = connect.createCredential("ChatGPT");
    plow.release();
    await abandoned;
    const state = await next;

    expect(plow.minted.map((m) => m.name)).toEqual(["Claude Code", "ChatGPT"]);
    expect(state.credential?.name).toBe("ChatGPT");
    expect(state.credential?.config).toContain(plow.issued[1]);
  });
});

describe("reading the state is a read", () => {
  it("never notifies, because the renderer re-reads on every notification", () => {
    // The same loop `onboarding.ts` documents: a getter that publishes and a
    // renderer that reads on every publish is an unbroken re-render cycle,
    // which leaves the window drawn and completely inert.
    signIn();
    const connect = build();
    connect.state();
    connect.state();
    expect(changes).toBe(0);
  });
});

describe("removing a roster row", () => {
  /** One active credential, as `GET /v1/api-keys` returns it. */
  function key(overrides: Partial<KeyInfo> = {}): KeyInfo {
    return {
      id: 1,
      key_prefix: keyPrefixOf("plow_sk_someone_elses_credential"),
      name: "Kitchen agent",
      scopes: ["relay:call"],
      tokens_used: 0,
      is_active: true,
      last_seen_at: "2026-08-25T10:00:00Z",
      created_at: "2026-08-20T10:00:00Z",
      agent_id: null,
      chat_uids: [],
      ...overrides,
    };
  }

  /**
   * Every route a row can take, and the two it must never take instead.
   *
   * Each is destructive in its own way when it goes to the wrong place: a key
   * revoke on a cloud agent leaves the VM running and the webhook firing while
   * the row disappears from the list; a key revoke on this Mac leaves the
   * credential on disk, the socket dialled and the window open, all talking to
   * an account that no longer accepts them.
   */
  it.each([
    [
      "a cloud agent",
      () => key({ id: 7, agent_id: "agent_7" }),
      { revoked: [] as number[], deleted: ["agent_7"], signOuts: 0 },
    ],
    [
      "this Mac",
      () => key({ id: 4, key_prefix: keyPrefixOf(DEVICE_TOKEN) }),
      { revoked: [] as number[], deleted: [] as string[], signOuts: 1 },
    ],
    [
      "an ordinary credential",
      () => key({ id: 8, agent_id: null }),
      { revoked: [8], deleted: [] as string[], signOuts: 0 },
    ],
  ])("removes %s down its own route and no other", async (_what, row, expected) => {
    signIn();
    const only = row();
    plow.keys = [only];
    const client = build();
    await client.refreshRoster();

    await client.removeRosterRow(only.id);

    expect(plow.revoked).toEqual(expected.revoked);
    expect(agentDeletes).toEqual(expected.deleted);
    expect(signOuts).toBe(expected.signOuts);
  });

  /**
   * A read that has been overtaken says nothing about now, however it ends.
   *
   * The removal's own refresh is the newest answer; a tab-selection refresh
   * still in the air describes the account before the delete. Letting it land
   * puts a revoked session back on screen marked active — a lie about who can
   * reach the account.
   */
  it.each([
    ["failure", (d: Deferred<KeyInfo[]>) => d.reject(new PlowApiError("http", "Plow returned 500.", 500))],
    ["success", (d: Deferred<KeyInfo[]>) => d.resolve([key({ id: 8, agent_id: null })])],
  ])("a late %s never displaces the newer roster read", async (_ending, finish) => {
    signIn();
    const stale = deferred<KeyInfo[]>();
    let first = true;
    plow.listGate = () => {
      if (!first) return null;
      first = false;
      return stale.promise;
    };
    plow.keys = [];
    const client = build();

    const overtaken = client.refreshRoster();
    await client.refreshRoster();

    finish(stale);
    await overtaken;

    // The newer read said the account is empty, and it stays empty — with no
    // banner from the overtaken one either, which would report a failure that
    // has already been superseded by a good answer.
    expect(client.state().roster.mcp).toEqual([]);
    expect(client.state().roster.other).toEqual([]);
    expect(client.state().rosterError).toBeNull();
  });

  it("refreshes the roster after minting a credential", async () => {
    signIn();
    plow.keys = [];
    const client = build();
    await client.refreshRoster();
    plow.keys = [key({ id: 5, name: "Claude Code" })];

    await client.createCredential("Claude Code");
    await client.refreshRoster();

    // The mint IS a new roster row. Without a re-read the credential the user
    // just made is absent from the list it belongs in.
    expect(client.state().roster.mcp.map((row) => row.id)).toEqual([5]);
  });

  it("keeps the row when the removal fails", async () => {
    signIn();
    plow.keys = [key({ id: 9, agent_id: "agent_9" })];
    const client = build({ deleteFails: true });
    await client.refreshRoster();

    const state = await client.removeRosterRow(9);

    expect(state.removeError).toBe("Plow returned 500.");
    expect(state.roster.cloud.map((row) => row.id)).toEqual([9]);
  });
});
