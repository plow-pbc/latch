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
import {
  ChatSetConflictError,
  CloudAgentResource,
  CloudAgentsClient,
} from "../src/cloudAgents.js";
import { PlowApi, PlowApiError, REQUEST_TIMEOUT_MS } from "../src/plowApi.js";
import { loadSettings, saveSettings } from "../src/settings.js";
import { deferred } from "./deferred.js";

const CREDENTIAL = "plow_sk_device_do_not_leak";
const SESSION = "session_rotates_and_is_never_the_identity";
const HOLDER_ID = "0123456789abcdef0123456789abcdef";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempHome(credential = CREDENTIAL): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-cloud-state-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = loadSettings(dir);
  settings.relayCredential = credential;
  // What activation leaves behind on every signed-in Mac since chunk 1.
  settings.provisionedChatUid = "cht_1";
  settings.provisionedChatLabel = "+15550100 · Ada";
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
    chatUids: ["cht_1"],
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

interface Fakes {
  agents: CloudAgentsApi & {
    calls: string[];
    created: Array<{ chatUids: string[]; name?: string; provider?: string | null }>;
    deleted: string[];
    updated: Array<{ agentId: string; chatUids: string[] }>;
  };
  chats: CloudChatsApi;
}

function fakes(opts: {
  list?: () => Promise<CloudAgentResource[]>;
  create?: () => Promise<CloudAgentResource>;
  remove?: (agentId: string) => Promise<void>;
  update?: (agentId: string, chatUids: readonly string[]) => Promise<CloudAgentResource>;
  poll?: (
    receipt: CloudAgentResource,
    onTransition?: (a: CloudAgentResource) => void | Promise<void>,
    signal?: AbortSignal,
  ) => Promise<CloudAgentResource>;
  chats?: () => Promise<CloudChatOption[]>;
} = {}): Fakes {
  const calls: string[] = [];
  const created: Array<{ chatUids: string[]; name?: string; provider?: string | null }> = [];
  const deleted: string[] = [];
  const updated: Array<{ agentId: string; chatUids: string[] }> = [];
  return {
    agents: {
      calls,
      created,
      deleted,
      updated,
      async list(credential: string) {
        calls.push("list");
        expect(credential).toBe(CREDENTIAL);
        return opts.list ? opts.list() : [];
      },
      async create(credential: string, request) {
        calls.push("create");
        expect(credential).toBe(CREDENTIAL);
        created.push({
          chatUids: request.chatUids,
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
      async updateChats(credential: string, agentId: string, chatUids: readonly string[]) {
        calls.push("updateChats");
        expect(credential).toBe(CREDENTIAL);
        updated.push({ agentId, chatUids: [...chatUids] });
        return opts.update
          ? opts.update(agentId, chatUids)
          : agent({ chatUids: [...chatUids] });
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
      cloudChatsNeedReactivation: false,
      cloudSendTo: null,
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

describe("a superseded agent-list read", () => {
  it.each([
    ["failure", (d: ReturnType<typeof deferred<CloudAgentResource[]>>) =>
      d.reject(new PlowApiError("http", "Plow returned 500.", 500))],
    ["success", (d: ReturnType<typeof deferred<CloudAgentResource[]>>) =>
      d.resolve([agent({ agentId: "agent_stale" })])],
  ])("a late %s never displaces the newer read", async (_ending, finish) => {
    const stale = deferred<CloudAgentResource[]>();
    let first = true;
    const state = build(
      tempHome(),
      fakes({
        list: async () => {
          if (!first) return [agent({ agentId: "agent_newest" })];
          first = false;
          return stale.promise;
        },
      }),
    );

    const overtaken = state.refresh();
    await state.refresh();

    finish(stale);
    await overtaken;

    // The newest read is the account as it is. An overtaken one describes it
    // as it was, and a stale failure would put a banner over a good answer.
    expect(state.state().cloudAgents.map((row) => row.agentId)).toEqual(["agent_newest"]);
    expect(state.state().cloudAgentsError).toBeNull();
  });
});

describe("the numbers a chat can be messaged on", () => {
  /** What `GET /v1/chats` returns for a chat with an agent and two humans. */
  const chatRow = {
    uid: "cht_1",
    status: "active",
    created_at: "2026-08-20T10:00:00Z",
    participants: [
      { type: "agent", line: { provider_key: "+15550100" } },
      { type: "member", display_name: "Ada", provider_key: "+15550111" },
      { type: "member", display_name: "Grace", provider_key: "+15550122" },
    ],
  };

  it("carries every participant, not only the ones the label shows", async () => {
    const state = build(
      tempHome(),
      fakes({
        list: async () => [agent({ chatUids: ["cht_1"] })],
        chats: async () => [
          {
            uid: "cht_1",
            label: "+15550100, +15550111, +15550122",
            recipients: { line: "+15550100", members: ["+15550111", "+15550122"] },
          },
        ],
      }),
    );

    await state.refresh();

    // The label is prose. Reading addresses out of it opened an INCOMPLETE
    // conversation on any home whose label showed a display name instead of a
    // number.
    expect(state.state().cloudAgents[0].recipients).toEqual({
      line: "+15550100",
      members: ["+15550111", "+15550122"],
    });
  });

  it("gives a freshly created row its numbers without waiting for a refresh", async () => {
    const held = deferred<CloudAgentResource>();
    const state = build(
      tempHome(),
      fakes({
        list: async () => [],
        create: async () => agent({ chatUids: ["cht_1"], status: "provisioning" }),
        poll: async () => held.promise,
        chats: async () => [
          {
            uid: "cht_1",
            label: "+15550100, +15550111",
            recipients: { line: "+15550100", members: ["+15550111"] },
          },
        ],
      }),
    );
    await state.refresh();

    await state.create(["cht_1"], "Kitchen agent");

    // The row goes on screen the moment the receipt lands, before any further
    // refresh — so it has to be addressable then, not one round trip later.
    expect(state.state().cloudAgents[0].recipients).toEqual({
      line: "+15550100",
      members: ["+15550111"],
    });
    held.resolve(agent({ chatUids: ["cht_1"] }));
  });

  it("says it does not know them rather than guessing from the label", async () => {
    const state = build(
      tempHome(),
      fakes({
        list: async () => [agent({ chatUids: ["cht_1"] })],
        chats: async () => {
          throw new PlowApiError("network", "Couldn't reach Plow.");
        },
      }),
    );

    await state.refresh();

    // The fallback label can be a bare uid, with no digits in it at all. A
    // screen that scraped this got an empty recipient list and a button that
    // did nothing; `null` is what lets it disable the button instead.
    expect(state.state().cloudAgents[0].recipients).toBeNull();
  });

  it("fills them in on the row when a later chat list answers", async () => {
    let failing = true;
    const state = build(
      tempHome(),
      fakes({
        list: async () => [agent({ chatUids: ["cht_1"] })],
        chats: async () => {
          if (failing) throw new PlowApiError("network", "Couldn't reach Plow.");
          return [
            {
              uid: "cht_1",
              label: "+15550100 · Ada",
              recipients: { line: "+15550100", members: ["+15550111"] },
            },
          ];
        },
      }),
    );
    await state.refresh();
    expect(state.state().cloudAgents[0].recipients).toBeNull();

    failing = false;
    await state.refresh();

    // The label and the addresses go stale together and are fixed together —
    // a row must never name a chat it cannot message.
    expect(state.state().cloudAgents[0].chatLabels).toEqual(["+15550100 · Ada"]);
    expect(state.state().cloudAgents[0].recipients).toEqual({
      line: "+15550100",
      members: ["+15550111"],
    });
  });

  it("reads them off the wire the same way the label does", async () => {
    // The REAL client against a real chat payload, so the label and the
    // addresses are proved to come from the same parse.
    const fetchImpl = async () =>
      new Response(JSON.stringify({ data: [chatRow] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const chats = await new CloudChatsClient(new PlowApi("https://api.plow.co", fetchImpl)).list(
      CREDENTIAL,
    );

    expect(chats).toEqual([
      {
        uid: "cht_1",
        label: "+15550100, +15550111, +15550122",
        recipients: { line: "+15550100", members: ["+15550111", "+15550122"] },
      },
    ]);
  });
});

describe("the activation chat fallback", () => {
  /**
   * A read that has been overtaken says nothing about now, however it ends.
   *
   * Two refreshes in one session share a generation, so neither could tell it
   * had been overtaken: a late failure replaced a good list with the cached
   * fallback and an error banner, and a late success showed chats the account
   * no longer has.
   */
  it.each([
    ["failure", (d: ReturnType<typeof deferred<CloudChatOption[]>>) =>
      d.reject(new PlowApiError("network", "Couldn't reach Plow."))],
    ["success", (d: ReturnType<typeof deferred<CloudChatOption[]>>) => d.resolve(CHATS)],
  ])("a late %s never displaces the newer read", async (_ending, finish) => {
    const newest = [{ uid: "cht_2", label: "+15550188 · Family" }];
    const slow = deferred<CloudChatOption[]>();
    let first = true;
    const state = build(
      tempHome(),
      fakes({
        chats: async () => {
          if (!first) return newest;
          first = false;
          return slow.promise;
        },
      }),
    );

    const stale = state.refresh();
    await state.refresh();

    finish(slow);
    await stale;

    expect(state.state()).toMatchObject({
      cloudChats: newest,
      cloudChatsLoaded: true,
      cloudChatsError: null,
    });
  });

  /**
   * Every `PlowApiErrorKind` the chat list can raise, and whether re-activating
   * is the remedy. One table, because the answer is per-kind and a case with no
   * row is a kind nobody decided about — `unauthorized` was exactly that, and
   * it is one of the two arms the fix keys on.
   *
   * Following the prompt wipes the credential AND the cached activation chat,
   * which is the fallback keeping setup usable while the list is down. Offering
   * it for a blip costs a re-activation over SMS and fixes nothing.
   */
  it.each([
    ["forbidden", new PlowApiError("forbidden", "This Mac cannot list chats yet.", 403), true],
    ["unauthorized", new PlowApiError("unauthorized", "Not authorized.", 401), true],
    ["network", new PlowApiError("network", "Couldn't reach Plow."), false],
    ["http 5xx", new PlowApiError("http", "Plow returned 500.", 500), false],
    ["provider_unavailable", new PlowApiError("provider_unavailable", "Unavailable.", 503), false],
    ["expired", new PlowApiError("expired", "That code expired.", 410), false],
  ])("re-activation prompt for %s: %s", async (_kind, error, expected) => {
    const state = build(
      tempHome(),
      fakes({
        chats: async () => {
          throw error;
        },
      }),
    );

    await state.refresh();

    expect(state.state().cloudChatsNeedReactivation).toBe(expected);
    // Whatever the kind, the fallback is there to be used.
    expect(state.state().cloudChats).toHaveLength(1);
  });

  it("clears the prompt once the chats come back", async () => {
    let refused = true;
    const state = build(
      tempHome(),
      fakes({
        chats: async () => {
          if (refused) throw new PlowApiError("forbidden", "Refused.", 403);
          return CHATS;
        },
      }),
    );
    await state.refresh();
    expect(state.state().cloudChatsNeedReactivation).toBe(true);

    refused = false;
    await state.refresh();

    expect(state.state().cloudChatsNeedReactivation).toBe(false);
  });

  it("labels rows from the cached chat even when the list failed first", async () => {
    // The agent list can resolve before the chat list fails. The rows are built
    // with no labels, and only relabelling puts the number on screen — without
    // it a raw chat uid sits where a phone number belongs.
    const agentsLanded = deferred<void>();
    const state = build(
      tempHome(),
      fakes({
        list: async () => {
          agentsLanded.resolve();
          return [agent({ chatUids: ["cht_1"] })];
        },
        // Held until the rows exist, so they are built with no labels at all —
        // which is the ordering that made a raw uid reach the screen.
        chats: async () => {
          await agentsLanded.promise;
          await settle();
          throw new PlowApiError("network", "Couldn't reach Plow.");
        },
      }),
    );

    await state.refresh();

    expect(state.state().cloudAgents[0].chatLabels).toEqual(["+15550100 · Ada"]);
  });

  it("offers nothing on a Mac whose activation left no chat", async () => {
    const home = tempHome();
    const settings = loadSettings(home);
    settings.provisionedChatUid = "";
    settings.provisionedChatLabel = "";
    saveSettings(home, settings);
    const state = build(
      home,
      fakes({
        chats: async () => {
          throw new PlowApiError("network", "Couldn't reach Plow.");
        },
      }),
    );

    await state.refresh();

    // Nothing to fall back to, and nothing invented.
    expect(state.state().cloudChats).toEqual([]);
    expect(state.state().cloudChatsError).toBe("Couldn't reach Plow.");
  });

  it("gives way to the real list as soon as one comes back", async () => {
    let failing = true;
    const state = build(
      tempHome(),
      fakes({
        chats: async () => {
          if (failing) throw new PlowApiError("http", "Plow returned 500.", 500);
          return [
            { uid: "cht_1", label: "+15550100 · Ada" },
            { uid: "cht_2", label: "+15550188 · Family" },
          ];
        },
      }),
    );
    await state.refresh();
    expect(state.state().cloudChats).toHaveLength(1);

    failing = false;
    await state.refresh();

    // Server truth wins the moment there is any.
    expect(state.state().cloudChats).toHaveLength(2);
    expect(state.state().cloudChatsLoaded).toBe(true);
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

    await state.create(["cht_1"], "Kitchen agent");

    expect(f.agents.created[0].provider).toBe("exe:hermes");
  });

});

describe("removing", () => {
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
    const client = new CloudAgentsClient(
      new PlowApi("https://api.plow.co", fetchImpl),
      async () => {
        waits += 1;
        return parked.promise;
      },
    );
    const home = tempHome();
    const state = new CloudAgentState({
      agents: client,
      chats: { async list() { return CHATS; } },
      home,
    });

    await state.create(["cht_1"], "Kitchen agent");
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

    const creating = state.create(["cht_1"], "Kitchen agent");
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
    await state.create(["cht_1"], "Kitchen agent");

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
        chats: new CloudChatsClient(new PlowApi("https://api.plow.co", fetchLike)),
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
    // The activation chat, offered so this is not a dead end — but the list
    // itself did not come back, and `cloudChatsLoaded` still says so.
    // The fallback chat, offered so this is not a dead end — with no
    // recipients, because settings never persisted the participants.
    expect(shown.cloudChats).toEqual([
      { uid: "cht_1", label: "+15550100 · Ada", recipients: null },
    ]);
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

describe("changing which chats an agent serves", () => {
  it("sends the whole ordered set and rewrites the row from the answer", async () => {
    // The listing follows the save, the way a real account does: an edit that
    // succeeded is what the next GET reports.
    let served = ["cht_1"];
    const f = fakes({
      list: async () => [agent({ chatUids: [...served] })],
      update: async (_id, chatUids) => {
        served = [...chatUids];
        return agent({ chatUids: [...served] });
      },
      chats: async () => [
        { uid: "cht_1", label: "+15550100 · Ada", recipients: null },
        { uid: "cht_2", label: "+15550200 · Bo", recipients: null },
      ],
    });
    const state = build(tempHome(), f);
    await state.refresh();

    await expect(state.editChats("agent_1", ["cht_2", "cht_1"])).resolves.toBe(true);

    expect(f.agents.updated).toEqual([{ agentId: "agent_1", chatUids: ["cht_2", "cht_1"] }]);
    // Home first, and the labels follow the same order — the row must not
    // reorder what the server said the agent serves.
    expect(state.state().cloudAgents[0]).toMatchObject({
      chatUids: ["cht_2", "cht_1"],
      chatLabels: ["+15550200 · Bo", "+15550100 · Ada"],
    });
  });

  it("takes the server's set over the one that was asked for", async () => {
    const f = fakes({
      list: async () => [agent({ chatUids: ["cht_1"] })],
      // The server dropped one. The row must show what the agent HAS.
      update: async () => agent({ chatUids: ["cht_1"] }),
    });
    const state = build(tempHome(), f);
    await state.refresh();

    await state.editChats("agent_1", ["cht_1", "cht_2"]);

    expect(state.state().cloudAgents[0].chatUids).toEqual(["cht_1"]);
  });

  it("cleans the set before deciding there is anything to send", async () => {
    const f = fakes({ list: async () => [agent()] });
    const state = build(tempHome(), f);
    await state.refresh();

    await expect(state.editChats("agent_1", [" ", ""])).resolves.toBe(false);

    expect(f.agents.updated).toEqual([]);
    expect(state.state().cloudActionError).toBe("An agent has to serve at least one chat.");
  });

  it("re-reads after a 5xx because the save may have landed", async () => {
    let served = ["cht_1"];
    const f = fakes({
      list: async () => [agent({ chatUids: [...served] })],
      update: async () => {
        served = ["cht_2"];
        throw new PlowApiError("http", "Couldn't update the agent. Try again.", 502);
      },
    });
    const state = build(tempHome(), f);
    await state.refresh();

    await expect(state.editChats("agent_1", ["cht_2"])).resolves.toBe(false);

    expect(f.agents.calls.filter((call) => call === "list")).toHaveLength(2);
    expect(state.state().cloudActionError).toBe("Couldn't update the agent. Try again.");
    expect(state.state().cloudAgents[0].chatUids).toEqual(["cht_2"]);
    expect(state.state().cloudAgentsError).toBeNull();
  });

  it("names a conflicting agent only when a candidate id matches our list", async () => {
    const f = fakes({
      list: async () => [
        agent(),
        agent({ agentId: HOLDER_ID, name: "Book club", chatUids: ["cht_2"] }),
      ],
      update: async () => {
        throw new ChatSetConflictError(["ffffffffffffffffffffffffffffffff", HOLDER_ID]);
      },
    });
    const state = build(tempHome(), f);
    await state.refresh();

    await expect(state.editChats("agent_1", ["cht_2"])).resolves.toBe(false);

    expect(state.state().cloudActionError).toBe(
      "This chat already belongs to Book club — edit that agent's chats instead.",
    );
    expect(f.agents.calls.filter((call) => call === "list")).toHaveLength(1);
  });

  it("uses fixed words when no candidate id matches our list", async () => {
    const f = fakes({
      list: async () => [agent()],
      update: async () => {
        throw new ChatSetConflictError(["ffffffffffffffffffffffffffffffff"]);
      },
    });
    const state = build(tempHome(), f);
    await state.refresh();

    await state.editChats("agent_1", ["cht_2"]);

    expect(state.state().cloudActionError).toBe(
      "This chat already belongs to another agent — edit that agent's chats instead.",
    );
  });

  it("re-reads after a timeout, because the save it gave up on may have landed", async () => {
    // The PUT went out and the answer never came. The agent may well be
    // serving the new set; the app cannot tell by itself, so it asks.
    let served = ["cht_1"];
    const f = fakes({
      list: async () => [agent({ chatUids: [...served] })],
      update: async () => {
        served = ["cht_2"];
        throw new PlowApiError("network", "Plow didn't answer in time. Try again.");
      },
    });
    const state = build(tempHome(), f);
    await state.refresh();

    await expect(state.editChats("agent_1", ["cht_2"])).resolves.toBe(false);

    expect(f.agents.calls.filter((call) => call === "list")).toHaveLength(2);
    expect(state.state().cloudAgents[0].chatUids).toEqual(["cht_2"]);
    // Still a failure to the person who clicked: they do not know it worked,
    // and the sentence is what tells them to look.
    expect(state.state().cloudActionError).toContain("didn't answer in time");
  });

  it("does not re-read after a 409 refused the edit", async () => {
    const message = "This chat already belongs to another agent — edit that agent's chats instead.";
    const f = fakes({
      list: async () => [agent({ chatUids: ["cht_1"] })],
      update: async () => { throw new PlowApiError("http", message, 409); },
    });
    const state = build(tempHome(), f);
    await state.refresh();

    await expect(state.editChats("agent_1", ["cht_2"])).resolves.toBe(false);

    expect(f.agents.calls.filter((call) => call === "list")).toHaveLength(1);
    expect(state.state().cloudAgents[0].chatUids).toEqual(["cht_1"]);
    expect(state.state().cloudActionError).toBe(message);
  });

  it("does not re-read when nothing was ever sent", async () => {
    const f = fakes({ list: async () => [agent({ chatUids: ["cht_1"] })] });
    const state = build(tempHome(), f);
    await state.refresh();
    const before = f.agents.calls.filter((call) => call === "list").length;

    // No id and no chats never reach Plow at all, so there is nothing to
    // reconcile with — the re-read is for a request that was actually sent.
    await state.editChats("  ", ["cht_1"]);
    await state.editChats("agent_1", []);

    expect(f.agents.calls.filter((call) => call === "list")).toHaveLength(before);
    expect(f.agents.updated).toEqual([]);
  });

  it("drops a save that lands after this Mac signed out", async () => {
    const held = deferred<CloudAgentResource>();
    const f = fakes({
      list: async () => [agent({ chatUids: ["cht_1"] })],
      update: async () => held.promise,
    });
    const state = build(tempHome(), f);
    await state.refresh();

    const saving = state.editChats("agent_1", ["cht_2"]);
    state.signedOut();
    held.resolve(agent({ chatUids: ["cht_2"] }));

    await expect(saving).resolves.toBe(false);
    await settle();
    // The agent belongs to the account that went away; nothing from it may
    // appear under the next one.
    expect(state.state().cloudAgents).toEqual([]);
    expect(state.state().cloudActionError).toBeNull();
  });

  it("makes a listing already in the air lose to the save that overtook it", async () => {
    const listing = deferred<CloudAgentResource[]>();
    let firstList = true;
    const f = fakes({
      list: async () => {
        if (!firstList) return [agent({ chatUids: ["cht_2"] })];
        firstList = false;
        return listing.promise;
      },
      update: async () => agent({ chatUids: ["cht_2"] }),
    });
    const state = build(tempHome(), f);

    const refreshing = state.refresh();
    await state.editChats("agent_1", ["cht_2"]);
    // The stale listing answers with the pre-save set. It is older than what
    // the user just did, so applying it would undo the save on screen.
    listing.resolve([agent({ chatUids: ["cht_1"] })]);
    await refreshing;
    await settle();

    expect(state.state().cloudAgents[0].chatUids).toEqual(["cht_2"]);
  });

  it("treats a bare string as no chats rather than as its letters", async () => {
    const f = fakes({ list: async () => [agent()] });
    const state = build(tempHome(), f);
    await state.refresh();

    // The IPC boundary: a caller still passing the old singular argument must
    // fail loudly here, not provision an agent across "c", "h", "t"…
    await expect(state.create("cht_1" as unknown as string[], "Kitchen")).resolves.toBeNull();
    await expect(state.editChats("agent_1", "cht_1" as unknown as string[])).resolves.toBe(false);

    expect(f.agents.created).toEqual([]);
    expect(f.agents.updated).toEqual([]);
  });

  it("refuses to act with no agent id, and asks Plow nothing", async () => {
    const f = fakes({ list: async () => [agent()] });
    const state = build(tempHome(), f);
    await state.refresh();

    await expect(state.editChats("  ", ["cht_1"])).resolves.toBe(false);

    expect(f.agents.updated).toEqual([]);
  });
});

describe("CloudChatsClient", () => {
  it("never repeats the credential back in a failure", async () => {
    const fetchImpl = async () => {
      throw new Error(`connect ECONNREFUSED with Bearer ${CREDENTIAL}`);
    };

    await expect(
      new CloudChatsClient(new PlowApi("https://api.plow.co", fetchImpl)).list(CREDENTIAL),
    ).rejects.toMatchObject({
      kind: "network",
      message: "Couldn't reach Plow at https://api.plow.co.",
    });
  });
});
