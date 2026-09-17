import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudAgentResource,
  CloudAgentLineError,
  CloudAgentsClient,
  isTerminalCloudAgent,
} from "../src/cloudAgents.js";
import { FetchLike, PlowApi, PlowApiError, REQUEST_TIMEOUT_MS } from "../src/plowApi.js";

const CREDENTIAL = "plow_dev_credential_123456789";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const LINE = { uid: "lin_willow", object: "line", provider_type: "imessage", provider_key: "+15550000001" };

const wireAgent = (overrides: Record<string, unknown> = {}) => ({
  uid: "agent_123",
  line: LINE, credential: null, settings: { daily_payment_cap_usd: { value: 200 }, verbose_output: { value: false } }, image: null,
  url: "https://provider.example/agent_123",
  provider: "exe:hermes",
  name: "Kitchen",
  status: "running",
  failure_code: null,
  created_at: "2026-08-20T12:00:00Z",
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

  it("lists local and failed agents without credential joins", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 200, body: [
      wireAgent({ uid: "local", provider: "self_hosted", status: null }),
      wireAgent({ uid: "failed", status: "failed", credential: null }),
    ] }]);
    const rows = await new CloudAgentsClient(new PlowApi("https://stub.invalid", fetchImpl)).list(CREDENTIAL);
    expect(rows).toMatchObject([
      { agentId: "local", status: null, line: { uid: LINE.uid, number: LINE.provider_key, displayName: null } },
      { agentId: "failed", credential: null },
    ]);
    expect(calls[0].url).toBe("https://stub.invalid/v1/agents");
  });

  it("rejects a slot wrapper and malformed agent names", async () => {
    for (const body of [[{ line: LINE, assistant: wireAgent() }], [wireAgent({ name: 7 })]]) {
      const { fetchImpl } = recordingFetch([{ status: 200, body }]);
      await expect(new CloudAgentsClient(new PlowApi("https://stub.invalid", fetchImpl)).list(CREDENTIAL)).rejects.toThrow("invalid cloud-agent response");
    }
  });
});



describe("CloudAgentsClient line changes", () => {
  it("sends only the new line uid to the encoded agent route", async () => {
    const { calls, fetchImpl } = recordingFetch([{
      status: 200,
      body: wireAgent({ line_uid: "lin_ash" }),
    }]);

    await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .changeLine(CREDENTIAL, "agent/with space", "lin_ash");

    expect(calls[0].url).toBe(
      "https://api.plow.co/v1/agents/agent%2Fwith%20space/line",
    );
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ line_uid: "lin_ash" });
  });

  it.each([
    ["NO_HOME_CHAT", "no_home_chat", "Text this line once first, then try again."],
    ["CHAT_SET_CONFLICT", "line_occupied", "Another agent already uses that line."],
    ["AGENT_FAILED", "agent_failed", "This agent failed to set up. Retry or delete it before changing lines."],
    ["PROVISION_IN_FLIGHT", "provision_in_flight", "This agent is still setting up. Try again when it's ready."],
    ["PENDING_TEARDOWN", "pending_teardown", "This agent is still being removed. Try again when removal finishes."],
    ["CHAT_DELETED", "chat_deleted", "That line changed while Plow was updating the agent. Refresh and try again."],
    ["PROVIDER_CONFLICT", "provider_conflict", "Another kind of agent already uses that line."],
  ] as const)("maps %s to fixed change-line copy", async (wireCode, code, copy) => {
    const { fetchImpl } = recordingFetch([{
      status: 409,
      body: { detail: { code: wireCode, message: `echo ${CREDENTIAL}` } },
    }]);

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .changeLine(CREDENTIAL, "agent_123", "lin_ash")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudAgentLineError);
    expect(error).toMatchObject({ code, message: copy });
    expect(String(error)).not.toContain(CREDENTIAL);
    expect(console.error).toHaveBeenCalledWith(
      `[cloud-agent] request failed status=409 code=${wireCode}`,
    );
  });

  it("maps the bare 404 to the same unavailable copy on the move path", async () => {
    const { fetchImpl } = recordingFetch([{ status: 404, body: { detail: "Line not found" } }]);

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .changeLine(CREDENTIAL, "agent_123", "lin_ash")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "line_unavailable",
      message: "This line isn't available right now. Refresh and try again.",
    });
  });

  it("keeps a missing agent apart from a line with no home chat", async () => {
    const { fetchImpl } = recordingFetch([{ status: 404, body: { detail: "Assistant not found" } }]);

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .changeLine(CREDENTIAL, "agent_123", "lin_ash")
      .catch((caught: unknown) => caught as Error);

    expect(error).not.toBeInstanceOf(CloudAgentLineError);
    expect(error.message).toBe("Plow returned 404.");
  });

});

describe("CloudAgentsClient deletion", () => {
  it("routes by encoded agent id and treats an already-gone agent as success", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 404 }]);

    await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .delete(CREDENTIAL, "agent/with space");

    expect(calls[0].url).toBe("https://api.plow.co/v1/agents/agent%2Fwith%20space");
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
    line: { uid: LINE.uid, displayName: null, number: LINE.provider_key }, credential: null, settings: { daily_payment_cap_usd: { value: 200 }, verbose_output: { value: false } }, image: null,
    url: null,
    provider: "exe:hermes",
    name: "Kitchen",
    status: "provisioning",
    failureCode: null,
    createdAt: "2026-09-08T00:00:00Z",
  });

  it("ignores a mismatched id and stops on the requested agent's terminal state", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: wireAgent({ uid: "someone_else", status: "running" }) },
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

  it("continues polling through network and 5xx failures", async () => {
    let reads = 0;
    const fetchImpl: FetchLike = async () => {
      reads += 1;
      if (reads === 1) throw new TypeError("connection dropped");
      if (reads === 2) return new Response(null, { status: 503 });
      return new Response(JSON.stringify(wireAgent({ status: "running" })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const final = await new CloudAgentsClient(
      new PlowApi("https://api.plow.co", fetchImpl),
      async () => {},
    ).poll(CREDENTIAL, receipt());

    expect(final.status).toBe("running");
    expect(reads).toBe(3);
  });

  it("stops after five minutes of consecutive retryable failures", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { calls, fetchImpl } = recordingFetch([
      { status: 503 },
      { status: 503 },
      { status: 409 },
    ]);

    await expect(new CloudAgentsClient(
      new PlowApi("https://api.plow.co", fetchImpl),
      async () => { now += 5 * 60_000; },
    ).poll(CREDENTIAL, receipt()))
      .rejects.toThrow("Cloud-agent provisioning is unavailable right now.");

    expect(calls).toHaveLength(2);
  });

  it("stops polling on an authoritative 4xx", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 409 },
      { status: 200, body: wireAgent({ status: "running" }) },
    ]);

    await expect(new CloudAgentsClient(
      new PlowApi("https://api.plow.co", fetchImpl),
      async () => {},
    ).poll(CREDENTIAL, receipt())).rejects.toThrow("Plow returned 409.");

    expect(calls).toHaveLength(1);
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
