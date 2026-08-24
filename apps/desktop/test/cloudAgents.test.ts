import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_AGENT_POLL_INTERVAL_MS,
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
    failure_reason: status === "failed" ? "VM did not start" : null,
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
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    expect(REQUEST_TIMEOUT_MS).toBeLessThan(60_000);
    timeout.mockRestore();
  });

  it("GETs one agent and the list, and DELETEs by agent_id with bearer auth", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: resource("active") },
      { status: 200, body: { object: "list", data: [resource("active")], has_more: false } },
      { status: 204 },
    ]);
    const client = new CloudAgentsClient("https://api.plow.co", fetchImpl);

    await client.get(CREDENTIAL, "agent_123");
    await client.list(CREDENTIAL);
    await client.delete(CREDENTIAL, "agent_123");

    expect(calls.map(({ url, init }) => [init.method, url])).toEqual([
      ["GET", "https://api.plow.co/v1/agents/cloud/agent_123"],
      ["GET", "https://api.plow.co/v1/agents/cloud"],
      ["DELETE", "https://api.plow.co/v1/agents/cloud/agent_123"],
    ]);
    expect(calls.every(({ init }) =>
      (init.headers as Record<string, string>).authorization === `Bearer ${CREDENTIAL}`,
    )).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(`/${CREDENTIAL}`);
  });

  it("treats deleting an already-gone agent as success", async () => {
    const { fetchImpl } = recordingFetch([{ status: 404, body: { detail: "Not found" } }]);
    await expect(
      new CloudAgentsClient("https://api.plow.co", fetchImpl).delete(CREDENTIAL, "gone"),
    ).resolves.toBeUndefined();
  });
});

describe("CloudAgentsClient polling", () => {
  it("POSTs, publishes the receipt, then polls and publishes until active", async () => {
    const waits: number[] = [];
    const { fetchImpl } = recordingFetch([
      { status: 202, body: resource("provisioning", { created_at: "initial" }) },
      { status: 200, body: resource("provisioning") },
      { status: 200, body: resource("active") },
    ]);
    const transitions: string[] = [];
    const client = new CloudAgentsClient("https://api.plow.co", fetchImpl, async (ms) => {
      waits.push(ms);
    });

    const final = await client.createAndPoll(
      CREDENTIAL,
      { chatUid: "cht_123", name: "Kitchen agent" },
      (agent) => transitions.push(`${agent.status}:${agent.createdAt}`),
    );

    expect(final.status).toBe("active");
    expect(transitions).toEqual([
      "provisioning:initial",
      "provisioning:2026-08-24T18:02:11Z",
      "active:2026-08-24T18:02:11Z",
    ]);
    expect(waits).toEqual([CLOUD_AGENT_POLL_INTERVAL_MS, CLOUD_AGENT_POLL_INTERVAL_MS]);
  });

  it("stops and preserves the failure reason when a poll reaches failed", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: resource("failed", { failure_reason: "Provider timed out" }) },
    ]);
    const client = new CloudAgentsClient("https://api.plow.co", fetchImpl, async () => undefined);

    const final = await client.poll(CREDENTIAL, fromWire(resource("provisioning")));

    expect(final).toMatchObject({ status: "failed", failureReason: "Provider timed out" });
    expect(calls).toHaveLength(1);
  });

  it("stops after an abort during the wait or GET without publishing another transition", async () => {
    for (const abortAt of ["wait", "get"] as const) {
      const controller = new AbortController();
      const calls: string[] = [];
      const transitions: string[] = [];
      const fetchImpl = async (url: string) => {
        calls.push(url);
        const isCreate = calls.length === 1;
        if (!isCreate && abortAt === "get") controller.abort();
        return new Response(JSON.stringify(resource(isCreate ? "provisioning" : "active")), {
          status: isCreate ? 202 : 200,
        });
      };
      const client = new CloudAgentsClient("https://api.plow.co", fetchImpl, async () => {
        if (abortAt === "wait") controller.abort();
      });

      const stopped = client.createAndPoll(
        CREDENTIAL,
        { chatUid: "cht_123" },
        (agent) => transitions.push(agent.status),
        controller.signal,
      );

      await expect(stopped).rejects.toMatchObject({ name: "AbortError" });
      expect(calls).toHaveLength(abortAt === "get" ? 2 : 1);
      expect(transitions).toEqual(["provisioning"]);
    }
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
      { status: 200, body: resource("failed", { agent_id: staleId }) },
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

  it("never puts a credential echoed by HTTP or fetch into an error string", async () => {
    const echoed = async () =>
      new Response(`{"detail":"rejected Bearer \\u0070low_sk_device_do_not_leak"}`, {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    const transportEcho = async () => {
      throw new Error(`failed request with Authorization: Bearer ${CREDENTIAL}`);
    };

    for (const client of [
      new CloudAgentsClient("https://api.plow.co", echoed),
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
      { status: 200, body: resource("failed", { failure_reason: `provider echoed ${CREDENTIAL}` }) },
    ]);
    const error = await new CloudAgentsClient("https://api.plow.co", fetchImpl)
      .get(CREDENTIAL, "agent_123")
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
    createdAt: String(value.created_at),
    sessionId: typeof value.session_id === "string" ? value.session_id : null,
  };
}
