import { describe, expect, it } from "vitest";
import {
  API_BASE_URL_ENV,
  DEVELOPMENT_API_BASE_URL,
  PRODUCTION_API_BASE_URL,
  PlowApi,
  REQUEST_TIMEOUT_MS,
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

});

describe("the device socket derives from that one base URL", () => {
  it("swaps https for wss and appends the relay path", () => {
    expect(relaySocketUrl("https://api.plow.co")).toBe("wss://api.plow.co/v1/relay/ws");
  });

  it("swaps http for ws, keeping the port a local API runs on", () => {
    expect(relaySocketUrl("http://localhost:18804")).toBe("ws://localhost:18804/v1/relay/ws");
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

  it("gives up on a request that is accepted and never answered", async () => {
    // Reported from a live run as "nothing in the window is interactive". The
    // request was taken and never answered; `fetch` has no default timeout, so
    // `Onboarding.run` held `busy` forever and the renderer's one-line
    // `disabled = !!state.busy` killed every button on the screen at once. The
    // fix has to be here — a call that cannot end is the root cause, and every
    // caller inherits it.
    let aborted = false;
    const fetchImpl = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal!.reason);
        });
      });

    const started = Date.now();
    const error = await new PlowApi("https://api.plow.co", fetchImpl)
      .createAgent("plow_device", "Claude Code")
      .catch((e) => e);

    expect(aborted).toBe(true);
    expect(error).toBeInstanceOf(PlowApiError);
    expect((error as PlowApiError).kind).toBe("network");
    // Honest about which failure it was: "didn't answer" sends you somewhere
    // different from "couldn't reach".
    expect((error as PlowApiError).message).toBe("Plow didn't answer in time. Try again.");
    expect(Date.now() - started).toBeLessThan(REQUEST_TIMEOUT_MS + 5_000);
  }, 30_000);

  it("passes a timeout signal on every request, not just the ones we remembered", async () => {
    const seen: Array<string | undefined> = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal ? "signal" : undefined);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const api = new PlowApi("https://api.plow.co", fetchImpl);
    await api.requestOtp("+1");
    await api.createActivation("Mac");
    await api.redeemActivation("s").catch(() => {});
    await api.relayInfo("t");
    await api.mintDeviceCredential("t", "Mac");
    await api.createAgent("t", "a");

    expect(seen).toEqual(Array(6).fill("signal"));
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

  it("mints this Mac's credential and retires the calling session in the same call", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: { token: "plow_devicetok", key_prefix: "devicet", name: "Domo Desktop" } },
    ]);
    await new PlowApi("https://api.plow.co", fetchImpl).mintDeviceCredential("plow_session", "Domo Desktop");

    expect(calls[0].url).toBe("https://api.plow.co/v1/relay/devices");
    // The flag is the whole reason there is no client-side cleanup: the session
    // that authorised this call can mint any credential on the account, and it
    // is gone server-side before this returns.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: "Domo Desktop",
      revoke_calling_session: true,
    });
    expect(calls[0].url).not.toContain("plow_session");
  });

  it("starts an activation and hands back the code, the secret and where to text it", async () => {
    const { calls, fetchImpl } = recordingFetch([
      {
        status: 200,
        body: { display_code: "Z1SWY", activation_secret: "act_secret_xyz", send_to: "+15551230000" },
      },
    ]);
    const activation = await new PlowApi("https://api.plow.co", fetchImpl).createActivation("This Mac");

    expect(calls[0].url).toBe("https://api.plow.co/v1/auth/activate");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: "This Mac" });
    // Unauthenticated by design — this is how an account that does not exist yet
    // gets created.
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(activation).toEqual({
      displayCode: "Z1SWY",
      activationSecret: "act_secret_xyz",
      sendTo: "+15551230000",
    });
  });

  it("reads a redeem poll, including the verified answer that omits the token", async () => {
    const api = (answers: Array<{ status: number; body?: unknown }>) =>
      new PlowApi("https://api.plow.co", recordingFetch(answers).fetchImpl);

    expect(await api([{ status: 200, body: { status: "pending" } }]).redeemActivation("s")).toEqual({
      status: "pending",
    });
    expect(
      await api([{ status: 200, body: { status: "verified", token: "plow_sess" } }]).redeemActivation("s"),
    ).toEqual({ status: "verified", token: "plow_sess" });
    // A second redeem after hand-off: `token` is absent, not null. Normalised
    // to null here so callers have one shape to check.
    expect(await api([{ status: 200, body: { status: "verified" } }]).redeemActivation("s")).toEqual({
      status: "verified",
      token: null,
    });
  });

  it("gives an expired activation its own kind, so the app can offer a fresh code", async () => {
    const { fetchImpl } = recordingFetch([{ status: 410, body: { detail: "Activation expired" } }]);
    const error = await new PlowApi("https://api.plow.co", fetchImpl)
      .redeemActivation("s")
      .catch((e) => e);

    expect((error as PlowApiError).kind).toBe("expired");
  });

  it("never puts the activation secret in a URL", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 200, body: { status: "pending" } }]);
    await new PlowApi("https://api.plow.co", fetchImpl).redeemActivation("act_secret_xyz");

    expect(calls[0].url).toBe("https://api.plow.co/v1/auth/activate/redeem");
    expect(calls[0].url).not.toContain("act_secret_xyz");
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

/**
 * `chatCompletion` shares the transport with every other call but NOT the error
 * policy, and that difference is the whole reason it exists.
 *
 * `errorFor` puts the server's `detail` verbatim into a thrown error's message.
 * That is right for onboarding, where `detail` is a sentence written for the
 * person reading it ("That code has expired"). It is wrong for the reviewer,
 * whose failure reasons are shown to a human deciding whether to trust an
 * operation — an upstream body is not text we control. So this one returns the
 * status and lets the caller map it.
 */
describe("chatCompletion returns outcomes instead of throwing them", () => {
  const HOSTILE = "Model '<script>alert(1)</script> plow_sk_leaked' is not allowed";

  it("returns {status, body} for a non-2xx instead of throwing", async () => {
    const { fetchImpl } = recordingFetch([{ status: 400, body: { detail: HOSTILE } }]);
    const api = new PlowApi("https://api.plow.co", fetchImpl);

    const result = await api.chatCompletion("plow_sk_token", { model: "m" });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ detail: HOSTILE });
  });

  it("does not throw a detail-bearing error on any error status", async () => {
    // If this ever throws, the reviewer's catch renders the message as
    // `reviewer error: <server detail>` and a hostile body lands in a
    // user-visible reason.
    for (const status of [400, 401, 402, 403, 410, 500, 502, 503]) {
      const { fetchImpl } = recordingFetch([{ status, body: { detail: HOSTILE } }]);
      const api = new PlowApi("https://api.plow.co", fetchImpl);
      const result = await api.chatCompletion("plow_sk_token", {});
      expect(result.status).toBe(status);
    }
  });

  it("returns a null body rather than throwing when the body is unreadable", async () => {
    const fetchImpl = async () =>
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } });
    const api = new PlowApi("https://api.plow.co", fetchImpl);

    expect(await api.chatCompletion("plow_sk_token", {})).toEqual({ status: 200, body: null });
  });

  it("carries the credential in the Authorization header and nowhere else", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 200, body: { choices: [] } }]);
    const api = new PlowApi("https://api.plow.co", fetchImpl);

    await api.chatCompletion("plow_sk_do_not_leak_me", { model: "m" });

    const { url, init } = calls[0];
    expect(url).toBe("https://api.plow.co/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer plow_sk_do_not_leak_me",
    );
    expect(url).not.toContain("plow_sk_do_not_leak_me");
    expect(init.body as string).not.toContain("plow_sk_do_not_leak_me");
  });
});

describe("revoking this Mac's own credential", () => {
  it("POSTs to the self-revoke route with the credential as a bearer token", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 200 }]);
    const api = new PlowApi("https://api.plow.co", fetchImpl);

    await api.revokeDeviceCredential("plow_sk_do_not_leak_me");

    const { url, init } = calls[0];
    expect(url).toBe("https://api.plow.co/v1/relay/devices/self/revoke");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer plow_sk_do_not_leak_me",
    );
    // The server knows which credential is calling, so the token is never in
    // the path — and never in a body either.
    expect(url).not.toContain("plow_sk_do_not_leak_me");
    expect(String(init.body ?? "")).not.toContain("plow_sk_do_not_leak_me");
  });

  it("accepts an empty 204, which is what a revoke has to say", async () => {
    // `recordingFetch` cannot build a null-body status, so this one is bespoke.
    const fetchImpl = async () => new Response(null, { status: 204 });
    const api = new PlowApi("https://api.plow.co", fetchImpl);
    await expect(api.revokeDeviceCredential("plow_sk_do_not_leak_me")).resolves.toBeUndefined();
  });

  it("throws on a refusal, leaving it to the caller to decide that is survivable", async () => {
    // Sign-out swallows this. The transport still reports it, so a future
    // caller that DOES care is not silently lied to.
    const { fetchImpl } = recordingFetch([{ status: 404, body: { detail: "Not Found" } }]);
    const api = new PlowApi("https://api.plow.co", fetchImpl);

    await expect(api.revokeDeviceCredential("plow_sk_do_not_leak_me")).rejects.toBeInstanceOf(
      PlowApiError,
    );
  });
});
