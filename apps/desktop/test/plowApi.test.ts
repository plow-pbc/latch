import { describe, expect, it } from "vitest";
import {
  API_BASE_URL_ENV,
  DEVELOPMENT_API_BASE_URL,
  PRODUCTION_API_BASE_URL,
  PlowApi,
  PlowApiError,
  relaySocketUrl,
  resolveApiBaseUrl,
} from "../src/plowApi.js";

/** A `fetch` that records what it was called with and replays canned answers. */
function recordingFetch(answers: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const answer = answers.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

describe("the API base URL is baked into the build", () => {
  it("points a dev build at the local API and everything else at production", () => {
    expect(resolveApiBaseUrl({ isDevBuild: true, env: {} })).toBe(DEVELOPMENT_API_BASE_URL);
    expect(resolveApiBaseUrl({ isDevBuild: false, env: {} })).toBe(PRODUCTION_API_BASE_URL);
  });

  it("lets a developer retarget with an environment variable", () => {
    const env = { [API_BASE_URL_ENV]: "https://staging.example/" };
    expect(resolveApiBaseUrl({ isDevBuild: false, env })).toBe("https://staging.example");
  });

  it("ignores an empty override rather than pointing at nothing", () => {
    expect(resolveApiBaseUrl({ isDevBuild: false, env: { [API_BASE_URL_ENV]: "  " } })).toBe(
      PRODUCTION_API_BASE_URL,
    );
  });
});

describe("the device socket derives from that one base URL", () => {
  it("swaps https for wss and appends the relay path", () => {
    expect(relaySocketUrl("https://api.plow.co")).toBe("wss://api.plow.co/v1/relay/ws");
  });

  it("swaps http for ws, keeping the port a local API runs on", () => {
    expect(relaySocketUrl("http://localhost:18804")).toBe("ws://localhost:18804/v1/relay/ws");
  });

  it("tolerates a trailing slash", () => {
    expect(relaySocketUrl("https://api.plow.co/")).toBe("wss://api.plow.co/v1/relay/ws");
  });
});

describe("PlowApi", () => {
  it("sends the phone number to /v1/auth/otp/request with no credential", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 200, body: { ok: true } }]);
    await new PlowApi("https://api.plow.co", fetchImpl).requestOtp("+15551110000");

    expect(calls[0].url).toBe("https://api.plow.co/v1/auth/otp/request");
    expect(calls[0].init.body).toBe(JSON.stringify({ phone: "+15551110000" }));
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("reports the SMS provider being down as its own kind — the one honest OTP failure", async () => {
    const { fetchImpl } = recordingFetch([{ status: 503, body: { detail: "Provider unavailable" } }]);
    const error = await new PlowApi("https://api.plow.co", fetchImpl)
      .requestOtp("+15551110000")
      .catch((e) => e);

    expect(error).toBeInstanceOf(PlowApiError);
    expect((error as PlowApiError).kind).toBe("provider_unavailable");
  });

  it("turns an unreachable API into a readable message, not a stack", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await new PlowApi("http://localhost:18804", fetchImpl)
      .requestOtp("+15551110000")
      .catch((e) => e);

    expect((error as PlowApiError).kind).toBe("network");
    expect((error as PlowApiError).message).toBe("Couldn't reach Plow at http://localhost:18804.");
  });

  it("returns the token from verify and flags a bad code as unauthorized", async () => {
    const ok = recordingFetch([{ status: 200, body: { token: "plow_abcdefghXYZ" } }]);
    expect(await new PlowApi("https://api.plow.co", ok.fetchImpl).verifyOtp("+1", "12345678")).toBe(
      "plow_abcdefghXYZ",
    );

    const bad = recordingFetch([{ status: 401, body: { detail: "Invalid or expired code" } }]);
    const error = await new PlowApi("https://api.plow.co", bad.fetchImpl)
      .verifyOtp("+1", "00000000")
      .catch((e) => e);
    expect((error as PlowApiError).kind).toBe("unauthorized");
  });

  it("reads the account and endpoint from /v1/relay/info rather than constructing them", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: { uid: "u_123", mcp_url: "https://api.plow.co/v1/relay/devices/u_123/mcp", device_connected: true } },
    ]);
    const info = await new PlowApi("https://api.plow.co", fetchImpl).relayInfo("plow_secret");

    expect(info).toEqual({
      uid: "u_123",
      mcpUrl: "https://api.plow.co/v1/relay/devices/u_123/mcp",
      deviceConnected: true,
    });
    // The credential travels in a header — never in the URL.
    expect(calls[0].url).not.toContain("plow_secret");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer plow_secret");
  });

  it("asks for relay:device and nothing else when minting this Mac's credential", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: { token: "plow_devicetok", key_prefix: "devicet", name: "Domo Desktop" } },
    ]);
    await new PlowApi("https://api.plow.co", fetchImpl).mintDeviceCredential("plow_otp", "Domo Desktop");

    expect(calls[0].url).toBe("https://api.plow.co/v1/api-keys");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: "Domo Desktop",
      scopes: ["relay:device"],
    });
  });

  it("mints an agent through the relay's own endpoint", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: { token: "plow_agenttok", key_prefix: "agenttk", name: "Claude Code" } },
    ]);
    const minted = await new PlowApi("https://api.plow.co", fetchImpl).createAgent(
      "plow_device",
      "Claude Code",
    );

    expect(calls[0].url).toBe("https://api.plow.co/v1/relay/agents");
    expect(minted.token).toBe("plow_agenttok");
  });
});
