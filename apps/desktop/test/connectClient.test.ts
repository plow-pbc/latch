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
import { PlowApi, PlowApiError } from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";

const DEVICE_TOKEN = "plow_DEVICEtok_secret";
const CLIENT_TOKEN = "plow_CLIENTtok_shown_once";
const MCP_URL = "http://localhost:18804/v1/relay/devices/u_123/mcp";

/** A stand-in Plow that records who asked for what. */
class FakePlow {
  minted: Array<{ token: string; name: string }> = [];
  fails: PlowApiError | null = null;

  api(): PlowApi {
    return this as unknown as PlowApi;
  }

  async createAgent(token: string, name: string) {
    if (this.fails) throw this.fails;
    this.minted.push({ token, name });
    return { token: CLIENT_TOKEN, keyPrefix: CLIENT_TOKEN.slice(5, 13), name };
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
    expect(config.mcpServers.domo.url).toBe(MCP_URL);
    expect(config.mcpServers.domo.headers.Authorization).toBe(`Bearer ${CLIENT_TOKEN}`);
    // A URL ends up in shell history, logs and stored registrations.
    expect(config.mcpServers.domo.url).not.toContain(CLIENT_TOKEN);
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
    expect(config.mcpServers.domo).toEqual({
      type: "http",
      url: MCP_URL,
      headers: { Authorization: "Bearer plow_secret" },
    });
  });
});
