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
    expect((error as PlowApiError).message).toBe("https://api.plow.co didn't answer in time. Try again.");
  });


  it("turns an unreachable API into a readable message, not a stack", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await new PlowApi("http://localhost:4242", fetchImpl)
      .requestOtp("+15551110000")
      .catch((e) => e);

    expect((error as PlowApiError).kind).toBe("network");
    expect((error as PlowApiError).message).toBe("Couldn't reach http://localhost:4242.");
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

  it("reads the account from /v1/relay/info", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: { uid: "u_123", mcp_url: "https://api.plow.co/v1/relay/devices/u_123/mcp", device_connected: true } },
    ]);
    const info = await new PlowApi("https://api.plow.co", fetchImpl).relayInfo("plow_secret");

    expect(info).toEqual({ uid: "u_123" });
    // The credential travels in a header — never in the URL.
    expect(calls[0].url).not.toContain("plow_secret");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer plow_secret");
  });

  it("registers this stable device identity with its DNS hostname", async () => {
    const { calls, fetchImpl } = recordingFetch([
      {
        status: 200,
        body: {
          device_id: "device/one",
          hostname: "mbp",
          display_name: "mbp (2)",
          is_primary: false,
          connected: false,
          mcp_url: "https://api.plow.co/v1/relay/devices/device%2Fone/mcp",
        },
      },
    ]);

    const device = await new PlowApi("https://api.plow.co", fetchImpl).registerRelayDevice(
      "plow_secret",
      "device/one",
      "mbp",
    );

    expect(calls[0].url).toBe("https://api.plow.co/v1/relay/devices/device%2Fone");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ hostname: "mbp" });
    expect(device).toEqual({ mcpUrl: "https://api.plow.co/v1/relay/devices/device%2Fone/mcp" });
  });


  it("consumes a payment approval by posting the session id and domain, credential in the header", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 200, body: { approved: true } }]);
    const result = await new PlowApi("https://api.plow.co", fetchImpl).consumePaymentApproval(
      "plow_devicetok",
      { sessionId: "42", domain: "chase.com" },
    );

    expect(result).toEqual({ approved: true });
    expect(calls[0].url).toBe("https://api.plow.co/v1/payment-approvals/consume");
    // The endpoint's snake-case contract: session_id + domain, nothing else.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      session_id: "42",
      domain: "chase.com",
    });
    // The device credential travels in the header, never in the URL or the body.
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      "Bearer plow_devicetok",
    );
    expect(calls[0].url).not.toContain("plow_devicetok");
    expect(String(calls[0].init.body)).not.toContain("plow_devicetok");
  });

  it.each([
    { what: "no approval on file (404)", answer: { status: 404, body: { detail: "no approval" } } },
    { what: "a server error (500)", answer: { status: 500, body: {} } },
  ])("throws rather than approving when the consume fails: $what", async ({ answer }) => {
    // Fail-closed: any non-2xx throws through call(), and the fill gate treats a
    // throw exactly like approved:false — nothing is released.
    const { fetchImpl } = recordingFetch([answer]);
    await expect(
      new PlowApi("https://api.plow.co", fetchImpl).consumePaymentApproval("t", {
        sessionId: "s",
        domain: "chase.com",
      }),
    ).rejects.toBeInstanceOf(PlowApiError);
  });

  it("reads a body that omits or malforms 'approved' as NOT approved", async () => {
    const { fetchImpl } = recordingFetch([{ status: 200, body: { note: "hmm" } }]);
    const result = await new PlowApi("https://api.plow.co", fetchImpl).consumePaymentApproval("t", {
      sessionId: "s",
      domain: "chase.com",
    });
    expect(result).toEqual({ approved: false });
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
    // `{ name }` EXACTLY — byte-identical to the request Plow's own app makes.
    // No `provision_chat` in any form: it assigns one of the account's few
    // pool lines, and an owner holding a chat on every line could not pair
    // another Mac at all while signing in spent one.
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

  it("starts a provisioned activation with no sign-in name", async () => {
    const { calls, fetchImpl } = recordingFetch([{
      status: 200,
      body: {
        display_code: "Z1SWY",
        activation_secret: "act_secret_xyz",
        send_to: "+15551230000",
      },
    }]);

    await new PlowApi("https://api.plow.co", fetchImpl).createProvisionedActivation();

    expect(JSON.parse(String(calls[0].init.body))).toEqual({ provision_chat: true });
  });

  it.each([
    {
      caseName: "uncoded 503",
      status: 503,
      body: { detail: "no chat line available" },
      expected: { status: 503, code: undefined },
    },
    {
      caseName: "structured no-line code",
      status: 409,
      body: {
        detail: {
          code: "NO_CHAT_LINE_AVAILABLE",
          message: "server-authored wording is not display copy",
        },
      },
      expected: {
        status: 409,
        code: "NO_CHAT_LINE_AVAILABLE",
        message: "Plow returned 409.",
      },
    },
  ])("parses provisioned-activation errors: $caseName", async ({ status, body, expected }) => {
    const { fetchImpl } = recordingFetch([{ status, body }]);

    const error = await new PlowApi("https://api.plow.co", fetchImpl)
      .createProvisionedActivation()
      .catch((caught: unknown) => caught as PlowApiError);

    expect(error).toMatchObject(expected);
  });

  it("drops the provisioned redeem token and finds an agent participant out of position", async () => {
    const token = "plow_session_that_must_be_dropped";
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: {
        status: "verified",
        token,
        chat: {
          uid: "cht_new",
          participants: [
            { type: "member", role: "owner", provider_key: "+15550111" },
            { type: "agent", line: { uid: "lin_new", provider_key: "+15550100" } },
          ],
        },
      },
    }]);

    const result = await new PlowApi("https://api.plow.co", fetchImpl)
      .redeemProvisionedActivation("act_secret_xyz");

    expect(result).toMatchObject({
      status: "verified",
      chat: { lineUid: "lin_new" },
      shape: {
        chat: "object",
        participantTypes: ["member", "agent"],
        agentLine: "uid_string",
      },
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("does not carry a redeem token echoed by provisioned chat fields", async () => {
    const token = "plow_session_that_must_be_dropped";
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: {
        status: "verified",
        token,
        chat: {
          uid: "cht_new",
          participants: [
            { type: token },
            { type: "agent", line: { uid: `lin_${token}`, provider_key: "+15550100" } },
          ],
        },
      },
    }]);

    const result = await new PlowApi("https://api.plow.co", fetchImpl)
      .redeemProvisionedActivation("act_secret_xyz");

    expect(result).toMatchObject({
      status: "verified",
      chat: null,
      shape: { participantTypes: ["other", "agent"] },
    });
    expect(JSON.stringify(result)).not.toContain(token);
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

  it("says what a 503 has always said — one sentence, no per-call override", async () => {
    // Activation used to carry its own 503 sentence, because asking for a chat
    // made that endpoint assign a pool line and an exhausted pool 503'd there.
    // It asks for no chat now, so that branch cannot run
    // (`api/plow/auth_routes/router.py` raises it only under `provision_chat`)
    // and the override went with it. A server that writes its own `detail`
    // still wins on every call.
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
                uid: "cpt_other",
                object: "chat_participant",
                status: "active",
                display_name: "Ada Lovelace",
                role: "member",
                provider_type: "linq",
                provider_key: "+15557654321",
                verified_at: "2026-08-24T18:02:11Z",
              },
              {
                type: "member",
                uid: "cpt_owner",
                object: "chat_participant",
                status: "active",
                display_name: "You",
                role: "owner",
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
        displayName: null,
        // The number, off the agent's line — NOT "chat_5".
        line: "+15559876543",
        lineUid: "lin_7",
        createdAt: "2026-08-24T18:02:11Z",
        // Members only: the agent participant is not a human in the chat.
        // The owner is first even though the wire put another member first.
        // Names and ownership cross for labelling; phone handles stay
        // alongside them for addressing.
        participants: [
          { providerKey: "+15551230000", displayName: "You", isOwner: true },
          { providerKey: "+15557654321", displayName: "Ada Lovelace", isOwner: false },
        ],
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
      displayName: null,
      line: null,
      lineUid: null,
      participants: [],
      createdAt: "",
    });
    // An untyped or unknown participant is neither the agent nor a member: no
    // line comes off it, and it is not shown as a person.
    expect(
      parseActivationChat({ uid: "cht_x", participants: [null, 7, {}, { type: "ghost" }] }),
    ).toEqual({
      uid: "cht_x",
      status: "",
      displayName: null,
      line: null,
      lineUid: null,
      participants: [],
      createdAt: "",
    });
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
    ).toEqual([{ providerKey: "+15551230000", displayName: null, isOwner: false }]);
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
      {
        status: 200,
        body: {
          id: 41,
          token: "plow_agenttok",
          key_prefix: "agenttk",
          name: "Claude Code",
          mcp_config: '{"mcpServers":{"plow-mbp":{"headers":{"Authorization":"Bearer plow_agenttok"}}}}',
        },
      },
    ]);
    const minted = await new PlowApi("https://api.plow.co", fetchImpl).createAgent(
      "plow_device",
      "Claude Code",
    );

    expect(calls[0].url).toBe("https://api.plow.co/v1/relay/agents");
    expect(minted.id).toBe(41);
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
 * The provider mint. Its response side used to be covered by a device-core
 * suite over a transport of its own; that transport is gone, so the coverage
 * belongs here — on the seam that actually makes the call. (The envelope's
 * per-row parse is `providerWiring.test.ts`'s, one layer up.)
 */
describe("mintAccountTokens", () => {
  const TOKEN = "ya29.a0AfB_byExampleTokenValue0000000000";
  const CRED = "plow-credential-value";
  const mint = (responses: { status: number; body: unknown }[]) => {
    const { calls, fetchImpl } = recordingFetch(responses);
    return {
      calls,
      run: () =>
        new PlowApi("https://api.plow.co", fetchImpl).mintAccountTokens(
          CRED,
          "/v1/connectors/gmail/",
          "access-token",
        ),
    };
  };

  it("posts to the provider's own route with the device credential, asking for every account", async () => {
    const { calls, run } = mint([
      {
        status: 200,
        body: { data: { accounts: [{ account: "a@example.com", access_token: TOKEN, is_default: true }] } },
      },
    ]);
    expect(await run()).toEqual({
      accounts: [{ account: "a@example.com", token: TOKEN, isDefault: true }],
      degraded: [],
    });
    expect(calls[0].url).toBe("https://api.plow.co/v1/connectors/gmail/access-token");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${CRED}`);
    // Which accounts is Plow's answer: this Mac names none, so it holds no
    // second copy of a fact the server owns.
    expect(calls[0].init.body).toBe('{"all":true}');
  });

  it.each([
    ["no accounts in the body", { status: 200, body: { data: {} } }],
    ["an empty envelope", { status: 200, body: { data: { accounts: [], degraded: [] } } }],
    ["no data at all", { status: 200, body: {} }],
    // Unvalidated JSON: a non-array here must map to PlowApiError, not throw
    // a raw TypeError past every caller that maps it.
    ["a non-array accounts field", { status: 200, body: { data: { accounts: 7 } } }],
  ])("refuses %s rather than returning it", async (_why, response) => {
    await expect(mint([response]).run()).rejects.toBeInstanceOf(PlowApiError);
  });

  it("refuses a non-2xx", async () => {
    await expect(mint([{ status: 503, body: { detail: "nope" } }]).run()).rejects.toBeInstanceOf(
      PlowApiError,
    );
  });

  it("never quotes the response or the credential into the message it raises", async () => {
    // This response carries a live credential by construction. `errorFor`
    // drops a server `detail` outright on an AUTHENTICATED call, which is the
    // rule this relies on rather than restates.
    const error = await mint([
      { status: 500, body: { detail: `echo ${CRED} and ${TOKEN}` } },
    ])
      .run()
      .catch((e) => e as Error);
    expect(error.message).not.toContain(CRED.slice(0, 12));
    expect(error.message).not.toContain(TOKEN.slice(0, 12));
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
