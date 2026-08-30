import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CloudAgentState,
  CloudAgentsApi,
  CloudChatOption,
  CloudChatsClient,
  CloudLinesClient,
} from "../src/cloudAgentState.js";
import { CloudAgentResource } from "../src/cloudAgents.js";
import { PlowApi, PlowApiError } from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";
import { deferred } from "./deferred.js";

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
    lineUid: "lin_willow",
    chatUids: ["line:lin_willow"],
    url: null,
    provider: "exe:hermes",
    name: "Kitchen",
    status: "running",
    failureCode: null,
    failureReason: null,
    createdAt: "2026-08-24T18:02:11Z",
    sessionId: null,
    ...overrides,
  };
}

function chat(overrides: Partial<CloudChatOption> = {}): CloudChatOption {
  return {
    uid: "cht_one",
    lineUid: "lin_willow",
    label: "Willow · You · Nina",
    recipients: { line: "+15550100", members: ["+15550111", "+15550122"] },
    people: [
      { number: "+15550111", name: null, isOwner: true },
      { number: "+15550122", name: "Nina", isOwner: false },
    ],
    ...overrides,
  };
}

function build(options: {
  listAgents?: () => Promise<CloudAgentResource[]>;
  listChats?: () => Promise<CloudChatOption[]>;
  listLines?: () => Promise<Array<{ displayName: string | null; number: string }>>;
  remove?: (agentId: string) => Promise<void>;
  onChange?: () => void;
} = {}) {
  const calls: string[] = [];
  const agents: CloudAgentsApi = {
    async list() {
      calls.push("listAgents");
      return options.listAgents ? options.listAgents() : [agent()];
    },
    async delete(_credential, agentId) {
      calls.push(`delete:${agentId}`);
      await options.remove?.(agentId);
    },
  };
  const state = new CloudAgentState({
    home: tempHome(),
    agents,
    chats: {
      async list() {
        calls.push("listChats");
        return options.listChats ? options.listChats() : [chat()];
      },
    },
    lines: {
      async list() {
        calls.push("listLines");
        return options.listLines
          ? options.listLines()
          : [{ displayName: "Willow", number: "+15550100" }];
      },
    },
    onChange: options.onChange,
  });
  return { state, calls };
}

describe("CloudAgentState line and thread display", () => {
  it("starts with an unknown account view", () => {
    const { state, calls } = build();

    expect(calls).toEqual([]);
    expect(state.state()).toEqual({
      cloudAgents: [],
      cloudAgentsError: null,
      cloudChatsError: null,
      cloudChatsNeedReactivation: false,
      cloudActionError: null,
      cloudChats: [],
      cloudChatsLoaded: false,
    });
  });

  it("filters a current agent's read-only threads by line uid", async () => {
    const { state } = build({
      listChats: async () => [
        chat({ uid: "cht_one", lineUid: "lin_willow", label: "one" }),
        chat({ uid: "cht_two", lineUid: "lin_ash", label: "two", recipients: { line: "+15550200", members: [] } }),
        chat({ uid: "cht_three", lineUid: "lin_willow", label: "three" }),
      ],
    });

    await state.refresh();

    expect(state.state().cloudAgents[0]).toMatchObject({
      lineUid: "lin_willow",
      threads: [
        { uid: "cht_one", label: "Willow · You · Nina" },
        { uid: "cht_three", label: "Willow · You · Nina" },
      ],
    });
    expect(state.state().cloudChats.map(({ uid, lineUid }) => ({ uid, lineUid }))).toEqual([
      { uid: "cht_one", lineUid: "lin_willow" },
      { uid: "cht_two", lineUid: "lin_ash" },
      { uid: "cht_three", lineUid: "lin_willow" },
    ]);
  });

  it("lists only a legacy agent's fixed chats, with resolved labels", async () => {
    const { state } = build({
      listAgents: async () => [agent({ lineUid: null, chatUids: ["cht_two", "cht_missing"] })],
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
      lineUid: null,
      threads: [
        { uid: "cht_two", label: "+15550200" },
        { uid: "cht_missing", label: "cht_missing" },
      ],
    });
  });

  it("marshals a finished, formatted line label and uses the line name in thread labels", async () => {
    const { state } = build({
      listChats: async () => [chat({
        recipients: { line: "+14155550142", members: ["+15550111", "+15550122"] },
      })],
      listLines: async () => [{ displayName: "Willow", number: "+14155550142" }],
    });

    await state.refresh();

    expect(state.state().cloudChats[0]).toEqual({
      uid: "cht_one",
      lineUid: "lin_willow",
      lineLabel: "Willow · +1 415-555-0142",
    });
    expect(state.state().cloudAgents[0].threads).toEqual([
      { uid: "cht_one", label: "Willow · You · Nina" },
    ]);
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

    second.resolve([chat({ uid: "cht_new" })]);
    await Promise.all([olderRefresh, newerRefresh]);
    expect(state.state().cloudChats.map(({ uid }) => uid)).toEqual(["cht_new"]);
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

    expect(state.state().cloudChats).toHaveLength(1);
    expect(state.state().cloudChats[0]).toEqual({
      uid: "cht_one",
      lineUid: "lin_willow",
      lineLabel: "+15550100",
    });
    expect(state.state().cloudAgents[0].threads).toEqual([
      { uid: "cht_one", label: "+15550100 · You · Nina" },
    ]);
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
          { type: "member", provider_key: "+15550111", role: "owner" },
          { type: "agent", line: { uid: "lin_willow", provider_key: "+15550100" } },
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
          line: { uid: `lin_${CREDENTIAL}`, provider_key: "+15550100" },
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
          { uid: "lin_1", provider_key: "+15550100", display_name: "Willow" },
          { uid: "lin_2", provider_key: "+15550200", display_name: null },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    ));

    await expect(client.list(CREDENTIAL)).resolves.toEqual([
      { displayName: "Willow", number: "+15550100" },
      { displayName: null, number: "+15550200" },
    ]);
  });

  it("drops malformed or credential-bearing rows", async () => {
    const client = new CloudLinesClient(new PlowApi(
      "https://api.plow.co",
      async () => new Response(JSON.stringify({
        data: [
          { provider_key: "not-a-number", display_name: "Bad" },
          { provider_key: "+15550100", display_name: CREDENTIAL },
          { provider_key: "+15550200", display_name: "Ash" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    ));

    await expect(client.list(CREDENTIAL)).resolves.toEqual([
      { displayName: null, number: "+15550100" },
      { displayName: "Ash", number: "+15550200" },
    ]);
  });
});
