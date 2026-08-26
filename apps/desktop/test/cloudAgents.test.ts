import { describe, expect, it } from "vitest";
import { CloudAgentResource, CloudAgentsClient } from "../src/cloudAgents.js";
import { PlowApi, PlowApiError } from "../src/plowApi.js";

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

describe("CloudAgentsClient destructive actions", () => {
  it("routes DELETE by encoded agent id and treats an already-gone agent as success", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 204 },
      { status: 404, body: { detail: "Not found" } },
    ]);
    const client = new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl));

    await expect(client.delete(CREDENTIAL, "agent/with space")).resolves.toBeUndefined();
    await expect(client.delete(CREDENTIAL, "gone")).resolves.toBeUndefined();

    expect(calls.map(({ url, init }) => [init.method, url])).toEqual([
      ["DELETE", "https://api.plow.co/v1/agents/cloud/agent%2Fwith%20space"],
      ["DELETE", "https://api.plow.co/v1/agents/cloud/gone"],
    ]);
  });

  it("deletes only the unfinished id prescribed by a recoverable 409 and re-POSTs once", async () => {
    const staleId = "dead_agent_456";
    const { calls, fetchImpl } = recordingFetch([
      {
        status: 409,
        body: {
          detail: `This chat has an unfinished cloud agent (${staleId}). Delete it with DELETE /v1/agents/cloud/${staleId} and provision again.`,
        },
      },
      { status: 204 },
      { status: 202, body: resource("provisioning", { agent_id: "replacement" }) },
    ]);

    const created = await new CloudAgentsClient(
      new PlowApi("https://api.plow.co", fetchImpl),
    ).create(CREDENTIAL, { chatUid: "cht_123" });

    expect(created.agentId).toBe("replacement");
    expect(calls.map(({ url, init }) => [init.method, url])).toEqual([
      ["POST", "https://api.plow.co/v1/agents/cloud"],
      ["DELETE", `https://api.plow.co/v1/agents/cloud/${staleId}`],
      ["POST", "https://api.plow.co/v1/agents/cloud"],
    ]);
    expect(calls[0].init.body).toBe(calls[2].init.body);
  });

  it("names the stuck agent when prescribed recovery cannot delete it", async () => {
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

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .create(CREDENTIAL, { chatUid: "cht_123" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlowApiError);
    expect(String(error)).toBe(
      `PlowApiError: Cloud agent ${staleId} could not be removed. This chat cannot be provisioned until that agent is removed.`,
    );
    expect(calls.map(({ init }) => init.method)).toEqual(["POST", "DELETE"]);
  });

  it("does not delete a live agent named by a provider-switch 409", async () => {
    const liveId = "live_agent_789";
    const detail = `This chat already has a hermes agent (${liveId}). Delete it with DELETE /v1/agents/cloud/${liveId} before provisioning a codex one.`;
    const { calls, fetchImpl } = recordingFetch([{ status: 409, body: { detail } }]);

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .create(CREDENTIAL, { chatUid: "cht_123", provider: "exe:codex" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlowApiError);
    expect(String(error)).toBe("PlowApiError: Plow returned 409.");
    expect(calls.map(({ init }) => init.method)).toEqual(["POST"]);
  });
});

describe("CloudAgentsClient cancellation", () => {
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
      return new Promise<Response>((_resolve, reject) => {
        fetched?.addEventListener("abort", () => reject(fetched?.reason), { once: true });
      });
    };
    const client = new CloudAgentsClient(
      new PlowApi("https://api.plow.co", fetchImpl),
      async () => undefined,
    );

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

describe("CloudAgentsClient credential boundary", () => {
  it("drops every server-authored error from authenticated calls", async () => {
    const fragment = CREDENTIAL.slice(3, 18);
    const echoed = async () =>
      new Response(JSON.stringify({ detail: `rejected fragment ${fragment}` }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    const nestedEcho = async () =>
      new Response(JSON.stringify({ error: { message: `rejected fragment ${fragment}` } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });

    for (const [client, message] of [
      [new CloudAgentsClient(new PlowApi("https://api.plow.co", echoed)), "Not permitted."],
      [new CloudAgentsClient(new PlowApi("https://api.plow.co", nestedEcho)), "Plow returned 404."],
    ] as const) {
      const error = await client.list(CREDENTIAL).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PlowApiError);
      expect(String(error)).toBe(`PlowApiError: ${message}`);
      expect(String(error)).not.toContain(fragment);
    }
  });

  it("rejects a successful resource that repeats the credential in a display field", async () => {
    const { fetchImpl } = recordingFetch([
      { status: 200, body: resource("running", { failure_reason: `provider echoed ${CREDENTIAL}` }) },
    ]);
    const error = await new CloudAgentsClient(
      new PlowApi("https://api.plow.co", fetchImpl),
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
