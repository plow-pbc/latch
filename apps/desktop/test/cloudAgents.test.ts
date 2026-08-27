import { describe, expect, it } from "vitest";
import {
  CREATE_REQUEST_TIMEOUT_MS,
  CloudAgentResource,
  CloudAgentsClient,
} from "../src/cloudAgents.js";
import { PlowApi, PlowApiError } from "../src/plowApi.js";

const CREDENTIAL = "plow_sk_device_do_not_leak";

function resource(
  status: CloudAgentResource["status"],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    agent_id: "agent_123",
    chat_uids: ["cht_123"],
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

  it.each([
    ["PENDING_TEARDOWN", "still being removed"],
    ["PROVIDER_CONFLICT", "different cloud-agent provider"],
    ["PROVISION_IN_FLIGHT", "already in progress"],
    ["CHAT_DELETED", "chat has been deleted"],
    ["OWNER_NO_ADDRESS", "no address for that chat"],
    ["OWNER_NOT_IN_CHAT", "not a member of that chat"],
    ["A_NEW_CONFLICT", "Plow returned 409."],
    ["constructor", "Plow returned 409."],
  ])("surfaces structured 409 %s without deleting anything", async (code, message) => {
    const { calls, fetchImpl } = recordingFetch([{
      status: 409,
      body: { detail: { code, message: "identical prose must not decide behavior" } },
    }]);

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .create(CREDENTIAL, { chatUids: ["cht_123"] })
      .catch((caught: unknown) => caught);

    expect(String(error)).toContain(message);
    expect(calls.map(({ init }) => init.method)).toEqual(["POST"]);
  });
});

describe("CloudAgentsClient contract parsing", () => {
  it("keeps a missing create status in provisioning", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 202,
      body: resource("provisioning", { status: undefined }),
    }]);

    const created = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .create(CREDENTIAL, { chatUids: ["cht_123"] });

    expect(created.status).toBe("provisioning");
  });

  it.each([
    "provider_unreachable",
    "image_pull_timeout",
    "setup_failed",
    "validation_failed",
    "unknown",
    "provision_timeout",
    "capacity_exhausted",
  ])("preserves failure_code %s", async (failureCode) => {
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: [resource("failed", { failure_code: failureCode })],
    }]);

    const [failed] = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .list(CREDENTIAL);

    expect(failed.failureCode).toBe(failureCode);
  });

  it("keeps failure_reason as a fallback", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: [resource("failed", { failure_reason: "legacy provider explanation" })],
    }]);

    const [failed] = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .list(CREDENTIAL);

    expect(failed.failureReason).toBe("legacy provider explanation");
  });
});

describe("CloudAgentsClient chat grant", () => {
  // The exact body prod serves: a chat set, no name, no created_at, no
  // session_id, and a null failure_code.
  const LIVE = {
    agent_id: "ec94d2d3566685683c3223e2ada04f52",
    chat_uids: ["cht_pnTWzzOSKeChIv0eE5MKyA", "cht_Ap3vD8sYqJ6nX1cF"],
    url: "https://plow-agent-ec94d2d3566685683c3223e2ada04f52.exe.xyz",
    provider: "exe:hermes",
    status: "running",
    failure_code: null,
  };

  it("reads a chat set, home first, in the server's order", async () => {
    const { fetchImpl } = recordingFetch([{ status: 200, body: [LIVE] }]);

    const [agent] = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .list(CREDENTIAL);

    expect(agent.chatUids).toEqual(LIVE.chat_uids);
    expect(agent.status).toBe("running");
    expect(agent.name).toBeNull();
    expect(agent.createdAt).toBeNull();
  });

  it("still reads the single chat_uid an older agent answers with", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: [{ ...LIVE, chat_uids: undefined, chat_uid: "cht_legacy" }],
    }]);

    const [agent] = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .list(CREDENTIAL);

    expect(agent.chatUids).toEqual(["cht_legacy"]);
  });

  it("sends the chat set as a list", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 202, body: LIVE }]);

    await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .create(CREDENTIAL, { chatUids: ["cht_one", "cht_two"] });

    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      chat_uids: ["cht_one", "cht_two"],
    });
  });

  it.each([
    ["no grant at all", {}],
    ["an empty set", { chat_uids: [] }],
    ["a set holding a non-string", { chat_uids: ["cht_ok", 7] }],
  ])("refuses a response with %s", async (_label, grant) => {
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: [{ ...LIVE, chat_uids: undefined, ...grant }],
    }]);

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .list(CREDENTIAL)
      .catch((caught: unknown) => caught);

    expect(String(error)).toBe("PlowApiError: Plow returned an invalid cloud-agent response.");
  });

  it("refuses a chat uid that repeats the credential", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: [{ ...LIVE, chat_uids: [`cht_${CREDENTIAL}`] }],
    }]);

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .list(CREDENTIAL)
      .catch((caught: unknown) => caught);

    expect(String(error)).toBe("PlowApiError: Plow returned an unsafe cloud-agent response.");
    expect(String(error)).not.toContain(CREDENTIAL);
  });
});

describe("CloudAgentsClient polling identity", () => {
  it("ignores a transient mismatched id and keeps polling the requested agent", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: resource("provisioning", { agent_id: "agent_OTHER" }) },
      { status: 200, body: resource("running", { agent_id: "agent_A" }) },
    ]);
    const transitions: string[] = [];
    const receipt = fromWire(resource("provisioning", { agent_id: "agent_A" }));

    const final = await new CloudAgentsClient(
      new PlowApi("https://api.plow.co", fetchImpl),
      async () => undefined,
    ).poll(CREDENTIAL, receipt, (agent) => {
      transitions.push(`${agent.agentId}:${agent.status}`);
    });

    expect(final).toMatchObject({ agentId: "agent_A", status: "running" });
    expect(calls.map(({ url }) => url)).toEqual([
      "https://api.plow.co/v1/agents/cloud/agent_A",
      "https://api.plow.co/v1/agents/cloud/agent_A",
    ]);
    expect(transitions).toEqual(["agent_A:provisioning", "agent_A:running"]);
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
    for (const [status, body, message] of [
      [403, { detail: `rejected fragment ${fragment}` }, "Not permitted."],
      [404, { error: { message: `rejected fragment ${fragment}` } }, "Plow returned 404."],
    ] as const) {
      const { fetchImpl } = recordingFetch([{ status, body }]);
      const client = new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl));
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
    chatUids: (value.chat_uids as string[]) ?? [],
    url: typeof value.url === "string" ? value.url : null,
    provider: typeof value.provider === "string" ? value.provider : null,
    name: typeof value.name === "string" ? value.name : null,
    status: value.status as CloudAgentResource["status"],
    failureReason: typeof value.failure_reason === "string" ? value.failure_reason : null,
    createdAt: typeof value.created_at === "string" ? value.created_at : null,
    sessionId: typeof value.session_id === "string" ? value.session_id : null,
  };
}

describe("CloudAgentsClient chat-set replacement", () => {
  it("PUTs the whole ordered set to the agent's chats endpoint", async () => {
    const { calls, fetchImpl } = recordingFetch([{
      status: 200,
      body: resource("running", { chat_uids: ["cht_home", "cht_two"] }),
    }]);

    const updated = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .updateChats(CREDENTIAL, "agent/with space", ["cht_home", "cht_two"]);

    const [call] = calls;
    expect([call.init.method, call.url]).toEqual([
      "PUT",
      "https://api.plow.co/v1/agents/cloud/agent%2Fwith%20space/chats",
    ]);
    expect(JSON.parse(String(call.init.body))).toEqual({ chat_uids: ["cht_home", "cht_two"] });
    expect(updated.chatUids).toEqual(["cht_home", "cht_two"]);
  });

  it("keeps the caller's order rather than sorting: the first entry is home", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 200, body: resource("running") }]);

    await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .updateChats(CREDENTIAL, "agent_123", ["cht_zeta", "cht_alpha", "cht_mid"]);

    expect(JSON.parse(String(calls[0].init.body)).chat_uids)
      .toEqual(["cht_zeta", "cht_alpha", "cht_mid"]);
  });

  it("drops blanks and repeats, and a repeat does not demote home", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 200, body: resource("running") },
      { status: 202, body: resource("provisioning") },
    ]);
    const client = new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl));

    await client.updateChats(CREDENTIAL, "agent_123", [" cht_home ", "cht_two", "", "cht_home"]);
    await client.create(CREDENTIAL, { chatUids: ["cht_home", "cht_home", " "] });

    expect(calls.map(({ init }) => JSON.parse(String(init.body)).chat_uids)).toEqual([
      ["cht_home", "cht_two"],
      ["cht_home"],
    ]);
  });

  it("names the agent that already holds a chat, from the server's own message", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 409,
      body: {
        detail: {
          code: "CHAT_SET_CONFLICT",
          message: "Groceries already belongs to Household helper.",
        },
      },
    }]);

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .updateChats(CREDENTIAL, "agent_123", ["cht_taken"])
      .catch((caught: unknown) => caught);

    // The only 409 whose useful half — WHICH agent — only the server knows.
    expect(String(error)).toContain("Groceries already belongs to Household helper.");
    expect((error as PlowApiError).status).toBe(409);
  });

  it("falls back to our own words when that message is missing or echoes the credential", async () => {
    const { fetchImpl } = recordingFetch([
      { status: 409, body: { detail: { code: "CHAT_SET_CONFLICT" } } },
      { status: 409, body: { detail: { code: "CHAT_SET_CONFLICT", message: `bad ${CREDENTIAL}` } } },
    ]);
    const client = new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl));

    const missing = await client.updateChats(CREDENTIAL, "a", ["cht_1"]).catch((e: unknown) => e);
    const echoed = await client.updateChats(CREDENTIAL, "a", ["cht_1"]).catch((e: unknown) => e);

    for (const error of [missing, echoed]) {
      expect(String(error)).toContain("already belongs to another agent");
      expect(String(error)).not.toContain(CREDENTIAL);
    }
  });

  it("says an agent that never started cannot have its chats changed", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 409,
      body: { detail: { code: "AGENT_FAILED", message: "unused" } },
    }]);

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .updateChats(CREDENTIAL, "agent_123", ["cht_1"])
      .catch((caught: unknown) => caught);

    expect(String(error)).toContain("failed to start");
    expect(String(error)).toContain("Remove it and set one up again");
  });

  it.each([500, 502, 503])("says nothing changed when the server rolls a %s back", async (status) => {
    const { fetchImpl } = recordingFetch([{ status, body: { detail: "boom" } }]);

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .updateChats(CREDENTIAL, "agent_123", ["cht_1"])
      .catch((caught: unknown) => caught);

    // A rollback is not a plain failure: the old set is still serving, and the
    // sentence has to say so or the reader goes looking for a broken agent.
    expect(String(error)).toContain("Nothing changed — the old chats are still live.");
    expect((error as PlowApiError).status).toBe(status);
  });

  it("reports a 4xx that is not a conflict as itself, not as a rollback", async () => {
    const { fetchImpl } = recordingFetch([{ status: 403, body: {} }]);

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .updateChats(CREDENTIAL, "agent_123", ["cht_1"])
      .catch((caught: unknown) => caught);

    expect((error as PlowApiError).kind).toBe("forbidden");
    expect(String(error)).not.toContain("Nothing changed");
  });

  it("refuses a response that repeats the credential back", async () => {
    const { fetchImpl } = recordingFetch([{
      status: 200,
      body: resource("running", { chat_uids: [`cht_${CREDENTIAL}`] }),
    }]);

    const error = await new CloudAgentsClient(new PlowApi("https://api.plow.co", fetchImpl))
      .updateChats(CREDENTIAL, "agent_123", ["cht_1"])
      .catch((caught: unknown) => caught);

    expect(String(error)).toBe("PlowApiError: Plow returned an unsafe cloud-agent response.");
    expect(String(error)).not.toContain(CREDENTIAL);
  });
});

describe("CloudAgentsClient request budgets", () => {
  /** Watch what each call asks `PlowApi` for, without changing what it does. */
  function watchedApi(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
    const api = new PlowApi("https://api.plow.co", fetchImpl);
    const asked: Array<{ method: string; path: string; timeoutMs?: number }> = [];
    const real = api.request.bind(api);
    api.request = ((method: string, path: string, opts: Parameters<typeof real>[2] = {}) => {
      asked.push({ method, path, timeoutMs: opts.timeoutMs });
      return real(method, path, opts);
    }) as typeof api.request;
    return { api, asked };
  }

  it("gives the chat-set PUT the same budget as a create", async () => {
    const { fetchImpl } = recordingFetch([
      { status: 202, body: resource("provisioning") },
      { status: 200, body: resource("running") },
    ]);
    const { api, asked } = watchedApi(fetchImpl);
    const client = new CloudAgentsClient(api);

    await client.create(CREDENTIAL, { chatUids: ["cht_1"] });
    await client.updateChats(CREDENTIAL, "agent_123", ["cht_1"]);

    // The PUT restarts the agent, so it waits on the provider exactly as the
    // create does. On the default budget a save that would have succeeded
    // times out — and a timed-out PUT is the outcome with no knowable result.
    expect(asked).toEqual([
      { method: "POST", path: "/v1/agents/cloud", timeoutMs: CREATE_REQUEST_TIMEOUT_MS },
      { method: "PUT", path: "/v1/agents/cloud/agent_123/chats", timeoutMs: CREATE_REQUEST_TIMEOUT_MS },
    ]);
  });

  it("leaves the reads on the default budget", async () => {
    const { fetchImpl } = recordingFetch([
      { status: 200, body: { data: [] } },
      { status: 204 },
    ]);
    const { api, asked } = watchedApi(fetchImpl);
    const client = new CloudAgentsClient(api);

    await client.list(CREDENTIAL);
    await client.delete(CREDENTIAL, "agent_123");

    expect(asked.map((call) => call.timeoutMs)).toEqual([undefined, undefined]);
  });
});
