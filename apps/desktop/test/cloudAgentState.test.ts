/**
 * The Agents tab's cloud half: what the renderer is handed, and what the four
 * mutations do to it.
 *
 * Two properties are the point of this file. Nothing credential-shaped may
 * reach the marshalled state — no device credential, no `session_id` — and
 * every piece of local state hangs off `agent_id`, which survives the
 * credential rotation a cloud agent's session undergoes by design.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CloudAgentState,
  CloudAgentsApi,
  CloudChatOption,
  CloudChatsApi,
  CloudChatsClient,
} from "../src/cloudAgentState.js";
import { CloudAgentResource, CloudAgentsClient } from "../src/cloudAgents.js";
import { PlowApiError, REQUEST_TIMEOUT_MS } from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";

const CREDENTIAL = "plow_sk_device_do_not_leak";
const SESSION = "session_rotates_and_is_never_the_identity";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempHome(credential = CREDENTIAL): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-cloud-state-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = loadSettings(dir);
  settings.relayCredential = credential;
  saveSettings(dir, settings);
  return dir;
}

/**
 * `status` is widened to a string on purpose: the shipped enum is
 * `provisioning | running | teardown`, and the client's union is catching up.
 * Tests speak the server's language, not the draft's.
 */
function agent(
  overrides: Partial<Omit<CloudAgentResource, "status">> & { status?: string } = {},
): CloudAgentResource {
  return {
    agentId: "agent_1",
    chatUid: "cht_1",
    url: "https://agent.example/internal",
    provider: "exe:hermes",
    name: "Kitchen agent",
    status: "running",
    failureReason: null,
    createdAt: "2026-08-24T18:02:11Z",
    sessionId: SESSION,
    ...overrides,
  } as CloudAgentResource;
}

const CHATS: CloudChatOption[] = [{ uid: "cht_1", label: "+15550100 · Ada" }];

/** Let every already-scheduled continuation run — a cancelled poll rejects a
 * turn after the call that cancelled it returns. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A deferred, so a test can hold a poll open and look at the screen. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Fakes {
  agents: CloudAgentsApi & {
    calls: string[];
    created: Array<{ chatUid: string; name?: string; provider?: string | null }>;
    deleted: string[];
  };
  chats: CloudChatsApi;
}

function fakes(opts: {
  list?: () => Promise<CloudAgentResource[]>;
  create?: () => Promise<CloudAgentResource>;
  remove?: (agentId: string) => Promise<void>;
  poll?: (
    receipt: CloudAgentResource,
    onTransition?: (a: CloudAgentResource) => void | Promise<void>,
    signal?: AbortSignal,
  ) => Promise<CloudAgentResource>;
  chats?: () => Promise<CloudChatOption[]>;
} = {}): Fakes {
  const calls: string[] = [];
  const created: Array<{ chatUid: string; name?: string; provider?: string | null }> = [];
  const deleted: string[] = [];
  return {
    agents: {
      calls,
      created,
      deleted,
      async list(credential: string) {
        calls.push("list");
        expect(credential).toBe(CREDENTIAL);
        return opts.list ? opts.list() : [];
      },
      async create(credential: string, request) {
        calls.push("create");
        expect(credential).toBe(CREDENTIAL);
        created.push({
          chatUid: request.chatUid,
          name: request.name,
          provider: request.provider,
        });
        return opts.create ? opts.create() : agent({ status: "provisioning" });
      },
      async delete(credential: string, agentId: string) {
        calls.push("delete");
        expect(credential).toBe(CREDENTIAL);
        deleted.push(agentId);
        if (opts.remove) await opts.remove(agentId);
      },
      async poll(credential: string, receipt, onTransition, signal) {
        calls.push("poll");
        expect(credential).toBe(CREDENTIAL);
        if (opts.poll) return opts.poll(receipt, onTransition, signal);
        await onTransition?.(receipt);
        return receipt;
      },
    },
    chats: {
      async list(credential: string) {
        calls.push("chats");
        expect(credential).toBe(CREDENTIAL);
        return opts.chats ? opts.chats() : CHATS;
      },
    },
  };
}

function build(home: string, f: Fakes): CloudAgentState {
  return new CloudAgentState({ agents: f.agents, chats: f.chats, home });
}

describe("before anything has been read", () => {
  it("claims nothing about the account rather than reporting it empty", async () => {
    const f = fakes({ list: async () => [agent()] });
    const state = build(tempHome(), f);

    // Constructed and not yet refreshed: no request has been made, so there is
    // nothing to say. `cloudChatsLoaded` false is what keeps this from reading
    // as "this account has no chats" — the same distinction a failed list
    // relies on.
    expect(f.agents.calls).toEqual([]);
    expect(state.state()).toEqual({
      cloudAgents: [],
      cloudAgentsError: null,
      cloudChatsError: null,
      cloudActionError: null,
      cloudChats: [],
      cloudChatsLoaded: false,
      cloudSendTo: null,
      cloudAgentSettings: {},
    });
  });
});

describe("refresh", () => {
  it("reports a list failure and keeps the rows already on screen", async () => {
    let fail = false;
    const state = build(
      tempHome(),
      fakes({
        list: async () => {
          if (fail) throw new PlowApiError("http", "Plow returned 500.", 500);
          return [agent()];
        },
      }),
    );
    await state.refresh();

    fail = true;
    await state.refresh();

    const shown = state.state();
    expect(shown.cloudAgentsError).toBe("Plow returned 500.");
    expect(shown.cloudActionError).toBeNull();
    expect(shown.cloudAgents).toHaveLength(1);
  });

  it("keeps simultaneous agent-list and chat-list failures separate", async () => {
    const state = build(
      tempHome(),
      fakes({
        list: async () => {
          throw new PlowApiError("http", "Plow returned 500.", 500);
        },
        chats: async () => {
          throw new PlowApiError("network", "Couldn't reach Plow.", undefined);
        },
      }),
    );

    await state.refresh();

    expect(state.state()).toMatchObject({
      cloudAgentsError: "Plow returned 500.",
      cloudChatsError: "Couldn't reach Plow.",
      cloudChatsLoaded: false,
    });
  });

  it("shows the number this Mac's activation assigned, and nothing else", async () => {
    const home = tempHome();
    const state = build(home, fakes());
    expect(state.state().cloudSendTo).toBeNull();

    const settings = loadSettings(home);
    settings.activationSendTo = "+15550100";
    saveSettings(home, settings);

    expect(state.state().cloudSendTo).toBe("+15550100");
  });

});

describe("a stuck teardown", () => {
  it("asks for the delete again rather than showing a live agent", async () => {
    let deleted = false;
    const f = fakes({
      list: async () => (deleted ? [] : [agent({ status: "teardown" })]),
      remove: async () => {
        deleted = true;
      },
    });
    const state = build(tempHome(), f);

    await state.refresh();
    await settle();

    // `teardown` is a delete that failed provider-side, not a resting state.
    // Nothing else will ask again, so this does.
    expect(f.agents.deleted).toEqual(["agent_1"]);
    expect(state.state().cloudAgents).toEqual([]);
  });

  it("does not pile a second DELETE onto the same agent", async () => {
    const held = deferred<void>();
    const f = fakes({
      list: async () => [agent({ status: "teardown" })],
      remove: async () => held.promise,
    });
    const state = build(tempHome(), f);

    await state.refresh();
    await state.refresh();
    await state.refresh();
    await settle();

    // One attempt at a time: a slow teardown must not collect a DELETE per
    // refresh.
    expect(f.agents.deleted).toEqual(["agent_1"]);
    held.resolve();
  });

  it("tries again on the next refresh when the retry itself fails", async () => {
    let failing = true;
    const f = fakes({
      list: async () => [agent({ status: "teardown" })],
      remove: async () => {
        if (failing) throw new PlowApiError("http", "Plow returned 500.", 500);
      },
    });
    const state = build(tempHome(), f);

    await state.refresh();
    await settle();
    expect(f.agents.deleted).toEqual(["agent_1"]);
    // Nobody clicked anything, so a failure here is not the user's to read.
    expect(state.state().cloudActionError).toBeNull();
    expect(state.state().cloudAgentsError).toBeNull();

    failing = false;
    await state.refresh();
    await settle();

    expect(f.agents.deleted).toEqual(["agent_1", "agent_1"]);
  });

  it("leaves a running agent alone", async () => {
    const f = fakes({ list: async () => [agent({ status: "running" })] });
    const state = build(tempHome(), f);

    await state.refresh();
    await settle();

    expect(f.agents.deleted).toEqual([]);
    expect(state.state().cloudAgents.map((row) => row.status)).toEqual(["running"]);
  });
});

describe("provisioning", () => {
  it("names the provider, because plow's default one 503s in prod", async () => {
    const f = fakes({ create: async () => agent({ status: "provisioning" }) });
    const state = build(tempHome(), f);

    await state.create("cht_1", "Kitchen agent");

    expect(f.agents.created[0].provider).toBe("exe:hermes");
  });

});

describe("removing and retrying", () => {
  it("does not let a listing from before a delete put the row back", async () => {
    const listing = deferred<CloudAgentResource[]>();
    let first = true;
    const f = fakes({
      // Only the first listing is held open — the delete's own refresh must be
      // free to answer, or nothing ever finishes.
      list: async () => {
        if (!first) return [];
        first = false;
        return listing.promise;
      },
      chats: async () => CHATS,
    });
    const state = build(tempHome(), f);

    // A refresh in the air, started before the user clicked Remove…
    const refreshing = state.refresh();
    await state.remove("agent_1");
    // …answering only now, with the agent still in it.
    listing.resolve([agent()]);
    await refreshing;

    expect(f.agents.deleted).toEqual(["agent_1"]);
    // The delete is newer than the listing. A resurrected row reads as a delete
    // that silently failed.
    expect(state.state().cloudAgents).toEqual([]);
  });

  it("carries a toggle made while the retry was in flight", async () => {
    const home = tempHome();
    const creating = deferred<CloudAgentResource>();
    const replacement = agent({ agentId: "agent_2", status: "provisioning" });
    const f = fakes({
      list: async () => [agent({ status: "running" })],
      create: async () => creating.promise,
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { adversarialReview: false });

    const retrying = state.retry("agent_1");
    // The panel is open across both round trips, and the user reaches it.
    await state.apply("agent_1", { adversarialReview: true });
    creating.resolve(replacement);
    await retrying;
    await settle();

    // What they last chose, not what was on disk when Retry was pressed.
    expect(loadSettings(home).cloudAgentSettings).toEqual({
      agent_2: { adversarialReview: true },
    });
  });

  it("carries a toggle made while the REPLACEMENT was being created", async () => {
    const home = tempHome();
    const creating = deferred<CloudAgentResource>();
    let creatingNow: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      creatingNow = resolve;
    });
    const f = fakes({
      list: async () => [agent({ status: "running" })],
      create: async () => {
        creatingNow();
        return creating.promise;
      },
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { adversarialReview: false });

    const retrying = state.retry("agent_1");
    // Not during the delete this time — the second round trip, with the
    // replacement already asked for and not yet answered.
    await entered;
    await state.apply("agent_1", { adversarialReview: true });
    creating.resolve(agent({ agentId: "agent_2", status: "provisioning" }));
    await retrying;
    await settle();

    expect(loadSettings(home).cloudAgentSettings).toEqual({
      agent_2: { adversarialReview: true },
    });
  });

  it("keeps a toggle made on an agent the retry did not touch", async () => {
    const home = tempHome();
    const creating = deferred<CloudAgentResource>();
    const f = fakes({
      list: async () => [
        agent({ status: "running" }),
        agent({ agentId: "agent_other", createdAt: "2026-08-01T00:00:00Z" }),
      ],
      create: async () => creating.promise,
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { adversarialReview: true });

    const retrying = state.retry("agent_1");
    await state.apply("agent_other", { adversarialReview: true });
    creating.resolve(agent({ agentId: "agent_2", status: "provisioning" }));
    await retrying;
    await settle();

    // The move touches two entries — the one it takes from and the one it
    // gives to. Every other agent's settings are none of its business.
    expect(loadSettings(home).cloudAgentSettings).toEqual({
      agent_2: { adversarialReview: true },
      agent_other: { adversarialReview: true },
    });
  });

  it("reports a delete failure without dropping the row", async () => {
    const f = fakes({
      list: async () => [agent()],
      remove: async () => {
        throw new PlowApiError("http", "Plow returned 500.", 500);
      },
    });
    const state = build(tempHome(), f);
    await state.refresh();

    await state.remove("agent_1");

    expect(state.state().cloudActionError).toBe("Plow returned 500.");
    expect(state.state().cloudAgents).toHaveLength(1);
  });
});

describe("the local settings write", () => {
  it("persists the switch and makes NO network call", async () => {
    const home = tempHome();
    const f = fakes({ list: async () => [agent()] });
    const state = build(home, f);
    await state.refresh();
    const before = [...f.agents.calls];

    await state.apply("agent_1", { adversarialReview: true });

    // The switch is this app's own reviewer, not a property of the machine
    // Plow provisioned. Nothing to send, nothing to wait for.
    expect(f.agents.calls).toEqual(before);
    expect(loadSettings(home).cloudAgentSettings.agent_1.adversarialReview).toBe(true);
    expect(state.state().cloudAgentSettings.agent_1.adversarialReview).toBe(true);
  });

  it("keys on the agent id, so a session_id rotation cannot reset it", async () => {
    const home = tempHome();
    let sessionId = "session_before";
    const state = build(home, fakes({ list: async () => [agent({ sessionId })] }));
    await state.refresh();
    await state.apply("agent_1", { adversarialReview: true });

    sessionId = "session_after";
    await state.refresh();

    expect(state.state().cloudAgentSettings.agent_1.adversarialReview).toBe(true);
  });

});

describe("the credential boundary", () => {
  it("marshals no credential and no session id, in any field", async () => {
    const state = build(
      tempHome(),
      fakes({
        list: async () => [agent(), agent({ agentId: "agent_2", status: "provisioning" })],
      }),
    );

    await state.refresh();
    const marshalled = JSON.stringify(state.state());

    expect(marshalled).not.toContain(CREDENTIAL);
    expect(marshalled).not.toContain(SESSION);
    expect(marshalled).not.toContain("sessionId");
    expect(marshalled).not.toContain("session_id");
    // The provider URL is main-process-only too.
    expect(marshalled).not.toContain("agent.example");
  });

  it("puts no credential in an error the renderer will read", async () => {
    const state = build(
      tempHome(),
      fakes({
        list: async () => {
          throw new Error(`fetch failed for Bearer ${CREDENTIAL}`);
        },
      }),
    );

    await state.refresh();

    expect(state.state().cloudAgentsError).toBe("Something went wrong. Try again.");
    expect(JSON.stringify(state.state())).not.toContain(CREDENTIAL);
  });
});

describe("a cancelled provision", () => {
  it("is silent — the real client rejects with an AbortError, not a message", async () => {
    // The real `CloudAgentsClient`, so this asserts against what an abort
    // actually throws (a DOMException named AbortError) rather than a fake's
    // idea of it.
    const parked = deferred<void>();
    let waits = 0;
    const receipt = {
      agent_id: "agent_1",
      chat_uid: "cht_1",
      status: "provisioning",
      created_at: "2026-08-24T18:02:11Z",
    };
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    // Server truth: the agent exists while it is provisioning, and the delete
    // takes it out of the listing.
    let deleted = false;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted = true;
        return json(200, {});
      }
      if (url.endsWith("/v1/agents/cloud")) {
        return init?.method === "POST" ? json(202, receipt) : json(200, { data: deleted ? [] : [receipt] });
      }
      return json(200, receipt);
    };
    // The poll parks in `wait`, so the test can abort it mid-flight.
    const client = new CloudAgentsClient("https://api.plow.co", fetchImpl, async () => {
      waits += 1;
      return parked.promise;
    });
    const home = tempHome();
    const state = new CloudAgentState({
      agents: client,
      chats: { async list() { return CHATS; } },
      home,
    });

    await state.create("cht_1", "Kitchen agent");
    await vi.waitFor(() => expect(waits).toBe(1));
    await state.remove("agent_1");
    parked.resolve();
    await settle();
    expect(state.state().cloudAgents).toEqual([]);

    // The cancel was the user's own click. Nothing to report.
    expect(state.state().cloudActionError).toBeNull();
    expect(state.state().cloudAgentsError).toBeNull();
  });

  it("recovers an agent whose receipt was lost, from the next list", async () => {
    // A create cancelled by a sign-out while the POST was in flight: the agent
    // exists on the account, and this process never recorded its id.
    const posting = deferred<CloudAgentResource>();
    const f = fakes({ create: async () => posting.promise, list: async () => [agent()] });
    const state = build(tempHome(), f);

    const creating = state.create("cht_1", "Kitchen agent");
    state.signedOut();
    posting.resolve(agent({ status: "provisioning" }));
    await creating;
    expect(state.state().cloudAgents).toEqual([]);

    await state.refresh();

    // The listing is authoritative, and it is the only way back to an agent
    // whose id was dropped on the floor.
    expect(state.state().cloudAgents.map((row) => row.agentId)).toEqual(["agent_1"]);
    expect(state.state().cloudActionError).toBeNull();
  });
});

describe("signing out", () => {
  it("clears every row and cancels a provision that is still polling", async () => {
    const held = deferred<CloudAgentResource>();
    let seen: AbortSignal | undefined;
    const f = fakes({
      create: async () => agent({ status: "provisioning" }),
      poll: async (_receipt, _onTransition, signal) => {
        seen = signal;
        return held.promise;
      },
      chats: async () => {
        throw new PlowApiError("forbidden", "Re-activate it to list chats.", 403);
      },
    });
    const state = build(tempHome(), f);
    // A failure belonging to the account that is about to go away: it must not
    // be waiting on screen for whoever signs in next.
    await state.refresh();
    expect(state.state().cloudChatsError).not.toBeNull();
    await state.create("cht_1", "Kitchen agent");

    state.signedOut();

    expect(seen?.aborted).toBe(true);
    expect(state.state()).toMatchObject({
      cloudAgents: [],
      cloudChats: [],
      cloudChatsLoaded: false,
      cloudAgentsError: null,
      cloudChatsError: null,
      cloudActionError: null,
    });
    held.resolve(agent());
  });

  it("drops a list that lands after the sign-out", async () => {
    const held = deferred<CloudAgentResource[]>();
    const state = build(tempHome(), fakes({ list: async () => held.promise }));

    const refreshing = state.refresh();
    state.signedOut();
    held.resolve([agent()]);
    await refreshing;

    expect(state.state().cloudAgents).toEqual([]);
  });
});

describe("a 403 from the real chat endpoint", () => {
  /** What this deployment actually answers `GET /v1/chats` with. */
  const FORBIDDEN_BODY = { detail: "Token does not have access to chats:use" };

  function fetchImpl(chatsStatus: number, agentsStatus = 200) {
    return async (url: string) => {
      if (url.endsWith("/v1/chats")) {
        return new Response(JSON.stringify(chatsStatus === 200 ? { data: [] } : FORBIDDEN_BODY), {
          status: chatsStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: agentsStatus,
        headers: { "content-type": "application/json" },
      });
    };
  }

  function stateWith(fetchLike: (url: string) => Promise<Response>, agents?: CloudAgentsApi) {
    const home = tempHome();
    return {
      home,
      state: new CloudAgentState({
        agents: agents ?? {
          async create() {
            throw new Error("not used");
          },
          async list() {
            return [];
          },
          async delete() {},
          async poll(_credential, receipt) {
            return receipt;
          },
        },
        // The REAL client, so this covers the HTTP status handling the fakes
        // elsewhere in this file stand in for.
        chats: new CloudChatsClient("https://api.plow.co", fetchLike),
        home,
        }),
    };
  }

  it("reaches the screen as a chat-list failure, not as an empty account", async () => {
    const { state } = stateWith(fetchImpl(403));

    await state.refresh();

    const shown = state.state();
    expect(shown.cloudChatsLoaded).toBe(false);
    expect(shown.cloudChatsError).toBe(
      "This Mac cannot list chats yet. Try re-activating it, then try again.",
    );
    expect(shown.cloudChats).toEqual([]);
    // The agent list is fine, and must not be blamed for this.
    expect(shown.cloudAgentsError).toBeNull();
  });

  it("survives the agent list failing at the same time", async () => {
    // The deployment that found this: `GET /v1/chats` 403s while the agent
    // list answers 405. One shared error field meant the agent list's message
    // won and the 403 vanished, so the picker opened empty with no reason.
    const { state } = stateWith(fetchImpl(403), {
      async create() {
        throw new Error("not used");
      },
      async list() {
        throw new PlowApiError("http", "Plow returned 405.", 405);
      },
      async delete() {},
      async poll(_credential, receipt) {
        return receipt;
      },
    });

    await state.refresh();

    expect(state.state()).toMatchObject({
      cloudAgentsError: "Plow returned 405.",
      cloudChatsError:
        "This Mac cannot list chats yet. Try re-activating it, then try again.",
      cloudChatsLoaded: false,
    });
  });

});

describe("CloudChatsClient", () => {
  it("never repeats the credential back in a failure", async () => {
    const fetchImpl = async () => {
      throw new Error(`connect ECONNREFUSED with Bearer ${CREDENTIAL}`);
    };

    await expect(
      new CloudChatsClient("https://api.plow.co", fetchImpl).list(CREDENTIAL),
    ).rejects.toMatchObject({ kind: "network", message: "Couldn't reach Plow." });
  });
});
