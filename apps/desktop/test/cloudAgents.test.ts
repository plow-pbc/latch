import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_AGENT_POLL_INTERVAL_MS,
  CREATE_REQUEST_TIMEOUT_MS,
  CloudAgentResource,
  CloudAgentsClient,
} from "../src/cloudAgents.js";
import { PlowApiError, REQUEST_TIMEOUT_MS } from "../src/plowApi.js";

const CREDENTIAL = "plow_sk_device_do_not_leak";

function resource(
  status: CloudAgentResource["status"],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    agent_id: "agent_123",
    chat_uid: "cht_123",
    url: "https://agent.example",
    provider: "exe:hermes",
    name: "Kitchen agent",
    status,
    failure_reason: null,
    created_at: "2026-08-24T18:02:11Z",
    session_id: "session_rotates",
    ...overrides,
  };
}

function recordingFetch(answers: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const answer = answers.shift() ?? { status: 200, body: {} };
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

describe("CloudAgentsClient request contracts", () => {
  it("POSTs the complete create shape with bearer auth and a short request timeout", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 202, body: resource("provisioning") }]);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const client = new CloudAgentsClient("https://api.plow.co/", fetchImpl);

    await client.create(CREDENTIAL, {
      chatUid: "cht_123",
      name: "Kitchen agent",
      provider: "exe:hermes",
      scopes: ["relay:call", "chats:use"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.plow.co/v1/agents/cloud");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({
      authorization: `Bearer ${CREDENTIAL}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      chat_uid: "cht_123",
      name: "Kitchen agent",
      provider: "exe:hermes",
      scopes: ["relay:call", "chats:use"],
    });
    // Create alone gets the longer one: prod boots a VM before it answers.
    expect(timeout).toHaveBeenCalledWith(CREATE_REQUEST_TIMEOUT_MS);
    expect(timeout).not.toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    // Still short of the load balancer's 60s idle cut.
    expect(CREATE_REQUEST_TIMEOUT_MS).toBeLessThan(60_000);
    expect(CREATE_REQUEST_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
    timeout.mockRestore();
  });

  it("accepts the synchronous create shape as running with an unknown creation time", async () => {
    const synchronousBody = {
      agent_id: "c2ea74c38219be7cd617bef46149ab68",
      chat_uid: "cht_EhdlO6AUM_XbR_PzQqdWAw",
      url: "https://plow-agent-c2ea74c38219be7cd617bef46149ab68.exe.xyz",
      provider: "exe:hermes",
    };
    const { fetchImpl } = recordingFetch([{ status: 200, body: synchronousBody }]);

    const created = await new CloudAgentsClient("https://api.plow.co", fetchImpl).create(
      CREDENTIAL,
      { chatUid: "cht_EhdlO6AUM_XbR_PzQqdWAw", provider: "exe:hermes" },
    );

    expect(created).toMatchObject({
      agentId: "c2ea74c38219be7cd617bef46149ab68",
      chatUid: "cht_EhdlO6AUM_XbR_PzQqdWAw",
      status: "running",
      createdAt: null,
    });

    const missingId = { ...synchronousBody, agent_id: undefined };
    const invalid = recordingFetch([{ status: 200, body: missingId }]);
    await expect(
      new CloudAgentsClient("https://api.plow.co", invalid.fetchImpl).create(CREDENTIAL, {
        chatUid: "cht_123",
      }),
    ).rejects.toMatchObject({ message: "Plow returned an invalid cloud-agent response." });

    const missingChatUid = { ...synchronousBody, chat_uid: undefined };
    const invalidChat = recordingFetch([{ status: 200, body: missingChatUid }]);
    await expect(
      new CloudAgentsClient("https://api.plow.co", invalidChat.fetchImpl).create(CREDENTIAL, {
        chatUid: "cht_123",
      }),
    ).rejects.toMatchObject({ message: "Plow returned an invalid cloud-agent response." });
  });

  it("leaves every call but create on the short timeout", async () => {
    const { fetchImpl } = recordingFetch([
      { status: 200, body: { object: "list", data: [], has_more: false } },
      { status: 204 },
    ]);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const client = new CloudAgentsClient("https://api.plow.co", fetchImpl);

    await client.list(CREDENTIAL);
    await client.delete(CREDENTIAL, "agent_123");

    // Only the synchronous create waits on a VM. Nothing else may hold the
    // longer window open.
    expect(timeout).toHaveBeenCalledTimes(2);
    for (const call of timeout.mock.calls) expect(call[0]).toBe(REQUEST_TIMEOUT_MS);
    timeout.mockRestore();
  });

  it("GETs the list and DELETEs by agent_id with bearer auth", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: { object: "list", data: [resource("running")], has_more: false } },
      { status: 204 },
    ]);
    const client = new CloudAgentsClient("https://api.plow.co", fetchImpl);

    await client.list(CREDENTIAL);
    await client.delete(CREDENTIAL, "agent_123");

    expect(calls.map(({ url, init }) => [init.method, url])).toEqual([
      ["GET", "https://api.plow.co/v1/agents/cloud"],
      ["DELETE", "https://api.plow.co/v1/agents/cloud/agent_123"],
    ]);
    expect(calls.every(({ init }) =>
      (init.headers as Record<string, string>).authorization === `Bearer ${CREDENTIAL}`,
    )).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(`/${CREDENTIAL}`);
  });

  it("accepts both bare and enveloped list responses", async () => {
    const { fetchImpl } = recordingFetch([
      { status: 200, body: [] },
      { status: 200, body: { object: "list", data: [resource("running")], has_more: false } },
    ]);
    const client = new CloudAgentsClient("https://api.plow.co", fetchImpl);

    await expect(client.list(CREDENTIAL)).resolves.toEqual([]);
    await expect(client.list(CREDENTIAL)).resolves.toEqual([fromWire(resource("running"))]);
  });

  it("treats deleting an already-gone agent as success", async () => {
    const { fetchImpl } = recordingFetch([{ status: 404, body: { detail: "Not found" } }]);
    await expect(
      new CloudAgentsClient("https://api.plow.co", fetchImpl).delete(CREDENTIAL, "gone"),
    ).resolves.toBeUndefined();
  });
});

describe("CloudAgentsClient polling", () => {
  it("POSTs, publishes the receipt, then polls and publishes until running", async () => {
    const waits: number[] = [];
    const { calls, fetchImpl } = recordingFetch([
      { status: 202, body: resource("provisioning", { created_at: "initial" }) },
      { status: 200, body: resource("provisioning") },
      { status: 200, body: resource("running") },
    ]);
    const transitions: string[] = [];
    const client = new CloudAgentsClient("https://api.plow.co", fetchImpl, async (ms) => {
      waits.push(ms);
    });

    const receipt = await client.create(CREDENTIAL, {
      chatUid: "cht_123",
      name: "Kitchen agent",
    });
    const final = await client.poll(
      CREDENTIAL,
      receipt,
      (agent) => transitions.push(`${agent.status}:${agent.createdAt}`),
    );

    expect(final.status).toBe("running");
    expect(transitions).toEqual([
      "provisioning:initial",
      "provisioning:2026-08-24T18:02:11Z",
      "running:2026-08-24T18:02:11Z",
    ]);
    expect(waits).toEqual([CLOUD_AGENT_POLL_INTERVAL_MS, CLOUD_AGENT_POLL_INTERVAL_MS]);
    expect(calls.map(({ url, init }) => [init.method, url])).toEqual([
      ["POST", "https://api.plow.co/v1/agents/cloud"],
      ["GET", "https://api.plow.co/v1/agents/cloud/agent_123"],
      ["GET", "https://api.plow.co/v1/agents/cloud/agent_123"],
    ]);
  });

  it("stops when a poll reaches teardown", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: resource("teardown") },
    ]);
    const client = new CloudAgentsClient("https://api.plow.co", fetchImpl, async () => undefined);

    const final = await client.poll(CREDENTIAL, fromWire(resource("provisioning")));

    expect(final).toMatchObject({ status: "teardown" });
    expect(calls).toHaveLength(1);
  });

  it("preserves an unknown status from a valid 200 and treats it as terminal", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: resource("provider_verifying") },
    ]);
    const client = new CloudAgentsClient("https://api.plow.co", fetchImpl, async () => undefined);

    const final = await client.poll(CREDENTIAL, fromWire(resource("provisioning")));

    expect(final.status).toBe("provider_verifying");
    expect(calls).toHaveLength(1);
  });

  it("stops after an abort during the wait or GET without publishing another transition", async () => {
    for (const abortAt of ["wait", "get"] as const) {
      const controller = new AbortController();
      const calls: string[] = [];
      const transitions: string[] = [];
      const fetchImpl = async (url: string) => {
        calls.push(url);
        if (abortAt === "get") controller.abort();
        return new Response(JSON.stringify(resource("running")), { status: 200 });
      };
      const client = new CloudAgentsClient("https://api.plow.co", fetchImpl, async () => {
        if (abortAt === "wait") controller.abort();
      });

      const stopped = client.poll(
        CREDENTIAL,
        fromWire(resource("provisioning")),
        (agent) => transitions.push(agent.status),
        controller.signal,
      );

      await expect(stopped).rejects.toMatchObject({ name: "AbortError" });
      expect(calls).toHaveLength(abortAt === "get" ? 1 : 0);
      expect(transitions).toEqual(["provisioning"]);
    }
  });

  it("aborts the fetch signal of an in-flight poll GET", async () => {
    const controller = new AbortController();
    let fetched: AbortSignal | null = null;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      fetched = init?.signal as AbortSignal;
      markStarted?.();
      return new Promise<Response>((resolve, reject) => {
        fetched?.addEventListener("abort", () => reject(fetched?.reason), { once: true });
        // On the unfixed client the fetch signal is timeout-only. Let its GET
        // answer after the caller aborts so the regression fails promptly.
        controller.signal.addEventListener(
          "abort",
          () =>
            queueMicrotask(() =>
              resolve(new Response(JSON.stringify(resource("running")), { status: 200 })),
            ),
          { once: true },
        );
      });
    };
    const client = new CloudAgentsClient("https://api.plow.co", fetchImpl, async () => undefined);

    const polling = client.poll(
      CREDENTIAL,
      fromWire(resource("provisioning")),
      undefined,
      controller.signal,
    );
    await started;
    controller.abort();

    await expect(polling).rejects.toMatchObject({ name: "AbortError" });
    expect(fetched).not.toBeNull();
    expect(fetched!.aborted).toBe(true);
  });
});

describe("CloudAgentsClient recovery and credential boundary", () => {
  it("silently deletes the id named by a recoverable 409 and re-POSTs once", async () => {
    const staleId = "dead_agent_456";
    const { calls, fetchImpl } = recordingFetch([
      {
        status: 409,
        body: {
          detail: `This chat has an unfinished cloud agent (${staleId}). Delete it with DELETE /v1/agents/cloud/${staleId} and provision again.`,
        },
      },
      { status: 200, body: resource("running", { agent_id: staleId }) },
      { status: 202, body: resource("provisioning", { agent_id: "replacement" }) },
    ]);
    const created = await new CloudAgentsClient("https://api.plow.co", fetchImpl).create(
      CREDENTIAL,
      { chatUid: "cht_123" },
    );

    expect(created.agentId).toBe("replacement");
    expect(calls.map(({ url, init }) => [init.method, url])).toEqual([
      ["POST", "https://api.plow.co/v1/agents/cloud"],
      ["DELETE", `https://api.plow.co/v1/agents/cloud/${staleId}`],
      ["POST", "https://api.plow.co/v1/agents/cloud"],
    ]);
    expect(calls[0].init.body).toBe(calls[2].init.body);
  });

  it("stops with the stuck agent id when prescribed recovery cannot delete it", async () => {
    const staleId = "dead_agent_456";
    const { calls, fetchImpl } = recordingFetch([
      {
        status: 409,
        body: {
          detail: `This chat has an unfinished cloud agent (${staleId}). Delete it with DELETE /v1/agents/cloud/${staleId} and provision again.`,
        },
      },
      { status: 500, body: { detail: "Database unavailable." } },
    ]);

    const error = await new CloudAgentsClient("https://api.plow.co", fetchImpl)
      .create(CREDENTIAL, { chatUid: "cht_123" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlowApiError);
    expect(error).toMatchObject({ kind: "http", status: 500 });
    expect(String(error)).toBe(
      `PlowApiError: Cloud agent ${staleId} could not be removed. This chat cannot be provisioned until that agent is removed.`,
    );
    expect(calls.map(({ init }) => init.method)).toEqual(["POST", "DELETE"]);
  });

  it("does not delete a live agent named by a provider-switch 409", async () => {
    const liveId = "live_agent_789";
    const detail = `This chat already has a hermes agent (${liveId}). Delete it with DELETE /v1/agents/cloud/${liveId} before provisioning a codex one.`;
    const { calls, fetchImpl } = recordingFetch([{ status: 409, body: { detail } }]);

    const error = await new CloudAgentsClient("https://api.plow.co", fetchImpl)
      .create(CREDENTIAL, { chatUid: "cht_123", provider: "exe:codex" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlowApiError);
    expect(String(error)).toBe(`PlowApiError: ${detail}`);
    expect(calls.map(({ init }) => init.method)).toEqual(["POST"]);
  });

  it.each([
    "Another create is already in flight.",
    "This account has no messaging address.",
    "The user is not a participant in this chat.",
  ])("does not recover an unrelated 409: %s", async (detail) => {
    const { calls, fetchImpl } = recordingFetch([{ status: 409, body: { detail } }]);
    const error = await new CloudAgentsClient("https://api.plow.co", fetchImpl)
      .create(CREDENTIAL, { chatUid: "cht_123" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlowApiError);
    expect(String(error)).toBe(`PlowApiError: ${detail}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("POST");
  });

  it("surfaces the message from a create 404 error envelope", async () => {
    const detail = "chat 'x' not found.";
    const { calls, fetchImpl } = recordingFetch([
      {
        status: 404,
        body: {
          error: {
            type: "not_found_error",
            code: "chat_not_found",
            message: detail,
          },
        },
      },
    ]);

    const error = await new CloudAgentsClient("https://api.plow.co", fetchImpl)
      .create(CREDENTIAL, { chatUid: "x" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlowApiError);
    expect(String(error)).toBe(`PlowApiError: ${detail}`);
    expect(calls.map(({ init }) => init.method)).toEqual(["POST"]);
  });

  it("never puts a credential echoed by HTTP or fetch into an error string", async () => {
    const echoed = async () =>
      new Response(`{"detail":"rejected Bearer \\u0070low_sk_device_do_not_leak"}`, {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    const transportEcho = async () => {
      throw new Error(`failed request with Authorization: Bearer ${CREDENTIAL}`);
    };
    const nestedEcho = async () =>
      new Response(JSON.stringify({ error: { message: `rejected Bearer ${CREDENTIAL}` } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });

    for (const client of [
      new CloudAgentsClient("https://api.plow.co", echoed),
      new CloudAgentsClient("https://api.plow.co", nestedEcho),
      new CloudAgentsClient("https://api.plow.co", transportEcho),
    ]) {
      const error = await client.list(CREDENTIAL).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PlowApiError);
      expect(String(error)).not.toContain(CREDENTIAL);
      expect(String(error)).not.toContain(CREDENTIAL.slice(0, 10));
    }
  });

  it("rejects a successful resource that repeats the credential in a display field", async () => {
    const { fetchImpl } = recordingFetch([
      { status: 200, body: resource("running", { failure_reason: `provider echoed ${CREDENTIAL}` }) },
    ]);
    const error = await new CloudAgentsClient(
      "https://api.plow.co",
      fetchImpl,
      async () => undefined,
    )
      .poll(CREDENTIAL, fromWire(resource("provisioning")))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlowApiError);
    expect(String(error)).toBe("PlowApiError: Plow returned an unsafe cloud-agent response.");
    expect(String(error)).not.toContain(CREDENTIAL);
  });
});

function fromWire(value: Record<string, unknown>): CloudAgentResource {
  return {
    agentId: String(value.agent_id),
    chatUid: String(value.chat_uid),
    url: typeof value.url === "string" ? value.url : null,
    provider: typeof value.provider === "string" ? value.provider : null,
    name: typeof value.name === "string" ? value.name : null,
    status: value.status as CloudAgentResource["status"],
    failureReason: typeof value.failure_reason === "string" ? value.failure_reason : null,
    createdAt: typeof value.created_at === "string" ? value.created_at : null,
    sessionId: typeof value.session_id === "string" ? value.session_id : null,
  };
}
