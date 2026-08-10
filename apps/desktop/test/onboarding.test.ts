import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODE_TTL_MS, Onboarding, agentConfig } from "../src/onboarding.js";
import { PlowApi, PlowApiError } from "../src/plowApi.js";
import { loadSettings } from "../src/settings.js";

const DEVICE_TOKEN = "plow_DEVICEtok_secret";
const OTP_TOKEN = "plow_OTPTOKEN_secret";
const AGENT_TOKEN = "plow_AGENTtok_secret";
const MCP_URL = "http://localhost:18804/v1/relay/devices/u_123/mcp";

/** A stand-in Plow: records what was called, answers what the real one does. */
class FakePlow {
  requested: string[] = [];
  minted: Array<{ token: string; name: string }> = [];
  revoked: number[] = [];
  connected = false;
  verifyFails: "unauthorized" | "network" | null = null;
  requestFails: "provider_unavailable" | "network" | null = null;
  /** Rows in the user's key list, as `GET /v1/api-keys` would return them. */
  keys = [
    { id: 7, keyPrefix: OTP_TOKEN.slice(5, 13), name: "Account Portal" },
    { id: 8, keyPrefix: DEVICE_TOKEN.slice(5, 13), name: "Domo Desktop (test)" },
  ];

  api(): PlowApi {
    return this as unknown as PlowApi;
  }

  async requestOtp(phone: string): Promise<void> {
    if (this.requestFails) throw new PlowApiError(this.requestFails, "provider down");
    this.requested.push(phone);
  }

  async verifyOtp(): Promise<string> {
    if (this.verifyFails) throw new PlowApiError(this.verifyFails, "nope", 401);
    return OTP_TOKEN;
  }

  async relayInfo(token: string) {
    expect(token).toBe(OTP_TOKEN); // the OTP session, not the device credential
    return { uid: "u_123", mcpUrl: MCP_URL, deviceConnected: this.connected };
  }

  async mintDeviceCredential(token: string, name: string) {
    expect(token).toBe(OTP_TOKEN);
    this.minted.push({ token, name });
    return { token: DEVICE_TOKEN, keyPrefix: DEVICE_TOKEN.slice(5, 13), name };
  }

  async createAgent(token: string, name: string) {
    // The device credential mints agents — the OTP session is long gone.
    expect(token).toBe(DEVICE_TOKEN);
    return { token: AGENT_TOKEN, keyPrefix: AGENT_TOKEN.slice(5, 13), name };
  }

  async listKeys() {
    return this.keys;
  }

  async revokeKey(_token: string, id: number) {
    this.revoked.push(id);
  }
}

let home: string;
let plow: FakePlow;
let warnings: string[];
let started: number;
let clock: number;

function build(): Onboarding {
  return new Onboarding({
    api: plow.api(),
    home,
    startRelay: async () => {
      started += 1;
      plow.connected = true;
    },
    isConnected: () => plow.connected,
    deviceName: "Domo Desktop (test)",
    now: () => clock,
    warn: (m) => warnings.push(m),
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-onboarding-"));
  plow = new FakePlow();
  warnings = [];
  started = 0;
  clock = 1_700_000_000_000;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("first-run login", () => {
  it("walks phone → code → connected and stores what the server told it", async () => {
    const onboarding = build();
    expect(onboarding.state().step).toBe("phone");

    let state = await onboarding.requestCode(" +1 555 111 0000 ");
    expect(plow.requested).toEqual(["+1 555 111 0000"]);
    expect(state.step).toBe("code");
    expect(state.codeExpiresAt).toBe(clock + CODE_TTL_MS);
    // The copy cannot promise a code was sent — the API answers the same for an
    // unknown number, an unparseable one and a failed send — so the first ask
    // leaves the message line to the screen's own wording.
    expect(state.message).toBe("");

    state = await onboarding.submitCode("12345678");
    expect(state.step).toBe("connected");
    expect(state.accountUid).toBe("u_123");
    expect(state.mcpUrl).toBe(MCP_URL);
    expect(started).toBe(1);

    // The endpoint came from GET /v1/relay/info; the app never builds it.
    const settings = loadSettings(home);
    expect(settings.relayCredential).toBe(DEVICE_TOKEN);
    expect(settings.mcpUrl).toBe(MCP_URL);
  });

  it("throws the OTP session away the moment the device credential exists", async () => {
    const onboarding = build();
    await onboarding.requestCode("+15551110000");
    await onboarding.submitCode("12345678");

    // Row 7 is the "Account Portal" session verify just minted; row 8 is this
    // Mac's own credential and must survive.
    expect(plow.revoked).toEqual([7]);
    // And it is not kept anywhere on disk.
    expect(JSON.stringify(loadSettings(home))).not.toContain(OTP_TOKEN);
  });

  it("stays usable when the login session cannot be revoked", async () => {
    plow.revokeKey = async () => {
      throw new PlowApiError("forbidden", "Not permitted.", 403);
    };
    const onboarding = build();
    await onboarding.requestCode("+15551110000");
    const state = await onboarding.submitCode("12345678");

    expect(state.step).toBe("connected");
    expect(warnings.join(" ")).toContain("could not revoke the login session");
    expect(warnings.join(" ")).not.toContain(OTP_TOKEN);
  });


  it("writes settings owner-only", async () => {
    // The spec names this hazard by name: settings.json holds the device
    // credential, and it used to be written with no mode at all. The
    // first-run transcript checks the mode too, but a permission bit on a
    // file holding a credential is worth pinning in CI in its own right.
    const onboarding = build();
    await onboarding.requestCode("+15551110000");
    await onboarding.submitCode("12345678");

    const mode = fs.statSync(path.join(home, "app/settings.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("opens on the connected screen when this Mac already holds a credential", async () => {
    const first = build();
    await first.requestCode("+15551110000");
    await first.submitCode("12345678");

    expect(build().state().step).toBe("connected");
  });
});

describe("honest messages instead of a spinner", () => {
  it("names a wrong code as a wrong code", async () => {
    plow.verifyFails = "unauthorized";
    const onboarding = build();
    await onboarding.requestCode("+15551110000");
    const state = await onboarding.submitCode("00000000");

    expect(state.step).toBe("code");
    expect(state.message).toBe("That code didn't work. Check it, or send a new one.");
    expect(state.busy).toBe(false);
  });

  it("distinguishes an expired code, which the server cannot", async () => {
    const onboarding = build();
    await onboarding.requestCode("+15551110000");
    clock += CODE_TTL_MS + 1;
    const state = await onboarding.submitCode("12345678");

    expect(state.message).toBe("That code has expired. Send a new one.");
  });

  it("resends with a fresh clock", async () => {
    const onboarding = build();
    await onboarding.requestCode("+15551110000");
    clock += 60_000;
    const state = await onboarding.resendCode();

    expect(plow.requested).toEqual(["+15551110000", "+15551110000"]);
    expect(state.codeExpiresAt).toBe(clock + CODE_TTL_MS);
    // "Asked", never "sent" — the API cannot tell us which.
    expect(state.message).toBe("Asked Plow for a new code.");
  });

  it("says so when the API is unreachable", async () => {
    plow.requestFails = "network";
    const state = await build().requestCode("+15551110000");

    expect(state.step).toBe("phone");
    expect(state.message).toBe("provider down");
    expect(state.busy).toBe(false);
  });

  it("rejects a code that is not eight digits without a round trip", async () => {
    const onboarding = build();
    await onboarding.requestCode("+15551110000");
    const state = await onboarding.submitCode("1234");

    expect(state.message).toBe("Enter the 8-digit code from your phone.");
  });
});

describe("creating an agent", () => {
  it("yields a credential and a pasteable config, shown once", async () => {
    const onboarding = build();
    await onboarding.requestCode("+15551110000");
    await onboarding.submitCode("12345678");

    const state = await onboarding.createAgent("Claude Code");
    expect(state.step).toBe("agent");
    expect(state.agent?.token).toBe(AGENT_TOKEN);
    // The credential is a header, never part of a URL.
    expect(JSON.parse(state.agent!.config).mcpServers.domo.url).toBe(MCP_URL);
    expect(JSON.parse(state.agent!.config).mcpServers.domo.headers.Authorization).toBe(
      `Bearer ${AGENT_TOKEN}`,
    );

    // Dismissing drops it: the app cannot show it a second time.
    const after = onboarding.dismissAgent();
    expect(after.agent).toBeNull();
    expect(after.step).toBe("connected");
    expect(JSON.stringify(loadSettings(home))).not.toContain(AGENT_TOKEN);
  });
});

describe("what the renderer is allowed to see", () => {
  it("never carries the device credential in the state", async () => {
    const onboarding = build();
    await onboarding.requestCode("+15551110000");
    const connectedState = await onboarding.submitCode("12345678");
    const agentState = await onboarding.createAgent("Claude Code");

    for (const state of [connectedState, agentState]) {
      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain(DEVICE_TOKEN);
      expect(serialized).not.toContain(OTP_TOKEN);
    }
  });
});

describe("agentConfig", () => {
  it("puts the credential in a header, because URLs end up in logs", () => {
    const config = JSON.parse(agentConfig(MCP_URL, "plow_tok"));
    expect(config.mcpServers.domo.url).not.toContain("plow_tok");
    expect(config.mcpServers.domo.headers.Authorization).toBe("Bearer plow_tok");
  });
});
