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
import { ConnectClient, agentConfig, isRosterId } from "../src/connectClient.js";
import { KeyInfo, PlowApi, PlowApiError } from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";

const DEVICE_TOKEN = "plow_DEVICEtok_secret";
const CLIENT_TOKEN = "plow_CLIENTtok_shown_once";
const MCP_URL = "http://localhost:18804/v1/relay/devices/u_123/mcp";

/** One `GET /v1/api-keys` row, defaulted to a qualifying, active agent. */
function keyRow(over: Partial<KeyInfo> = {}): KeyInfo {
  return {
    id: 1,
    key_prefix: "plow_AGE",
    name: "Claude Code",
    scopes: ["relay:call"],
    tokens_used: 0,
    is_active: true,
    last_seen_at: "2026-08-16T10:00:00Z",
    created_at: "2026-08-01T09:00:00Z",
    ...over,
  };
}

/** A stand-in Plow that records who asked for what. */
class FakePlow {
  minted: Array<{ token: string; name: string }> = [];
  /** What `GET /v1/api-keys` will return, and who asked for it. */
  keys: KeyInfo[] = [];
  listedWith: string[] = [];
  listFails: PlowApiError | null = null;
  revoked: Array<{ token: string; id: number }> = [];
  revokeFails: PlowApiError | null = null;
  /** Every credential handed back, in order. Distinct, like the real ones. */
  issued: string[] = [];
  fails: PlowApiError | null = null;
  /** Set to hold every mint open until `release()`, the way a slow API does. */
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  api(): PlowApi {
    return this as unknown as PlowApi;
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
    // The real endpoint creates a row that the next list returns.
    this.keys.push(keyRow({ id: 100 + this.minted.length, name }));
    return { token: issued, keyPrefix: issued.slice(5, 13), name };
  }

  async listApiKeys(token: string): Promise<KeyInfo[]> {
    if (this.gate) await this.gate;
    this.listedWith.push(token);
    if (this.listFails) throw this.listFails;
    return this.keys.map((k) => ({ ...k }));
  }

  async revokeApiKey(token: string, id: number) {
    if (this.gate) await this.gate;
    this.revoked.push({ token, id });
    if (this.revokeFails) throw this.revokeFails;
    // Soft delete, exactly as plow does it: the row keeps coming back, inactive.
    for (const key of this.keys) if (key.id === id) key.is_active = false;
    return { status: "revoked", id };
  }
}

let home: string;
let plow: FakePlow;
let connected: boolean;
let changes: number;

function build(): ConnectClient {
  return new ConnectClient({
    api: plow.api(),
    home,
    isConnected: () => connected,
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
    // Busy on, busy off, and the roster the mint just added a row to: the
    // screen is notified for each. What matters is that the busy edges are
    // both published — a mint that only notified at the end is a dead window.
    expect(changes).toBe(3);
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

describe("the roster of what can reach this Mac", () => {
  it("lists with the device credential and shows only the display projection", async () => {
    signIn();
    plow.keys = [
      keyRow({ id: 7, name: "Claude Code", scopes: ["relay:call"] }),
      keyRow({ id: 8, name: "plow.co", scopes: ["relay:*"] }),
      keyRow({ id: 9, name: "old", scopes: ["*:*"] }),
      // Not relay-capable, and not revoked from here: this Mac's own device row.
      keyRow({ id: 10, name: "Domo Desktop", scopes: ["relay:device", "llm:chat"] }),
      keyRow({ id: 11, name: "gone", is_active: false }),
    ];
    const connect = build();
    const state = await connect.refreshRoster();

    expect(plow.listedWith).toEqual([DEVICE_TOKEN]);
    expect(state.rosterError).toBeNull();
    expect(state.roster).toEqual([
      { id: 7, name: "Claude Code", kind: "Agent", createdAt: "2026-08-01T09:00:00Z", lastSeenAt: "2026-08-16T10:00:00Z" },
      { id: 8, name: "plow.co", kind: "Plow web login", createdAt: "2026-08-01T09:00:00Z", lastSeenAt: "2026-08-16T10:00:00Z" },
      { id: 9, name: "old", kind: "Legacy — full access", createdAt: "2026-08-01T09:00:00Z", lastSeenAt: "2026-08-16T10:00:00Z" },
    ]);
  });

  it("carries no token, no key prefix and no scope array across the bridge", async () => {
    // The state is structured-cloned to a sandboxed web view. Everything in it
    // is readable there, so what is in it is the whole of the boundary.
    signIn();
    plow.keys = [keyRow({ id: 7, key_prefix: "plow_LEAK", scopes: ["relay:call", "vault:read"] })];
    const connect = build();
    await connect.createCredential("Claude Code");
    const marshalled = JSON.stringify(connect.state());

    expect(marshalled).not.toContain(DEVICE_TOKEN);
    expect(marshalled).not.toContain("plow_LEAK");
    expect(marshalled).not.toContain("key_prefix");
    expect(marshalled).not.toContain("scopes");
    expect(marshalled).not.toContain("vault:read");
    expect(marshalled).not.toContain("tokens_used");
    // The freshly minted client credential is on screen; nothing else is.
    expect(marshalled).toContain(plow.issued[0]);
  });

  it("re-reads after a mint, so the new agent is in the state the mint returns", async () => {
    signIn();
    const connect = build();
    const state = await connect.createCredential("Claude Code");
    expect(state.roster.map((r) => r.name)).toEqual(["Claude Code"]);
  });

  it("says nothing rather than erroring when this Mac is not signed in", async () => {
    const state = await build().refreshRoster();
    expect(plow.listedWith).toEqual([]);
    expect(state.roster).toEqual([]);
    expect(state.rosterError).toBeNull();
  });

  it("notifies the screen when the answer changes, and stays quiet when it does not", async () => {
    // The main process re-reads the roster whenever the renderer asks for the
    // state, and the renderer re-reads on every notification. Publishing only
    // on a change is the whole reason that settles instead of spinning.
    signIn();
    plow.keys = [keyRow({ id: 7 })];
    const connect = build();
    await connect.refreshRoster();
    expect(changes).toBe(1);
    await connect.refreshRoster();
    await connect.refreshRoster();
    expect(changes).toBe(1);

    plow.keys = [keyRow({ id: 7 }), keyRow({ id: 8, name: "ChatGPT" })];
    await connect.refreshRoster();
    expect(changes).toBe(2);
  });

  it("joins a list already in flight rather than asking twice", async () => {
    signIn();
    plow.keys = [keyRow({ id: 7 })];
    plow.hold();
    const connect = build();
    const both = Promise.all([connect.refreshRoster(), connect.refreshRoster()]);
    plow.release();
    await both;
    expect(plow.listedWith).toEqual([DEVICE_TOKEN]);
  });

  it("drops the roster on sign-out rather than showing the last account's", async () => {
    signIn();
    plow.keys = [keyRow({ id: 7 })];
    const connect = build();
    await connect.refreshRoster();
    expect(connect.signedOut().roster).toEqual([]);
    expect(connect.state().rosterError).toBeNull();
  });
});

describe("a roster that will not load", () => {
  it("surfaces the error and leaves the connect card entirely intact", async () => {
    signIn();
    plow.listFails = new PlowApiError("network", "Couldn't reach Plow.");
    const connect = build();
    const state = await connect.refreshRoster();

    expect(state.rosterError).toBe("Couldn't reach Plow.");
    expect(state.roster).toEqual([]);
    // Everything the card above the roster renders from is still there.
    expect(state.mcpUrl).toBe(MCP_URL);
    expect(state.accountUid).toBe("u_123");
    expect(state.hasCredential).toBe(true);
    expect(state.connected).toBe(true);
    expect(state.message).toBe("");
  });

  it("keeps the rows it already had, rather than blanking the list", async () => {
    signIn();
    plow.keys = [keyRow({ id: 7, name: "Claude Code" })];
    const connect = build();
    await connect.refreshRoster();

    plow.listFails = new PlowApiError("network", "Couldn't reach Plow.");
    const state = await connect.refreshRoster();
    expect(state.roster.map((r) => r.id)).toEqual([7]);
    expect(state.rosterError).toBe("Couldn't reach Plow.");
  });

  it("recovers on the retry, and clears the error with it", async () => {
    signIn();
    plow.listFails = new PlowApiError("network", "Couldn't reach Plow.");
    const connect = build();
    await connect.refreshRoster();

    plow.listFails = null;
    plow.keys = [keyRow({ id: 7 })];
    const state = await connect.refreshRoster();
    expect(state.rosterError).toBeNull();
    expect(state.roster.map((r) => r.id)).toEqual([7]);
  });

  it("never puts the device credential in the error the renderer is shown", async () => {
    signIn();
    plow.listFails = new PlowApiError("http", "Plow said no.");
    const connect = build();
    const state = await connect.refreshRoster();
    expect(JSON.stringify(state)).not.toContain(DEVICE_TOKEN);
  });
});

describe("revoking a listed credential", () => {
  it("revokes with the device credential and re-reads the list", async () => {
    signIn();
    plow.keys = [keyRow({ id: 7, name: "Claude Code" }), keyRow({ id: 8, name: "ChatGPT" })];
    const connect = build();
    await connect.refreshRoster();

    // Something else added an agent while this screen was open. The refreshed
    // list is what the roster becomes, so it turns up — a local splice of the
    // revoked row would silently keep showing a stale account.
    plow.keys.push(keyRow({ id: 9, name: "Codex" }));

    const state = await connect.revokeCredential(7);
    expect(plow.revoked).toEqual([{ token: DEVICE_TOKEN, id: 7 }]);
    // The row is gone because the refreshed list reports it inactive.
    expect(state.roster.map((r) => r.id)).toEqual([8, 9]);
    expect(state.rosterError).toBeNull();
    expect(state.busy).toBe(false);
  });

  it("reports a failed revoke and leaves the row where it was", async () => {
    signIn();
    plow.keys = [keyRow({ id: 7 })];
    const connect = build();
    await connect.refreshRoster();

    plow.revokeFails = new PlowApiError("network", "Couldn't reach Plow.");
    const state = await connect.revokeCredential(7);
    expect(state.rosterError).toBe("Couldn't reach Plow.");
    expect(state.roster.map((r) => r.id)).toEqual([7]);
    expect(state.busy).toBe(false);
    expect(JSON.stringify(state)).not.toContain(DEVICE_TOKEN);
  });

  it("refuses an id that is not a row id, without calling Plow at all", async () => {
    // It crosses the bridge from a sandboxed renderer and is pasted into a
    // request path. Anything but a plain row id is a bug or an attempt.
    signIn();
    const connect = build();
    for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, "7", null, undefined, {}]) {
      const state = await connect.revokeCredential(bad as number);
      expect(state.message).toBe("That isn't something this Mac can revoke.");
    }
    expect(plow.revoked).toEqual([]);
  });

  it("does nothing when this Mac is not signed in", async () => {
    const state = await build().revokeCredential(7);
    expect(plow.revoked).toEqual([]);
    expect(state.message).toBe("This Mac isn't signed in yet.");
  });
});

describe("isRosterId", () => {
  it("accepts a plain row id and nothing else", () => {
    expect(isRosterId(0)).toBe(true);
    expect(isRosterId(7)).toBe(true);
    for (const bad of [-1, 1.5, NaN, Infinity, -0.0001, Number.MAX_SAFE_INTEGER + 2, "7", null, undefined, {}, []]) {
      expect(isRosterId(bad)).toBe(false);
    }
  });
});
