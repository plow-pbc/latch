/**
 * The Agents tab's cloud half: what the renderer is handed, and what the four
 * mutations do to it.
 *
 * Two properties are the point of this file. Nothing credential-shaped may
 * reach the marshalled state — no device credential, no `session_id` — and
 * every piece of local state hangs off `agent_id`, which survives the
 * credential rotation that a reconfigure performs by design.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CloudAgentState,
  CloudAgentControls,
  cloudAgentScopes,
  tabShowsCloudAgents,
  CloudAgentsApi,
  CloudChatOption,
  CloudChatsApi,
  CloudChatsClient,
  resolveCloudAgentsEnabled,
} from "../src/cloudAgentState.js";
import { CloudAgentResource, CloudAgentsClient } from "../src/cloudAgents.js";
import { PlowApiError, REQUEST_TIMEOUT_MS } from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";

const CREDENTIAL = "plow_sk_device_do_not_leak";
const SESSION = "session_rotates_on_every_reconfigure";

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

function agent(overrides: Partial<CloudAgentResource> = {}): CloudAgentResource {
  return {
    agentId: "agent_1",
    chatUid: "cht_1",
    url: "https://agent.example/internal",
    provider: "exe:hermes",
    name: "Kitchen agent",
    status: "active",
    failureReason: null,
    createdAt: "2026-08-24T18:02:11Z",
    sessionId: SESSION,
    ...overrides,
  };
}

const CHATS: CloudChatOption[] = [{ uid: "cht_1", label: "+15550100 · Ada" }];

/** Let every already-scheduled continuation run — a cancelled poll rejects a
 * turn after the call that cancelled it returns. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The local-only save: the review switch, and neither permission touched. */
const reviewOnly = (adversarialReview: boolean): CloudAgentControls => ({
  relay: null,
  inference: null,
  adversarialReview,
});

/**
 * A poll that behaves like the real client: it publishes the receipt, then the
 * terminal state it settles on. The default fake merely echoes, which never
 * reaches a terminal status.
 */
function settlesOn(final: CloudAgentResource) {
  return async (
    receipt: CloudAgentResource,
    onTransition?: (a: CloudAgentResource) => void | Promise<void>,
  ) => {
    await onTransition?.(receipt);
    await onTransition?.(final);
    return final;
  };
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
    created: Array<{ chatUid: string; name?: string }>;
    deleted: string[];
    reconfigured: Array<{ agentId: string; scopes?: string[]; chatUid?: string }>;
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
  reconfigure?: (agentId: string) => Promise<CloudAgentResource>;
  chats?: () => Promise<CloudChatOption[]>;
} = {}): Fakes {
  const calls: string[] = [];
  const created: Array<{ chatUid: string; name?: string }> = [];
  const deleted: string[] = [];
  const reconfigured: Array<{ agentId: string; scopes?: string[]; chatUid?: string }> = [];
  return {
    agents: {
      calls,
      created,
      deleted,
      reconfigured,
      async list(credential: string) {
        calls.push("list");
        expect(credential).toBe(CREDENTIAL);
        return opts.list ? opts.list() : [];
      },
      async create(credential: string, request) {
        calls.push("create");
        expect(credential).toBe(CREDENTIAL);
        created.push({ chatUid: request.chatUid, name: request.name });
        return opts.create ? opts.create() : agent({ status: "provisioning" });
      },
      async delete(credential: string, agentId: string) {
        calls.push("delete");
        expect(credential).toBe(CREDENTIAL);
        deleted.push(agentId);
        if (opts.remove) await opts.remove(agentId);
      },
      async reconfigure(credential: string, agentId: string, request) {
        calls.push("reconfigure");
        expect(credential).toBe(CREDENTIAL);
        reconfigured.push({ agentId, scopes: request.scopes, chatUid: request.chatUid });
        return opts.reconfigure
          ? opts.reconfigure(agentId)
          : agent({ status: "provisioning", sessionId: "session_after_reconfigure" });
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

function build(home: string, f: Fakes, enabled = true): CloudAgentState {
  return new CloudAgentState({ agents: f.agents, chats: f.chats, home, enabled });
}

describe("the real client", () => {
  it("still satisfies the interface this state polls through", () => {
    // Chunk 2 owns `CloudAgentsClient`; this state owns the slice of it it
    // calls, including the abort signal it hands to `poll`. Structural
    // assignability is what keeps the two from drifting apart silently.
    const api: CloudAgentsApi = new CloudAgentsClient("https://api.plow.co");
    expect(typeof api.poll).toBe("function");
    expect(api.poll.length).toBeGreaterThanOrEqual(4);
  });
});

describe("which tab refreshes the group", () => {
  it("counts renderer boot's stored tab, including the key it used to have", () => {
    // Boot restores the stored tab and selects it directly — no `ui:setTab` —
    // so a predicate that only knew about a click would leave a fresh launch
    // showing an empty group.
    expect(tabShowsCloudAgents("agents")).toBe(true);
    // "connect" is the Agents tab's old key; a home stored on it lands here.
    expect(tabShowsCloudAgents("connect")).toBe(true);
    expect(tabShowsCloudAgents("audit")).toBe(false);
    expect(tabShowsCloudAgents("settings")).toBe(false);
    expect(tabShowsCloudAgents("")).toBe(false);
  });
});

describe("the feature flag", () => {
  it("is off unless this run turns it on", () => {
    expect(resolveCloudAgentsEnabled({})).toBe(false);
    expect(resolveCloudAgentsEnabled({ DOMO_CLOUD_AGENTS: "" })).toBe(false);
    expect(resolveCloudAgentsEnabled({ DOMO_CLOUD_AGENTS: "0" })).toBe(false);
    expect(resolveCloudAgentsEnabled({ DOMO_CLOUD_AGENTS: "1" })).toBe(true);
    expect(resolveCloudAgentsEnabled({ DOMO_CLOUD_AGENTS: " TRUE " })).toBe(true);
  });

  it("keeps the group empty and makes no request while it is off", async () => {
    const f = fakes({ list: async () => [agent()] });
    const state = build(tempHome(), f, false);

    await state.refresh();
    await state.create("cht_1", "Kitchen agent");

    expect(f.agents.calls).toEqual([]);
    expect(state.state()).toMatchObject({
      cloudEnabled: false,
      cloudAgents: [],
      cloudChats: [],
      cloudChatsLoaded: false,
      cloudSendTo: null,
    });
  });
});

describe("refresh", () => {
  it("renders the account's agents with their chat labels and no errors", async () => {
    const state = build(tempHome(), fakes({ list: async () => [agent()] }));

    await state.refresh();

    const shown = state.state();
    expect(shown.cloudAgentsError).toBeNull();
    expect(shown.cloudActionError).toBeNull();
    expect(shown.cloudChats).toEqual(CHATS);
    expect(shown.cloudChatsLoaded).toBe(true);
    expect(shown.cloudAgents).toEqual([
      {
        agentId: "agent_1",
        name: "Kitchen agent",
        chatUid: "cht_1",
        chatLabel: "+15550100 · Ada",
        provider: "exe:hermes",
        status: "active",
        failureReason: null,
        createdAt: "2026-08-24T18:02:11Z",
      },
    ]);
  });

  it("sorts newest first, so a fresh agent is at the top", async () => {
    const state = build(
      tempHome(),
      fakes({
        list: async () => [
          agent({ agentId: "old", createdAt: "2026-08-01T00:00:00Z" }),
          agent({ agentId: "new", createdAt: "2026-08-24T00:00:00Z" }),
        ],
      }),
    );

    await state.refresh();

    expect(state.state().cloudAgents.map((row) => row.agentId)).toEqual(["new", "old"]);
  });

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

  it("treats a 403 on the chat list as a failed list, not an empty account", async () => {
    const state = build(
      tempHome(),
      fakes({
        list: async () => [agent()],
        chats: async () => {
          throw new PlowApiError("forbidden", "Re-activate it to list chats.", 403);
        },
      }),
    );

    await state.refresh();

    const shown = state.state();
    expect(shown.cloudChats).toEqual([]);
    // The pair that keeps "no chats" off the screen: not loaded, and an error
    // that says what to do about it.
    expect(shown.cloudChatsLoaded).toBe(false);
    expect(shown.cloudAgentsError).toBe("Re-activate it to list chats.");
    expect(shown.cloudAgents).toHaveLength(1);
  });

  it("says the chat list loaded even when the account has none", async () => {
    const state = build(tempHome(), fakes({ list: async () => [], chats: async () => [] }));

    await state.refresh();

    // The one shape that may be answered with "you have no chats yet".
    expect(state.state()).toMatchObject({ cloudChats: [], cloudChatsLoaded: true });
  });

  it("does not call a failed chat list an empty account", async () => {
    const state = build(
      tempHome(),
      fakes({
        list: async () => [agent()],
        chats: async () => {
          throw new PlowApiError("network", "Couldn't reach Plow.");
        },
      }),
    );

    await state.refresh();

    const shown = state.state();
    // Empty chats, but NOT loaded: the roster stays, the error explains it, and
    // nobody is pointed at re-activating over a transient failure.
    expect(shown.cloudChats).toEqual([]);
    expect(shown.cloudChatsLoaded).toBe(false);
    expect(shown.cloudAgentsError).toBe("Couldn't reach Plow.");
    expect(shown.cloudAgents).toHaveLength(1);
  });

  it("keeps a chat failure and its error together when the agent list succeeds", async () => {
    // The two requests run concurrently. The agent list finishing last used to
    // clear the shared error field, leaving "no chats loaded" with nothing on
    // screen to explain it — which reads as an empty account.
    const agentsAnswer = deferred<CloudAgentResource[]>();
    const state = build(
      tempHome(),
      fakes({
        list: async () => agentsAnswer.promise,
        chats: async () => {
          throw new PlowApiError(
            "forbidden",
            "This Mac signed in before chat access existed. Re-activate it to list chats.",
            403,
          );
        },
      }),
    );

    const refreshing = state.refresh();
    await settle();
    agentsAnswer.resolve([agent()]);
    await refreshing;

    const shown = state.state();
    expect(shown.cloudChatsLoaded).toBe(false);
    expect(shown.cloudAgentsError).toBe(
      "This Mac signed in before chat access existed. Re-activate it to list chats.",
    );
    expect(shown.cloudAgents).toHaveLength(1);
  });

  it("lets a chat failure clear once the chats come back", async () => {
    let fail = true;
    const state = build(
      tempHome(),
      fakes({
        chats: async () => {
          if (fail) throw new PlowApiError("http", "Plow returned 500.", 500);
          return CHATS;
        },
      }),
    );
    await state.refresh();
    expect(state.state().cloudAgentsError).toBe("Plow returned 500.");

    fail = false;
    await state.refresh();

    expect(state.state()).toMatchObject({ cloudAgentsError: null, cloudChatsLoaded: true });
  });

  it("shows the agent list's failure ahead of the chat list's", async () => {
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

    // One banner, and an empty roster is the louder failure.
    expect(state.state().cloudAgentsError).toBe("Plow returned 500.");
  });

  it("forgets that the list ever loaded once a chat list fails", async () => {
    let fail = false;
    const state = build(
      tempHome(),
      fakes({
        chats: async () => {
          if (fail) throw new PlowApiError("http", "Plow returned 500.", 500);
          return CHATS;
        },
      }),
    );
    await state.refresh();
    expect(state.state().cloudChatsLoaded).toBe(true);

    fail = true;
    await state.refresh();

    expect(state.state().cloudChatsLoaded).toBe(false);
  });

  it("does not claim the list loaded while it is still in flight", async () => {
    const held = deferred<CloudChatOption[]>();
    const state = build(tempHome(), fakes({ chats: async () => held.promise }));

    const refreshing = state.refresh();
    // A request in the air is not an answer, and the empty state may only be
    // rendered on an answer.
    expect(state.state().cloudChatsLoaded).toBe(false);

    held.resolve(CHATS);
    await refreshing;
    expect(state.state().cloudChatsLoaded).toBe(true);
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

  it("does nothing at all when this Mac is not signed in", async () => {
    const f = fakes({ list: async () => [agent()] });
    const state = build(tempHome(""), f);

    await state.refresh();

    // Not "it failed quietly": it never asked. A Mac with no credential has
    // nothing to authenticate with, and a request that cannot succeed is a 401
    // on the account for no reason.
    expect(f.agents.calls).toEqual([]);
    expect(state.state().cloudAgents).toEqual([]);
    expect(state.state().cloudAgentsError).toBeNull();
  });
});

describe("provisioning", () => {
  it("puts the row on screen in provisioning before the poll finishes", async () => {
    const held = deferred<CloudAgentResource>();
    const receipt = agent({ status: "provisioning", name: null, url: null, sessionId: null });
    const changes: number[] = [];
    const f = fakes({ create: async () => receipt, poll: async () => held.promise });
    const state = new CloudAgentState({
      agents: f.agents,
      chats: f.chats,
      home: tempHome(),
      enabled: true,
      onChange: () => changes.push(1),
    });

    await state.create("cht_1", "Kitchen agent");

    const shown = state.state();
    expect(shown.cloudAgents).toHaveLength(1);
    expect(shown.cloudAgents[0]).toMatchObject({
      agentId: "agent_1",
      status: "provisioning",
      // The create receipt carries no name; the submitted one fills the gap.
      name: "Kitchen agent",
    });
    expect(changes.length).toBeGreaterThan(0);
    held.resolve(agent());
  });

  it("keeps a provisioning row that the account listing has not caught up with", async () => {
    const held = deferred<CloudAgentResource>();
    const f = fakes({
      create: async () => agent({ status: "provisioning" }),
      poll: async () => held.promise,
      list: async () => [],
    });
    const state = build(tempHome(), f);

    await state.create("cht_1", "Kitchen agent");
    await state.refresh();

    expect(state.state().cloudAgents.map((row) => row.status)).toEqual(["provisioning"]);
    held.resolve(agent());
  });

  it("updates the row in place when the poll reaches failed", async () => {
    const failed = agent({ status: "failed", failureReason: "VM did not start" });
    const f = fakes({
      create: async () => agent({ status: "provisioning" }),
      poll: async (receipt, onTransition) => {
        await onTransition?.(receipt);
        await onTransition?.(failed);
        return failed;
      },
      list: async () => [failed],
    });
    const state = build(tempHome(), f);

    await state.create("cht_1", "Kitchen agent");
    await vi.waitFor(() => expect(state.state().cloudAgents[0].status).toBe("failed"));

    expect(state.state().cloudAgents).toHaveLength(1);
    expect(state.state().cloudAgents[0].failureReason).toBe("VM did not start");
  });

  it("reports a create failure as an action error, not a list error", async () => {
    const f = fakes({
      create: async () => {
        throw new PlowApiError("provider_unavailable", "Provisioning is unavailable.", 503);
      },
    });
    const state = build(tempHome(), f);

    await state.create("cht_1", "Kitchen agent");

    expect(state.state().cloudActionError).toBe("Provisioning is unavailable.");
    expect(state.state().cloudAgentsError).toBeNull();
    expect(state.state().cloudAgents).toEqual([]);
  });

  it("refuses to create without a chat", async () => {
    const f = fakes();
    const state = build(tempHome(), f);

    await state.create("  ", "Kitchen agent");

    expect(f.agents.calls).toEqual([]);
    expect(state.state().cloudActionError).toBe("Pick the chat this agent will answer in.");
  });
});

describe("removing and retrying", () => {
  it("stops polling before the delete round trip, not after it", async () => {
    const held = deferred<CloudAgentResource>();
    const deleting = deferred<void>();
    let seen: AbortSignal | undefined;
    let abortedWhenDeleteBegan: boolean | undefined;
    const f = fakes({
      create: async () => agent({ status: "provisioning" }),
      poll: async (_receipt, _onTransition, signal) => {
        seen = signal;
        return held.promise;
      },
      remove: async () => {
        abortedWhenDeleteBegan = seen?.aborted;
        return deleting.promise;
      },
      list: async () => [],
    });
    const state = build(tempHome(), f);
    await state.create("cht_1", "Kitchen agent");

    const removing = state.remove("agent_1");
    deleting.resolve();
    await removing;

    // The poll must already be cancelled when the DELETE goes out: a delete is
    // a round trip, and a poll running across it keeps asking Plow about a
    // machine that is being torn down.
    expect(abortedWhenDeleteBegan).toBe(true);
    held.resolve(agent());
  });

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

  it("still applies a listing started after the delete", async () => {
    let deleted = false;
    const f = fakes({
      list: async () => (deleted ? [] : [agent()]),
      remove: async () => {
        deleted = true;
      },
    });
    const state = build(tempHome(), f);
    await state.refresh();
    expect(state.state().cloudAgents).toHaveLength(1);

    await state.remove("agent_1");
    deleted = false;
    await state.refresh();

    // Ordering, not a permanent block: server truth after the mutation wins.
    expect(state.state().cloudAgents.map((row) => row.agentId)).toEqual(["agent_1"]);
  });

  it("drops the row and its local settings once the delete lands", async () => {
    const home = tempHome();
    let removed = false;
    const f = fakes({
      list: async () => (removed ? [] : [agent()]),
      remove: async () => {
        removed = true;
      },
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", reviewOnly(true));
    expect(state.state().cloudAgents).toHaveLength(1);

    await state.remove("agent_1");

    expect(f.agents.deleted).toEqual(["agent_1"]);
    expect(state.state().cloudAgents).toEqual([]);
    expect(state.state().cloudActionError).toBeNull();
    // Nothing left for them to apply to, and a dead id kept forever is how the
    // file grows without bound.
    expect(loadSettings(home).cloudAgentSettings).toEqual({});
  });

  it("cancels a provision in flight when its agent is deleted", async () => {
    const held = deferred<CloudAgentResource>();
    let seen: AbortSignal | undefined;
    const f = fakes({
      create: async () => agent({ status: "provisioning" }),
      poll: async (_receipt, _onTransition, signal) => {
        seen = signal;
        return held.promise;
      },
      list: async () => [],
    });
    const state = build(tempHome(), f);
    await state.create("cht_1", "Kitchen agent");
    expect(seen?.aborted).toBe(false);

    await state.remove("agent_1");

    expect(seen?.aborted).toBe(true);
    held.resolve(agent());
  });

  it("retries by deleting and re-creating in the same chat, carrying local settings", async () => {
    const home = tempHome();
    const replacement = agent({ agentId: "agent_2", status: "provisioning" });
    const f = fakes({
      list: async () => [agent({ status: "failed", failureReason: "VM did not start" })],
      create: async () => replacement,
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", reviewOnly(true));

    await state.retry("agent_1");

    expect(f.agents.deleted).toEqual(["agent_1"]);
    expect(f.agents.created).toEqual([{ chatUid: "cht_1", name: "Kitchen agent" }]);
    // The replacement has a NEW agent id, and the choice moved onto it.
    expect(loadSettings(home).cloudAgentSettings).toEqual({
      agent_2: { adversarialReview: true },
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

describe("the derived scope set", () => {
  it("always carries chats:use, and nothing the controls did not ask for", () => {
    // `chats:use` is what makes it an agent that can read its chat at all.
    expect(cloudAgentScopes({ relay: false, inference: false })).toEqual(["chats:use"]);
    expect(cloudAgentScopes({ relay: true, inference: false })).toEqual([
      "chats:use",
      "relay:call",
    ]);
    expect(cloudAgentScopes({ relay: false, inference: true })).toEqual(["chats:use", "llm:chat"]);
    expect(cloudAgentScopes({ relay: true, inference: true })).toEqual([
      "chats:use",
      "relay:call",
      "llm:chat",
    ]);
  });

  it("never widens past the agent role, for any controls at all", () => {
    // The guarantee, not one example of it: whatever the panel sends, the
    // request can only ever carry scopes from this set. Anything outside it
    // hands a cloud machine something the user never asked it for — and the
    // device's own `relay:device` is the one that would matter.
    const ALLOWED = new Set(["chats:use", "relay:call", "llm:chat"]);
    const seen = new Set<string>();
    for (const relay of [true, false]) {
      for (const inference of [true, false]) {
        const scopes = cloudAgentScopes({ relay, inference });
        for (const scope of scopes) {
          expect(ALLOWED.has(scope)).toBe(true);
          seen.add(scope);
        }
        // No duplicates either — a set replaces the agent's scopes wholesale.
        expect(new Set(scopes).size).toBe(scopes.length);
      }
    }
    // And every one of them is reachable, so the set is exactly these three.
    expect(seen).toEqual(ALLOWED);
  });

  it("ignores anything the controls carry beyond the two switches", () => {
    const scopes = cloudAgentScopes({
      relay: false,
      inference: false,
      ...({ scopes: ["relay:device"], admin: true } as Record<string, unknown>),
    } as { relay: boolean; inference: boolean });

    expect(scopes).toEqual(["chats:use"]);
  });

  it("is what apply actually sends, for every combination", async () => {
    const ALLOWED = new Set(["chats:use", "relay:call", "llm:chat"]);
    for (const relay of [true, false]) {
      for (const inference of [true, false]) {
        const f = fakes({ list: async () => [agent()] });
        const state = build(tempHome(), f);
        await state.refresh();

        await state.apply("agent_1", { relay, inference, adversarialReview: false });

        const sent = f.agents.reconfigured[0].scopes ?? [];
        expect(sent).toEqual(cloudAgentScopes({ relay, inference }));
        for (const scope of sent) expect(ALLOWED.has(scope)).toBe(true);
      }
    }
  });
});

describe("Apply changes", () => {
  it("sends the derived scopes for the two permissions", async () => {
    const f = fakes({ list: async () => [agent()] });
    const state = build(tempHome(), f);
    await state.refresh();

    await state.apply("agent_1", { relay: true, inference: false, adversarialReview: false });

    expect(f.agents.reconfigured).toEqual([
      { agentId: "agent_1", scopes: ["chats:use", "relay:call"], chatUid: undefined },
    ]);
  });

  it("makes NO network call when the user touched neither permission", async () => {
    const home = tempHome();
    const f = fakes({ list: async () => [agent()] });
    const state = build(home, f);
    await state.refresh();
    const before = [...f.agents.calls];

    // Nothing has ever been applied to this agent, so nothing is known about
    // its permissions — and it still must not be restarted for a local switch.
    await state.apply("agent_1", reviewOnly(true));

    expect(f.agents.calls).toEqual(before);
    expect(f.agents.reconfigured).toEqual([]);
    expect(state.state().cloudSaving).toBeNull();
    expect(state.state().cloudSaveError).toBeNull();
    expect(loadSettings(home).cloudAgentSettings.agent_1.adversarialReview).toBe(true);
  });

  it("makes no network call for a local switch even when the pair is known", async () => {
    const home = tempHome();
    const f = fakes({ list: async () => [agent()], poll: settlesOn(agent({ status: "active" })) });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    await settle();
    const before = [...f.agents.calls];

    await state.apply("agent_1", reviewOnly(true));

    expect(f.agents.calls).toEqual(before);
    expect(loadSettings(home).cloudAgentSettings.agent_1).toEqual({
      adversarialReview: true,
      relay: true,
      inference: true,
    });
  });

  it("refuses to guess the permission the user did not choose", async () => {
    const f = fakes({ list: async () => [agent()] });
    const state = build(tempHome(), f);
    await state.refresh();

    await state.apply("agent_1", { relay: false, inference: null, adversarialReview: false });

    // A scope set replaces the agent's permissions wholesale, so half an answer
    // cannot be sent: the missing half would be a guess, and a guess can widen
    // an agent that was narrowed when it was created.
    expect(f.agents.reconfigured).toEqual([]);
    expect(state.state().cloudSaveError).toEqual({
      agentId: "agent_1",
      message: "Choose both relay access and inference before applying.",
    });
  });

  it("does not fill a missing permission in from what it remembers", async () => {
    const f = fakes({ list: async () => [agent()], poll: settlesOn(agent({ status: "active" })) });
    const state = build(tempHome(), f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    await settle();
    const before = f.agents.reconfigured.length;

    await state.apply("agent_1", { relay: false, inference: null, adversarialReview: false });

    // Even a remembered pair is only what we last ASKED for. Nothing reports
    // what the agent actually has, so it can never complete a request.
    expect(f.agents.reconfigured).toHaveLength(before);
    expect(state.state().cloudSaveError?.agentId).toBe("agent_1");
  });

  it("reconfigures whenever a permission was chosen, known pair or not", async () => {
    const f = fakes({ list: async () => [agent()] });
    const state = build(tempHome(), f);
    await state.refresh();

    await state.apply("agent_1", { relay: false, inference: false, adversarialReview: false });

    expect(f.agents.reconfigured).toEqual([
      { agentId: "agent_1", scopes: ["chats:use"], chatUid: undefined },
    ]);
  });

  it("writes the local switch immediately, before any restart finishes", async () => {
    const home = tempHome();
    const held = deferred<CloudAgentResource>();
    const f = fakes({ list: async () => [agent()], poll: async () => held.promise });
    const state = build(home, f);
    await state.refresh();

    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: true });

    // Local, immediate, and independent of the machine coming back.
    expect(loadSettings(home).cloudAgentSettings.agent_1.adversarialReview).toBe(true);
    expect(state.state().cloudSaving).toBe("agent_1");
    held.resolve(agent());
  });

  it("says which agent is being applied, and stops saying it when it is back", async () => {
    const held = deferred<CloudAgentResource>();
    const f = fakes({ list: async () => [agent()], poll: async () => held.promise });
    const state = build(tempHome(), f);
    await state.refresh();

    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    expect(state.state().cloudSaving).toBe("agent_1");
    expect(state.state().cloudSaveError).toBeNull();

    held.resolve(agent({ status: "active" }));
    await settle();

    expect(state.state().cloudSaving).toBeNull();
  });

  it("keeps the local switch through the session_id rotation a restart causes", async () => {
    const home = tempHome();
    const rotated = agent({ status: "active", sessionId: "session_after_reconfigure" });
    const f = fakes({
      list: async () => [rotated],
      reconfigure: async () =>
        agent({ status: "provisioning", sessionId: "session_after_reconfigure" }),
      poll: settlesOn(rotated),
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", reviewOnly(true));

    await state.apply("agent_1", { relay: false, inference: true, adversarialReview: true });
    await settle();

    // A reconfigure mints a fresh credential by design. `agent_id` is what the
    // settings hang off, so nothing here notices.
    expect(loadSettings(home).cloudAgentSettings.agent_1).toEqual({
      adversarialReview: true,
      relay: false,
      inference: true,
    });
    expect(JSON.stringify(state.state())).not.toContain("session_after_reconfigure");
  });

  it("leaves the previous permissions on screen when the reconfigure fails", async () => {
    const home = tempHome();
    let fail = false;
    const f = fakes({
      list: async () => [agent()],
      reconfigure: async () => {
        if (fail) throw new PlowApiError("http", "Plow returned 500.", 500);
        return agent({ status: "active" });
      },
      poll: settlesOn(agent({ status: "active" })),
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    await settle();

    fail = true;
    await state.apply("agent_1", { relay: false, inference: false, adversarialReview: false });
    await settle();

    const shown = state.state();
    expect(shown.cloudSaveError).toEqual({ agentId: "agent_1", message: "Plow returned 500." });
    expect(shown.cloudSaving).toBeNull();
    // The old credential stays live and the agent keeps running, so the panel
    // must keep showing what it actually has.
    expect(loadSettings(home).cloudAgentSettings.agent_1).toMatchObject({
      relay: true,
      inference: true,
    });
    expect(shown.cloudAgents).toHaveLength(1);
    // A save failure is not a list failure and not a create/delete failure.
    expect(shown.cloudAgentsError).toBeNull();
    expect(shown.cloudActionError).toBeNull();
  });

  it("does not record permissions the restart never delivered", async () => {
    const home = tempHome();
    const broken = agent({ status: "failed", failureReason: "VM did not come back" });
    const f = fakes({
      list: async () => [broken],
      poll: settlesOn(broken),
    });
    const state = build(home, f);
    await state.refresh();

    await state.apply("agent_1", { relay: true, inference: false, adversarialReview: false });
    await settle();

    expect(state.state().cloudSaveError).toEqual({
      agentId: "agent_1",
      message: "VM did not come back",
    });
    expect(state.state().cloudSaving).toBeNull();
    // Nothing was applied, so the next save must still know it has to ask.
    expect(loadSettings(home).cloudAgentSettings.agent_1.relay).toBeUndefined();
  });

  it("clears the previous save error when a new save starts", async () => {
    const home = tempHome();
    let fail = true;
    const f = fakes({
      list: async () => [agent()],
      reconfigure: async () => {
        if (fail) throw new PlowApiError("http", "Plow returned 500.", 500);
        return agent({ status: "active" });
      },
      poll: settlesOn(agent({ status: "active" })),
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    await settle();
    expect(state.state().cloudSaveError).toEqual({
      agentId: "agent_1",
      message: "Plow returned 500.",
    });

    fail = false;
    await state.apply("agent_1", { relay: true, inference: false, adversarialReview: false });
    await settle();

    expect(state.state().cloudSaveError).toBeNull();
  });

  it("is silent when a sign-out cancels the restart it was watching", async () => {
    const held = deferred<CloudAgentResource>();
    let seen: AbortSignal | undefined;
    const f = fakes({
      list: async () => [agent()],
      poll: async (_receipt, _onTransition, signal) => {
        seen = signal;
        await held.promise;
        // What the real client does on resuming: throws the signal's reason,
        // an AbortError.
        signal?.throwIfAborted();
        return agent();
      },
    });
    const state = build(tempHome(), f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });

    state.signedOut();
    held.resolve(agent());
    await settle();

    expect(seen?.aborted).toBe(true);
    expect(state.state().cloudSaving).toBeNull();
    expect(state.state().cloudSaveError).toBeNull();
  });

  it("is silent when removing the agent cancels the restart it was watching", async () => {
    // A delete cancels the poll without changing accounts, so nothing stands
    // between the AbortError and the panel except the check that it was asked
    // for. The user removed the agent; there is nothing to report.
    const held = deferred<void>();
    let deleted = false;
    const f = fakes({
      list: async () => (deleted ? [] : [agent()]),
      remove: async () => {
        deleted = true;
      },
      poll: async (_receipt, _onTransition, signal) => {
        await held.promise;
        // What the real client does on resuming a cancelled poll.
        signal?.throwIfAborted();
        return agent();
      },
    });
    const state = build(tempHome(), f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    expect(state.state().cloudSaving).toBe("agent_1");

    await state.remove("agent_1");
    held.resolve();
    await settle();

    expect(state.state().cloudSaveError).toBeNull();
    expect(state.state().cloudSaving).toBeNull();
    expect(state.state().cloudAgents).toEqual([]);
  });

  it("forgets the permissions when the POST's fate is unknown", async () => {
    const home = tempHome();
    let fail = false;
    const f = fakes({
      list: async () => [agent()],
      reconfigure: async () => {
        // No status: nothing came back, so nobody knows whether it landed.
        if (fail) throw new PlowApiError("network", "Couldn't reach Plow.");
        return agent({ status: "active" });
      },
      poll: settlesOn(agent({ status: "active" })),
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    await settle();
    expect(loadSettings(home).cloudAgentSettings.agent_1.relay).toBe(true);

    fail = true;
    await state.apply("agent_1", { relay: false, inference: false, adversarialReview: false });
    await settle();

    // The POST may well have landed. Keeping the old pair would let a later
    // save skip Plow and show relay as on while the live credential has it off.
    const entry = loadSettings(home).cloudAgentSettings.agent_1;
    expect(entry.relay).toBeUndefined();
    expect(entry.inference).toBeUndefined();
    expect(state.state().cloudSaveError).toEqual({
      agentId: "agent_1",
      message: "Couldn't reach Plow.",
    });
  });

  it("forgets the permissions when the restart poll could not finish", async () => {
    const home = tempHome();
    let fail = false;
    const f = fakes({
      list: async () => [agent()],
      poll: async (receipt, onTransition) => {
        if (fail) throw new PlowApiError("network", "Couldn't reach Plow.");
        await onTransition?.(receipt);
        return agent({ status: "active" });
      },
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    await settle();
    expect(loadSettings(home).cloudAgentSettings.agent_1.inference).toBe(true);

    fail = true;
    await state.apply("agent_1", { relay: false, inference: false, adversarialReview: false });
    await settle();

    // The POST succeeded, so the restart is happening — we just never read how
    // it ended.
    const entry = loadSettings(home).cloudAgentSettings.agent_1;
    expect(entry.relay).toBeUndefined();
    expect(entry.inference).toBeUndefined();
  });

  it("forgets the permissions when an accepted 2xx receipt is unusable", async () => {
    const home = tempHome();
    let fail = false;
    const f = fakes({
      list: async () => [agent()],
      reconfigure: async () => {
        // What the client raises for a 202 whose body it cannot parse. The
        // request was ACCEPTED — the reconfigure may well have applied — so
        // this is as unknown as a timeout, not a refusal.
        if (fail) {
          throw new PlowApiError("http", "Plow returned an invalid cloud-agent response.", 202);
        }
        return agent({ status: "active" });
      },
      poll: settlesOn(agent({ status: "active" })),
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    await settle();
    expect(loadSettings(home).cloudAgentSettings.agent_1.relay).toBe(true);

    fail = true;
    await state.apply("agent_1", { relay: false, inference: false, adversarialReview: false });
    await settle();

    const entry = loadSettings(home).cloudAgentSettings.agent_1;
    expect(entry.relay).toBeUndefined();
    expect(entry.inference).toBeUndefined();
    expect(state.state().cloudSaveError?.agentId).toBe("agent_1");
  });

  it("forgets the permissions when a 2xx receipt names a different agent", async () => {
    const home = tempHome();
    let fail = false;
    const f = fakes({
      list: async () => [agent()],
      reconfigure: async () => {
        // The client refuses a receipt whose agent_id is not the one it asked
        // about. Same door, same conclusion: accepted, outcome unknown.
        if (fail) {
          throw new PlowApiError("http", "Plow returned an invalid cloud-agent response.", 200);
        }
        return agent({ status: "active" });
      },
      poll: settlesOn(agent({ status: "active" })),
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    await settle();

    fail = true;
    await state.apply("agent_1", { relay: false, inference: false, adversarialReview: false });
    await settle();

    expect(loadSettings(home).cloudAgentSettings.agent_1.relay).toBeUndefined();
  });

  it("forgets the permissions when the client tags a receipt it could not use", async () => {
    const home = tempHome();
    let fail = false;
    const f = fakes({
      list: async () => [agent()],
      reconfigure: async () => {
        if (fail) {
          // Tagged at the source rather than inferred from the status: the
          // client says it accepted the answer and could not use it.
          const error = new PlowApiError("http", "Plow returned an invalid response.", 409);
          Object.assign(error, { responseKind: "invalid-2xx-receipt" });
          throw error;
        }
        return agent({ status: "active" });
      },
      poll: settlesOn(agent({ status: "active" })),
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    await settle();

    fail = true;
    await state.apply("agent_1", { relay: false, inference: false, adversarialReview: false });
    await settle();

    // The tag wins over the status it happens to carry.
    expect(loadSettings(home).cloudAgentSettings.agent_1.relay).toBeUndefined();
  });

  it("keeps the permissions when the tag says the request was refused", async () => {
    const home = tempHome();
    let fail = false;
    const f = fakes({
      list: async () => [agent()],
      reconfigure: async () => {
        if (fail) {
          // The other half of the tag: the client says this never got past
          // being rejected, so the agent is unchanged.
          const error = new PlowApiError("http", "Plow returned 500.", 500);
          Object.assign(error, { responseKind: "refusal" });
          throw error;
        }
        return agent({ status: "active" });
      },
      poll: settlesOn(agent({ status: "active" })),
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: false, adversarialReview: false });
    await settle();

    fail = true;
    await state.apply("agent_1", { relay: false, inference: true, adversarialReview: false });
    await settle();

    // The tag is what decides; the status it happens to carry does not.
    expect(loadSettings(home).cloudAgentSettings.agent_1).toMatchObject({
      relay: true,
      inference: false,
    });
  });

  it("keeps the permissions when Plow itself declares the change refused", async () => {
    const home = tempHome();
    let fail = false;
    const f = fakes({
      list: async () => [agent()],
      reconfigure: async () => {
        // A status: the request arrived and was refused, so the agent is
        // unchanged and what is remembered about it is still true.
        if (fail) throw new PlowApiError("http", "Plow returned 409.", 409);
        return agent({ status: "active" });
      },
      poll: settlesOn(agent({ status: "active" })),
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: false, adversarialReview: false });
    await settle();

    fail = true;
    await state.apply("agent_1", { relay: false, inference: true, adversarialReview: false });
    await settle();

    expect(loadSettings(home).cloudAgentSettings.agent_1).toMatchObject({
      relay: true,
      inference: false,
    });
  });

  it("keeps the permissions when the restart is declared failed", async () => {
    const home = tempHome();
    const broken = agent({ status: "failed", failureReason: "VM did not come back" });
    let fail = false;
    const f = fakes({
      list: async () => [agent()],
      poll: async (receipt, onTransition) => {
        if (!fail) return settlesOn(agent({ status: "active" }))(receipt, onTransition);
        return settlesOn(broken)(receipt, onTransition);
      },
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: false, adversarialReview: false });
    await settle();

    fail = true;
    await state.apply("agent_1", { relay: false, inference: true, adversarialReview: false });
    await settle();

    // The API guarantees the old credential stays live, so this is certain.
    expect(loadSettings(home).cloudAgentSettings.agent_1).toMatchObject({
      relay: true,
      inference: false,
    });
  });

  it("forgets the permissions when a delete cancels the restart", async () => {
    const home = tempHome();
    const held = deferred<void>();
    let deleted = false;
    let holdPoll = false;
    const f = fakes({
      list: async () => (deleted ? [] : [agent()]),
      remove: async () => {
        deleted = true;
      },
      poll: async (receipt, onTransition, signal) => {
        if (!holdPoll) return settlesOn(agent({ status: "active" }))(receipt, onTransition);
        await held.promise;
        signal?.throwIfAborted();
        return agent();
      },
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: true });
    await settle();
    expect(loadSettings(home).cloudAgentSettings.agent_1.relay).toBe(true);

    holdPoll = true;
    await state.apply("agent_1", { relay: false, inference: false, adversarialReview: true });
    await state.remove("agent_1");
    held.resolve();
    await settle();

    // The delete removed the entry outright, which is the strongest form of
    // "we do not claim to know" — and nothing was left saying relay is on.
    expect(loadSettings(home).cloudAgentSettings.agent_1).toBeUndefined();
  });

  it("scopes a save failure to the agent it happened to", async () => {
    const f = fakes({
      list: async () => [agent(), agent({ agentId: "agent_2", createdAt: "2026-08-01T00:00:00Z" })],
      reconfigure: async () => {
        throw new PlowApiError("http", "Plow returned 500.", 500);
      },
    });
    const state = build(tempHome(), f);
    await state.refresh();

    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });

    // The panel renders the banner only for the agent it is showing; unscoped,
    // opening agent_2 afterwards showed it a failure it never had.
    expect(state.state().cloudSaveError).toEqual({
      agentId: "agent_1",
      message: "Plow returned 500.",
    });
  });

  it("forgets a remembered pair when a sign-out interrupts the POST", async () => {
    const home = tempHome();
    const posting = deferred<CloudAgentResource>();
    let hold = false;
    const f = fakes({
      list: async () => [agent()],
      reconfigure: async () =>
        hold ? posting.promise : agent({ status: "provisioning" }),
      poll: settlesOn(agent({ status: "active" })),
    });
    const state = build(home, f);
    await state.refresh();
    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    await settle();
    expect(loadSettings(home).cloudAgentSettings.agent_1.relay).toBe(true);

    hold = true;
    const saving = state.apply("agent_1", { relay: false, inference: false, adversarialReview: false });
    state.signedOut();
    // `reconfigure` takes no signal, so this landed and the agent restarted on
    // the narrower set — nothing here saw the answer.
    posting.resolve(agent({ status: "provisioning" }));
    await saving;
    await settle();

    // Keeping `relay: true` would let the next save skip Plow and show relay as
    // on for an agent whose live credential no longer has it.
    const entry = loadSettings(home).cloudAgentSettings.agent_1;
    expect(entry.relay).toBeUndefined();
    expect(entry.inference).toBeUndefined();
  });

  it("recovers from a sign-out during the POST by listing, not by assuming", async () => {
    const home = tempHome();
    const posting = deferred<CloudAgentResource>();
    const restarted = agent({ status: "active", sessionId: "session_after_reconfigure" });
    const f = fakes({ list: async () => [restarted], reconfigure: async () => posting.promise });
    const state = build(home, f);
    await state.refresh();

    const saving = state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    // `reconfigure` takes no signal, so the agent restarts with the new scopes
    // whatever happens here.
    state.signedOut();
    posting.resolve(agent({ status: "provisioning", sessionId: "session_after_reconfigure" }));
    await saving;
    await settle();
    expect(state.state().cloudAgents).toEqual([]);

    await state.refresh();

    // The listing is the way back — nothing was recorded locally, so the row
    // comes from the account and the permissions stay unknown.
    expect(state.state().cloudAgents.map((row) => row.agentId)).toEqual(["agent_1"]);
    expect(state.state().cloudSaveError).toBeNull();
    expect(state.state().cloudSaving).toBeNull();
    const entry = loadSettings(home).cloudAgentSettings.agent_1;
    expect(entry.relay).toBeUndefined();
    expect(entry.inference).toBeUndefined();
  });

  it("asks again after a cancelled save, rather than assuming it took", async () => {
    const home = tempHome();
    const posting = deferred<CloudAgentResource>();
    const f = fakes({ list: async () => [agent()], reconfigure: async () => posting.promise });
    const state = build(home, f);
    await state.refresh();
    const saving = state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });
    state.signedOut();
    posting.resolve(agent({ status: "provisioning" }));
    await saving;
    await settle();

    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });

    // Two requests, because the first one's outcome was never learned.
    expect(f.agents.reconfigured).toHaveLength(2);
  });

  it("refuses to save while the flag is off, and asks for nothing", async () => {
    const f = fakes({ list: async () => [agent()] });
    const state = build(tempHome(), f, false);

    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: true });

    expect(f.agents.calls).toEqual([]);
    expect(state.state().cloudSaveError).toBeNull();
  });

  it("says so rather than calling Plow when this Mac is not signed in", async () => {
    const f = fakes();
    const state = build(tempHome(""), f);

    await state.apply("agent_1", { relay: true, inference: true, adversarialReview: false });

    expect(f.agents.calls).toEqual([]);
    expect(state.state().cloudSaveError).toEqual({
      agentId: "agent_1",
      message: "This Mac isn't signed in yet.",
    });
  });
});

describe("local per-agent settings", () => {
  it("survives the session_id rotation a reconfigure performs", async () => {
    const home = tempHome();
    let sessionId = "session_before";
    const state = build(
      home,
      fakes({ list: async () => [agent({ sessionId })] }),
    );
    await state.refresh();
    await state.apply("agent_1", reviewOnly(true));

    sessionId = "session_after_reconfigure";
    await state.refresh();

    expect(state.state().cloudAgentSettings).toEqual({ agent_1: { adversarialReview: true } });
    expect(loadSettings(home).cloudAgentSettings.agent_1.adversarialReview).toBe(true);
  });

  it("stores only the one boolean it owns", async () => {
    const home = tempHome();
    const state = build(home, fakes());

    await state.apply("agent_1", {
      ...reviewOnly(true),
      ...({ relayAccess: true } as Record<string, unknown>),
    } as CloudAgentControls);

    expect(loadSettings(home).cloudAgentSettings).toEqual({
      agent_1: { adversarialReview: true },
    });
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
      enabled: true,
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
    });
    const state = build(tempHome(), f);
    await state.create("cht_1", "Kitchen agent");

    state.signedOut();

    expect(seen?.aborted).toBe(true);
    expect(state.state()).toMatchObject({
      cloudAgents: [],
      cloudChats: [],
      cloudChatsLoaded: false,
      cloudAgentsError: null,
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

describe("CloudChatsClient", () => {
  function recordingFetch(answer: { status: number; body?: unknown }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    };
    return { calls, fetchImpl };
  }

  const chatRow = {
    uid: "cht_1",
    status: "active",
    created_at: "2026-08-20T10:00:00Z",
    participants: [
      { type: "agent", line: { provider_key: "+15550100" } },
      { type: "member", display_name: "Ada", provider_key: "+15550111" },
    ],
  };

  it("GETs the chat list with bearer auth and a short timeout", async () => {
    const { calls, fetchImpl } = recordingFetch({ status: 200, body: { data: [chatRow] } });
    const timeout = vi.spyOn(AbortSignal, "timeout");

    const chats = await new CloudChatsClient("https://api.plow.co/", fetchImpl).list(CREDENTIAL);

    expect(calls[0].url).toBe("https://api.plow.co/v1/chats");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.headers).toMatchObject({ authorization: `Bearer ${CREDENTIAL}` });
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    // The line the chat runs on, then who is in it — never the chat's own
    // provider_key, which is the provider's thread id.
    expect(chats).toEqual([{ uid: "cht_1", label: "+15550100 · Ada" }]);
    timeout.mockRestore();
  });

  it("says what to do about a 403, since it has no screen of its own", async () => {
    const { fetchImpl } = recordingFetch({ status: 403, body: { detail: "missing scope" } });

    await expect(
      new CloudChatsClient("https://api.plow.co", fetchImpl).list(CREDENTIAL),
    ).rejects.toMatchObject({
      kind: "forbidden",
      status: 403,
      message: "This Mac signed in before chat access existed. Re-activate it to list chats.",
    });
  });

  it("never repeats the credential back in a failure", async () => {
    const fetchImpl = async () => {
      throw new Error(`connect ECONNREFUSED with Bearer ${CREDENTIAL}`);
    };

    await expect(
      new CloudChatsClient("https://api.plow.co", fetchImpl).list(CREDENTIAL),
    ).rejects.toMatchObject({ kind: "network", message: "Couldn't reach Plow." });
  });
});
