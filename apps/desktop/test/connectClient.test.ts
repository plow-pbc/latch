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
import { ConnectClient, agentConfig } from "../src/connectClient.js";
import { KeyInfo, PlowApi, PlowApiError } from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";

const DEVICE_TOKEN = "plow_DEVICEtok_secret";
const CLIENT_TOKEN = "plow_CLIENTtok_shown_once";
const MCP_URL = "http://localhost:18804/v1/relay/devices/u_123/mcp";

/** A stand-in Plow that records who asked for what. */
class FakePlow {
  minted: Array<{ token: string; name: string }> = [];
  /** Every credential handed back, in order. Distinct, like the real ones. */
  issued: string[] = [];
  fails: PlowApiError | null = null;
  /** What `listApiKeys` will answer with. */
  keys: KeyInfo[] = [];
  /** Every key revoke that was actually issued, in order. */
  revoked: number[] = [];
  /** Set to hold every mint open until `release()`, the way a slow API does. */
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  api(): PlowApi {
    return this as unknown as PlowApi;
  }

  async listApiKeys(_token: string): Promise<KeyInfo[]> {
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
    return { token: issued, keyPrefix: issued.slice(5, 13), name };
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
    expect(config.mcpServers.plow.url).toBe(MCP_URL);
    expect(config.mcpServers.plow.headers.Authorization).toBe(`Bearer ${plow.issued[0]}`);
    // A URL ends up in shell history, logs and stored registrations.
    expect(config.mcpServers.plow.url).not.toContain(CLIENT_TOKEN);
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

describe("agentConfig", () => {
  it("puts the credential in a header, because URLs end up in logs", () => {
    const config = JSON.parse(agentConfig(MCP_URL, "plow_secret"));
    expect(config.mcpServers.plow).toEqual({
      type: "http",
      url: MCP_URL,
      headers: { Authorization: "Bearer plow_secret" },
    });
  });
});

describe("removing a roster row", () => {
  /** One active credential, as `GET /v1/api-keys` returns it. */
  function key(overrides: Partial<KeyInfo> = {}): KeyInfo {
    return {
      id: 1,
      key_prefix: "plow_sk_other",
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

  it("NEVER revokes the key of a row that belongs to a cloud agent", async () => {
    signIn();
    plow.keys = [key({ id: 7, agent_id: "agent_7" })];
    const client = build();
    await client.refreshRoster();

    await client.removeRosterRow(7);

    // The whole point. A key revoke flips `is_active` and nothing else: the VM
    // keeps running, the chat's webhook keeps firing, and the row disappears
    // from this list because inactive rows are filtered out.
    expect(plow.revoked).toEqual([]);
    expect(agentDeletes).toEqual(["agent_7"]);
  });

  it("signs this Mac out instead of revoking its own key", async () => {
    signIn();
    // The roster marks exactly one row as this Mac; its prefix is the stored
    // credential's.
    plow.keys = [key({ id: 4, key_prefix: DEVICE_TOKEN.slice(0, 12) })];
    const client = build();
    await client.refreshRoster();

    await client.removeRosterRow(4);

    // A revoke alone leaves the credential on disk, the socket dialled and the
    // window open, all talking to an account that no longer accepts them —
    // while the row promised an immediate sign-out.
    expect(signOuts).toBe(1);
    expect(plow.revoked).toEqual([]);
    expect(agentDeletes).toEqual([]);
  });

  it("revokes the key of a row that is not an agent", async () => {
    signIn();
    plow.keys = [key({ id: 8, agent_id: null })];
    const client = build();
    await client.refreshRoster();

    await client.removeRosterRow(8);

    expect(plow.revoked).toEqual([8]);
    expect(agentDeletes).toEqual([]);
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
