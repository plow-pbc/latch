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
import {
  ConnectClient,
  ConnectClientState,
  agentConfig,
  isRosterId,
} from "../src/connectClient.js";
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
  /** Held LIST responses, by request number. Individually releasable, so a
   * test can decide the order two overlapping reads land in. */
  private listGates = new Map<number, { wait: Promise<void>; open: () => void }>();
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

  /** Hold the answer to the n-th list request (1-based). The request still
   * leaves, and still snapshots the account, exactly as a real one would. */
  holdList(n: number): void {
    let open: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.listGates.set(n, { wait, open });
  }

  releaseList(n: number): void {
    this.listGates.get(n)?.open();
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
    this.listedWith.push(token);
    // Answered as of the moment the request arrives, like the real endpoint —
    // so a read still in the air when a revoke lands returns the pre-revoke
    // account, which is exactly the thing that must not reach the screen.
    const snapshot = this.keys.map((k) => ({ ...k }));
    if (this.gate) await this.gate;
    await this.listGates.get(this.listedWith.length)?.wait;
    if (this.listFails) throw this.listFails;
    return snapshot;
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
/** Every state the screen was told to render, in order. */
let published: ConnectClientState[];

function build(): ConnectClient {
  const connect: ConnectClient = new ConnectClient({
    api: plow.api(),
    home,
    isConnected: () => connected,
    onChange: () => {
      changes += 1;
      published.push(connect.state());
    },
  });
  return connect;
}

/** Let queued microtasks and the timer queue drain, so an in-flight call has
 * actually reached the fake before a test releases it. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  published = [];
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
    // Busy on; the credential; the roster row it added; and the mint's own
    // closing publish. What matters is that the busy edges are both published
    // — a mint that only notified at the end is a dead window.
    expect(changes).toBe(4);
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
      keyRow({ id: 10, name: "Plow (this Mac)", scopes: ["relay:device", "llm:chat"] }),
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
    expect(state.revokeError).toBeNull();
    expect(state.busy).toBe(false);
  });

  it("reports a failed revoke and leaves the row where it was", async () => {
    signIn();
    plow.keys = [keyRow({ id: 7 })];
    const connect = build();
    await connect.refreshRoster();

    plow.revokeFails = new PlowApiError("network", "Couldn't reach Plow.");
    const state = await connect.revokeCredential(7);
    // The list is fine; it is the removal that did not happen. Saying so on
    // the roster's own error line would claim the rows are not to be trusted.
    expect(state.revokeError).toBe("Couldn't reach Plow.");
    expect(state.rosterError).toBeNull();
    expect(state.message).toBe("");
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
      expect(state.revokeError).toBe("That isn't something this Mac can revoke.");
      // A revoke failure is its own sentence: it is not a list failure, and it
      // is not the connect card's line either.
      expect(state.rosterError).toBeNull();
      expect(state.message).toBe("");
    }
    expect(plow.revoked).toEqual([]);
  });

  it("does nothing when this Mac is not signed in", async () => {
    const state = await build().revokeCredential(7);
    expect(plow.revoked).toEqual([]);
    expect(state.revokeError).toBe("This Mac isn't signed in yet.");
    expect(state.rosterError).toBeNull();
    expect(state.message).toBe("");
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

describe("only what is on the roster can be revoked", () => {
  it("refuses a real-looking id that was never listed, without calling Plow", async () => {
    // Ids are small sequential integers on a table shared with every other
    // credential on the account. A renderer that could name any of them could
    // walk the account — revoking keys that are not relay-capable, were never
    // shown here, and in the portal login's case would sign the user out of
    // the website. The roster is the whole of what this channel may act on.
    signIn();
    plow.keys = [
      keyRow({ id: 7, name: "Claude Code" }),
      // Real rows on the account, correctly filtered out of the roster.
      keyRow({ id: 8, name: "Plow (this Mac)", scopes: ["relay:device", "llm:chat"] }),
      keyRow({ id: 9, name: "revoked already", is_active: false }),
    ];
    const connect = build();
    await connect.refreshRoster();
    expect(connect.state().roster.map((r) => r.id)).toEqual([7]);

    for (const unlisted of [8, 9, 0, 42]) {
      const state = await connect.revokeCredential(unlisted);
      expect(state.revokeError).toBe("That isn't something this Mac can revoke.");
      expect(state.rosterError).toBeNull();
      expect(state.message).toBe("");
    }
    expect(plow.revoked).toEqual([]);

    // And the one that IS listed still goes through.
    await connect.revokeCredential(7);
    expect(plow.revoked).toEqual([{ token: DEVICE_TOKEN, id: 7 }]);
  });

  it("refuses everything while the roster has not loaded", async () => {
    signIn();
    const connect = build();
    const state = await connect.revokeCredential(7);
    expect(plow.revoked).toEqual([]);
    expect(state.revokeError).toBe("That isn't something this Mac can revoke.");
    expect(state.rosterError).toBeNull();
    expect(state.message).toBe("");
  });
});

describe("a read already in the air when the account changes under it", () => {
  it("does not let a revoke resolve on a list that predates it, whenever it lands", async () => {
    // The stale list left before the revoke did, so it describes the account
    // with the row still on it. Two things have to hold: the revoke must not
    // JOIN that request, and the request must not overwrite the revoke's own
    // answer when it finally lands — which, on a real network, it may well do
    // second. The gates below make it land second on purpose.
    signIn();
    plow.keys = [keyRow({ id: 7, name: "Claude Code" }), keyRow({ id: 8, name: "ChatGPT" })];
    const connect = build();
    await connect.refreshRoster();

    plow.holdList(2); // the stale read
    plow.holdList(3); // the revoke's own read
    const stale = connect.refreshRoster();
    await tick();

    const revoking = connect.revokeCredential(7);
    await tick();
    plow.releaseList(3); // the fresh answer lands first...
    await tick();
    plow.releaseList(2); // ...and the stale one arrives after it
    const [, state] = await Promise.all([stale, revoking]);

    // Three reads: the first, the one in the air, and the revoke's own — which
    // it had to start rather than join.
    expect(plow.listedWith).toHaveLength(3);
    expect(state.roster.map((r) => r.id)).toEqual([8]);
    // The late stale answer does not put the row back.
    expect(connect.state().roster.map((r) => r.id)).toEqual([8]);
  });

  it("does not let a mint resolve on a list that predates it either", async () => {
    signIn();
    plow.keys = [keyRow({ id: 7, name: "Claude Code" })];
    const connect = build();
    await connect.refreshRoster();

    plow.holdList(2);
    plow.holdList(3);
    const stale = connect.refreshRoster();
    await tick();

    const minting = connect.createCredential("ChatGPT");
    await tick();
    plow.releaseList(3);
    await tick();
    plow.releaseList(2);
    const [, state] = await Promise.all([stale, minting]);

    expect(state.roster.map((r) => r.name)).toEqual(["Claude Code", "ChatGPT"]);
    expect(connect.state().roster.map((r) => r.name)).toEqual(["Claude Code", "ChatGPT"]);
  });

  it("does not leave the next account joining the old account's list", async () => {
    // The generation check throws the old account's answer away. If the handle
    // were left installed, the new account would join that request, get the
    // discarded result, and sit on an empty Agents tab with no re-read coming.
    signIn();
    plow.keys = [keyRow({ id: 7, name: "Claude Code" })];
    const connect = build();
    plow.holdList(1);
    const abandoned = connect.refreshRoster();
    await tick();

    connect.signedOut();
    const state = await connect.refreshRoster();

    expect(plow.listedWith).toHaveLength(2);
    expect(state.roster.map((r) => r.id)).toEqual([7]);

    // And the abandoned read, landing after all of it, changes nothing.
    plow.releaseList(1);
    await abandoned;
    expect(connect.state().roster.map((r) => r.id)).toEqual([7]);
  });
});

describe("a revoke complaint is its own, and does not outstay its welcome", () => {
  it("does not clear a list failure, which a revoke has said nothing about", async () => {
    signIn();
    plow.keys = [keyRow({ id: 7 })];
    const connect = build();
    await connect.refreshRoster();
    plow.listFails = new PlowApiError("network", "Couldn't reach Plow.");
    await connect.refreshRoster();
    expect(connect.state().rosterError).toBe("Couldn't reach Plow.");

    // The rows are stale and say so; revoking one of them still fails on its
    // own terms, and the list's complaint is not this call's to withdraw.
    plow.revokeFails = new PlowApiError("http", "Plow said no.");
    const state = await connect.revokeCredential(7);
    expect(state.revokeError).toBe("Plow said no.");
    expect(state.rosterError).toBe("Couldn't reach Plow.");
  });

  it("goes when the next revoke works", async () => {
    signIn();
    plow.keys = [keyRow({ id: 7 }), keyRow({ id: 8 })];
    const connect = build();
    await connect.refreshRoster();

    plow.revokeFails = new PlowApiError("network", "Couldn't reach Plow.");
    expect((await connect.revokeCredential(7)).revokeError).toBe("Couldn't reach Plow.");

    plow.revokeFails = null;
    const state = await connect.revokeCredential(7);
    expect(state.revokeError).toBeNull();
    expect(state.roster.map((r) => r.id)).toEqual([8]);
  });

  it("survives a list that lands, which is what happens a round trip later", async () => {
    // Reads are triggered by the renderer asking for the state, and a failed
    // revoke is one of the things that makes it ask. Clearing on a successful
    // list would therefore erase the message almost as soon as it was written
    // — the user would see the row still there and nothing saying why.
    signIn();
    plow.keys = [keyRow({ id: 7 })];
    const connect = build();
    await connect.refreshRoster();
    plow.revokeFails = new PlowApiError("network", "Couldn't reach Plow.");
    await connect.revokeCredential(7);
    expect(connect.state().revokeError).toBe("Couldn't reach Plow.");

    const state = await connect.refreshRoster({ fresh: true });
    expect(state.rosterError).toBeNull();
    expect(state.revokeError).toBe("Couldn't reach Plow.");
  });

  it("survives a list that fails, because nothing has replaced what it said", async () => {
    signIn();
    plow.keys = [keyRow({ id: 7 })];
    const connect = build();
    await connect.refreshRoster();
    plow.revokeFails = new PlowApiError("network", "Couldn't reach Plow.");
    await connect.revokeCredential(7);

    plow.listFails = new PlowApiError("network", "Couldn't reach Plow.");
    const state = await connect.refreshRoster({ fresh: true });
    expect(state.revokeError).toBe("Couldn't reach Plow.");
    expect(state.rosterError).toBe("Couldn't reach Plow.");
  });

  it("goes on sign-out, with the roster it was about", async () => {
    signIn();
    plow.keys = [keyRow({ id: 7 })];
    const connect = build();
    await connect.refreshRoster();
    plow.revokeFails = new PlowApiError("network", "Couldn't reach Plow.");
    await connect.revokeCredential(7);

    const state = connect.signedOut();
    expect(state.revokeError).toBeNull();
    expect(state.rosterError).toBeNull();
    expect(state.roster).toEqual([]);
  });
});

describe("the credential goes on screen before anything else is asked of Plow", () => {
  it("does not hold the shown-once credential behind the roster re-read", async () => {
    // This screen exists to be copied from, and it is shown exactly once. The
    // list that follows the mint takes as long as a request takes — up to the
    // API client's whole timeout if Plow is wedged — and every second of that
    // would be a spinner over the thing the user is waiting to read.
    signIn();
    plow.holdList(1);
    const connect = build();
    const minting = connect.createCredential("Claude Code");
    await tick();

    // Readable...
    const shown = connect.state();
    expect(shown.credential?.config).toContain(plow.issued[0]);
    expect(shown.busy).toBe(false);
    // ...and the screen was TOLD, rather than left to find out later.
    const told = published.at(-1)!;
    expect(told.credential?.config).toContain(plow.issued[0]);
    expect(told.busy).toBe(false);
    // The roster is still the pre-mint one, which is exactly the point: it is
    // not what the user is here for, and it is not worth waiting on.
    expect(told.roster).toEqual([]);

    plow.releaseList(1);
    const state = await minting;
    expect(state.roster.map((r) => r.name)).toEqual(["Claude Code"]);
  });

  it("still shows it when the roster re-read fails outright", async () => {
    signIn();
    plow.listFails = new PlowApiError("network", "Couldn't reach Plow.");
    const connect = build();
    const state = await connect.createCredential("Claude Code");

    expect(state.credential?.config).toContain(plow.issued[0]);
    expect(state.rosterError).toBe("Couldn't reach Plow.");
    // The mint worked; the connect card must not claim otherwise.
    expect(state.message).toBe("");
  });
});
