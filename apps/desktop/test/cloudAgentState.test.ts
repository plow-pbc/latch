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
import { CloudAgentLineError, CloudAgentResource } from "../src/cloudAgents.js";
import {
  Activation,
  BUILTIN_TARGET_ID,
  KeyInfo,
  LOCAL_TARGET_ID,
  PlowApi,
  PlowApiError,
  ProvisionedActivationRedeem,
} from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";
import { deferred } from "./deferred.js";

const CREDENTIAL = "plow_session_123456789";
const BASE_URL = "https://api.plow.co";

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
    chatUids: ["cht_one"],
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

function activationSession(overrides: Partial<KeyInfo> = {}): KeyInfo {
  return {
    id: 42,
    key_prefix: null,
    name: null,
    scopes: ["*:*"],
    tokens_used: 0,
    is_active: true,
    last_seen_at: null,
    created_at: "2026-08-30T21:59:02.464862",
    agent_id: null,
    chat_uids: [],
    ...overrides,
  };
}

function thisMacSession(): KeyInfo {
  return activationSession({
    id: 1,
    created_at: "2026-08-30T21:58:59.000000",
    last_seen_at: "2026-08-30T21:59:01.000000",
  });
}

function verifiedProvisionedActivation(): ProvisionedActivationRedeem {
  return {
    status: "verified",
    chat: {
      uid: "cht_new",
      status: "active",
      displayName: null,
      line: "+14155550999",
      lineUid: "lin_new",
      participants: [],
      createdAt: "",
    },
    shape: {
      chat: "object",
      participantTypes: ["member", "agent"],
      agentLine: "uid_string",
    },
  };
}

function build(options: {
  listAgents?: () => Promise<CloudAgentResource[]>;
  createAgent?: (request: { lineUid: string; name: string; provider: string }) => Promise<CloudAgentResource>;
  changeAgentLine?: (agentId: string, lineUid: string) => Promise<CloudAgentResource>;
  pollAgent?: (
    receipt: CloudAgentResource,
    transition?: (agent: CloudAgentResource) => void | Promise<void>,
    target?: AgentTarget,
  ) => Promise<CloudAgentResource>;
  listAgentsFor?: (targetId: string) => Promise<CloudAgentResource[]>;
  listChats?: () => Promise<CloudChatOption[]>;
  listLines?: () => Promise<CloudLineOption[]>;
  createActivation?: () => Promise<Activation>;
  redeemActivation?: () => Promise<ProvisionedActivationRedeem>;
  listKeys?: () => Promise<KeyInfo[]>;
  revokeKey?: (id: number) => Promise<void>;
  remove?: (agentId: string) => Promise<void>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  warn?: (message: string) => void;
  onChange?: () => void;
} = {}) {
  const calls: string[] = [];
  const audit: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const agents: CloudAgentsApi = {
    async create(target, request) {
      calls.push(`create@${target.id}:${request.lineUid}:${request.name}:${request.provider}`);
      return options.createAgent
        ? options.createAgent(request)
        : agent({ name: request.name, status: "running" });
    },
    async changeLine(target, agentId, lineUid) {
      calls.push(`changeLine@${target.id}:${agentId}:${lineUid}`);
      return options.changeAgentLine
        ? options.changeAgentLine(agentId, lineUid)
        : agent({ agentId });
    },
    async list(target) {
      calls.push(`listAgents@${target.id}`);
      if (options.listAgentsFor) return options.listAgentsFor(target.id);
      if (target.id !== BUILTIN_TARGET_ID) return [];
      return options.listAgents ? options.listAgents() : [agent()];
    },
    async delete(target, agentId) {
      calls.push(`delete@${target.id}:${agentId}`);
      await options.remove?.(agentId);
    },
    async poll(target, receipt, transition) {
      calls.push(`poll@${target.id}:${receipt.agentId}`);
      if (options.pollAgent) return options.pollAgent(receipt, transition, target);
      await transition?.(receipt);
      return receipt;
    },
  };
  const home = tempHome();
  const state = new CloudAgentState({
    home,
    baseUrl: BASE_URL,
    agents,
    activation: {
      async createProvisionedActivation() {
        calls.push("createActivation");
        return options.createActivation
          ? options.createActivation()
          : { displayCode: "NEW42", activationSecret: "act_secret", sendTo: "+15550100" };
      },
      async redeemProvisionedActivation() {
        calls.push("redeemActivation");
        return options.redeemActivation
          ? options.redeemActivation()
          : { status: "pending" };
      },
      async listApiKeys() {
        calls.push("listKeys");
        return options.listKeys ? options.listKeys() : [];
      },
      async revokeApiKey(_credential, id) {
        calls.push(`revokeKey:${id}`);
        await options.revokeKey?.(id);
        return { status: "revoked", id };
      },
    },
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
          : [{ uid: "lin_willow", displayName: "Willow", number: "+15550100" }];
      },
    },
    recordAudit: (event, fields) => {
      audit.push({ event, fields });
    },
    now: options.now,
    wait: options.wait ?? (() => new Promise<void>(() => {})),
    warn: options.warn,
    onChange: options.onChange,
  });
  return { state, calls, audit, home };
}

describe("CloudAgentState line and thread display", () => {
  it("starts with an unknown account view", () => {
    const { state, calls } = build();

    expect(calls).toEqual([]);
    expect(state.state()).toEqual({
      cloudAgents: [],
      cloudFreeLines: [],
      cloudLineFlow: {
        phase: "idle",
        activation: null,
        message: null,
        completedAgentId: null,
        retryNewLine: false,
        terminal: null,
      },
      cloudAgentsError: null,
      cloudChatsError: null,
      cloudChatsNeedReactivation: false,
      cloudActionError: null,
      cloudChatsLoaded: false,
      cloudTargets: [{ id: BUILTIN_TARGET_ID, baseUrl: BASE_URL, builtin: true }],
    });
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
      listAgents: async () => [agent({ chatUids: ["cht_missing"] })],
    });
    await unresolved.refresh();

    expect(unresolved.agentSmsUrl("agent_1")).toBeNull();
    expect(unresolved.state().cloudAgents[0].canMessage).toBe(false);
  });

  it("keeps a resolved line without an E.164 number non-messageable", async () => {
    const { state } = build({
      listChats: async () => [chat({ recipients: { line: "not-a-number", members: [] } })],
      listLines: async () => [{
        uid: "lin_willow",
        displayName: "Willow",
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
      listAgents: async () => [agent({ chatUids: ["cht_missing", "cht_two"] })],
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

    expect(state.state().cloudAgents[0].line).toEqual({ uid: "lin_willow", label: "+15550100" });
    expect(state.state().cloudAgents[0].threads).toEqual([
      { uid: "cht_one", label: "+15550100 · You · Nina" },
    ]);
  });

  it("keeps the resource provider when agents load before chats resolve the retry line", async () => {
    const chats = deferred<CloudChatOption[]>();
    const requests: Array<{ lineUid: string; name: string; provider: string }> = [];
    const { state } = build({
      listAgents: async () => [agent({ status: "failed", provider: "exe:life" })],
      listChats: async () => chats.promise,
      createAgent: async (request) => {
        requests.push(request);
        return agent({ status: "provisioning", provider: request.provider });
      },
    });

    const refresh = state.refresh();
    await vi.waitFor(() => expect(state.state().cloudAgents).toHaveLength(1));
    expect(state.state().cloudAgents[0].line).toBeNull();
    expect(state.state().cloudAgents[0].canRetry).toBe(false);

    chats.resolve([chat()]);
    await refresh;
    expect(state.state().cloudAgents[0].canRetry).toBe(true);
    await state.retryFailed("agent_1");

    expect(requests).toEqual([{
      lineUid: "lin_willow",
      name: "Kitchen",
      provider: "exe:life",
    targetId: BUILTIN_TARGET_ID,
    }]);
  });

  it("keeps the selected provider when later resources omit it", async () => {
    const requests: Array<{ lineUid: string; name: string; provider: string }> = [];
    let created = false;
    const { state } = build({
      listAgents: async () => created
        ? [agent({ status: "failed", provider: null, chatUids: [] })]
        : [],
      createAgent: async (request) => {
        requests.push(request);
        created = true;
        return agent({ status: "provisioning", provider: null });
      },
    });
    await state.refresh();

    await state.create({
      name: "Kitchen",
      provider: "exe:pirate",
      lineUid: "lin_willow",
    });
    await vi.waitFor(() => expect(state.state().cloudAgents[0]?.status).toBe("failed"));
    expect(state.state().cloudAgents[0]).toMatchObject({ line: null, canRetry: true });
    await state.retryFailed("agent_1");

    expect(requests).toEqual([
      { lineUid: "lin_willow", name: "Kitchen", provider: "exe:pirate", targetId: BUILTIN_TARGET_ID },
      { lineUid: "lin_willow", name: "Kitchen", provider: "exe:pirate", targetId: BUILTIN_TARGET_ID },
    ]);
  });

  it("does not offer retry after relaunch when a failed resource omits its provider", async () => {
    const createAgent = vi.fn(async () => agent());
    const { state } = build({
      listAgents: async () => [agent({ status: "failed", provider: null })],
      createAgent,
    });

    await state.refresh();

    expect(state.state().cloudAgents[0]).toMatchObject({
      status: "failed",
      canRetry: false,
    });
    expect(await state.retryFailed("agent_1")).toBeNull();
    expect(createAgent).not.toHaveBeenCalled();
  });
});

describe("CloudAgentState new agent flow", () => {
  it("derives unique free lines from chats minus agent line uids", async () => {
    const { state } = build({
      listAgents: async () => [agent({ chatUids: ["cht_willow"] })],
      listChats: async () => [
        chat({ uid: "cht_willow", lineUid: "lin_willow" }),
        chat({ uid: "cht_ash_one", lineUid: "lin_ash", recipients: { line: "+15550200", members: [] } }),
        chat({ uid: "cht_ash_two", lineUid: "lin_ash", recipients: { line: "+15550200", members: [] } }),
      ],
      listLines: async () => [
        { uid: "lin_willow", displayName: "Willow", number: "+15550100" },
        { uid: "lin_ash", displayName: "Ash", number: "+15550200" },
      ],
    });

    await state.refresh();

    expect(state.state().cloudFreeLines).toEqual([
      { uid: "lin_ash", label: "Ash · +15550200" },
    ]);
  });

  it("creates directly on a picked free line without activating", async () => {
    const created: Array<{ lineUid: string; name: string; provider: string }> = [];
    const { state, calls } = build({
      listAgents: async () => [],
      createAgent: async (request) => {
        created.push(request);
        return agent({ agentId: "agent_new", name: request.name });
      },
    });
    await state.refresh();

    await state.create({ name: "Garden", provider: "exe:life", lineUid: "lin_willow", targetId: BUILTIN_TARGET_ID });

    expect(created).toEqual([{
      name: "Garden",
      provider: "exe:life",
      lineUid: "lin_willow",
      targetId: BUILTIN_TARGET_ID,
    }]);
    expect(calls).not.toContain("createActivation");
    expect(state.state().cloudAgents).toHaveLength(1);
    expect(state.state().cloudLineFlow.completedAgentId).toBe("agent_new");
  });

  it("always activates for New line, then creates from the verified line uid", async () => {
    const created: Array<{ lineUid: string; name: string; provider: string }> = [];
    const { state, calls } = build({
      listAgents: async () => [],
      wait: async () => {},
      redeemActivation: async () => ({
        status: "verified",
        chat: {
          uid: "cht_new",
          status: "active",
          displayName: null,
          line: "+14155550999",
          lineUid: "lin_new",
          participants: [],
          createdAt: "",
        },
        shape: {
          chat: "object",
          participantTypes: ["member", "agent"],
          agentLine: "uid_string",
        },
      }),
      createAgent: async (request) => {
        created.push(request);
        return agent({
          agentId: "agent_new",
          chatUids: ["cht_new"],
          name: request.name,
          status: "provisioning",
        });
      },
      pollAgent: async () => new Promise<CloudAgentResource>(() => {}),
    });
    await state.refresh();
    expect(state.state().cloudFreeLines).toHaveLength(1);

    await state.create({ name: "Garden", provider: "exe:pirate", lineUid: null });
    await vi.waitFor(() => expect(created).toEqual([{
      name: "Garden",
      provider: "exe:pirate",
      lineUid: "lin_new",
      targetId: BUILTIN_TARGET_ID,
    }]));

    expect(calls).toContain("createActivation");
    expect(state.state().cloudLineFlow.completedAgentId).toBe("agent_new");
    expect(state.state().cloudAgents[0].line).toEqual({
      uid: "lin_new",
      label: "+1 415-555-0999",
    });
  });

  it("revokes the one session created by verification on a non-UTC Mac", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const keys = [
        // Production currently gives this Mac's own row no prefix marker.
        thisMacSession(),
        activationSession(),
      ];
      const { state, calls, audit } = build({
        now: () => Date.parse("2026-08-30T21:59:00Z"),
        wait: async () => {},
        redeemActivation: async () => verifiedProvisionedActivation(),
        listKeys: async () => keys,
        revokeKey: async (id) => {
          keys.find((key) => key.id === id)!.is_active = false;
        },
      });

      await state.create({ name: "Garden", provider: "exe:hermes", lineUid: null });
      await vi.waitFor(() => expect(audit).toHaveLength(1));

      expect(keys[0]).toMatchObject({
        id: 1,
        key_prefix: null,
        last_seen_at: "2026-08-30T21:59:01.000000",
        is_active: true,
      });
      expect(calls.filter((call) => call === "listKeys")).toHaveLength(1);
      expect(calls.filter((call) => call.startsWith("revokeKey:"))).toEqual([
        "revokeKey:42",
      ]);
      expect(audit).toEqual([{
        event: "activation_session_cleanup",
        fields: { outcome: "revoked", keyId: 42 },
      }]);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("completes the visible agent flow before a session lookup finishes", async () => {
    const listing = deferred<KeyInfo[]>();
    const { state, calls, audit } = build({
      now: () => Date.parse("2026-08-30T21:59:00Z"),
      wait: async () => {},
      redeemActivation: async () => verifiedProvisionedActivation(),
      listKeys: async () => listing.promise,
    });

    await state.create({ name: "Garden", provider: "exe:hermes", lineUid: null });
    await vi.waitFor(() => expect(calls).toContain("listKeys"));

    expect(state.state().cloudLineFlow.completedAgentId).toBe("agent_1");
    listing.resolve([]);
    await vi.waitFor(() => expect(audit).toHaveLength(1));
  });

  it.each([
    ["no matching sessions", [], { outcome: "no_match" }],
    ["an agent-owned key", [activationSession({ agent_id: "agent_42" })], { outcome: "no_match" }],
    ["a named key", [activationSession({ name: "Deliberate Admin key" })], { outcome: "no_match" }],
    ["a non-wildcard key", [activationSession({ scopes: ["relay:*"] })], { outcome: "no_match" }],
    ["an already-used key", [activationSession({ last_seen_at: "2026-08-30T21:59:03.000000" })], { outcome: "no_match" }],
    [
      "two matching sessions",
      [activationSession(), activationSession({ id: 43 })],
      { outcome: "ambiguous", candidateCount: 2 },
    ],
  ] satisfies Array<[string, KeyInfo[], Record<string, string | number>]>)(
    "revokes nothing when verification has %s",
    async (_shape, candidates, expectedFields) => {
      const keys = [
        thisMacSession(),
        ...candidates,
      ];
      const { state, calls, audit } = build({
        now: () => Date.parse("2026-08-30T21:59:00Z"),
        wait: async () => {},
        redeemActivation: async () => verifiedProvisionedActivation(),
        listKeys: async () => keys,
      });

      await state.create({ name: "Garden", provider: "exe:hermes", lineUid: null });
      await vi.waitFor(() => expect(audit).toHaveLength(1));

      expect(calls.some((call) => call.startsWith("revokeKey:"))).toBe(false);
      expect(audit).toEqual([{
        event: "activation_session_cleanup",
        fields: expectedFields,
      }]);
    },
  );

  it("leaves the verification session active and audits a failed revoke", async () => {
    const keys = [
      thisMacSession(),
      activationSession(),
    ];
    const { state, calls, audit } = build({
      now: () => Date.parse("2026-08-30T21:59:00Z"),
      wait: async () => {},
      redeemActivation: async () => verifiedProvisionedActivation(),
      listKeys: async () => keys,
      revokeKey: async () => {
        throw new PlowApiError("http", "Plow returned 500.", 500);
      },
    });

    await state.create({ name: "Garden", provider: "exe:hermes", lineUid: null });
    await vi.waitFor(() => expect(audit).toHaveLength(1));

    expect(calls).toContain("revokeKey:42");
    expect(keys.find((key) => key.id === 42)?.is_active).toBe(true);
    expect(audit).toEqual([{
      event: "activation_session_cleanup",
      fields: {
        outcome: "failed",
        stage: "revoke",
        keyId: 42,
        error: "Plow returned 500.",
      },
    }]);
  });

  it("selects an idempotently returned roster agent without duplicating it", async () => {
    const existing = agent({ agentId: "agent_existing" });
    const { state } = build({
      listAgents: async () => [existing],
      createAgent: async () => existing,
    });
    await state.refresh();

    await state.create({ name: "Kitchen", provider: "exe:hermes", lineUid: "lin_willow", targetId: BUILTIN_TARGET_ID });

    expect(state.state().cloudAgents).toHaveLength(1);
    expect(state.state().cloudLineFlow.completedAgentId).toBe("agent_existing");
  });

  it("reports a verified payload with no agent line and logs only its safe shape", async () => {
    const droppedToken = "plow_token_from_redeem_must_disappear";
    const warned: string[] = [];
    const { state, home } = build({
      wait: async () => {},
      warn: (message) => warned.push(message),
      redeemActivation: async () => ({
        status: "verified",
        token: droppedToken,
        chat: {
          uid: "cht_missing_line",
          status: "active",
          displayName: null,
          line: "+15550100",
          lineUid: null,
          participants: [{ providerKey: null, displayName: null, isOwner: true }],
          createdAt: "",
        },
        shape: {
          chat: "object",
          participantTypes: ["member", "agent"],
          agentLine: "uid_missing",
        },
      } as unknown as ProvisionedActivationRedeem),
    });

    await state.create({ name: "Garden", provider: "exe:hermes", lineUid: null });
    await vi.waitFor(() => expect(state.state().cloudLineFlow.phase).toBe("error"));

    expect(state.state().cloudLineFlow).toMatchObject({
      message: "Couldn't read the line for this agent.",
      retryNewLine: true,
    });
    expect(warned).toEqual([
      '[cloud-agent] verified activation missing line uid: {"chat":"object","participantTypes":["member","agent"],"agentLine":"uid_missing"}',
    ]);
    expect(JSON.stringify(state.state())).not.toContain(droppedToken);
    expect(JSON.stringify(loadSettings(home))).not.toContain(droppedToken);
    expect(warned.join("\n")).not.toContain(droppedToken);
  });

  it("cancelling the code screen stops redemption and creates nothing", async () => {
    const tick = deferred<void>();
    const { state, calls } = build({ wait: async () => tick.promise });

    await state.create({ name: "Garden", provider: "exe:hermes", lineUid: null });
    expect(state.state().cloudLineFlow.phase).toBe("waiting");
    expect(state.createSmsUrl()).toBe(
      "sms:+15550100?&body=Plow%20Activate%3A%20NEW42",
    );
    state.cancelLineFlow();
    tick.resolve();
    await Promise.resolve();

    expect(calls).not.toContain("redeemActivation");
    expect(calls.some((call) => call.startsWith("create@plow:"))).toBe(false);
    expect(state.state().cloudLineFlow.phase).toBe("idle");
  });

  it("keeps an uncoded activation 503 retryable instead of guessing pool exhaustion", async () => {
    let attempts = 0;
    const { state } = build({
      createActivation: async () => {
        attempts += 1;
        throw new PlowApiError("provider_unavailable", "server wording may change", 503);
      },
    });

    await state.create({ name: "Garden", provider: "exe:hermes", lineUid: null });

    expect(state.state().cloudLineFlow).toMatchObject({
      phase: "error",
      message: "server wording may change",
      retryNewLine: true,
      terminal: null,
    });
    await state.retryLineFlow();
    expect(attempts).toBe(2);
  });

  it("makes an explicit no-chat-line code terminal without reading its message", async () => {
    const { state } = build({
      createActivation: async () => {
        // Forward-looking fixture: Plow does not emit this code yet.
        throw new PlowApiError(
          "http",
          "untrusted and unrelated wording",
          409,
          "NO_CHAT_LINE_AVAILABLE",
        );
      },
    });

    await state.create({ name: "Garden", provider: "exe:hermes", lineUid: null });

    expect(state.state().cloudLineFlow).toMatchObject({
      phase: "error",
      message: "No numbers are available right now. Try again later.",
      retryNewLine: false,
      terminal: "no_numbers",
    });
  });

  it("shows fixed no-home-chat copy and retries failed rows with the same body", async () => {
    const requests: Array<{ lineUid: string; name: string; provider: string }> = [];
    let fail = true;
    const { state } = build({
      listAgents: async () => [agent({ status: "failed" })],
      createAgent: async (request) => {
        requests.push(request);
        if (fail) {
          fail = false;
          throw new PlowApiError("http", "Text this line once first, then try again.", 409);
        }
        return agent({ status: "provisioning" });
      },
    });
    await state.refresh();

    await state.create({ name: "Kitchen", provider: "exe:hermes", lineUid: "lin_willow", targetId: BUILTIN_TARGET_ID });
    expect(state.state().cloudLineFlow.message).toBe("Text this line once first, then try again.");
    await state.retryFailed("agent_1");

    expect(requests).toEqual([
      { name: "Kitchen", provider: "exe:hermes", lineUid: "lin_willow", targetId: BUILTIN_TARGET_ID },
      { name: "Kitchen", provider: "exe:hermes", lineUid: "lin_willow", targetId: BUILTIN_TARGET_ID },
    ]);
  });
});

describe("CloudAgentState change-line flow", () => {
  it("moves an agent with no home chat to a picked free line without activating", async () => {
    const moved: Array<{ agentId: string; lineUid: string }> = [];
    const { state, calls } = build({
      listAgents: async () => [agent({ chatUids: ["cht_missing"] })],
      listChats: async () => [
        chat({ uid: "cht_willow", lineUid: "lin_willow" }),
        chat({ uid: "cht_ash", lineUid: "lin_ash", recipients: { line: "+15550200", members: [] } }),
      ],
      listLines: async () => [
        { uid: "lin_willow", displayName: "Willow", number: "+15550100" },
        { uid: "lin_ash", displayName: "Ash", number: "+15550200" },
      ],
      changeAgentLine: async (agentId, lineUid) => {
        moved.push({ agentId, lineUid });
        return agent({ agentId, chatUids: ["cht_ash"] });
      },
    });
    await state.refresh();

    await state.changeLine({ agentId: "agent_1", lineUid: "lin_ash" });

    expect(moved).toEqual([{ agentId: "agent_1", lineUid: "lin_ash" }]);
    expect(calls).not.toContain("createActivation");
    expect(state.state().cloudAgents[0]).toMatchObject({
      line: { uid: "lin_ash", label: "Ash · +15550200" },
      threads: [{ uid: "cht_ash" }],
    });
    expect(state.state().cloudLineFlow.completedAgentId).toBe("agent_1");
  });

  it("reuses new-line activation before moving an existing agent", async () => {
    const moved: Array<{ agentId: string; lineUid: string }> = [];
    const { state, calls } = build({
      wait: async () => {},
      redeemActivation: async () => ({
        status: "verified",
        chat: {
          uid: "cht_new",
          status: "active",
          displayName: null,
          line: "+14155550999",
          lineUid: "lin_new",
          participants: [],
          createdAt: "",
        },
        shape: {
          chat: "object",
          participantTypes: ["member", "agent"],
          agentLine: "uid_string",
        },
      }),
      changeAgentLine: async (agentId, lineUid) => {
        moved.push({ agentId, lineUid });
        return agent({ agentId, chatUids: ["cht_new"] });
      },
    });
    await state.refresh();

    await state.changeLine({ agentId: "agent_1", lineUid: null });
    await vi.waitFor(() => expect(moved).toEqual([
      { agentId: "agent_1", lineUid: "lin_new" },
    ]));

    expect(calls).toContain("createActivation");
    expect(calls.some((call) => call.startsWith("create@plow:"))).toBe(false);
    expect(state.state().cloudAgents[0].line).toEqual({
      uid: "lin_new",
      label: "+1 415-555-0999",
    });
    expect(state.state().cloudLineFlow.completedAgentId).toBe("agent_1");
  });

  it("shows no-home-chat copy and keeps the same PUT available to retry", async () => {
    const moved: string[] = [];
    let fail = true;
    const { state } = build({
      changeAgentLine: async (agentId, lineUid) => {
        moved.push(`${agentId}:${lineUid}`);
        if (fail) {
          fail = false;
          throw new CloudAgentLineError(
            "no_home_chat",
            "Text this line once first, then try again.",
          );
        }
        return agent({ agentId, chatUids: ["cht_ash"] });
      },
    });
    await state.refresh();

    await state.changeLine({ agentId: "agent_1", lineUid: "lin_ash" });
    expect(state.state().cloudLineFlow).toMatchObject({
      phase: "error",
      message: "Text this line once first, then try again.",
    });
    await state.retryLineFlow();

    expect(moved).toEqual(["agent_1:lin_ash", "agent_1:lin_ash"]);
    expect(state.state().cloudLineFlow.completedAgentId).toBe("agent_1");
  });

  it("refreshes the picker after another agent claims the chosen line", async () => {
    let lists = 0;
    const { state } = build({
      listAgents: async () => lists++ === 0
        ? [agent()]
        : [agent(), agent({ agentId: "agent_2", chatUids: ["cht_ash"] })],
      listChats: async () => [
        chat(),
        chat({ uid: "cht_ash", lineUid: "lin_ash", recipients: { line: "+15550200", members: [] } }),
      ],
      listLines: async () => [
        { uid: "lin_willow", displayName: "Willow", number: "+15550100" },
        { uid: "lin_ash", displayName: "Ash", number: "+15550200" },
      ],
      changeAgentLine: async () => {
        throw new CloudAgentLineError(
          "line_occupied",
          "Another agent already uses that line.",
        );
      },
    });
    await state.refresh();
    expect(state.state().cloudFreeLines.map((line) => line.uid)).toEqual(["lin_ash"]);

    await state.changeLine({ agentId: "agent_1", lineUid: "lin_ash" });

    expect(state.state().cloudLineFlow).toMatchObject({
      phase: "idle",
      message: "Another agent already uses that line.",
    });
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

    expect(calls).toContain("delete@plow:agent_1");
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
      { uid: "lin_1", displayName: "Willow", number: "+15550100" },
      { uid: "lin_2", displayName: null, number: "+15550200" },
    ]);
  });

  it("drops malformed or credential-bearing rows", async () => {
    const client = new CloudLinesClient(new PlowApi(
      "https://api.plow.co",
      async () => new Response(JSON.stringify({
        data: [
          { provider_key: "not-a-number", display_name: "Bad" },
          { uid: "lin_credential_name", provider_key: "+15550100", display_name: CREDENTIAL },
          { uid: `lin_${CREDENTIAL}`, provider_key: "+15550150", display_name: "Unsafe" },
          { uid: "lin_ash", provider_key: "+15550200", display_name: "Ash" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    ));

    await expect(client.list(CREDENTIAL)).resolves.toEqual([
      { uid: "lin_credential_name", displayName: null, number: "+15550100" },
      { uid: "lin_ash", displayName: "Ash", number: "+15550200" },
    ]);
  });
});

/**
 * The self-hosted host is a SECOND origin with its OWN bearer, and everything
 * here is about the app never confusing the two: which host a call goes to,
 * whose failure it is when one is unreachable, and what the Mac's own Plow
 * credential is not handed to.
 */
describe("CloudAgentState self-hosted target", () => {
  const HOST = "http://192.168.15.12:8765";

  /** Save the host the way `addTarget` does, before the state is built. */
  function withHost(home: string, baseUrl = HOST): void {
    saveSettings(home, {
      ...loadSettings(home),
      agentTarget: { baseUrl, bearer: "serve-token-abc" },
    });
  }

  it("offers the built-in Plow first and never leaks the host's bearer", () => {
    const { state, home } = build();
    withHost(home);

    expect(state.state().cloudTargets).toEqual([
      { id: BUILTIN_TARGET_ID, baseUrl: BASE_URL, builtin: true },
      { id: LOCAL_TARGET_ID, baseUrl: HOST, builtin: false },
    ]);
    expect(JSON.stringify(state.state())).not.toContain("serve-token-abc");
  });

  it("creates on the host as local:docker, and polls the same host", async () => {
    const { state, calls, home } = build();
    withHost(home);
    await state.refresh();
    calls.length = 0;

    await state.create({
      name: "Garden",
      provider: "local:docker",
      lineUid: "lin_willow",
      targetId: LOCAL_TARGET_ID,
    });

    expect(calls).toContain("create@local:lin_willow:Garden:local:docker");
    await vi.waitFor(() => expect(calls).toContain("poll@local:agent_1"));
    // The Mac's Plow credential was NOT what authorised any of it.
    expect(calls.some((call) => call.startsWith("create@plow"))).toBe(false);
  });

  it("refuses to create on a host this Mac does not have", async () => {
    const { state, calls } = build();

    await state.create({
      name: "Garden",
      provider: "local:docker",
      lineUid: "lin_willow",
      targetId: LOCAL_TARGET_ID,
    });

    expect(calls.some((call) => call.startsWith("create@"))).toBe(false);
    expect(state.state().cloudLineFlow.message)
      .toBe("That host is no longer set up on this Mac.");
  });

  it("keeps an unreachable host's rows and names it, without losing Plow's", async () => {
    const { state, home } = build({
      listAgentsFor: async (targetId) => [
        agent(targetId === BUILTIN_TARGET_ID
          ? { agentId: "agent_cloud", name: "Cloud" }
          : { agentId: "agent_local", name: "Local" }),
      ],
    });
    withHost(home);
    await state.refresh();
    expect(state.state().cloudAgents.map((row) => row.agentId).sort())
      .toEqual(["agent_cloud", "agent_local"]);

    // The box went to sleep. Plow is fine.
    const { state: after, home: afterHome } = build({
      listAgentsFor: async (targetId) => {
        if (targetId === BUILTIN_TARGET_ID) return [agent({ agentId: "agent_cloud", name: "Cloud" })];
        throw new PlowApiError("network", `Couldn't reach Plow at ${HOST}.`);
      },
    });
    withHost(afterHome);
    await after.refresh();

    expect(after.state().cloudAgents.map((row) => row.agentId)).toEqual(["agent_cloud"]);
    expect(after.state().cloudAgentsError).toBe(`${HOST}: Couldn't reach Plow at ${HOST}.`);
  });

  // `agent-mgr` answers with the NAME its owner typed, so a local agent CAN be
  // called exactly what a Plow agent_id is called. Keyed on the raw id, the
  // local row overwrote the Plow one and a Plow removal followed it to the
  // self-host — deleting a different machine's agent. Identity is the pair, so
  // each row is removed on its OWN host and neither can divert the other.
  it.each([
    ["the self-hosted one", LOCAL_TARGET_ID, "delete@local:agent_1", "delete@plow:agent_1"],
    ["the Plow one", BUILTIN_TARGET_ID, "delete@plow:agent_1", "delete@local:agent_1"],
  ])("removes %s on its own host when both share an id", async (_which, targetId, expected, other) => {
    const collision = "agent_1";
    const { state, calls, home } = build({
      listAgentsFor: async (host) => [
        agent({ agentId: collision, name: host === BUILTIN_TARGET_ID ? "Cloud" : "Local" }),
      ],
    });
    withHost(home);
    await state.refresh();

    // BOTH survive the merge: neither overwrites the other.
    expect(state.state().cloudAgents.map((row) => `${row.targetId}:${row.name}`).sort())
      .toEqual(["local:Local", "plow:Cloud"]);

    calls.length = 0;
    await state.remove(collision, targetId);

    expect(calls).toContain(expected);
    expect(calls).not.toContain(other);
  });

  it("changes a self-hosted agent's line on its own host", async () => {
    const { state, calls, home } = build({
      listAgentsFor: async (host) =>
        host === BUILTIN_TARGET_ID ? [] : [agent({ agentId: "agent_local" })],
    });
    withHost(home);
    await state.refresh();
    calls.length = 0;

    // The host has to survive INTO the request: `finishLineFlow` rebuilds the
    // key from it, so dropping it sent the PUT to Plow for a local agent.
    await state.changeLine({
      agentId: "agent_local",
      targetId: LOCAL_TARGET_ID,
      lineUid: "lin_ash",
    });

    expect(calls).toContain("changeLine@local:agent_local:lin_ash");
    expect(calls).not.toContain("changeLine@plow:agent_local:lin_ash");
  });

  it.each([
    // Accepted: every address the owner can actually reach agent-mgr at.
    ["a private LAN address", "http://192.168.15.12:8765", "http://192.168.15.12:8765"],
    ["a 10/8 address", "http://10.0.0.5:8765", "http://10.0.0.5:8765"],
    ["a MagicDNS name", "http://slowdown.tail1234.ts.net", "http://slowdown.tail1234.ts.net"],
    ["a bare hostname", "http://slowdown:8765", "http://slowdown:8765"],
    ["an mDNS name", "http://slowdown.local:8765", "http://slowdown.local:8765"],
    ["loopback", "http://127.0.0.1:8765", "http://127.0.0.1:8765"],
    // https anywhere, because the bearer is not on the wire.
    ["https to a public host", "https://agents.example.com", "https://agents.example.com"],
    // Canonicalised: case folded, default port and trailing slash dropped, so
    // one machine cannot become two hosts.
    ["a shouted address", "HTTP://SLOWDOWN.local:80/", "http://slowdown.local"],

    // Refused, because a URL is not a place to keep a secret: each of these
    // would be stored, written to the wire log, and shown to the renderer.
    ["credentials in the URL", "http://user:pass@192.168.15.12:8765", null],
    ["a password alone", "http://:pass@192.168.15.12:8765", null],
    ["a query string", "http://192.168.15.12:8765?token=abc", null],
    ["a fragment", "http://192.168.15.12:8765#abc", null],
    ["a path", "http://192.168.15.12:8765/serve-token-abc", null],
    ["even a one-segment path", "http://192.168.15.12:8765/api", null],
    // Refused, because the bearer would cross a network nobody here controls.
    ["cleartext to a public host", "http://agents.example.com:8765", null],
    ["cleartext to a public IP", "http://93.184.216.34:8765", null],
    // 100.64/10 is the SHARED CGNAT range, not Tailscale's alone. With no
    // tailnet route up it can follow a carrier route instead, and nothing in
    // the URL says which — so the MagicDNS name above is the tailnet path.
    ["cleartext to a raw CGNAT address", "http://100.98.135.12:8765", null],
    // Not addresses at all.
    ["a bare host:port that is not a URL", "192.168.15.12:8765", null],
    ["a scheme that is not http", "slowdown:8765", null],
    ["a local file", "file:///etc/passwd", null],
  ])("%s", (_why, baseUrl, stored) => {
    const { state, home } = build();

    expect(state.addTarget({ baseUrl, bearer: "t" })).toBe(stored !== null);
    expect(loadSettings(home).agentTarget?.baseUrl ?? null).toBe(stored);
    if (stored === null) expect(state.state().cloudActionError).toContain("isn't usable");
  });

  it("refuses a host with no token", () => {
    const { state } = build();

    expect(state.addTarget({ baseUrl: HOST, bearer: " " })).toBe(false);
    expect(state.state().cloudActionError).toBe("Paste the host's AGENT_MGR_SERVE_TOKEN.");
    expect(state.state().cloudTargets).toHaveLength(1);
  });

  it("re-entering the same host rotates its token and keeps its rows", async () => {
    const { state, home } = build({
      listAgentsFor: async (targetId) =>
        targetId === BUILTIN_TARGET_ID ? [] : [agent({ agentId: "agent_local" })],
    });
    withHost(home);
    await state.refresh();

    expect(state.addTarget({ baseUrl: `${HOST}/`, bearer: "rotated-token" })).toBe(true);

    // Same machine, new token: the agents on screen are still that machine's.
    expect(loadSettings(home).agentTarget)
      .toEqual({ baseUrl: HOST, bearer: "rotated-token" });
    expect(state.state().cloudAgents.map((row) => row.agentId)).toEqual(["agent_local"]);
  });

  it("pointing at a different box drops the old box's rows", async () => {
    const { state, home } = build({
      listAgentsFor: async (targetId) =>
        targetId === BUILTIN_TARGET_ID
          ? [agent({ agentId: "agent_cloud" })]
          : [agent({ agentId: "agent_local" })],
    });
    withHost(home);
    await state.refresh();

    state.addTarget({ baseUrl: "http://192.168.15.99:8765", bearer: "t" });

    // `agent_local` is an id on a machine we are no longer pointed at, and
    // agent-mgr ids are NAMES — reconciling it against a different box could
    // put someone else's "demo" under it.
    expect(state.state().cloudAgents.map((row) => row.agentId)).toEqual(["agent_cloud"]);
  });

  it("drops a roster read that lands after the host was replaced", async () => {
    const listing = deferred<CloudAgentResource[]>();
    const { state, home } = build({
      listAgentsFor: async (targetId) =>
        targetId === BUILTIN_TARGET_ID ? [] : listing.promise,
    });
    withHost(home);

    // Host A's read is still in flight when the owner points at host B.
    const inFlight = state.refresh();
    state.addTarget({ baseUrl: "http://192.168.15.99:8765", bearer: "t" });
    listing.resolve([agent({ agentId: "agent_on_host_a" })]);
    await inFlight;

    // `local` is a SLOT, not a machine. Letting A's rows land under it would
    // address the next Delete to a box that never had that agent.
    expect(state.state().cloudAgents).toEqual([]);
  });

  it("a poll picks up a token rotated while its agent is provisioning", async () => {
    const gate = deferred<void>();
    const seen: string[] = [];
    const { state, home } = build({
      listAgentsFor: async () => [],
      // The poll is handed the live target, so reading `bearer` on either side
      // of the gate is exactly what the real loop does once per request.
      pollAgent: async (receipt, transition, target) => {
        seen.push(target!.bearer);
        await gate.promise;
        seen.push(target!.bearer);
        await transition?.(receipt);
        return { ...receipt, status: "running" };
      },
    });
    withHost(home);

    const created = state.create({
      name: "demo",
      provider: "local:docker",
      lineUid: "lin_willow",
      targetId: LOCAL_TARGET_ID,
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    // Same machine, new token. This deliberately keeps the rows, so it must
    // not strand the poll on the credential it started with.
    expect(state.addTarget({ baseUrl: HOST, bearer: "rotated-token" })).toBe(true);
    gate.resolve();
    await created;

    expect(seen).toEqual(["serve-token-abc", "rotated-token"]);
    // And no false "Not authorized" about a credential already replaced.
    expect(state.state().cloudActionError).toBe(null);
  });

  it("forgetting the host drops its rows without deleting its agents", async () => {
    const { state, calls, home } = build({
      listAgentsFor: async (targetId) =>
        targetId === BUILTIN_TARGET_ID
          ? [agent({ agentId: "agent_cloud" })]
          : [agent({ agentId: "agent_local" })],
    });
    withHost(home);
    await state.refresh();
    calls.length = 0;

    state.forgetTarget();

    expect(state.state().cloudAgents.map((row) => row.agentId)).toEqual(["agent_cloud"]);
    expect(state.state().cloudTargets).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("delete@"))).toBe(false);
  });
});
