import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CloudAgentState,
  CloudAgentsApi,
  CloudChatOption,
  CloudChatsClient,
  CloudLineOption,
  CloudLinesClient,
} from "../src/cloudAgentState.js";
import { CloudAgentResource } from "../src/cloudAgents.js";
import type { AgentIndex } from "../src/agentIndex.js";
import {
  CloudAgentProvider,
  PlowApi,
  PlowApiError,
} from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";
import { Deferred, deferred } from "./deferred.js";

const CREDENTIAL = "plow_session_123456789";

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-line-state-"));
  const settings = loadSettings(home);
  settings.relayCredential = CREDENTIAL;
  saveSettings(home, settings);
  return home;
}

function agent(overrides: Partial<CloudAgentResource> = {}): CloudAgentResource {
  return {
    agentId: "agent_1",
    line: { uid: "lin_willow", displayName: "Willow", number: "+15550100" },
    credential: null,
    url: null,
    provider: "exe:hermes",
    name: "Kitchen",
    status: "running",
    failureCode: null,
    createdAt: "2026-08-24T18:02:11Z",
    ...overrides,
  };
}

function chat(overrides: Partial<CloudChatOption> = {}): CloudChatOption {
  return {
    uid: "cht_one",
    lineUid: "lin_willow",
    status: "active",
    // Coherent with `people` below: the owner and Nina, so this default is a
    // group thread and NOT a line an agent can be created on.
    memberCount: 2,
    hasOwnerMember: true,
    label: "Willow · You · Nina",
    recipients: { line: "+15550100", members: ["+15550111", "+15550122"] },
    people: [
      { number: "+15550111", name: null, isOwner: true },
      { number: "+15550122", name: "Nina", isOwner: false },
    ],
    ...overrides,
  };
}

/** The one thread shape a line can have an agent created on: active, and the
 * account holder alone in it. */
function homeChat(overrides: Partial<CloudChatOption> = {}): CloudChatOption {
  return chat({
    uid: "cht_home",
    status: "active",
    memberCount: 1,
    hasOwnerMember: true,
    label: "Willow · You",
    recipients: { line: "+15550100", members: ["+15550111"] },
    people: [{ number: "+15550111", name: null, isOwner: true }],
    ...overrides,
  });
}

function build(options: {
  listAgents?: () => Promise<CloudAgentResource[]>;
  changeAgentLine?: (agentId: string, lineUid: string) => Promise<CloudAgentResource>;
  pollAgent?: (
    receipt: CloudAgentResource,
    transition?: (agent: CloudAgentResource) => void | Promise<void>,
  ) => Promise<CloudAgentResource>;
  listChats?: () => Promise<CloudChatOption[]>;
  listLines?: () => Promise<CloudLineOption[]>;
  listProviders?: () => Promise<CloudAgentProvider[]>;
  remove?: (agentId: string) => Promise<void>;
  onChange?: () => void;
  agentIndex?: () => Promise<AgentIndex>;
} = {}) {
  const calls: string[] = [];
  const agents: CloudAgentsApi = {
    async changeLine(_credential, agentId, lineUid) {
      calls.push(`changeLine:${agentId}:${lineUid}`);
      return options.changeAgentLine
        ? options.changeAgentLine(agentId, lineUid)
        : agent({ agentId });
    },
    async list() {
      calls.push("listAgents");
      return options.listAgents ? options.listAgents() : [agent()];
    },
    async delete(_credential, agentId) {
      calls.push(`delete:${agentId}`);
      await options.remove?.(agentId);
    },
    async poll(_credential, receipt, transition) {
      calls.push(`poll:${receipt.agentId}`);
      if (options.pollAgent) return options.pollAgent(receipt, transition);
      await transition?.(receipt);
      return receipt;
    },
  };
  const home = tempHome();
  const state = new CloudAgentState({
    home,
    agents,
    chats: {
      async list() {
        calls.push("listChats");
        return options.listChats ? options.listChats() : [chat()];
      },
    },
    providers: {
      async listCloudAgentProviders() {
        calls.push("listProviders");
        return { managedPhone: "+15551234567", providers: options.listProviders
          ? await options.listProviders()
          : [{ id: "provider/default", name: "Default", phrase: "Start Default" }] };
      },
    },
    lines: {
      async list() {
        calls.push("listLines");
        return options.listLines
          ? options.listLines()
          : [{ uid: "lin_willow", agentUid: "agent_1", displayName: "Willow", number: "+15550100" }];
      },
    },
    onChange: options.onChange,
    agentIndex: options.agentIndex,
  });
  return { state, calls, home, agents };
}

describe("CloudAgentState line and thread display", () => {

  it("keeps live provider ids opaque and in the endpoint's order", async () => {
    const providers = [
      { id: " provider/Zeta ", name: "Zeta", phrase: "Start" },
      { id: "exe:life", name: "Life", phrase: "Start" },
    ];
    const { state, calls } = build({ listProviders: async () => providers });

    await state.refresh();

    expect(state.state().cloudProviders).toEqual(providers);
    expect(state.state().cloudProvidersError).toBeNull();
    expect(calls.filter((call) => call === "listProviders")).toHaveLength(1);
  });

  it("reports an initial provider-list failure without inventing a fallback roster", async () => {
    const { state } = build({
      listProviders: async () => {
        throw new PlowApiError("forbidden", "Not permitted.", 403);
      },
    });

    await state.refresh();

    expect(state.state().cloudProviders).toBeNull();
    expect(state.state().cloudProvidersError).toBe("Not permitted.");
  });

  it("clears a previous provider list when its refresh fails", async () => {
    let fail = false;
    const { state } = build({
      listProviders: async () => {
        if (fail) throw new PlowApiError("network", "Plow didn't answer in time. Try again.");
        return [{ id: "provider/available", name: "Available", phrase: "Start" }];
      },
    });
    await state.refresh();

    fail = true;
    await state.refresh();

    expect(state.state().cloudProviders).toBeNull();
    expect(state.state().cloudProvidersError).toBe("Plow didn't answer in time. Try again.");
  });

  it("sorts newest agents first and missing creation dates by name", async () => {
    const { state } = build({
      listAgents: async () => [
        agent({ agentId: "agent_missing_a", name: "Zulu", createdAt: null }),
        agent({ agentId: "agent_old", name: "Older", createdAt: "2026-08-20T18:02:11Z" }),
        agent({ agentId: "agent_missing_z", name: "Alpha", createdAt: null }),
        agent({ agentId: "agent_new", name: "Newest", createdAt: "2026-08-29T18:02:11Z" }),
      ],
    });

    await state.refresh();

    expect(state.state().cloudAgents.map((row) => row.name)).toEqual([
      "Newest",
      "Older",
      "Alpha",
      "Zulu",
    ]);
  });

  it("builds a Messages route only from a resolved agent line", async () => {
    const { state } = build();
    await state.refresh();

    expect(state.agentSmsUrl("agent_1")).toBe("sms:+15550100");
    expect(state.state().cloudAgents[0].canMessage).toBe(true);

    const { state: unresolved } = build({
      listAgents: async () => [agent({ line: null })],
    });
    await unresolved.refresh();

    expect(unresolved.agentSmsUrl("agent_1")).toBeNull();
    expect(unresolved.state().cloudAgents[0].canMessage).toBe(false);
  });

  it("keeps a resolved line without an E.164 number non-messageable", async () => {
    const { state } = build({
      listAgents: async () => [agent({ line: { uid: "lin_willow", displayName: "Willow", number: "not-a-number" } })],
      listChats: async () => [chat({ recipients: { line: "not-a-number", members: [] } })],
      listLines: async () => [{
        uid: "lin_willow",
        agentUid: null, displayName: "Willow",
        number: "",
      }],
    });

    await state.refresh();

    expect(state.state().cloudAgents[0]).toMatchObject({
      line: { uid: "lin_willow", label: "Willow · not-a-number" },
      canMessage: false,
    });
    expect(state.agentSmsUrl("agent_1")).toBeNull();
  });

  it("filters an agent's read-only threads by its home chat's line", async () => {
    const { state } = build({
      listChats: async () => [
        chat({ uid: "cht_one", lineUid: "lin_willow", label: "one" }),
        chat({ uid: "cht_two", lineUid: "lin_ash", label: "two", recipients: { line: "+15550200", members: [] } }),
        chat({ uid: "cht_three", lineUid: "lin_willow", label: "three" }),
      ],
    });

    await state.refresh();

    expect(state.state().cloudAgents[0]).toMatchObject({
      line: { uid: "lin_willow", label: "Willow · +15550100" },
      threads: [
        { uid: "cht_one", label: "Willow · You · Nina" },
        { uid: "cht_three", label: "Willow · You · Nina" },
      ],
    });
  });

  it("shows no line and no threads when the home chat is absent", async () => {
    const { state } = build({
      listAgents: async () => [agent({ line: null })],
      listChats: async () => [
        chat({ uid: "cht_one" }),
        chat({
          uid: "cht_two",
          lineUid: "lin_ash",
          recipients: { line: "+15550200", members: [] },
          people: [],
        }),
      ],
    });

    await state.refresh();

    expect(state.state().cloudAgents[0]).toMatchObject({
      line: null,
      threads: [],
    });
  });

  it("keeps the roster and reports chat-list failure independently", async () => {
    const { state } = build({
      listChats: async () => {
        throw new PlowApiError("http", "Plow returned 503.", 503);
      },
    });

    await state.refresh();

    expect(state.state().cloudAgents).toHaveLength(1);
    expect(state.state().cloudAgents[0].threads).toEqual([]);
    expect(state.state().cloudAgentsError).toBeNull();
    expect(state.state().cloudChatsError).toBe("Plow returned 503.");
    expect(state.state().cloudChatsLoaded).toBe(false);
  });

  it("drops a roster read that lands after sign-out", async () => {
    const listing = deferred<CloudAgentResource[]>();
    const { state } = build({ listAgents: async () => listing.promise });

    const refresh = state.refresh();
    state.signedOut();
    listing.resolve([agent()]);
    await refresh;

    expect(state.state().cloudAgents).toEqual([]);
  });

  it("waits for a newer chat read when its own read is superseded", async () => {
    const first = deferred<CloudChatOption[]>();
    const second = deferred<CloudChatOption[]>();
    let reads = 0;
    const { state } = build({
      listChats: async () => (reads++ === 0 ? first.promise : second.promise),
    });

    const olderRefresh = state.refresh();
    await vi.waitFor(() => expect(reads).toBe(1));
    const newerRefresh = state.refresh();
    await vi.waitFor(() => expect(reads).toBe(2));
    let olderSettled = false;
    void olderRefresh.then(() => { olderSettled = true; });

    first.resolve([]);
    await Promise.resolve();
    expect(olderSettled).toBe(false);

    second.resolve([chat(), chat({ uid: "cht_new" })]);
    await Promise.all([olderRefresh, newerRefresh]);
    expect(state.state().cloudAgents[0].threads.map(({ uid }) => uid)).toEqual([
      "cht_one",
      "cht_new",
    ]);
  });

  it("keeps existing rows when a later agent-list refresh fails", async () => {
    let fail = false;
    const { state } = build({
      listAgents: async () => {
        if (fail) throw new Error("offline");
        return [agent()];
      },
    });
    await state.refresh();

    fail = true;
    await state.refresh();

    expect(state.state().cloudAgents).toHaveLength(1);
    expect(state.state().cloudAgentsError).toBe("Something went wrong. Try again.");
  });

  it("keeps chats usable when line display metadata fails", async () => {
    const { state } = build({
      listLines: async () => {
        throw new PlowApiError("http", "Plow returned 503.", 503);
      },
    });

    await state.refresh();

    expect(state.state().cloudAgents[0].line).toEqual({ uid: "lin_willow", label: "Willow · +15550100" });
    expect(state.state().cloudAgents[0].threads).toEqual([
      { uid: "cht_one", label: "+15550100 · You · Nina" },
    ]);
  });


});

describe("CloudAgentState available move destinations", () => {
  // The server will only claim an agent on a line the account holds an ACTIVE
  // one-to-one thread with itself on. Everything below is that rule, read off
  // the chats already loaded — `lin_ash` carries two threads of the shape under
  // test so a line that does qualify is still offered exactly once.
  it.each([
    ["an active one-to-one thread with the owner", { status: "active", memberCount: 1, hasOwnerMember: true }, ["lin_ash"]],
    ["a thread the provider has not confirmed", { status: "pending", memberCount: 1, hasOwnerMember: true }, []],
    ["a group thread", { status: "active", memberCount: 2, hasOwnerMember: true }, []],
    ["a one-to-one thread that is not the owner's", { status: "active", memberCount: 1, hasOwnerMember: false }, []],
    ["no thread at all", null, []],
  ] as const)("offers a free line on %s", async (_label, shape, offered) => {
    const { state } = build({
      listAgents: async () => [agent({ line: { uid: "lin_willow", displayName: "Willow", number: "+15550100" } })],
      listChats: async () => [
        chat({ uid: "cht_willow", lineUid: "lin_willow" }),
        ...(shape === null ? [] : [
          homeChat({ uid: "cht_ash_one", lineUid: "lin_ash", recipients: { line: "+15550200", members: [] }, ...shape }),
          homeChat({ uid: "cht_ash_two", lineUid: "lin_ash", recipients: { line: "+15550200", members: [] }, ...shape }),
        ]),
      ],
      listLines: async () => [
        // Occupied, and never offered whatever its threads look like.
        { uid: "lin_willow", agentUid: "agent_1", displayName: "Willow", number: "+15550100" },
        { uid: "lin_ash", agentUid: null, displayName: "Ash", number: "+15550200" },
        // A pool number this account has never held: no threads, never offered.
        { uid: "lin_elm", agentUid: null, displayName: "Elm", number: "+15550300" },
      ],
    });

    await state.refresh();

    expect(state.state().cloudFreeLines.map((line) => line.uid)).toEqual(offered);
  });

  it("offers nothing while the chat list is unknown", async () => {
    const { state } = build({
      listAgents: async () => [],
      listChats: async () => {
        throw new PlowApiError("http", "Plow returned 503.", 503);
      },
      listLines: async () => [
        { uid: "lin_willow", agentUid: null, displayName: "Willow", number: "+15550100" },
        { uid: "lin_ash", agentUid: "agent_1", displayName: "Ash", number: "+15550200" },
      ],
    });

    await state.refresh();

    // Ownership is unknown, and the whole service pool is the wrong guess to
    // make about it — every line here would fail at create.
    expect(state.state().cloudChatsLoaded).toBe(false);
    expect(state.state().cloudFreeLines).toEqual([]);
  });
});



describe("CloudAgentState deletion", () => {
  it("deletes by agent id and refreshes the roster", async () => {
    let listed = true;
    const { state, calls } = build({
      listAgents: async () => listed ? [agent()] : [],
      remove: async () => { listed = false; },
    });
    await state.refresh();

    await state.remove("agent_1");

    expect(calls).toContain("delete:agent_1");
    expect(state.state().cloudAgents).toEqual([]);
  });

  it("retries a server-reported teardown without showing a live row", async () => {
    const removed = vi.fn(async () => {});
    const { state } = build({
      listAgents: async () => [agent({ status: "teardown" })],
      remove: removed,
    });

    await state.refresh();
    await vi.waitFor(() => expect(removed).toHaveBeenCalledWith("agent_1"));
  });

  it("keeps the row and reports a delete failure", async () => {
    const { state } = build({
      remove: async () => {
        throw new PlowApiError("http", "Plow returned 503.", 503);
      },
    });
    await state.refresh();

    await state.remove("agent_1");

    expect(state.state().cloudAgents).toHaveLength(1);
    expect(state.state().cloudActionError).toBe("Plow returned 503.");
  });

  it("does not overlap teardown retries for the same agent", async () => {
    const deleting = deferred<void>();
    const removed = vi.fn(async () => deleting.promise);
    const { state } = build({
      listAgents: async () => [agent({ status: "teardown" })],
      remove: removed,
    });

    await state.refresh();
    await vi.waitFor(() => expect(removed).toHaveBeenCalledTimes(1));
    const secondRefresh = state.refresh();
    await Promise.resolve();
    expect(removed).toHaveBeenCalledTimes(1);

    deleting.resolve();
    await secondRefresh;
    await vi.waitFor(() => expect(state.state().cloudAgents).toEqual([]));
  });
});

describe("CloudChatsClient", () => {
  const clientFor = (body: unknown) => new CloudChatsClient(new PlowApi(
    "https://api.plow.co",
    async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ));

  it("extracts a chat's line uid from the agent participant", async () => {
    const rows = await clientFor({
      data: [{
        uid: "cht_one",
        participants: [
          { type: "member", agent_uid: null, provider_key: "+15550111", role: "owner" },
          { type: "agent", line: { uid: "lin_willow", agent_uid: null, provider_key: "+15550100" } },
        ],
      }],
    }).list(CREDENTIAL);

    expect(rows).toMatchObject([{
      uid: "cht_one",
      lineUid: "lin_willow",
      recipients: { line: "+15550100", members: ["+15550111"] },
    }]);
  });

  it("drops a row whose line uid echoes the credential", async () => {
    const rows = await clientFor({
      data: [{
        uid: "cht_one",
        participants: [{
          type: "agent",
          line: { uid: `lin_${CREDENTIAL}`, agent_uid: null, provider_key: "+15550100" },
        }],
      }],
    }).list(CREDENTIAL);

    expect(rows).toEqual([]);
  });

  it("turns a credential refusal into fixed reactivation copy", async () => {
    const client = new CloudChatsClient(new PlowApi(
      "https://api.plow.co",
      async () => new Response(JSON.stringify({ detail: CREDENTIAL }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    ));

    await expect(client.list(CREDENTIAL)).rejects.toMatchObject({
      kind: "forbidden",
      message: "This Mac cannot list chats yet. Try re-activating it, then try again.",
    });
  });
});

describe("Plow line display metadata", () => {
  it("parses names and numbers without requiring a display name", async () => {
    const client = new CloudLinesClient(new PlowApi(
      "https://api.plow.co",
      async () => new Response(JSON.stringify({
        data: [
          { uid: "lin_1", agent_uid: "agent_1", provider_key: "+15550100", display_name: "Willow" },
          { uid: "lin_2", agent_uid: null, provider_key: "+15550200", display_name: null },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    ));

    await expect(client.list(CREDENTIAL)).resolves.toEqual([
      { uid: "lin_1", agentUid: "agent_1", displayName: "Willow", number: "+15550100" },
      { uid: "lin_2", agentUid: null, displayName: null, number: "+15550200" },
    ]);
  });

  it("drops malformed or credential-bearing rows", async () => {
    const client = new CloudLinesClient(new PlowApi(
      "https://api.plow.co",
      async () => new Response(JSON.stringify({
        data: [
          { agent_uid: null, provider_key: "not-a-number", display_name: "Bad" },
          { uid: "lin_credential_name", agent_uid: null, provider_key: "+15550100", display_name: CREDENTIAL },
          { uid: `lin_${CREDENTIAL}`, agent_uid: null, provider_key: "+15550150", display_name: "Unsafe" },
          { uid: "lin_ash", agent_uid: null, provider_key: "+15550200", display_name: "Ash" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    ));

    await expect(client.list(CREDENTIAL)).resolves.toEqual([
      { uid: "lin_credential_name", agentUid: null, displayName: null, number: "+15550100" },
      { uid: "lin_ash", agentUid: null, displayName: "Ash", number: "+15550200" },
    ]);
  });
});

describe("CloudAgentState text-to-start", () => {
  it("uses the selected provider's phrase, escaping message text", async () => {
    const { state } = build({ listProviders: async () => [
      { id: "one", name: "One", phrase: "Start One" },
      { id: "two", name: "Two", phrase: "Start Two & café?" },
      { id: "self_hosted", name: "Self-hosted", phrase: null },
    ] });
    expect(state.newAgentSmsUrl("two")).toBeNull();
    await state.refresh();
    expect(state.newAgentSmsUrl("two")).toBe("sms:+15551234567?&body=Start%20Two%20%26%20caf%C3%A9%3F");
    expect(state.newAgentSmsUrl("one")).toBe("sms:+15551234567?&body=Start%20One");
    expect(state.newAgentSmsUrl("unknown")).toBeNull();
    expect(state.state().cloudProviders?.map((p) => p.id)).toEqual(["one", "two"]);
    state.signedOut();
    expect(state.newAgentSmsUrl("two")).toBeNull();
  });

  it("does not use a stale catalog after a failed refresh", async () => {
    let fail = false;
    const { state } = build({ listProviders: async () => {
      if (fail) throw new Error("unavailable");
      return [{ id: "one", name: "One", phrase: "Start One" }];
    } });
    await state.refresh();
    fail = true;
    await state.refresh();
    expect(state.newAgentSmsUrl("one")).toBeNull();
  });

  it("moves an existing agent without creating or activating", async () => {
    const { state, calls } = build({ changeAgentLine: async () => agent({
      line: { uid: "lin_ash", displayName: "Ash", number: "+15550200" },
    }) });
    await state.refresh();
    expect(await state.changeLine({ agentId: "agent_1", lineUid: "lin_ash" })).toBe("agent_1");
    expect(state.state().cloudAgents[0].line?.uid).toBe("lin_ash");
    expect(calls).toContain("changeLine:agent_1:lin_ash");
  });

  it("reports a failed line move without losing the agent", async () => {
    const { state } = build({ changeAgentLine: async () => { throw new PlowApiError("http", "Move refused"); } });
    await state.refresh();
    expect(await state.changeLine({ agentId: "agent_1", lineUid: "lin_ash" })).toBeNull();
    expect(state.state().cloudActionError).toBe("Move refused");
    expect(state.state().cloudAgents[0].line?.uid).toBe("lin_willow");
  });

  it("polls an agent discovered provisioning until ready", async () => {
    const running = deferred<CloudAgentResource>();
    let current = agent({ status: "provisioning" });
    const { state, calls } = build({
      listAgents: async () => [current],
      pollAgent: async (_receipt, transition) => {
        current = await running.promise;
        await transition?.(current);
        return current;
      },
    });
    await state.refresh();
    expect(state.state().cloudAgents[0].status).toBe("provisioning");
    running.resolve(agent());
    await vi.waitFor(() => expect(state.state().cloudAgents[0].status).toBe("running"));
    expect(calls.filter((call) => call === "poll:agent_1")).toHaveLength(1);
  });
});

describe("CloudAgentState deploy catalog", () => {
  const LIFE = { blurb: "Runs a household.", builder: "Sam", users: 16, successRate: 88, verified: true, rank: 0, logo: null };

  it.each([
    ["describes agents once the Index answers", (index: Deferred<AgentIndex>) => index.resolve({ "exe:life": LIFE }), { "exe:life": LIFE }],
    ["keeps the provider list when the Index fails", (index: Deferred<AgentIndex>) => index.reject(new Error("offline")), {}],
  ] as const)("%s, without holding up the roster", async (_case, settle, expected) => {
    const index = deferred<AgentIndex>();
    const onChange = vi.fn();
    const { state } = build({ agentIndex: () => index.promise, onChange });
    await state.refresh();
    expect(state.state().cloudAgents).toHaveLength(1);
    expect(state.state().cloudProviders).toHaveLength(1);
    onChange.mockClear();
    settle(index);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(state.state().cloudAgentIndex).toEqual(expected);
    expect(state.state().cloudProvidersError).toBeNull();
  });
});

describe("CloudAgentState waiting for a deployed agent", () => {
  const HERMES = "exe:hermes"; // agent()'s provider

  function withArrival() {
    let listed = [agent()];
    const built = build({
      listAgents: async () => listed,
      // Settle like the real poll does, or pollToTerminal's refresh re-polls forever.
      pollAgent: async (receipt, transition) => {
        const settled = { ...receipt, status: "running" as const };
        listed = listed.map((row) => (row.agentId === settled.agentId ? settled : row));
        await transition?.(settled);
        return settled;
      },
    });
    const arrive = (provider = HERMES) => {
      listed = [agent(), agent({ agentId: "agent_new", name: "New", provider, status: "provisioning" })];
    };
    return { ...built, arrive };
  }

  it.each([
    ["the deployed provider's new agent", HERMES, "agent_new"],
    // An earlier, abandoned deploy landing late must not end this one.
    ["nothing for another provider's new agent", "exe:life", null],
  ])("resolves with %s", async (_case, provider, expected) => {
    const { state, arrive } = withArrival();
    await state.refresh();
    const waited = state.awaitNewAgent(HERMES, { intervalMs: 5, timeoutMs: 60 });
    arrive(provider);
    expect(await waited).toBe(expected);
  });

  it("resolves null when nothing appears before the timeout", async () => {
    const { state } = withArrival();
    await state.refresh();
    expect(await state.awaitNewAgent(HERMES, { intervalMs: 5, timeoutMs: 30 })).toBeNull();
  });

  it("resolves as soon as any refresh sees the new agent", async () => {
    const { state, arrive } = withArrival();
    await state.refresh();
    const waited = state.awaitNewAgent(HERMES, { intervalMs: 60_000, timeoutMs: 120_000 });
    arrive();
    await state.refresh();
    expect(await waited).toBe("agent_new");
  });

  it.each([
    ["a sign-out", (state: CloudAgentState) => state.signedOut()],
    ["a newer wait", (state: CloudAgentState) => { void state.awaitNewAgent(HERMES, { intervalMs: 60_000, timeoutMs: 120_000 }); }],
  ])("gives up with null on %s", async (_case, interrupt) => {
    const { state } = withArrival();
    await state.refresh();
    const waited = state.awaitNewAgent(HERMES, { intervalMs: 60_000, timeoutMs: 120_000 });
    interrupt(state);
    expect(await waited).toBeNull();
    state.signedOut(); // ends the newer wait, so no timer outlives the test
  });

  it("does not pile up re-reads when the agent list is slow", async () => {
    const heldOpen = deferred<CloudAgentResource[]>();
    let agentListImpl = async () => [agent()];
    const { state, calls } = build({
      listAgents: async () => agentListImpl(),
    });

    await state.refresh();
    agentListImpl = async () => heldOpen.promise;
    const waited = state.awaitNewAgent(HERMES, { intervalMs: 5, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 60));

    // Measure post-release burst: old code queues ~12 ticks behind the held read.
    const before = calls.filter((c) => c === "listAgents").length;
    agentListImpl = async () => [agent()];
    heldOpen.resolve([agent()]);
    await new Promise((r) => setTimeout(r, 0)); // Flush macrotask; queued thunks drain before it.

    const burstSize = calls.filter((c) => c === "listAgents").length - before;
    expect(burstSize).toBeLessThanOrEqual(1);

    state.signedOut();
    expect(await waited).toBeNull();
  });
});
