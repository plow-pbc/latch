import { describe, expect, it, vi } from "vitest";
import {
  API_BASE_URL_ENV,
  PRODUCTION_API_BASE_URL,
  PlowApi,
  REQUEST_TIMEOUT_MS,
  PlowApiError,
  parseActivationChat,
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
  it("points EVERY build at production, including a run from source", () => {
    // Production is live, so it is the useful default and the one that matches
    // what a user gets. A from-source run that quietly talked to localhost was
    // a standing way to "test" against nothing.
    expect(resolveApiBaseUrl({ env: {} })).toBe(PRODUCTION_API_BASE_URL);
    expect(resolveApiBaseUrl({})).toBe(PRODUCTION_API_BASE_URL);
    expect(resolveApiBaseUrl({ env: { SOMETHING_ELSE: "http://localhost:1" } })).toBe(
      PRODUCTION_API_BASE_URL,
    );
  });

  it("lets a developer retarget with an environment variable", () => {
    const env = { [API_BASE_URL_ENV]: "https://staging.example/" };
    expect(resolveApiBaseUrl({ env })).toBe("https://staging.example");
  });

  it("still reaches a local relay through that override", () => {
    // There is no local default any more; a developer who wants one exports it.
    // This is the whole mechanism, so it is worth pinning on a real local URL.
    const env = { [API_BASE_URL_ENV]: "http://localhost:4242" };
    expect(resolveApiBaseUrl({ env })).toBe("http://localhost:4242");
  });

  it("ignores an override that is only whitespace", () => {
    expect(resolveApiBaseUrl({ env: { [API_BASE_URL_ENV]: "   " } })).toBe(PRODUCTION_API_BASE_URL);
  });
});

describe("the device socket derives from that one base URL", () => {
  it("swaps https for wss and appends the relay path", () => {
    expect(relaySocketUrl("https://api.plow.co")).toBe("wss://api.plow.co/v1/relay/ws");
  });

  it("swaps http for ws, keeping the port a local API runs on", () => {
    expect(relaySocketUrl("http://localhost:4242")).toBe("ws://localhost:4242/v1/relay/ws");
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

    // Driven rather than waited out. Vitest's fake timers cannot move
    // `AbortSignal.timeout` — it runs on a timer internal to Node, not the
    // global `setTimeout` sinon patches — so the clock is faked by standing in
    // for the call itself. That keeps what this test is for: the request must
    // carry a timeout of REQUEST_TIMEOUT_MS, and firing it must land as
    // "didn't answer in time".
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);

    const pending = new PlowApi("https://api.plow.co", fetchImpl)
      .createAgent("plow_device", "Claude Code")
      .catch((e) => e);
    controller.abort(new DOMException("The operation was aborted.", "TimeoutError"));
    const error = await pending;

    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    timeout.mockRestore();
    expect(aborted).toBe(true);
    expect(error).toBeInstanceOf(PlowApiError);
    expect((error as PlowApiError).kind).toBe("network");
    // Honest about which failure it was: "didn't answer" sends you somewhere
    // different from "couldn't reach".
    expect((error as PlowApiError).message).toBe("Plow didn't answer in time. Try again.");
  });

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
    const error = await new PlowApi("http://localhost:4242", fetchImpl)
      .requestOtp("+15551110000")
      .catch((e) => e);

    expect((error as PlowApiError).kind).toBe("network");
    expect((error as PlowApiError).message).toBe("Couldn't reach Plow at http://localhost:4242.");
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
      { status: 200, body: { token: "plow_devicetok", key_prefix: "devicet", name: "Plow Latch" } },
    ]);
    await new PlowApi("https://api.plow.co", fetchImpl).mintDeviceCredential("plow_session", "Plow Latch");

    expect(calls[0].url).toBe("https://api.plow.co/v1/relay/devices");
    // The flag is the whole reason there is no client-side cleanup: the session
    // that authorised this call can mint any credential on the account, and it
    // is gone server-side before this returns.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: "Plow Latch",
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
    // `provision_chat` is what makes the account have a chat at all: without it
    // the server hands back the managed phone, which is not a pool line, so the
    // activation text creates no chat and there is no second way to make one.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: "This Mac",
      provision_chat: true,
    });
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
    ).toEqual({ status: "verified", token: "plow_sess", chat: null });
    // A second redeem after hand-off: `token` is absent, not null. Normalised
    // to null here so callers have one shape to check.
    expect(await api([{ status: 200, body: { status: "verified" } }]).redeemActivation("s")).toEqual({
      status: "verified",
      token: null,
      chat: null,
    });
  });

  it("does not blame the SMS provider when activation 503s with no line to assign", async () => {
    // Asking for a chat makes this endpoint assign a pool line, so an exhausted
    // pool 503s here — the same status the OTP calls use for "texts are down".
    // The OTP sentence would send the user to wait on the wrong thing.
    const { fetchImpl } = recordingFetch([{ status: 503, body: {} }]);
    const error = (await new PlowApi("https://api.plow.co", fetchImpl)
      .createActivation("This Mac")
      .catch((e) => e)) as PlowApiError;

    expect(error.kind).toBe("provider_unavailable");
    expect(error.message).toBe("Plow couldn't start setup right now. Try again in a minute.");
    expect(error.message).not.toContain("text messages");
  });

  it("still prefers the server's own reason for that 503", async () => {
    // The server knows which 503 this was; we are guessing.
    const { fetchImpl } = recordingFetch([
      { status: 503, body: { detail: "No phone lines are available." } },
    ]);
    const error = (await new PlowApi("https://api.plow.co", fetchImpl)
      .createActivation("This Mac")
      .catch((e) => e)) as PlowApiError;

    expect(error.message).toBe("No phone lines are available.");
  });

  it("leaves the OTP 503 saying what it has always said", async () => {
    // The override is one call's, not a change to what 503 means everywhere.
    const { fetchImpl } = recordingFetch([{ status: 503, body: {} }]);
    const error = (await new PlowApi("https://api.plow.co", fetchImpl)
      .requestOtp("+15551110000")
      .catch((e) => e)) as PlowApiError;

    expect(error.message).toBe("Plow can't send text messages right now.");
  });

  it("keeps the chat the verified redeem carries — it is answered exactly once", async () => {
    const { fetchImpl } = recordingFetch([
      {
        status: 200,
        body: {
          status: "verified",
          token: "plow_sess",
          // The REAL ChatResource. Two traps in it: the chat's own
          // `provider_key` is the provider's THREAD ID, not a number, and the
          // phone number lives on the agent participant's `line`.
          chat: {
            uid: "cht_D7hfWNK",
            object: "chat",
            status: "active",
            provider_key: "chat_5",
            failure_reason: null,
            created_at: "2026-08-24T18:02:11Z",
            participants: [
              {
                type: "agent",
                uid: "cpt_agent",
                object: "chat_participant",
                line: { uid: "lin_7", provider_type: "linq", provider_key: "+15559876543" },
              },
              {
                type: "member",
                uid: "cpt_ada",
                object: "chat_participant",
                status: "active",
                display_name: "Ada Lovelace",
                provider_type: "linq",
                provider_key: "+15551230000",
                verified_at: "2026-08-24T18:02:11Z",
              },
            ],
          },
        },
      },
    ]);
    const result = await new PlowApi("https://api.plow.co", fetchImpl).redeemActivation("s");

    expect(result).toEqual({
      status: "verified",
      token: "plow_sess",
      chat: {
        uid: "cht_D7hfWNK",
        status: "active",
        // The number, off the agent's line — NOT "chat_5".
        line: "+15559876543",
        createdAt: "2026-08-24T18:02:11Z",
        // Members only: the agent participant is not a human in the chat.
        participants: [{ displayName: "Ada Lovelace", providerKey: "+15551230000" }],
      },
    });
    // The thread id is not carried at all, so no screen can show it as a
    // number by mistake.
    expect(JSON.stringify(result)).not.toContain("chat_5");
  });

  it("reads a chat that arrives with fields missing rather than losing the sign-in", () => {
    // This is display data on the last screen of setup; a shape we did not
    // expect must never throw away a login that has already succeeded.
    expect(parseActivationChat({ uid: "cht_x" })).toEqual({
      uid: "cht_x",
      status: "",
      line: null,
      participants: [],
      createdAt: "",
    });
    // An untyped or unknown participant is neither the agent nor a member: no
    // line comes off it, and it is not shown as a person.
    expect(
      parseActivationChat({ uid: "cht_x", participants: [null, 7, {}, { type: "ghost" }] }),
    ).toEqual({ uid: "cht_x", status: "", line: null, participants: [], createdAt: "" });
    // An agent participant with no line at all is still not the thread id.
    expect(
      parseActivationChat({ uid: "cht_x", provider_key: "chat_5", participants: [{ type: "agent" }] })
        ?.line,
    ).toBeNull();
    expect(
      parseActivationChat({
        uid: "cht_x",
        participants: [{ type: "member", provider_key: "+15551230000" }],
      })?.participants,
    ).toEqual([{ displayName: "", providerKey: "+15551230000" }]);
    // No uid is no chat: there would be nothing to join on later.
    expect(parseActivationChat({ status: "active" })).toBeNull();
    expect(parseActivationChat(undefined)).toBeNull();
    expect(parseActivationChat("cht_x")).toBeNull();
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

  it("lists API keys and revokes one by id with bearer credentials", async () => {
    const credential = "plow_device_do_not_leak";
    const keys = [
      {
        id: 17,
        key_prefix: "agentkey",
        name: "Claude Code",
        scopes: ["relay:call"],
        tokens_used: 12,
        is_active: true,
        last_seen_at: "2026-08-17T12:00:00+00:00",
        created_at: "2026-08-16T12:00:00+00:00",
        agent_id: "agent_123",
        chat_uids: ["cht_123"],
      },
    ];
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: keys },
      { status: 200, body: { status: "revoked", id: 17 } },
    ]);
    const api = new PlowApi("https://api.plow.co", fetchImpl);

    await expect(api.listApiKeys(credential)).resolves.toEqual(keys);
    await expect(api.revokeApiKey(credential, 17)).resolves.toEqual({
      status: "revoked",
      id: 17,
    });

    expect(calls.map(({ url, init }) => [init.method, url])).toEqual([
      ["GET", "https://api.plow.co/v1/api-keys"],
      ["DELETE", "https://api.plow.co/v1/api-keys/17"],
    ]);
    expect(
      calls.every(
        ({ init }) =>
          (init.headers as Record<string, string>).authorization === `Bearer ${credential}`,
      ),
    ).toBe(true);
    expect(calls.every(({ url }) => !url.includes(credential))).toBe(true);
  });

  it("rejects a path-shaped API key id without making a request", async () => {
    const { calls, fetchImpl } = recordingFetch([]);
    const api = new PlowApi("https://api.plow.co", fetchImpl);

    await expect(
      api.revokeApiKey(
        "plow_device_do_not_leak",
        "17/../relay/devices/self/revoke" as unknown as number,
      ),
    ).rejects.toMatchObject({ message: "Invalid API key id." });
    expect(calls).toHaveLength(0);
  });

  /**
   * Every encoding of the credential, and the plain sentence that carries
   * none — all four answer with the status fallback, because an authenticated
   * call drops the detail without reading it.
   *
   * The guard used to match the whole token, so a server echoing the first ten
   * characters went straight to the screen. CLAUDE.md covers a repeat "in any
   * encoding", and a prefix is an encoding: the only way to be right about
   * every one of them is to inspect none of them.
   */
  it.each([
    ["the whole credential", (c: string) => `Not permitted for Bearer ${c}`],
    ["a ten-character prefix", (c: string) => `Key ${c.slice(0, 10)} is not permitted`],
    ["a fragment", (c: string) => `token ...${c.slice(4, 14)}... refused`],
    ["nothing secret at all", () => "Your plan does not include this."],
  ])("drops an authenticated error's detail when it carries %s", async (_shape, body) => {
    const credential = "plow_device_do_not_leak";
    const { fetchImpl } = recordingFetch([
      { status: 403, body: { detail: body(credential) } },
    ]);

    const error = await new PlowApi("https://api.plow.co", fetchImpl)
      .listApiKeys(credential)
      .catch((caught) => caught as Error);

    expect(error).toBeInstanceOf(PlowApiError);
    expect(error.message).toBe("Not permitted.");
    expect(error.message).not.toContain(credential.slice(0, 10));
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
