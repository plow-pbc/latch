import { describe, expect, it } from "vitest";
import {
  CloudAgentResource,
  CloudAgentsClient,
  isTerminalCloudAgent,
} from "../src/cloudAgents.js";
import { FetchLike, PlowApi, PlowApiError, REQUEST_TIMEOUT_MS } from "../src/plowApi.js";

const CREDENTIAL = "plow_dev_credential_123456789";

const wireAgent = (overrides: Record<string, unknown> = {}) => ({
  agent_id: "agent_123",
  line_uid: "lin_willow",
  chat_uids: ["line:lin_willow"],
  url: "https://provider.example/agent_123",
  provider: "exe:hermes",
  name: "Kitchen",
  status: "running",
  failure_code: null,
  failure_reason: null,
  created_at: "2026-08-20T12:00:00Z",
  session_id: "session_123",
  ...overrides,
});

function recordingFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: next.body === undefined ? undefined : { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

describe("CloudAgentsClient resources", () => {
  it("parses a line-scoped agent and keeps the informational grant", async () => {
    const { fetchImpl } = recordingFetch([{ status: 200, body: { data: [wireAgent()] } }]);

    const [agent] = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .list(CREDENTIAL);

    expect(agent).toMatchObject({
      agentId: "agent_123",
      lineUid: "lin_willow",
      chatUids: ["line:lin_willow"],
      name: "Kitchen",
      status: "running",
    });
  });

  it("parses a legacy agent with a null line and fixed chats", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: { data: [wireAgent({ line_uid: null, chat_uids: ["cht_one", "cht_two"] })] },
    }]);

    const [agent] = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .list(CREDENTIAL);

    expect(agent.lineUid).toBeNull();
    expect(agent.chatUids).toEqual(["cht_one", "cht_two"]);
  });

  it("falls back to a lone line grant when line_uid is absent", async () => {
    const oldShape = wireAgent({ chat_uids: ["line:lin_fallback"] });
    delete oldShape.line_uid;
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: { data: [oldShape] },
    }]);

    const [agent] = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .list(CREDENTIAL);

    expect(agent.lineUid).toBe("lin_fallback");
  });

  it("defaults an omitted status to provisioning", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: { data: [wireAgent({ status: undefined })] },
    }]);

    const [agent] = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .list(CREDENTIAL);

    expect(agent.status).toBe("provisioning");
  });

  it("preserves failure codes and legacy failure prose", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: {
        data: [wireAgent({
          status: "failed",
          failure_code: "capacity_exhausted",
          failure_reason: "Provider capacity is exhausted.",
        })],
      },
    }]);

    const [agent] = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .list(CREDENTIAL);

    expect(agent.failureCode).toBe("capacity_exhausted");
    expect(agent.failureReason).toBe("Provider capacity is exhausted.");
  });

  it("accepts the older single-chat grant and rejects malformed grants", async () => {
    const oldShape = wireAgent();
    delete oldShape.chat_uids;
    Object.assign(oldShape, { chat_uid: "cht_legacy" });
    const { fetchImpl } = recordingFetch([
      { status: 200, body: { data: [oldShape] } },
      { status: 200, body: { data: [wireAgent({ chat_uids: [] })] } },
    ]);
    const client = new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl));

    await expect(client.list(CREDENTIAL)).resolves.toMatchObject([
      { chatUids: ["cht_legacy"] },
    ]);
    await expect(client.list(CREDENTIAL)).rejects.toThrow(
      "Plow returned an invalid cloud-agent response.",
    );
  });

  it("rejects a non-string line uid instead of treating a current agent as legacy", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: { data: [wireAgent({ line_uid: 7 })] },
    }]);

    await expect(new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .list(CREDENTIAL))
      .rejects.toThrow("Plow returned an invalid cloud-agent response.");
  });

  it("rejects a renderer-bound line uid that repeats the credential", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: { data: [wireAgent({ line_uid: `line-${CREDENTIAL}` })] },
    }]);

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .list(CREDENTIAL)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlowApiError);
    expect((error as Error).message).toBe("Plow returned an unsafe cloud-agent response.");
    expect((error as Error).message).not.toContain(CREDENTIAL);
  });
});

describe("CloudAgentsClient deletion", () => {
  it("routes by encoded agent id and treats an already-gone agent as success", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 404 }]);

    await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .delete(CREDENTIAL, "agent/with space");

    expect(calls[0].url).toBe("https://api.plow.co/v1/agents/cloud/agent%2Fwith%20space");
    expect(calls[0].init.method).toBe("DELETE");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
  });

  it("uses fixed error copy instead of server-authored detail", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 503,
      body: { detail: `provider echoed ${CREDENTIAL}` },
    }]);

    await expect(new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .delete(CREDENTIAL, "agent_123"))
      .rejects.toThrow("Cloud-agent provisioning is unavailable right now.");
  });
});

describe("CloudAgentsClient polling", () => {
  const receipt = (): CloudAgentResource => ({
    agentId: "agent_123",
    lineUid: "lin_willow",
    chatUids: ["line:lin_willow"],
    url: null,
    provider: null,
    name: "Kitchen",
    status: "provisioning",
    failureCode: null,
    failureReason: null,
    createdAt: null,
    sessionId: null,
  });

  it("ignores a mismatched id and stops on the requested agent's terminal state", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: wireAgent({ agent_id: "someone_else", status: "running" }) },
      { status: 200, body: wireAgent({ status: "running" }) },
    ]);
    const transitions: string[] = [];
    const client = new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl), async () => {});

    const final = await client.poll(CREDENTIAL, receipt(), (agent) => {
      transitions.push(`${agent.agentId}:${agent.status}`);
    });

    expect(final.agentId).toBe("agent_123");
    expect(transitions).toEqual(["agent_123:provisioning", "agent_123:running"]);
    expect(calls).toHaveLength(2);
  });

  it("passes the caller's abort signal to poll reads", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl: FetchLike = async (_url, init = {}) => {
      seen.push(init);
      return new Response(JSON.stringify(wireAgent({ status: "running" })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const controller = new AbortController();

    await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl), async () => {})
      .poll(CREDENTIAL, receipt(), undefined, controller.signal);

    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(seen[0].signal?.aborted).toBe(false);
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts an in-flight poll read", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
    const fetchImpl: FetchLike = async (_url, init = {}) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    };
    const polling = new CloudAgentsClient(
      new PlowApi("https://api.plow.co", fetchImpl),
      async () => {},
    ).poll(CREDENTIAL, receipt(), undefined, controller.signal);

    await fetchStarted;
    controller.abort();

    await expect(polling).rejects.toMatchObject({ name: "AbortError" });
  });

  it("classifies only provisioning as non-terminal", () => {
    expect(isTerminalCloudAgent({ status: "provisioning" })).toBe(false);
    expect(isTerminalCloudAgent({ status: "running" })).toBe(true);
    expect(isTerminalCloudAgent({ status: "failed" })).toBe(true);
    expect(isTerminalCloudAgent({ status: "future_status" })).toBe(true);
  });
});
