import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudAgentResource,
  CloudAgentLineError,
  CloudAgentsClient,
  isTerminalCloudAgent,
} from "../src/cloudAgents.js";
import {
  AgentTarget,
  BUILTIN_TARGET_ID,
  FetchLike,
  PlowApi,
  PlowApiError,
  REQUEST_TIMEOUT_MS,
} from "../src/plowApi.js";

const CREDENTIAL = "plow_dev_credential_123456789";
/** The built-in Plow target: this suite's origin, authorised with CREDENTIAL. */
const TARGET: AgentTarget = {
  id: BUILTIN_TARGET_ID,
  label: "Plow",
  baseUrl: "https://api.plow.co",
  bearer: CREDENTIAL,
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const wireAgent = (overrides: Record<string, unknown> = {}) => ({
  agent_id: "agent_123",
  chat_uids: ["cht_home"],
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
  it.each([
    ["deployed line-scoped shape", wireAgent(), {
      agentId: "agent_123",
      chatUids: ["cht_home"],
      name: "Kitchen",
      status: "running",
    }],
    ["omitted status", wireAgent({ status: undefined }), { status: "provisioning" }],
    ["failure metadata", wireAgent({
      status: "failed",
      failure_code: "capacity_exhausted",
      failure_reason: "Provider capacity is exhausted.",
    }), {
      failureCode: "capacity_exhausted",
      failureReason: "Provider capacity is exhausted.",
    }],
  ])("resource parsing matrix: %s", async (_case, wire, expected) => {
    const { fetchImpl } = recordingFetch([{ status: 200, body: { data: [wire] } }]);

    await expect(new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl))
      .list(TARGET)).resolves.toMatchObject([expected]);
  });

  it("accepts the older single-chat grant", async () => {
    const oldShape = wireAgent();
    delete oldShape.chat_uids;
    Object.assign(oldShape, { chat_uid: "cht_home_old" });
    const { fetchImpl } = recordingFetch([{ status: 200, body: { data: [oldShape] } }]);
    const client = new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl));

    await expect(client.list(TARGET)).resolves.toMatchObject([
      { chatUids: ["cht_home_old"] },
    ]);
  });

  it("keeps the roster when informational chat grants are empty or absent", async () => {
    const absentGrant = wireAgent({ agent_id: "agent_absent", line_uid: "lin_absent" });
    delete absentGrant.chat_uids;
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: {
        data: [
          wireAgent({ agent_id: "agent_empty", line_uid: "lin_empty", chat_uids: [] }),
          absentGrant,
        ],
      },
    }]);

    await expect(new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl))
      .list(TARGET)).resolves.toMatchObject([
      { agentId: "agent_empty", chatUids: [] },
      { agentId: "agent_absent", chatUids: [] },
    ]);
  });

  it("rejects a malformed chat grant", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: { data: [wireAgent({ chat_uids: [7] })] },
    }]);

    await expect(new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl))
      .list(TARGET)).rejects.toThrow("Plow returned an invalid cloud-agent response.");
  });

});

describe("CloudAgentsClient creation", () => {
  it.each([200, 202])("accepts %s and sends the selected provider", async (status) => {
    const { calls, fetchImpl } = recordingFetch([{ status, body: wireAgent() }]);

    await new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl)).create(
      TARGET,
      { lineUid: "lin_willow", name: "Kitchen", provider: "exe:life" },
    );

    expect(calls[0].url).toBe("https://api.plow.co/v1/agents/cloud");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      line_uid: "lin_willow",
      name: "Kitchen",
      provider: "exe:life",
    });
    expect(String(calls[0].init.body)).not.toContain("chat_uids");
  });

  it("omits a blank optional name", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 200, body: wireAgent() }]);

    await new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl)).create(
      TARGET,
      { lineUid: "lin_willow", name: "", provider: "exe:hermes" },
    );

    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      line_uid: "lin_willow",
      provider: "exe:hermes",
    });
  });

  it("maps NO_HOME_CHAT to fixed create copy", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 409,
      body: { detail: { code: "NO_HOME_CHAT", message: `echo ${CREDENTIAL}` } },
    }]);

    await expect(new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl)).create(
      TARGET,
      { lineUid: "lin_willow", name: "Kitchen", provider: "exe:hermes" },
    )).rejects.toThrow("Text this line once first, then try again.");
    expect(console.error).toHaveBeenCalledWith(
      "[cloud-agent] request failed status=409 code=NO_HOME_CHAT",
    );
  });

  it("uses fixed copy and logs only status for an unknown authenticated error", async () => {
    const encoded = Buffer.from(CREDENTIAL).toString("base64");
    const { fetchImpl } = recordingFetch([{
      status: 422,
      body: {
        detail: { code: "LINE_CAPACITY", message: `Rejected bearer ${encoded}` },
        token: CREDENTIAL,
        debug: "body-only marker",
      },
    }]);

    const error = await new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl))
      .create(TARGET, {
        lineUid: "lin_willow",
        name: "Kitchen",
        provider: "exe:hermes",
      })
      .catch((caught: unknown) => caught as Error);

    expect(error.message).toBe("Plow returned 422.");
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "[cloud-agent] request failed status=422",
    );
    const stderr = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(error.message).not.toContain(encoded);
    expect(stderr).not.toContain(encoded);
    expect(stderr).not.toContain(CREDENTIAL);
    expect(stderr).not.toContain("LINE_CAPACITY");
    expect(stderr).not.toContain("body-only marker");
  });
});

describe("CloudAgentsClient line changes", () => {
  it("sends only the new line uid to the encoded agent route", async () => {
    const { calls, fetchImpl } = recordingFetch([{
      status: 200,
      body: wireAgent({ line_uid: "lin_ash" }),
    }]);

    await new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl))
      .changeLine(TARGET, "agent/with space", "lin_ash");

    expect(calls[0].url).toBe(
      "https://api.plow.co/v1/agents/cloud/agent%2Fwith%20space/line",
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

    const error = await new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl))
      .changeLine(TARGET, "agent_123", "lin_ash")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudAgentLineError);
    expect(error).toMatchObject({ code, message: copy });
    expect(String(error)).not.toContain(CREDENTIAL);
    expect(console.error).toHaveBeenCalledWith(
      `[cloud-agent] request failed status=409 code=${wireCode}`,
    );
  });

});

describe("CloudAgentsClient deletion", () => {
  it("routes by encoded agent id and treats an already-gone agent as success", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 404 }]);

    await new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl))
      .delete(TARGET, "agent/with space");

    expect(calls[0].url).toBe("https://api.plow.co/v1/agents/cloud/agent%2Fwith%20space");
    expect(calls[0].init.method).toBe("DELETE");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
  });

  it("uses fixed error copy instead of server-authored detail", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 503,
      body: { detail: `provider echoed ${CREDENTIAL}` },
    }]);

    await expect(new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl))
      .delete(TARGET, "agent_123"))
      .rejects.toThrow("Cloud-agent provisioning is unavailable right now.");
  });
});

describe("CloudAgentsClient polling", () => {
  const receipt = (): CloudAgentResource => ({
    agentId: "agent_123",
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
    const client = new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl), async () => {});

    const final = await client.poll(TARGET, receipt(), (agent) => {
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

    await new CloudAgentsClient(() => new PlowApi("https://api.plow.co", fetchImpl), async () => {})
      .poll(TARGET, receipt(), undefined, controller.signal);

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
      () => new PlowApi("https://api.plow.co", fetchImpl),
      async () => {},
    ).poll(TARGET, receipt());

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
      () => new PlowApi("https://api.plow.co", fetchImpl),
      async () => { now += 5 * 60_000; },
    ).poll(TARGET, receipt()))
      .rejects.toThrow("Cloud-agent provisioning is unavailable right now.");

    expect(calls).toHaveLength(2);
  });

  it("stops polling on an authoritative 4xx", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 409 },
      { status: 200, body: wireAgent({ status: "running" }) },
    ]);

    await expect(new CloudAgentsClient(
      () => new PlowApi("https://api.plow.co", fetchImpl),
      async () => {},
    ).poll(TARGET, receipt())).rejects.toThrow("Plow returned 409.");

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
      () => new PlowApi("https://api.plow.co", fetchImpl),
      async () => {},
    ).poll(TARGET, receipt(), undefined, controller.signal);

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

/**
 * A self-hosted host answers on its OWN origin with its OWN bearer, and its
 * 400 carries the command the owner has to run next. Both are things the
 * cloud path never had to get right.
 */
describe("CloudAgentsClient against a self-hosted host", () => {
  const LOCAL: AgentTarget = {
    id: "tgt_slowdown",
    label: "slowdown",
    baseUrl: "http://192.168.15.12:8765",
    bearer: "serve-token-abc",
  };

  it("sends to the host's own origin with the host's own bearer", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 202, body: wireAgent() }]);

    await new CloudAgentsClient(() => new PlowApi(LOCAL.baseUrl, fetchImpl)).create(
      LOCAL,
      { lineUid: "lin_willow", name: "Kitchen", provider: "local:docker" },
    );

    expect(calls[0].url).toBe("http://192.168.15.12:8765/v1/agents/cloud");
    expect(new Headers(calls[0].init.headers).get("authorization"))
      .toBe("Bearer serve-token-abc");
    // The Mac's Plow session is not what authorised a host the owner typed in.
    expect(new Headers(calls[0].init.headers).get("authorization")).not.toContain(CREDENTIAL);
  });

  it("shows the register command instead of 'returned 400'", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 400,
      body: { detail: "Unknown agent 'demo'. Run 'agent-mgr register demo <dir>' on this host." },
    }]);

    const error = await new CloudAgentsClient(() => new PlowApi(LOCAL.baseUrl, fetchImpl))
      .create(LOCAL, { lineUid: "lin_willow", name: "demo", provider: "local:docker" })
      .catch((thrown) => thrown);

    // The sentence IS the fix; a generic failure would hide the one useful
    // thing in the response.
    expect(String(error)).toContain("agent-mgr register demo <dir>");
  });

  it("recognises the marker in a nested detail too", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 400,
      body: { detail: { message: "Run 'agent-mgr register ...' first." } },
    }]);

    const error = await new CloudAgentsClient(() => new PlowApi(LOCAL.baseUrl, fetchImpl))
      .create(LOCAL, { lineUid: "lin_willow", name: "demo", provider: "local:docker" })
      .catch((thrown) => thrown);

    expect(String(error)).toContain("agent-mgr register demo <dir>");
  });

  it.each([
    ["in the clear", (bearer: string) => `bad token ${bearer}`],
    // The one a literal check cannot catch — and the reason NOTHING
    // server-authored is forwarded rather than filtered.
    ["base64-encoded", (bearer: string) => `bad token ${Buffer.from(bearer).toString("base64")}`],
    ["hex-encoded", (bearer: string) => `bad token ${Buffer.from(bearer).toString("hex")}`],
    ["reversed", (bearer: string) => `bad token ${[...bearer].reverse().join("")}`],
  ])("never repeats a 400 body that carries the token %s", async (_how, encode) => {
    const { fetchImpl } = recordingFetch([{
      status: 400,
      body: { detail: encode(LOCAL.bearer) },
    }]);

    const error = await new CloudAgentsClient(() => new PlowApi(LOCAL.baseUrl, fetchImpl))
      .create(LOCAL, { lineUid: "lin_willow", name: "demo", provider: "local:docker" })
      .catch((thrown) => thrown);

    // The body is a host the owner typed in talking. It is asked a yes/no
    // question and never quoted, so no encoding of the bearer has a path here.
    expect(String(error)).not.toContain(encode(LOCAL.bearer));
    expect(String(error)).toContain("400");
  });

  it("writes the register sentence itself, from the name it sent", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 400,
      // Everything else in this body is noise the screen must not repeat.
      body: { detail: `Unknown agent. Run 'agent-mgr register ...'. token=${LOCAL.bearer}` },
    }]);

    const error = await new CloudAgentsClient(() => new PlowApi(LOCAL.baseUrl, fetchImpl))
      .create(LOCAL, { lineUid: "lin_willow", name: "demo", provider: "local:docker" })
      .catch((thrown) => thrown);

    expect(String(error)).toContain("agent-mgr register demo <dir>");
    expect(String(error)).not.toContain(LOCAL.bearer);
    expect(String(error)).not.toContain("Unknown agent.");
  });

  it("still answers 401 for a wrong bearer", async () => {
    const { fetchImpl } = recordingFetch([{ status: 401, body: { detail: "nope" } }]);

    await expect(new CloudAgentsClient(() => new PlowApi(LOCAL.baseUrl, fetchImpl))
      .create(LOCAL, { lineUid: "lin_willow", name: "demo", provider: "local:docker" }))
      .rejects.toThrow("Not authorized.");
  });
});
